import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { Actor } from "../../actor/actor.js";
import { ActorMesh } from "../../actor/actor-mesh.js";
import type { ActorRecord } from "../../actor/actor-record.js";
import { ProviderPacer, submitPoolGate } from "../../actor/provider-pacer.js";
import { projectActorRunLaunchConfig } from "../../actor/run-accounting.js";
import { Repositories } from "../../db/repositories/index.js";
import type { MeshChat } from "../../db/repositories/mesh-chat-repository.js";
import type { Logger } from "../../observability/logger.js";
import type { RawProviderModelConfig } from "../../providers/model-config.js";
import type { CodingProvider } from "../../providers/types.js";

export interface EntityRef {
  instance: string;
  kind: "message" | "run";
  id: string;
}

/** No prompt, output, chat body, or provider configuration in the event. */
export interface InstanceEvent {
  id: string;
  actorId: string;
  type: "mesh.message" | "run.failed";
  entity: EntityRef;
  status?: "failed";
}

/** An observation, not a launch reservation or permission from the leader. */
export interface QuotaObservation {
  provider: string;
  observedAt: string;
  intervalMs: number;
}

/**
 * Executable architecture sketch for #1020, deliberately outside daemon startup.
 * The same local ActorMesh/RunManager/Actor composition runs on either role.
 * Transport authentication, durable outgoing delivery and control-plane writes
 * are not implemented by this sketch; see README before considering integration.
 */
export class PrototypeInstance {
  readonly repositories: Repositories;
  readonly mesh: ActorMesh;
  private readonly hosted = new Set<string>();
  private readonly activeRuns = new Map<string, string>();
  private readonly pacers = new Map<string, ProviderPacer>();
  private readonly quota = new Map<string, QuotaObservation>();

  constructor(
    readonly id: string,
    private readonly options: {
      home: string;
      db: Database.Database;
      logger: Logger;
      provider: (actorId: string, selected: RawProviderModelConfig) => CodingProvider;
      /** Enqueue ordinary delivery; returning here never waits for a peer ACK. */
      publish: (event: InstanceEvent) => void;
      /** Transport supplies authenticated requester identity to the entity owner. */
      fetchMessage: (requesterId: string, ref: EntityRef) => Promise<MeshChat>;
    }
  ) {
    this.repositories = new Repositories(options.db);
    const repos = this.repositories;
    this.mesh = new ActorMesh({
      actors: repos.actors,
      inboxStore: repos.inbox,
      maxConcurrent: 2,
      // The existing bounded selected-work recovery now reads THIS instance's
      // completed runs, independently of event delivery or leader availability.
      completedFocusEntryCounts: (actorId, excludeRunId) =>
        repos.actorRuns.completedFocusEntryCounts(actorId, excludeRunId),
      providerGate: (run, candidates, admission) =>
        submitPoolGate(
          run,
          candidates.map((config) => ({
            config,
            lane: config.provider,
            pacer: this.pacer(config.provider),
          })),
          {
            ...admission,
            onSelected: (selection) =>
              admission.onSelected?.({
                ...selection.candidate,
                model: selection.candidate.model ?? "unknown",
                lane: selection.lane,
                declaredIndex: selection.declaredIndex,
                eligibleAt: selection.eligibleAt,
                responsive: selection.responsive,
              }),
          }
        ),
      log: (message) => options.logger.debug("prototype_mesh", { instance: id, message }),
      onLifecycleError: (failure) =>
        options.logger.error("prototype_lifecycle_error", { instance: id, err: failure.error }),
      lifecycleListeners: [
        {
          onStart: (event) => {
            repos.actorRuns.start({
              id: event.runId,
              actorId: event.actorId,
              modelConfig: projectActorRunLaunchConfig(event.selected),
            });
            this.activeRuns.set(event.actorId, event.runId);
          },
          onPrompt: (event) =>
            repos.runPrompts.recordForActor(event.actorId, event.runId, event.prompt),
          onEnd: (event) => {
            this.activeRuns.delete(event.actorId);
            if (event.terminal.kind === "abandoned") {
              if (event.terminal.started) {
                repos.actorRuns.abandon(event.runId, event.terminal.reason);
              }
              return;
            }
            const result = event.terminal.result;
            repos.actorRuns.complete(event.runId, result);
            options.logger.info("prototype_run_recorded", {
              instance: id,
              actorId: event.actorId,
              runId: event.runId,
              success: result.success,
            });
            // Success has no mandatory leader notification. A failure is an
            // ordinary event addressed to the parent, not a completion RPC.
            const parentId = repos.actors.get(event.actorId)?.parentId;
            if (!result.success && !result.cancelled && !result.interrupted && parentId) {
              options.publish({
                id: randomUUID(),
                actorId: parentId,
                type: "run.failed",
                entity: { instance: id, kind: "run", id: event.runId },
                status: "failed",
              });
            }
          },
        },
      ],
      createActor: (context) => {
        const record = context.record;
        const cwd = join(options.home, "workers", record.id);
        mkdirSync(cwd, { recursive: true });
        return new Actor({
          id: record.id,
          cwd,
          modelConfig: record.modelConfig ?? [],
          resolveProvider: (selected) => options.provider(record.id, selected),
          mcpServers: [], // Local actor-scoped MCP composition belongs here.
          debounceMs: 0,
          loadSessionId: () => repos.actors.get(record.id)?.sessionId,
          saveSessionId: (sessionId) => repos.actors.patch(record.id, { sessionId }),
          // This is built locally after admission; it contains references, not
          // eagerly fetched bodies. Production would reuse buildWorkerPrompt.
          buildPrompt: () => ({
            prompt: JSON.stringify({
              charter: repos.actors.get(record.id)?.charter,
              inbox: repos.inbox.list(record.id, { limit: 100 }).entries,
            }),
          }),
          gate: context.gate,
          beforeRun: context.beforeRun,
          admitRun: context.admitRun,
          lifecycle: context.lifecycle,
          onQueuedRunCancelled: context.onQueuedRunCancelled,
          onRuntimeStateChanged: context.onRuntimeStateChanged,
        });
      },
    });
  }

