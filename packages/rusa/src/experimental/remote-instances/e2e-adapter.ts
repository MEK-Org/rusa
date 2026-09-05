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
    const name = record.provider ?? config.rootActor?.provider ?? "antigravity";
    const target = context.executionTarget;
    if (!target) return new Actor(options);
    const host = hub.createHost(target, record.id);
    const toolUrls = () => hub.toolUrls(target, record.id, options.mcpServers);
    const runtime = new ActorHandle({
      host,
      bootstrap: {
        id: record.id,
        cwd: options.cwd,
        sessionId: options.loadSessionId(),
        providerOptions: {
          providers: { [name]: config.providers[name] },
          name,
          model: record.model,
          effort: record.effort,
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
      onFailure: (error) => {
        options.log?.(`[remote-instance] ${error.message}\n`);
        void options.onRunEnd?.({ success: false, output: error.message, exitCode: -1 });
      },
    });
    return runtime;
  };
}
