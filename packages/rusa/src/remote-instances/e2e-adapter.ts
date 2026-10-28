import { Actor } from "../actor/actor.js";
import type { RunStartE2EHooks } from "../commands/start.js";
import type { RusaConfig } from "../config/types.js";
import type { Logger } from "../observability/logger.js";
import type { InboxRepository } from "../repositories/inbox-repository.js";
import { ActorHandle } from "./actor-handle.js";
import { ActorProjection } from "./actor-projection.js";
import type { FollowerHub } from "./follower-hub.js";
import type { QuotaObservation } from "./protocol.js";

export function instanceWorkerFactory(
  config: RusaConfig,
  hub: FollowerHub,
  opts?: {
    logger?: Logger;
    inbox?: InboxRepository;
    leaderInstanceId?: string;
    quota?: (record: import("../actor/actor-record.js").ActorRecord) => QuotaObservation[];
  }
): NonNullable<RunStartE2EHooks["createWorkerActor"]> {
  return (context, options) => {
    const record = context.record;
    const target = context.executionTarget;
    // Only an omitted target means "run here". A defined-but-unusable one falls
    // through to the hub, which refuses it by name.
    if (target === undefined) return new Actor(options);
    // The follower receives the whole pool, and the leader's provider gate
    // chooses one candidate per run and carries that tuple in the admission
    // (#608). The follower fills a tuple's unset fields from providerOptions,
    // so they carry no model or effort: the first candidate's would otherwise
    // leak into every other candidate's provider.
    const name = options.modelConfig[0]?.provider ?? config.rootActor?.provider ?? "antigravity";
    const host = hub.createHost(target, record.id);
    if (hub.ownsExecution(target)) {
      if (!opts?.inbox || !opts.leaderInstanceId || !opts.quota)
        throw new Error("Instance execution handoff is not composed");
      return new ActorProjection({
        host,
        record: () => context.getRecord() ?? record,
        inbox: opts.inbox,
        quota: opts.quota,
        leaderInstanceId: opts.leaderInstanceId,
        onState: context.onRuntimeStateChanged,
      });
    }
    const toolUrls = () => hub.toolUrls(target, record.id, options.mcpServers);
    const runtime = new ActorHandle({
      host,
      bootstrap: {
        id: record.id,
        cwd: options.cwd,
        sessionId: options.loadSessionId(),
        modelConfig: [...options.modelConfig],
        providerOptions: {
          // Provider definitions contain only adapter metadata. The follower
          // selects this map at the next-run boundary, including a valid
          // cross-provider staged pin, without reading leader configuration.
          providers: config.providers,
          name,
        },
        mcpServers: toolUrls(),
        actorOptions: {
          sandbox: options.sandbox,
          addDirs: options.addDirs,
          timeoutMs: options.timeoutMs,
          debounceMs: options.debounceMs,
        },
        // A follower may still retain its runtime when this leader handle was
        // rehydrated without a provider session. The follower treats this only
        // as permission to adopt an existing runtime; it still constructs one
        // when none exists.
        reconnect: true,
      },
      context,
      actorOptions: options,
      snapshot: () => {
        const current = context.getRecord();
        if (!current) throw new Error("Actor record is missing");
        return {
          record: current,
          prompt: "",
          promptBuild: options.buildPrompt(),
          mcpServers: toolUrls(),
        };
      },
      saveSession: options.saveSessionId,
      onEvent: (event) => {
        if (event.type === "ready") {
          options.log?.(
            `[remote-instance] coordinator=${process.pid} follower=${target} pid=${event.pid}\n`
          );
        }
      },
      // Report the connection failure only. `ActorHandle` decides whether an
      // admitted run needs terminating; synthesizing one here would book a
      // failed run for an actor that was merely idle when its follower dropped.
      onFailure: (error) => {
        options.log?.(`[remote-instance] ${error.message}\n`);
      },
      logger: opts?.logger,
      target,
    });
    return runtime;
  };
}
