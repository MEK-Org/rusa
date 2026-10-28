import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { Actor } from "../actor/actor.js";
import { ActorMesh } from "../actor/actor-mesh.js";
import type { ActorRecord } from "../actor/actor-record.js";
import { ComputerUseLock } from "../actor/computer-use-lock.js";
import { FailureEscalationBackoff, routeRunFailure } from "../actor/failure-sink.js";
import { assemblePortableContext, portableContextMaxRuns } from "../actor/portable-context.js";
import { ProviderPacer, submitPoolGate } from "../actor/provider-pacer.js";
import { projectActorRunLaunchConfig } from "../actor/run-accounting.js";
import { buildWorkerPrompt } from "../actor/worker-prompt.js";
import type { InstanceExecutionRepositories } from "../db/repositories/index.js";
import type { MeshChat } from "../db/repositories/mesh-chat-repository.js";
import { resolveMeshGitIdentity } from "../gitops/mesh-git-identity.js";
import type { McpHttpServer } from "../mcp/http-server.js";
import { createInboxMcpServer } from "../mcp/inbox-mcp.js";
import { createMeshChatMcpServer, MESH_CHAT_MCP_NAME } from "../mcp/mesh-chat-mcp.js";
import { toolError, toolOk } from "../mcp/result.js";
import { createMcpServer } from "../mcp/strict-server.js";
import type { Logger } from "../observability/logger.js";
import type { RawProviderModelConfig } from "../providers/model-config.js";
import type { CodingProvider } from "../providers/types.js";
import { ExecutionActorRepository } from "./execution-actor-repository.js";
import type { InstanceEntityRef, InstanceInboxEvent, QuotaObservation } from "./protocol.js";

/**
 * The ordinary local coordinator, now composed by follower startup too. Leader
 * connectivity is needed to change global authority or read an uncached entity,
 * never to admit a local run or finish its inbox/recovery accounting.
 */
export class ExecutionInstance {
  readonly mesh: ActorMesh;
  readonly repositories: InstanceExecutionRepositories;
  private readonly activeRuns = new Map<string, string>();
  private readonly pacers = new Map<string, ProviderPacer>();
  private readonly quota = new Map<string, QuotaObservation>();
  private readonly locks = new ComputerUseLock();
  private draining = false;
  private readonly failures = new FailureEscalationBackoff();

