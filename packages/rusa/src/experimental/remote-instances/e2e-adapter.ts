import { Actor } from "../../actor/actor.js";
import type { RunStartE2EHooks } from "../../commands/start.js";
import type { RusaConfig } from "../../config/types.js";
import { ActorHandle } from "./actor-handle.js";
import type { FollowerHub } from "./follower-hub.js";

export function instanceWorkerFactory(
  config: RusaConfig,
  hub: FollowerHub
): NonNullable<RunStartE2EHooks["createWorkerActor"]> {
  return (context, options) => {
    const record = context.record;
    const target = context.executionTarget;
    // Only an omitted target means "run here". A defined-but-unusable one falls
    // through to the hub, which refuses it by name.
    if (target === undefined) return new Actor(options);
    // The follower constructs exactly one provider from the bootstrap, so a
    // multi-candidate pool has no honest remote meaning yet. Refuse it rather
    // than silently running whichever candidate happens to be first.
    if (options.modelConfig.length > 1) {
      throw new Error(
        `actor ${record.id} declares ${options.modelConfig.length} candidates; remote placement supports a single declared provider/model`
      );
    }
    const declared = options.modelConfig[0];
    const name = declared?.provider ?? config.rootActor?.provider ?? "antigravity";
    const host = hub.createHost(target, record.id);
    const toolUrls = () => hub.toolUrls(target, record.id, options.mcpServers);
    const runtime = new ActorHandle({
      host,
      bootstrap: {
        id: record.id,
        cwd: options.cwd,
        sessionId: options.loadSessionId(),
        modelConfig: [...options.modelConfig],
        providerOptions: {
          providers: { [name]: config.providers[name] },
          name,
          model: declared?.model,
          effort: declared?.effort,
        },
        mcpServers: toolUrls(),
        actorOptions: {
          sandbox: options.sandbox,
          addDirs: options.addDirs,
          timeoutMs: options.timeoutMs,
          yieldGraceMs: options.yieldGraceMs,
          debounceMs: options.debounceMs,
        },
      },
      context: {
        ...context,
        onQueued: (queued) => options.onQueued?.(queued),
        onRunEnd: (result) => options.onRunEnd?.(result),
      },
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
    });
    return runtime;
  };
}
