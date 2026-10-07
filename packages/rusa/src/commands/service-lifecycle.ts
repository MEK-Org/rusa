import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { isGchatThreadHead } from "../actor/inbox-hints.js";
import type { InboxEntry } from "../repositories/inbox-repository.js";

/** Versioned, host-local evidence for the service transition immediately before a boot. */
export const SERVICE_LIFECYCLE_VERSION = 1;

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
    (candidate.cleanShutdown === undefined || isCleanShutdown(candidate.cleanShutdown))
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
    const document = this.requireDocument();
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
      renameSync(temporary, this.filePath);
    } catch (error) {
      try {
        if (existsSync(temporary)) rmSync(temporary, { force: true });
      } catch {
        // Keep the original error authoritative; cleanup is best effort.
      }
      throw error;
    }
  }
}