  /** Install already-authorized static metadata; this is not a global mutation API. */
  install(record: ActorRecord, hostedHere: boolean): void {
    if (this.hosted.has(record.id)) throw new Error("Prototype does not update live installations");
    this.repositories.actors.upsert(record);
    if (hostedHere) {
      if (!record.modelConfig?.length) throw new Error("An installed actor needs a model pool");
      this.hosted.add(record.id);
      this.mesh.rehydrate(record);
    }
  }

  /** Initial revision: the leader pushes observations; each instance owns its clocks. */
  observeQuota(observation: QuotaObservation): void {
    this.pacer(observation.provider).setInterval(observation.intervalMs);
    this.quota.set(observation.provider, { ...observation });
  }

  private pacer(provider: string): ProviderPacer {
    let pacer = this.pacers.get(provider);
    if (!pacer) {
      pacer = new ProviderPacer();
      this.pacers.set(provider, pacer);
    }
    return pacer;
  }

  /** The transport must authenticate origin before calling this boundary. */
  receive(origin: string, event: InstanceEvent): void {
    if (event.entity.instance !== origin) throw new Error("Event origin mismatch");
    if (!this.hosted.has(event.actorId)) throw new Error("Recipient is not hosted here");
    // SQLite commits and deduplicates before ActorMesh's advisory wake runs.
    this.repositories.inbox.append([
      {
        id: `${origin}:${event.id}:${event.actorId}`,
        actorId: event.actorId,
        source: `instance:${origin}`,
        payload: { ...event, deliveryRole: "owner" },
      },
    ]);
  }

  /** Store the body on its origin, then queue only a small event. */
  sendMessage(senderId: string, recipientId: string, body: string): EntityRef {
    if (!this.hosted.has(senderId)) throw new Error("Sender is not hosted here");
    const sender = this.repositories.actors.get(senderId);
    if (sender?.parentId !== recipientId && !sender?.handles?.some((h) => h.id === recipientId)) {
      throw new Error("Sender has no recipient handle");
    }
    const messageId = this.repositories.meshChat.record({ senderId, recipientId, body });
    const entity: EntityRef = { instance: this.id, kind: "message", id: messageId };
    this.options.publish({ id: messageId, actorId: recipientId, type: "mesh.message", entity });
    return entity;
  }

  /** Origin-side authorization applies to every fetch, including remote ones. */
  serveMessage(requesterId: string, ref: EntityRef): MeshChat {
    if (ref.instance !== this.id || ref.kind !== "message") throw new Error("Wrong entity owner");
    const message = this.repositories.meshChat.getById(ref.id);
    if (!message || (requesterId !== message.senderId && requesterId !== message.recipientId)) {
      throw new Error("Message is absent or not visible to requester");
    }
    return message;
  }

  async readMessage(requesterId: string, ref: EntityRef): Promise<MeshChat> {
    if (ref.kind !== "message") throw new Error("Not a message reference");
    if (!this.hosted.has(requesterId)) throw new Error("Reader is not hosted here");
    const cached = this.repositories.meshChat.getById(ref.id);
    if (cached) {
      if (requesterId !== cached.senderId && requesterId !== cached.recipientId) {
        throw new Error("Cached message is not visible to requester");
      }
      return cached;
    }
    const message = await this.options.fetchMessage(requesterId, ref);
    if (
      message.id !== ref.id ||
      (requesterId !== message.senderId && requesterId !== message.recipientId)
    ) {
      throw new Error("Fetched message does not match authorized reference");
    }
    this.repositories.meshChat.record({
      ...message,
      responsive: message.responsive ?? undefined,
      responsiveReason: message.responsiveReason ?? undefined,
    });
    return message;
  }

  /** Stand-in for the existing local inbox MCP's select/mark_handled boundary. */
  select(actorId: string, entryIds: string[]): void {
    const runId = this.activeRuns.get(actorId);
    if (!runId) throw new Error("No active local run");
    this.mesh.selectInboxEntries(actorId, entryIds, () =>
      this.repositories.inboxFocus.recordSelection({
        actorId,
        runId,
        entryIds,
        primaryObligationId: null,
        resolution: "none",
      })
    );
  }

  markHandled(actorId: string, entryIds: string[]): void {
    const selected = this.mesh.selectedInboxEntries(actorId);
    if (entryIds.some((entryId) => !selected.includes(entryId)))
      throw new Error("Entry not selected");
    this.repositories.inbox.markHandled(actorId, entryIds, undefined, "Handled by prototype actor");
  }

  /** Local restart recovery reads local durable work, never a leader run table. */
  resume(): void {
    this.mesh.reconcileInbox();
  }

  snapshot() {
    return {
      instance: this.id,
      observedAt: new Date().toISOString(),
      quota: [...this.quota.values()],
      actors: [...this.hosted].map((actorId) => ({
        actorId,
        running: this.mesh.get(actorId)?.isRunning ?? false,
        queued: this.mesh.get(actorId)?.isQueued ?? false,
        unhandled: this.repositories.inbox.countUnhandled(actorId),
        recentRuns: this.repositories.actorRuns.listRecentCompleted(actorId, 10).map((run) => ({
          id: run.id,
          success: run.success,
          endedAt: run.endedAt,
        })),
      })),
    };
  }

  close(): void {
    this.mesh.shutdownAll();
  }
}
