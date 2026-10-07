import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { isGchatThreadHead } from "../actor/inbox-hints.js";
import type { ChatClient } from "../chat/types.js";
import type { InboxEntry, InboxRepository } from "../repositories/inbox-repository.js";

/** Versioned, host-local evidence for the service transition immediately before a boot. */
export const SERVICE_LIFECYCLE_VERSION = 1;
/** A restart notice must never hold an already-drained update indefinitely. */
export const RESTART_ANNOUNCEMENT_TIMEOUT_MS = 10_000;

export interface GchatRestartDestination {
  kind: "gchat";
  spaceName: string;
  /** Omitted for the top-level message that requested the restart. */
  threadName?: string;
  /** The selected durable inbox item that established this route. */
  entryId: string;
}

export interface RequestedRestartIntent {
  id: string;
  requestedAt: string;
  targetSha: string;
  branch: string;
  subject: string;
  origin?: GchatRestartDestination;
  consumedByBootId?: string;
  announcement?: {
    attemptedAt: string;
    outcome: "delivered" | "failed" | "unavailable";
    detail?: string;
  };
}

export interface CleanShutdownEvidence {
  at: string;
  reason: "deploy" | "signal";
  transitionId?: string;
  consumedByBootId?: string;
}

export type PriorServiceState =
  | "requested_clean"
  | "requested_without_matching_clean_shutdown"
  | "clean_without_requested_restart"
  | "unknown";

export interface ServiceBootWake {
  bootId: string;
  createdAt: string;
  prior: PriorServiceState;
  requestedRestart?: RequestedRestartIntent;
  cleanShutdown?: CleanShutdownEvidence;
  /** Present only when corrupt lifecycle state prevented evidence recovery. */
  lifecycleError?: string;
}

interface ServiceLifecycleDocument {
  version: number;
  requestedRestart?: RequestedRestartIntent;
  cleanShutdown?: CleanShutdownEvidence;
  pendingBootWakes: ServiceBootWake[];
}

export type LifecycleLoadResult =
  | { kind: "absent" }
  | { kind: "ok"; document: ServiceLifecycleDocument }
  | { kind: "invalid"; reason: string };

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isOrigin(value: unknown): value is GchatRestartDestination {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.kind === "gchat" &&
    nonEmptyString(candidate.spaceName) &&
    nonEmptyString(candidate.entryId) &&
    (candidate.threadName === undefined || nonEmptyString(candidate.threadName))
  );
}

function isIntent(value: unknown): value is RequestedRestartIntent {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  if (
    !nonEmptyString(candidate.id) ||
    !nonEmptyString(candidate.requestedAt) ||
    !nonEmptyString(candidate.targetSha) ||
    !nonEmptyString(candidate.branch) ||
    !nonEmptyString(candidate.subject)
  ) {
    return false;
  }
  if (candidate.origin !== undefined && !isOrigin(candidate.origin)) return false;
  if (candidate.consumedByBootId !== undefined && !nonEmptyString(candidate.consumedByBootId)) {
    return false;
  }
  if (candidate.announcement !== undefined) {
    if (!candidate.announcement || typeof candidate.announcement !== "object") return false;
    const announcement = candidate.announcement as Record<string, unknown>;
    if (
      !nonEmptyString(announcement.attemptedAt) ||
      (announcement.outcome !== "delivered" &&
        announcement.outcome !== "failed" &&
        announcement.outcome !== "unavailable") ||
      (announcement.detail !== undefined && typeof announcement.detail !== "string")
    ) {
      return false;
    }
  }
  return true;
}

function isCleanShutdown(value: unknown): value is CleanShutdownEvidence {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    nonEmptyString(candidate.at) &&
    (candidate.reason === "deploy" || candidate.reason === "signal") &&
    (candidate.transitionId === undefined || nonEmptyString(candidate.transitionId)) &&
    (candidate.consumedByBootId === undefined || nonEmptyString(candidate.consumedByBootId))
  );
}

function isBootWake(value: unknown): value is ServiceBootWake {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  if (
    !nonEmptyString(candidate.bootId) ||
    !nonEmptyString(candidate.createdAt) ||
    ![
      "requested_clean",
      "requested_without_matching_clean_shutdown",
      "clean_without_requested_restart",
      "unknown",
    ].includes(String(candidate.prior))
  ) {
    return false;
  }
  return (
    (candidate.requestedRestart === undefined || isIntent(candidate.requestedRestart)) &&
    (candidate.cleanShutdown === undefined || isCleanShutdown(candidate.cleanShutdown)) &&
    (candidate.lifecycleError === undefined || typeof candidate.lifecycleError === "string")
  );
}

