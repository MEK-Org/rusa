import type { ActorRuntimeState, MeshActor } from "../actor/actor-mesh.js";
import type { ActorRecord } from "../actor/actor-record.js";
import type { ProviderModelConfig } from "../providers/model-config.js";
import type { InboxRepository } from "../repositories/inbox-repository.js";
import type { ActorChannel } from "./actor-channel.js";
import type { ActorEvent, LeaderCommand, QuotaObservation } from "./protocol.js";

/** Leader projection of execution owned elsewhere. No gate, run id or completion ACK. */
export class ActorProjection implements MeshActor {
  readonly id: string;
  private state: ActorRuntimeState = "idle";
  private observedAt?: string;
  private closed = false;
  constructor(
    private readonly options: {
      host: ActorChannel;
      record: () => ActorRecord;
      inbox: InboxRepository;
      quota: (record: ActorRecord) => QuotaObservation[];
      leaderInstanceId: string;
      onState: (state: ActorRuntimeState) => void;
    }
  ) {
    this.id = options.record().id;
    this.attachHost(options.host);
  }

  attachHost(host: ActorChannel): void {
    this.options.host = host;
    host.on("message", (message: ActorEvent) => {
      if (message.type === "executionSnapshot") {
        this.state = message.state;
        this.observedAt = message.observedAt;
        this.options.onState(message.state);
      }
    });
    // A channel loss invalidates observation freshness, never settles a run.
    host.on("exit", () => {
      this.observedAt = undefined;
    });
    this.install();
    this.requestRun();
  }

  private send(message: LeaderCommand): void {
    if (!this.closed && this.options.host.connected) this.options.host.send(message, () => {});
  }
  private install(): void {
    const record = this.options.record();
    this.send({ type: "quota", observations: this.options.quota(record) });
    this.send({ type: "install", record });
  }
  requestRun(): void {
    // The leader retains an outgoing copy for reconnect replay. The local
    // inbox deduplicates it; only the execution owner records selection/handling.
    let cursor: string | undefined;
    do {
      const page = this.options.inbox.list(this.id, { status: "unhandled", limit: 100, cursor });
      if (page.entries.length)
        this.send({
          type: "inbox",
          entries: page.entries.map((entry) => ({
            id: entry.id,
            actorId: this.id,
            source: entry.source,
            deliveredAt: entry.deliveredAt.toISOString(),
            payload:
              entry.payload.type === "mesh.message" && !entry.payload.entity
                ? {
                    ...entry.payload,
                    entity: {
                      instance: this.options.leaderInstanceId,
                      kind: "message",
                      id: entry.payload.messageId,
                    },
                  }
                : entry.payload,
          })),
        });
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    this.send({ type: "wake" });
    this.refresh();
  }
  refresh(): void {
    this.send({ type: "executionRead" });
  }
  get isRunning(): boolean {
    return !!this.observedAt && this.state === "running";
  }
  get isQueued(): boolean {
    return !!this.observedAt && this.state === "queued";
  }
  preemptForResponsive(): { preempted: false } {
    return { preempted: false };
  }
  markUnkillable(): void {
    this.send({ type: "unkillable" });
  }
  interrupt(by: string) {
    this.send({ type: "interrupt", by });
    return { interrupted: false };
  }
  setModelConfig(modelConfig: ProviderModelConfig[]): void {
    this.send({ type: "install", record: { ...this.options.record(), modelConfig } });
  }
  rescheduleQueuedRun(): boolean {
    this.install();
    return false;
  }
  close(): void {
    this.send({ type: "stop" });
    this.closed = true;
  }
}
