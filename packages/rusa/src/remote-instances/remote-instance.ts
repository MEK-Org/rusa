import { createHash, randomBytes, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";
import type { ActorChannel } from "./actor-channel.js";
import type { FollowerCommand, FollowerEvent } from "./follower-hub.js";
import type {
  ActorEvent,
  FollowerFileOperation,
  FollowerFileOperationResult,
  FollowerParkedEvent,
  FollowerUpdateCommand,
  FollowerUpdateStatus,
  FollowerUpdateStatusEvent,
  FollowerUpdateStatusPhase,
  LeaderCommand,
  MaterialReadReply,
} from "./protocol.js";
import { INSTANCE_PROTOCOL_VERSION } from "./protocol.js";
import {
  MATERIAL_READ_TIMEOUT_MS,
  MATERIAL_READS_PER_HOST,
  RUN_MATERIAL_READ_MAX_BYTES,
  type RunMaterialKind,
  type RunMaterialRead,
} from "./run-material.js";

/**
 * First protocol whose followers run `fileOp` (#1013). A capability floor, so
 * it stays 9 when `INSTANCE_PROTOCOL_VERSION` moves on.
 */
export const FILE_OP_PROTOCOL_VERSION = 9;

/**
 * How long the leader waits for a follower's `fileOpResult`. Generous enough
 * for a 1 GiB download on a slow link; it exists so a command lost in transit
 * or a stalled provider stream fails the tool call instead of hanging it.
 */
export const FILE_OP_TIMEOUT_MS = 30 * 60_000;

const SHA256_HEX = /^[0-9a-f]{64}$/;

/** Keeps only the known result fields, so nothing else a follower sends reaches a tool result. */
function parseFileOpResult(value: unknown): FollowerFileOperationResult | undefined {
  const candidate = value as Partial<FollowerFileOperationResult> | null;
  if (
    !candidate ||
    typeof candidate.path !== "string" ||
    !Number.isSafeInteger(candidate.bytes) ||
    (candidate.bytes as number) < 0 ||
    typeof candidate.sha256 !== "string" ||
    !SHA256_HEX.test(candidate.sha256)
  ) {
    return undefined;
  }
  return {
    path: candidate.path,
    bytes: candidate.bytes as number,
    sha256: candidate.sha256,
    ...(typeof candidate.name === "string" ? { name: candidate.name } : {}),
    ...(typeof candidate.contentType === "string" ? { contentType: candidate.contentType } : {}),
  };
}

/** Why a run's execution host cannot answer a material read now; retrying later may. */
export type MaterialReadUnavailableReason =
  | "offline"
  | "unsupported"
  | "busy"
  | "timeout"
  | "disconnected";

export class MaterialReadUnavailableError extends Error {
  constructor(
    readonly reason: MaterialReadUnavailableReason,
    message: string
  ) {
    super(message);
    this.name = "MaterialReadUnavailableError";
  }
}

export interface MaterialReadRequest {
  runId: string;
  kind: RunMaterialKind;
  attempt?: number;
}

/**
 * Check a follower's material reply against the leader's own limits: an `ok`
 * whose decoded bytes do not match its length and digest is an integrity
 * failure, whatever the follower claimed.
 */
function parseMaterialReadReply(
  value: unknown,
  request: MaterialReadRequest
): RunMaterialRead | { status: "error"; error: string } {
  const reply = value as Partial<Record<string, unknown>> | null;
  // A prompt answer names its attempt, the one asked for when one was.
  const attemptFits = (attempt: unknown) =>
    request.kind !== "prompt" ||
    (Number.isSafeInteger(attempt) &&
      (attempt as number) >= 1 &&
      (request.attempt === undefined || attempt === request.attempt));
  const isRef = (r: Partial<Record<string, unknown>>) =>
    Number.isSafeInteger(r.bytes) &&
    (r.bytes as number) >= 0 &&
    typeof r.sha256 === "string" &&
    SHA256_HEX.test(r.sha256);
  switch (reply?.status) {
    case "missing":
      if (reply.attempt === undefined) return { status: "missing" };
      // Only a latest-prompt miss names an attempt: the newest allocated one.
      if (request.kind !== "prompt" || request.attempt !== undefined) break;
      if (!attemptFits(reply.attempt)) break;
      return { status: "missing", attempt: reply.attempt as number };
    case "integrity":
      return { status: reply.status };
    case "error":
      return { status: "error", error: String(reply.error ?? "unknown error") };
    case "tooLarge":
      if (!isRef(reply) || !attemptFits(reply.attempt)) break;
      return {
        status: "tooLarge",
        ...(request.kind === "prompt" ? { attempt: reply.attempt as number } : {}),
        bytes: reply.bytes as number,
        sha256: reply.sha256 as string,
      };
    case "ok": {
      if (!isRef(reply) || typeof reply.content !== "string") break;
      if ((reply.bytes as number) > RUN_MATERIAL_READ_MAX_BYTES) break;
      if (!attemptFits(reply.attempt)) break;
      const attempt = reply.attempt;
      const content = Buffer.from(reply.content, "base64");
      if (
        content.length !== reply.bytes ||
        createHash("sha256").update(content).digest("hex") !== reply.sha256
      ) {
        return { status: "integrity" };
      }
      return {
        status: "ok",
        ...(request.kind === "prompt" ? { attempt: attempt as number } : {}),
        bytes: content.length,
        sha256: reply.sha256 as string,
        content,
      };
    }
  }
  return { status: "error", error: "malformed material read reply" };
}

interface PendingMaterialRead {
  actorId: string;
  request: MaterialReadRequest;
  resolve: (result: RunMaterialRead | { status: "error"; error: string }) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface PendingFileOp {
  actorId: string;
  resolve: (result: FollowerFileOperationResult) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export const ACTIVE_UPDATE_PHASES = new Set<FollowerUpdateStatusPhase>([
  "pending",
  "fetching",
  "building",
  "draining",
  "restarting",
] satisfies readonly FollowerUpdateStatusPhase[]);

/** In-memory deduplication tracker preserving at-most-once delivery across follower reconnects. */
export class FollowerDedupeTracker {
  private readonly processedBatches = new Set<string>();
  private readonly processedEvents = new Map<string, "accepted" | "failed">();
  private readonly batchOrder: string[] = [];
  private readonly eventOrder: string[] = [];
  private static readonly MAX_TRACKED_BATCHES = 1000;
  private static readonly MAX_TRACKED_EVENTS = 10_000;
  lastSeen = Date.now();

  touch(): void {
    this.lastSeen = Date.now();
  }

  hasBatch(batchId: string): boolean {
    return this.processedBatches.has(batchId);
  }

  recordBatch(batchId: string): void {
    // The tracker must survive a follower generation replacement after a
    // response-lost retry. Recording the just-accepted batch is meaningful
    // activity even when the instance has been connected for a long time.
    this.touch();
    if (this.processedBatches.has(batchId)) return;
    this.processedBatches.add(batchId);
    this.batchOrder.push(batchId);
    if (this.batchOrder.length > FollowerDedupeTracker.MAX_TRACKED_BATCHES) {
      const oldest = this.batchOrder.shift();
      if (oldest) this.processedBatches.delete(oldest);
    }
  }

  hasEvent(eventId: string): boolean {
    return this.processedEvents.has(eventId);
  }

  eventOutcome(eventId: string): "accepted" | "failed" | undefined {
    return this.processedEvents.get(eventId);
  }

  recordEvent(eventId: string, outcome: "accepted" | "failed" = "accepted"): void {
    // Keep the follower's replay fence fresh for individual event processing
    // too, in case a batch is interrupted before it reaches recordBatch().
    this.touch();
    const recorded = this.processedEvents.get(eventId);
    if (recorded) {
      // Acceptance is final: a later failure for the same id cannot undo it.
      // The sole failed -> accepted transition is FollowerHub.acceptEvent's
      // pre-dispatch fence after synchronous receive returns successfully.
      // Recorded failures otherwise stay terminal under that admission path.
      if (recorded !== "accepted") this.processedEvents.set(eventId, outcome);
      return;
    }
    this.processedEvents.set(eventId, outcome);
    this.eventOrder.push(eventId);
    if (this.eventOrder.length > FollowerDedupeTracker.MAX_TRACKED_EVENTS) {
      const oldest = this.eventOrder.shift();
      if (oldest) this.processedEvents.delete(oldest);
    }
  }
}

/** Leader-side representation of one registered follower generation. */
export class RemoteInstance {
  session = randomBytes(32).toString("hex");
  readonly hosts = new Map<string, InstanceActorChannel>();
  readonly commands: FollowerCommand[] = [];
  seen = Date.now();
  poll?: ServerResponse;
  pollTimer?: ReturnType<typeof setTimeout>;
  updateStatus?: FollowerUpdateStatus;
  /** Latest parked-head report; undefined until a follower that reports one polls (#880). */
  parkedEvent?: FollowerParkedEvent | null;
  private readonly fileOps = new Map<string, PendingFileOp>();
  /** Set when this generation offered bounded execution and the hub echoed it (#1020). */
  boundedExecution = false;
  private readonly materialReads = new Map<string, PendingMaterialRead>();

  constructor(
    readonly id: string,
    readonly platform: string,
    readonly pid: number,
    private readonly dedupeTracker: FollowerDedupeTracker = new FollowerDedupeTracker(),
    public commitSha?: string,
    readonly protocolVersion: number = INSTANCE_PROTOCOL_VERSION,
    /** Process-lifetime follower identity, distinct from the renewable HTTP session. */
    readonly generation = randomBytes(16).toString("hex"),
    /** Undefined for direct fixtures; the hub supplies its contact-age policy. */
    private readonly staleAfterMs?: number
  ) {}

  /** The same authenticated follower process recovered its HTTP session. */
  renewSession(): void {
    this.session = randomBytes(32).toString("hex");
    this.seen = Date.now();
    clearTimeout(this.pollTimer);
    if (this.poll) {
      this.poll.writeHead(410, { "content-type": "application/json" });
      this.poll.end(JSON.stringify({ error: "Session replaced" }));
      this.poll = undefined;
    }
  }

  hasBatch(batchId: string): boolean {
    return this.dedupeTracker.hasBatch(batchId);
  }

  recordBatch(batchId: string): void {
    this.dedupeTracker.recordBatch(batchId);
  }

  hasEvent(eventId: string): boolean {
    return this.dedupeTracker.hasEvent(eventId);
  }

  eventOutcome(eventId: string): "accepted" | "failed" | undefined {
    return this.dedupeTracker.eventOutcome(eventId);
  }

  recordEvent(eventId: string, outcome: "accepted" | "failed" = "accepted"): void {
    this.dedupeTracker.recordEvent(eventId, outcome);
  }

  /** Contact gates new actor placement and follower updates, not existing actor commands. */
  assertDispatchable(): void {
    const error = this.staleContactError();
    if (error) throw error;
  }

  private staleContactError(): Error | undefined {
    return this.staleAfterMs !== undefined && Date.now() - this.seen > this.staleAfterMs
      ? new Error(`Follower ${this.id} has no recent contact`)
      : undefined;
  }

  enqueueCommand(command: FollowerCommand): void {
    this.commands.push(command);
    this.flush();
  }

  enqueueUpdate(update: FollowerUpdateCommand): void {
    this.enqueueCommand(update);
  }

  isUpdateInProgress(): boolean {
    const status = this.updateStatus?.status;
    return status !== undefined && ACTIVE_UPDATE_PHASES.has(status);
  }

  setUpdateStatus(status: FollowerUpdateStatus): boolean {
    // A delayed status from a previous command must not replace the current
    // command's operator-visible state.
    if (
      this.updateStatus &&
      this.updateStatus.updateId !== status.updateId &&
      this.isUpdateInProgress()
    ) {
      return false;
    }
    this.updateStatus = status;
    return true;
  }

  createHost(actorId: string): ActorChannel {
    if (this.hosts.has(actorId)) throw new Error("Actor already assigned");
    return this.openHost(actorId);
  }

  /** Replace only the leader-side channel; the follower actor keeps running. */
  rebindHost(actorId: string): ActorChannel {
    const previous = this.hosts.get(actorId);
    if (previous) {
      // `attachHost()` removes the leader listener immediately after this call.
      // Do not synthesize an exit: same-generation reconnect is not a run result.
      previous.disconnect();
      this.hosts.delete(actorId);
    }
    return this.openHost(actorId);
  }

  private openHost(actorId: string): ActorChannel {
    const host = new InstanceActorChannel(this.id, this.pid, (message) => {
      this.commands.push({ actorId, message });
      this.flush();
    });
    this.hosts.set(actorId, host);
    host.once("exit", () => this.hosts.delete(actorId));
    return host;
  }

  /**
   * Has this follower run one provider download for an actor it hosts
   * (#1013). Undefined when the follower predates `fileOp`; the caller keeps
   * its refusal. Settles on the follower's `fileOpResult`, or rejects when
   * this generation closes or the deadline passes. A result after the
   * deadline is ignored.
   */
  fileOp(
    actorId: string,
    operation: FollowerFileOperation
  ): Promise<FollowerFileOperationResult> | undefined {
    if (this.protocolVersion < FILE_OP_PROTOCOL_VERSION) return undefined;
    const requestId = randomUUID();
    const result = new Promise<FollowerFileOperationResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.fileOps.delete(requestId);
        reject(
          new Error(
            `Follower ${this.id} did not finish the file operation within ${FILE_OP_TIMEOUT_MS / 60_000} minutes; the file may still appear at the destination`
          )
        );
      }, FILE_OP_TIMEOUT_MS);
      timer.unref?.();
      this.fileOps.set(requestId, { actorId, resolve, reject, timer });
    });
    this.commands.push({ actorId, message: { type: "fileOp", requestId, operation } });
    this.flush();
    return result;
  }

  private settleFileOp(actorId: string, message: Extract<ActorEvent, { type: "fileOpResult" }>) {
    const pending = this.fileOps.get(message.requestId);
    if (!pending || pending.actorId !== actorId) return;
    this.fileOps.delete(message.requestId);
    clearTimeout(pending.timer);
    if (typeof message.error === "string") {
      pending.reject(new Error(message.error));
      return;
    }
    const result = parseFileOpResult(message.result);
    if (result) pending.resolve(result);
    else pending.reject(new Error(`Follower ${this.id} returned a malformed file result`));
  }

  /**
   * Read one retained original of an actor's run from this follower (#1020).
   * Rejects with {@link MaterialReadUnavailableError} when this generation did
   * not negotiate bounded execution, already has
   * {@link MATERIAL_READS_PER_HOST} reads in flight, does not answer within
   * {@link MATERIAL_READ_TIMEOUT_MS}, or closes first.
   */
  materialRead(
    actorId: string,
    request: MaterialReadRequest
  ): Promise<RunMaterialRead | { status: "error"; error: string }> {
    if (!this.boundedExecution) {
      return Promise.reject(
        new MaterialReadUnavailableError(
          "unsupported",
          `Follower ${this.id} did not negotiate bounded execution`
        )
      );
    }
    if (this.materialReads.size >= MATERIAL_READS_PER_HOST) {
      return Promise.reject(
        new MaterialReadUnavailableError(
          "busy",
          `Follower ${this.id} already has ${MATERIAL_READS_PER_HOST} material reads in flight`
        )
      );
    }
    const requestId = randomUUID();
    const result = new Promise<RunMaterialRead | { status: "error"; error: string }>(
      (resolve, reject) => {
        const timer = setTimeout(() => {
          this.materialReads.delete(requestId);
          reject(
            new MaterialReadUnavailableError(
              "timeout",
              `Follower ${this.id} did not answer the material read within ${MATERIAL_READ_TIMEOUT_MS / 1000}s`
            )
          );
        }, MATERIAL_READ_TIMEOUT_MS);
        timer.unref?.();
        this.materialReads.set(requestId, { actorId, request, resolve, reject, timer });
      }
    );
    this.commands.push({
      actorId,
      message: {
        type: "materialRead",
        requestId,
        runId: request.runId,
        kind: request.kind,
        ...(request.attempt === undefined ? {} : { attempt: request.attempt }),
      },
    });
    this.flush();
    return result;
  }

  private settleMaterialRead(
    actorId: string,
    message: { requestId: string; result: MaterialReadReply }
  ): void {
    const pending = this.materialReads.get(message.requestId);
    if (!pending || pending.actorId !== actorId) return;
    this.materialReads.delete(message.requestId);
    clearTimeout(pending.timer);
    pending.resolve(parseMaterialReadReply(message.result, pending.request));
  }

  receive(event: {
    actorId: string;
    message:
      | ActorEvent
      | { type: "exit"; code: number | null; signal: NodeJS.Signals | null }
      | FollowerUpdateStatusEvent;
    eventId?: string;
  }): void {
    if (event.actorId === "$instance") {
      if (
        event.message &&
        typeof event.message === "object" &&
        "type" in event.message &&
        event.message.type === "update_status"
      ) {
        const msg = event.message as FollowerUpdateStatusEvent;
        const status: FollowerUpdateStatus = {
          updateId: msg.updateId,
          status: msg.status,
          step: msg.step,
          error: msg.error,
          oldSha: msg.oldSha,
          newSha: msg.newSha,
          rollbackFailed: msg.rollbackFailed,
          timestamp: new Date().toISOString(),
        };
        this.setUpdateStatus(status);
      }
      return;
    }
    if (event.message.type === "fileOpResult") {
      this.settleFileOp(event.actorId, event.message);
      return;
    }
    if (event.message.type === "materialReadResult") {
      this.settleMaterialRead(event.actorId, event.message);
      return;
    }
    this.hosts
      .get(event.actorId)
      ?.receive(
        event.message as
          | ActorEvent
          | { type: "exit"; code: number | null; signal: NodeJS.Signals | null }
      );
  }

  stopActor(actorId: string): void {
    const host = this.hosts.get(actorId);
    if (host) {
      host.receive({ type: "exit", code: 0, signal: null });
      this.hosts.delete(actorId);
    }
    this.commands.push({ actorId, message: { type: "stop" } });
    this.flush();
  }

  flush(): void {
    if (!this.poll || !this.commands.length) return;
    clearTimeout(this.pollTimer);
    this.poll.writeHead(200, { "content-type": "application/json" });
    this.poll.end(JSON.stringify(this.commands.splice(0)));
    this.poll = undefined;
  }

  close(): void {
    clearTimeout(this.pollTimer);
    if (this.poll) {
      this.poll.writeHead(410, { "content-type": "application/json" });
      this.poll.end(JSON.stringify({ error: "Follower disconnected" }));
      this.poll = undefined;
    }
    for (const host of [...this.hosts.values()])
      host.receive({ type: "exit", code: -1, signal: null });
    this.commands.length = 0;
    for (const pending of this.fileOps.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`Follower ${this.id} disconnected during a file operation`));
    }
    this.fileOps.clear();
    for (const pending of this.materialReads.values()) {
      clearTimeout(pending.timer);
      pending.reject(
        new MaterialReadUnavailableError(
          "disconnected",
          `Follower ${this.id} disconnected during a material read`
        )
      );
    }
    this.materialReads.clear();
  }
}

/** An actor-addressed channel on the instance connection, not an OS process. */
class InstanceActorChannel extends EventEmitter implements ActorChannel {
  connected = true;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  constructor(
    readonly nodeId: string,
    readonly pid: number,
    private readonly enqueue: (message: LeaderCommand) => void
  ) {
    super();
  }

  send(message: LeaderCommand, callback: (error: Error | null) => void): boolean {
    if (!this.connected) {
      callback(new Error("Remote instance actor disconnected"));
      return false;
    }
    this.enqueue(message);
    callback(null);
    return true;
  }

  receive(message: FollowerEvent["message"]): void {
    if (!this.connected) return;
    if (message.type === "exit") {
      this.connected = false;
      this.exitCode = message.code;
      this.signalCode = message.signal;
      this.emit("exit", message.code, message.signal);
    } else this.emit("message", message);
  }

  disconnect(): void {
    this.connected = false;
  }
}