function validateDocument(value: unknown): LifecycleLoadResult {
  if (!value || typeof value !== "object")
    return { kind: "invalid", reason: "document is not an object" };
  const document = value as Record<string, unknown>;
  if (document.version !== SERVICE_LIFECYCLE_VERSION) {
    return {
      kind: "invalid",
      reason: `unsupported schema version ${String(document.version)} (expected ${SERVICE_LIFECYCLE_VERSION})`,
    };
  }
  if (!Array.isArray(document.pendingBootWakes) || !document.pendingBootWakes.every(isBootWake)) {
    return { kind: "invalid", reason: "invalid pendingBootWakes" };
  }
  if (document.requestedRestart !== undefined && !isIntent(document.requestedRestart)) {
    return { kind: "invalid", reason: "invalid requestedRestart" };
  }
  if (document.cleanShutdown !== undefined && !isCleanShutdown(document.cleanShutdown)) {
    return { kind: "invalid", reason: "invalid cleanShutdown" };
  }
  return { kind: "ok", document: document as unknown as ServiceLifecycleDocument };
}

function emptyDocument(): ServiceLifecycleDocument {
  return { version: SERVICE_LIFECYCLE_VERSION, pendingBootWakes: [] };
}

/**
 * Resolves a restart announcement route only when the current selection proves one
 * unambiguous Google Chat destination. Mixed, missing, or non-Chat selections are
 * intentionally unknown rather than guessed.
 */
export function resolveRequestedRestartDestination(
  entries: readonly InboxEntry[]
): GchatRestartDestination | undefined {
  if (entries.length !== 1) return undefined;
  const entry = entries[0];
  if (!entry || entry.payload.type !== "gchat.message") return undefined;
  const rawSpace = entry.payload.spaceName;
  if (!nonEmptyString(rawSpace)) return undefined;
  const spaceName = rawSpace.startsWith("spaces/") ? rawSpace : `spaces/${rawSpace}`;
  const threadName = nonEmptyString(entry.payload.threadName)
    ? entry.payload.threadName.trim()
    : undefined;
  const messageName = nonEmptyString(entry.payload.messageName)
    ? entry.payload.messageName.trim()
    : undefined;
  // Every top-level Chat message has a thread handle. Without the message id we
  // cannot distinguish that implicit handle from an existing reply thread.
  if (threadName && !messageName) return undefined;
  return {
    kind: "gchat",
    spaceName,
    ...(threadName && !isGchatThreadHead(messageName, threadName) ? { threadName } : {}),
    entryId: entry.id,
  };
}

type LifecycleWarning = (event: string, fields: Record<string, unknown>) => void;

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function withinDeadline<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`restart announcement timed out after ${timeoutMs}ms`)),
          timeoutMs
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Persist a committed restart intent, then make its bounded best-effort Chat
 * announcement. The local receipt is intentionally independent of transport:
 * a receipt-write failure never rewrites a delivered message as failed.
 */
export async function recordAndAnnounceRequestedRestart(args: {
  lifecycle: Pick<ServiceLifecycleStore, "recordRequestedRestart" | "recordAnnouncement">;
  entries: readonly InboxEntry[];
  chatClient?: Pick<ChatClient, "send">;
  targetSha: string;
  branch: string;
  subject: string;
  timeoutMs?: number;
  onWarning: LifecycleWarning;
}): Promise<string | undefined> {
  const origin = resolveRequestedRestartDestination(args.entries);
  let intent: RequestedRestartIntent;
  try {
    intent = args.lifecycle.recordRequestedRestart({
      targetSha: args.targetSha,
      branch: args.branch,
      subject: args.subject,
      ...(origin ? { origin } : {}),
    });
  } catch (error) {
    args.onWarning("service_restart_intent_persist_failed", {
      targetSha: args.targetSha,
      branch: args.branch,
      err: error,
    });
    return undefined;
  }

  const recordOutcome = (
    outcome: "delivered" | "failed" | "unavailable",
    detail?: string
  ): void => {
    try {
      args.lifecycle.recordAnnouncement(intent.id, outcome, detail);
    } catch (error) {
      args.onWarning("service_restart_announcement_record_failed", {
        transitionId: intent.id,
        outcome,
        err: error,
      });
    }
  };

  if (!origin || !args.chatClient) {
    recordOutcome(
      "unavailable",
      origin ? "chat client unavailable" : "originating Chat destination unknown"
    );
    args.onWarning("service_restart_announcement_unavailable", {
      transitionId: intent.id,
      reason: origin ? "chat_client_unavailable" : "origin_unknown",
    });
    return intent.id;
  }

  try {
    await withinDeadline(
      args.chatClient.send(
        origin.spaceName,
        `↪ Restart requested here → ${args.targetSha.slice(0, 7)} (${args.subject}) — draining + restarting`,
        origin.threadName ? { threadName: origin.threadName } : undefined
      ),
      args.timeoutMs ?? RESTART_ANNOUNCEMENT_TIMEOUT_MS
    );
  } catch (error) {
    const detail = errorDetail(error);
    recordOutcome("failed", detail);
    args.onWarning("service_restart_announcement_failed", { transitionId: intent.id, err: error });
    return intent.id;
  }

  // This is deliberately outside the send try/catch: transport success remains
  // true even when the local receipt cannot be written after it.
  recordOutcome("delivered");
  return intent.id;
}

