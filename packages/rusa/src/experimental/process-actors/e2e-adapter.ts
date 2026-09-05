import type { RunStartE2EHooks } from "../../commands/start.js";
import type { RusaConfig } from "../../config/types.js";
import type { FollowerHub } from "./follower-hub.js";
import { ProcessActor } from "./process-actor.js";

export function processWorkerFactory(
  config: RusaConfig,
  paths: { childEntry: URL; providerModule: URL },
  hub?: FollowerHub
): NonNullable<RunStartE2EHooks["createWorkerActor"]> {
  return (context, options) => {
    const record = context.record;
    const name = record.provider ?? config.rootActor?.provider ?? "antigravity";
    const target = context.executionTarget;
    if (target && !hub) throw new Error("Follower gateway is not enabled");
    const host = target ? hub?.createHost(target, record.id) : undefined;
    const toolUrls = () =>
      target && hub ? hub.toolUrls(target, record.id, options.mcpServers) : options.mcpServers;
    const runtime = new ProcessActor({
      host,
      childEntry: paths.childEntry,
      bootstrap: {
        id: record.id,
        cwd: options.cwd,
        sessionId: options.loadSessionId(),
        providerModule: paths.providerModule.href,
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
          options.log?.(`[process-actor] coordinator=${process.pid} actor=${event.pid}\n`);
        }
      },
      onFailure: (error) => {
        options.log?.(`[process-actor] ${error.message}\n`);
        void options.onRunEnd?.({ success: false, output: error.message, exitCode: -1 });
      },
    });
    return runtime;
  };
}
