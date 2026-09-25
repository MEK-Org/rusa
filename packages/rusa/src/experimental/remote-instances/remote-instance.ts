import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";
import type { ActorChannel } from "./actor-channel.js";
import type { FollowerCommand, FollowerEvent } from "./follower-hub.js";
import type {
  ActorEvent,
  FollowerUpdateCommand,
  FollowerUpdateStatus,
  FollowerUpdateStatusEvent,
  FollowerUpdateStatusPhase,
  LeaderCommand,
} from "./protocol.js";
import { INSTANCE_PROTOCOL_VERSION } from "./protocol.js";

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
  private readonly processedEvents = new Set<string>();
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

  recordEvent(eventId: string): void {
    // Keep the follower's replay fence fresh for individual event processing
    // too, in case a batch is interrupted before it reaches recordBatch().
    this.touch();
    if (this.processedEvents.has(eventId)) return;
    this.processedEvents.add(eventId);
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

  recordEvent(eventId: string): void {
    this.dedupeTracker.recordEvent(eventId);
  }

  /** Fresh work is rejected at both host creation and existing-host send boundaries. */
  assertDispatchable(): void {
    const error = this.staleContactError();
    if (error) throw error;
  }

  private commandDispatchError(message: LeaderCommand): Error | undefined {
    return message.type === "wake" ? this.staleContactError() : undefined;
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
    const host = new InstanceActorChannel(
      this.id,
      this.pid,
      (message) => {
        this.commands.push({ actorId, message });
        this.flush();
      },
      (message) => this.commandDispatchError(message)
    );
    this.hosts.set(actorId, host);
    host.once("exit", () => this.hosts.delete(actorId));
    return host;
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
    private readonly enqueue: (message: LeaderCommand) => void,
    private readonly dispatchError: (message: LeaderCommand) => Error | undefined
  ) {
    super();
  }

  send(message: LeaderCommand, callback: (error: Error | null) => void): boolean {
    if (!this.connected) {
      callback(new Error("Remote instance actor disconnected"));
      return false;
    }
    const error = this.dispatchError(message);
    if (error) {
      callback(error);
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