  constructor(
    readonly id: string,
    repositories: InstanceExecutionRepositories,
    private readonly options: {
      home: string;
      sandbox: boolean;
      logger: Logger;
      mcp: McpHttpServer;
      provider: (actorId: string, selected: RawProviderModelConfig) => CodingProvider;
      publish: (fromId: string, event: InstanceInboxEvent) => void;
      fetchMessage: (requesterId: string, ref: InstanceEntityRef) => Promise<MeshChat>;
      maxConcurrent?: number;
      gitIdentity?: unknown;
    }
  ) {
    this.repositories = {
      ...repositories,
      actors: new ExecutionActorRepository(repositories.actors, repositories.referenceCache),
    };
    const repos = this.repositories;
    this.mesh = new ActorMesh({
      actors: repos.actors,
      inboxStore: repos.inbox,
      maxConcurrent: options.maxConcurrent,
      completedFocusEntryCounts: (actorId, excludeRunId) =>
        repos.actorRuns.completedFocusEntryCounts(actorId, excludeRunId),
      providerGate: (run, candidates, admission) =>
        submitPoolGate(
          run,
          candidates.map((config) => ({
            config,
            lane: config.provider,
            pacer: this.pacer(config.provider, config.model),
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
      log: (message) => options.logger.debug("instance_mesh", { instance: id, message }),
      onLifecycleError: (failure) =>
        options.logger.error("instance_lifecycle_error", { err: failure.error }),
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
          onEnd: async (event) => {
            this.activeRuns.delete(event.actorId);
            if (event.terminal.kind === "abandoned") {
              if (event.terminal.started)
                repos.actorRuns.abandon(event.runId, event.terminal.reason);
              return;
            }
            const result = event.terminal.result;
            repos.actorRuns.complete(event.runId, result);
            // Ordinary local failure policy stores a message and pushes its small
            // inbox event. Successful return sends no mandatory leader message.
            await routeRunFailure(
              {
                actors: repos.actors,
                rootId: undefined,
                postToErrorChat: null,
                escalation: this.failures,
                log: (message) => options.logger.warn("instance_run_failure", { message }),
                sendToParent: (to, body, from, _forensics, delivery) => {
                  this.sendMessage(from, to, body, delivery?.responsive);
                },
              },
              event.actorId,
              result,
              undefined,
              event.runId
            );
          },
        },
      ],
      createActor: (context) => {
        const record = context.record;
        const cwd = join(options.home, "workers", record.id);
        mkdirSync(cwd, { recursive: true });
        const inboxUrl = options.mcp.addServer(`${record.id}:inbox`, () =>
          createInboxMcpServer(repos.inbox, record.id, {
            select: (ids, obligationId) => {
              // Global obligation resolution has not moved with the worklist.
              if (obligationId)
                throw new Error("Global obligation focus is not integrated in this draft");
              return this.select(record.id, ids);
            },
            selected: () => this.mesh.selectedInboxEntries(record.id),
            onHandled: () => this.mesh.inboxHandled(record.id),
            assertHandleable: (ids) => this.mesh.assertInboxEntriesHandleable(record.id, ids),
          })
        );
        const entitiesUrl = options.mcp.addServer(`${record.id}:mesh`, () =>
          this.messageMcp(record.id)
        );
        const readUrl = options.mcp.addServer(`${record.id}:${MESH_CHAT_MCP_NAME}`, () =>
          createMeshChatMcpServer(
            {
              getById: (id) => repos.meshChat.getById(id),
              listForActor: (id, opts) => repos.meshChat.listForActor(id, opts),
              readRemote: (ref) => this.readMessage(record.id, ref),
            },
            record.id
          )
        );
        let actor: Actor;
        actor = new Actor({
          id: record.id,
          cwd,
          sandbox: options.sandbox && !record.executionConfig?.unsandboxed,
          modelConfig: record.modelConfig ?? [],
          resolveProvider: (selected) => options.provider(record.id, selected),
          mcpServers: [
            { name: "inbox", url: inboxUrl },
            { name: "mesh", url: entitiesUrl },
            { name: MESH_CHAT_MCP_NAME, url: readUrl },
          ],
          debounceMs: 10,
          loadSessionId: () =>
            repos.actors.get(record.id)?.context?.type === "portable"
              ? undefined
              : repos.actors.get(record.id)?.sessionId,
          saveSessionId: (sessionId) => {
            if (repos.actors.get(record.id)?.context?.type !== "portable")
              repos.actors.patch(record.id, { sessionId });
          },
          buildPrompt: () => {
            const current = repos.actors.get(record.id);
            if (!current) throw new Error("Installed actor is missing");
            const history =
              current.context?.type === "portable"
                ? assemblePortableContext(
                    repos.actorRuns
                      .listRecentCompleted(record.id, portableContextMaxRuns())
                      .map((run) => ({
                        id: run.id,
                        ts: run.endedAt ?? run.startedAt,
                        body: run.output,
                      }))
                  )
                : null;
            return {
              prompt: buildWorkerPrompt(
                current.charter,
                {
                  threadId: current.id,
                  parentId: current.parentId,
                  handles: (current.handles ?? []).map((h) => ({
                    id: h.id,
                    label: repos.actors.get(h.id)?.title ?? h.id,
                  })),
                  understandingMountEnabled: false,
                  gitIdentity: resolveMeshGitIdentity(options.gitIdentity),
                },
                history?.section
              ),
              injectRecord: history?.record,
            };
          },
          // No computer-use grant is installed in this prototype. The shared
          // lock remains host-local when control snapshots grow that capability.
          gate: (fn, candidates, responsive) =>
            this.locks.gateAfterProvider(
              record.id,
              responsive,
              (start) => context.gate(start, candidates, responsive),
              fn,
              () => false,
              () => actor.preemptForResponsive(),
              () => actor.requestRun()
            ),
          beforeRun: context.beforeRun,
          admitRun: context.admitRun,
          lifecycle: context.lifecycle,
          onQueuedRunCancelled: context.onQueuedRunCancelled,
          onRuntimeStateChanged: context.onRuntimeStateChanged,
          log: (chunk) =>
            options.logger.debug("instance_provider_output", { actorId: record.id, chunk }),
        });
        return actor;
      },
    });
  }

  /** Installed snapshots are not a global actor/grant mutation surface. */
  install(record: ActorRecord): void {
    if (record.executionConfig?.executionTarget !== this.id)
      throw new Error("Wrong execution owner");
    if (!record.modelConfig?.length)
      throw new Error("An installed actor needs a resolved model pool");
    if (this.draining) return;
    const prior = this.repositories.actors.get(record.id);
    this.repositories.actors.upsert({
      ...record,
      // Preserve this execution owner's provider session across reconnects.
      sessionId: prior?.sessionId ?? record.sessionId,
      modelClass: undefined,
      modelClassError: undefined,
      executionConfig: { unsandboxed: record.executionConfig.unsandboxed },
    });
    this.repositories.actors.setModelSelection(record.id, {
      modelConfig: record.modelConfig,
      modelClass: undefined,
      desiredModelConfig: record.desiredModelConfig,
      desiredModelClass: undefined,
    });
    const installed = this.repositories.actors.get(record.id);
    if (!installed) throw new Error("Installed actor is missing");
    if (!this.mesh.get(record.id)) this.mesh.rehydrate(installed);
    else this.mesh.get(record.id)?.setModelConfig?.(record.modelConfig);
    this.mesh.dispatch(record.id);
  }

  /** Boot may resume installed work before the leader is reachable. */
  resume(): void {
    for (const record of this.repositories.actors.list()) {
      if (record.status === "active" && !this.mesh.get(record.id)) this.mesh.rehydrate(record);
    }
    this.mesh.reconcileInbox();
  }

  observeQuota(observation: QuotaObservation): void {
    this.pacer(observation.provider, observation.model).setInterval(observation.intervalMs);
    this.quota.set(`${observation.provider}:${observation.model ?? ""}`, observation);
  }
  private pacer(provider: string, model?: string): ProviderPacer {
    const key = `${provider}:${model ?? ""}`;
    let pacer = this.pacers.get(key);
    if (!pacer) {
      pacer = new ProviderPacer();
      this.pacers.set(key, pacer);
    }
    return pacer;
  }

  receive(event: InstanceInboxEvent): void {
    if (!this.repositories.actors.get(event.actorId))
      throw new Error("Recipient is not installed here");
    this.repositories.inbox.append([{ ...event, deliveredAt: new Date(event.deliveredAt) }]);
  }

  sendMessage(
    senderId: string,
    recipientId: string,
    body: string,
    responsive = false
  ): InstanceEntityRef {
    const sender = this.repositories.actors.get(senderId);
    if (
      !sender ||
      (sender.parentId !== recipientId && !sender.handles?.some((h) => h.id === recipientId))
    ) {
      throw new Error("Sender has no recipient handle");
    }
    const messageId = this.repositories.meshChat.record({
      senderId,
      recipientId,
      body,
      responsive,
    });
    const entity: InstanceEntityRef = { instance: this.id, kind: "message", id: messageId };
    const event: InstanceInboxEvent = {
      id: randomUUID(),
      actorId: recipientId,
      source: `mesh:${senderId}`,
      deliveredAt: new Date().toISOString(),
      payload: {
        type: "mesh.message",
        messageId,
        fromId: senderId,
        entity,
        deliveryRole: "owner",
        ...(responsive ? { priority: "responsive" } : {}),
      },
    };
    if (this.repositories.actors.get(recipientId)?.status === "active") this.receive(event);
    else this.options.publish(senderId, event);
    return entity;
  }

  serveMessage(requesterId: string, ref: InstanceEntityRef): MeshChat {
    if (ref.instance !== this.id || ref.kind !== "message") throw new Error("Wrong entity owner");
    const message = this.repositories.meshChat.getById(ref.id);
    if (!message || (requesterId !== message.senderId && requesterId !== message.recipientId))
      throw new Error("Message is absent or not visible");
    return message;
  }

  async readMessage(requesterId: string, ref: InstanceEntityRef): Promise<MeshChat> {
    if (!this.repositories.actors.get(requesterId)) throw new Error("Reader is not installed here");
    if (ref.instance === this.id) return this.serveMessage(requesterId, ref);
    const key = `mesh:instances/${ref.instance}/messages/${ref.id}`;
    const cached = this.repositories.referenceCache.get(key);
    const message: MeshChat = cached
      ? JSON.parse(cached.entity_json)
      : await this.options.fetchMessage(requesterId, ref);
    if (
      ref.kind !== "message" ||
      message.id !== ref.id ||
      (requesterId !== message.senderId && requesterId !== message.recipientId)
    )
      throw new Error("Message does not match authorized reference");
    if (!cached)
      this.repositories.referenceCache.set({
        ref: key,
        document_version: 1,
        entity_json: JSON.stringify(message),
        fetched_at: new Date().toISOString(),
        refresh_after: new Date().toISOString(),
      });
    return message;
  }

  select(actorId: string, entryIds: string[]) {
    const runId = this.activeRuns.get(actorId);
    if (!runId) throw new Error("No active local run");
    return this.mesh.selectInboxEntries(actorId, entryIds, () =>
      this.repositories.inboxFocus.recordSelection({
        actorId,
        runId,
        entryIds,
        primaryObligationId: null,
        resolution: "none",
      })
    );
  }

  private messageMcp(actorId: string) {
    const server = createMcpServer({ name: "mesh", version: "0.1.0" });
    server.registerTool(
      "send_message",
      {
        description: "Store a message here, then deliver a small event to its recipient.",
        inputSchema: { thread_id: z.string(), body: z.string() },
      },
      async ({ thread_id, body }) => {
        try {
          return toolOk(this.sendMessage(actorId, thread_id, body));
        } catch (err) {
          return toolError(err);
        }
      }
    );
    return server;
  }

  beginDrain(): void {
    this.draining = true;
    this.mesh.shutdownAll();
  }
  get activeActorIds(): string[] {
    return [...this.activeRuns.keys()];
  }
  snapshot(actorId: string) {
    const actor = this.mesh.get(actorId);
    return {
      observedAt: new Date().toISOString(),
      state: actor?.isRunning
        ? ("running" as const)
        : actor?.isQueued
          ? ("queued" as const)
          : ("idle" as const),
    };
  }
  close(): void {
    this.locks.close();
    this.mesh.shutdownAll();
  }
}