/**
 * A deliberately small, atomically replaced host record. It is not an alternate
 * inbox: the inbox owns root work; this record only binds a controlled transition
 * to the next boot and retains a boot wake until that durable inbox write succeeds.
 */
export class ServiceLifecycleStore {
  constructor(
    readonly filePath: string,
    private readonly now: () => string = () => new Date().toISOString()
  ) {}

  read(): LifecycleLoadResult {
    if (!existsSync(this.filePath)) return { kind: "absent" };
    try {
      return validateDocument(JSON.parse(readFileSync(this.filePath, "utf8")));
    } catch (error) {
      return {
        kind: "invalid",
        reason: `unparseable JSON: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  recordRequestedRestart(input: {
    targetSha: string;
    branch: string;
    subject: string;
    origin?: GchatRestartDestination;
  }): RequestedRestartIntent {
    const document = this.requireDocument();
    const intent: RequestedRestartIntent = {
      id: randomUUID(),
      requestedAt: this.now(),
      targetSha: input.targetSha,
      branch: input.branch,
      subject: input.subject,
      ...(input.origin ? { origin: input.origin } : {}),
    };
    document.requestedRestart = intent;
    this.save(document);
    return intent;
  }

  recordAnnouncement(
    transitionId: string,
    outcome: "delivered" | "failed" | "unavailable",
    detail?: string
  ): void {
    const document = this.requireDocument();
    if (document.requestedRestart?.id !== transitionId) return;
    document.requestedRestart.announcement = {
      attemptedAt: this.now(),
      outcome,
      ...(detail ? { detail } : {}),
    };
    this.save(document);
  }

  recordCleanShutdown(reason: "deploy" | "signal", transitionId?: string): void {
    const document = this.requireDocument();
    const matchingTransition =
      transitionId !== undefined &&
      document.requestedRestart?.id === transitionId &&
      document.requestedRestart.consumedByBootId === undefined;
    document.cleanShutdown = {
      at: this.now(),
      reason,
      ...(matchingTransition ? { transitionId } : {}),
    };
    this.save(document);
  }

  /** Persist this boot before attempting its root wake; returned rows include interrupted prior delivery. */
  beginBoot(): ServiceBootWake[] {
    const loaded = this.read();
    let document: ServiceLifecycleDocument;
    let lifecycleError: string | undefined;
    if (loaded.kind === "ok") {
      document = structuredClone(loaded.document);
    } else if (loaded.kind === "absent") {
      document = emptyDocument();
    } else {
      lifecycleError = loaded.reason;
      this.rotateInvalidEvidence();
      document = emptyDocument();
    }
    const bootId = randomUUID();
    const intent = document.requestedRestart;
    const shutdown = document.cleanShutdown;
    const pendingIntent = intent?.consumedByBootId === undefined ? intent : undefined;
    const pendingShutdown = shutdown?.consumedByBootId === undefined ? shutdown : undefined;
    const prior: PriorServiceState = pendingIntent
      ? pendingShutdown?.transitionId === pendingIntent.id
        ? "requested_clean"
        : "requested_without_matching_clean_shutdown"
      : pendingShutdown
        ? "clean_without_requested_restart"
        : "unknown";
    const bootWake: ServiceBootWake = {
      bootId,
      createdAt: this.now(),
      prior,
      ...(pendingIntent ? { requestedRestart: structuredClone(pendingIntent) } : {}),
      ...(pendingShutdown ? { cleanShutdown: structuredClone(pendingShutdown) } : {}),
      ...(lifecycleError ? { lifecycleError } : {}),
    };
    if (pendingIntent) pendingIntent.consumedByBootId = bootId;
    if (pendingShutdown) pendingShutdown.consumedByBootId = bootId;
    document.pendingBootWakes.push(bootWake);
    this.save(document);
    return structuredClone(document.pendingBootWakes);
  }

  acknowledgeBootWake(bootId: string): void {
    const document = this.requireDocument();
    const before = document.pendingBootWakes.length;
    document.pendingBootWakes = document.pendingBootWakes.filter((wake) => wake.bootId !== bootId);
    if (document.pendingBootWakes.length !== before) this.save(document);
  }

  private requireDocument(): ServiceLifecycleDocument {
    const loaded = this.read();
    if (loaded.kind === "ok") return structuredClone(loaded.document);
    if (loaded.kind === "absent") return emptyDocument();
    throw new Error(`service lifecycle state is invalid: ${loaded.reason}`);
  }

  private save(document: ServiceLifecycleDocument): void {
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const temporary = `${this.filePath}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      const temporaryFd = openSync(temporary, "r");
      try {
        fsyncSync(temporaryFd);
      } finally {
        closeSync(temporaryFd);
      }
      renameSync(temporary, this.filePath);
      // `rename` is atomic, but syncing the containing directory is what makes
      // that replacement durable across the supported host-filesystem reboot
      // boundary. It cannot promise survival of hardware or filesystem lies.
      this.syncDirectory(dir);
    } catch (error) {
      try {
        if (existsSync(temporary)) rmSync(temporary, { force: true });
      } catch {
        // Keep the original error authoritative; cleanup is best effort.
      }
      throw error;
    }
  }

  private rotateInvalidEvidence(): void {
    const dir = dirname(this.filePath);
    const backup = `${this.filePath}.${randomUUID()}.invalid`;
    renameSync(this.filePath, backup);
    this.syncDirectory(dir);
  }

  private syncDirectory(dir: string): void {
    const directoryFd = openSync(dir, "r");
    try {
      fsyncSync(directoryFd);
    } finally {
      closeSync(directoryFd);
    }
  }
}

function appendBootWake(inboxStore: InboxRepository, rootId: string, wake: ServiceBootWake): void {
  inboxStore.append([
    {
      id: `service-boot:${wake.bootId}`,
      actorId: rootId,
      source: "system:service-lifecycle",
      payload: {
        type: "service.boot",
        priority: "responsive",
        bootId: wake.bootId,
        prior: wake.prior,
        ...(wake.requestedRestart ? { requestedRestart: wake.requestedRestart } : {}),
        ...(wake.cleanShutdown ? { cleanShutdown: wake.cleanShutdown } : {}),
        ...(wake.lifecycleError ? { lifecycleError: wake.lifecycleError } : {}),
        prompt:
          "Assess the preceding service-transition evidence. Investigate an unexpected or unknown startup; do not infer a cause beyond the recorded evidence.",
      },
    },
  ]);
}

/**
 * Delivers every persisted boot wake through the authoritative inbox. A failed
 * evidence read is itself an unknown startup, never a reason to suppress root
 * work; the fallback row is durable even though corrupt evidence is retained.
 */
export function appendServiceBootWakes(args: {
  lifecycle: Pick<ServiceLifecycleStore, "beginBoot" | "acknowledgeBootWake">;
  inboxStore: InboxRepository;
  rootId: string;
  onLifecycleError: LifecycleWarning;
}): void {
  let wakes: ServiceBootWake[];
  try {
    wakes = args.lifecycle.beginBoot();
  } catch (error) {
    args.onLifecycleError("service_boot_evidence_read_failed", { err: error });
    appendBootWake(args.inboxStore, args.rootId, {
      bootId: `invalid-${randomUUID()}`,
      createdAt: new Date().toISOString(),
      prior: "unknown",
      lifecycleError: errorDetail(error),
    });
    return;
  }

  for (const wake of wakes) {
    appendBootWake(args.inboxStore, args.rootId, wake);
    try {
      args.lifecycle.acknowledgeBootWake(wake.bootId);
    } catch (error) {
      // The inbox row committed first, so keeping this wake pending is a safe
      // retry. A later boot re-appends the same deterministic inbox id.
      args.onLifecycleError("service_boot_wake_acknowledgement_failed", {
        bootId: wake.bootId,
        err: error,
      });
    }
  }
}
