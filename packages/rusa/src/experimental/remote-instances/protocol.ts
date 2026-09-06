import type { ActorOptions, PromptBuild, RunAbandon } from "../../actor/actor.js";
import type { ActorRuntimeState } from "../../actor/actor-mesh.js";
import type { ActorRecord } from "../../actor/actor-record.js";
import type { ActorRunMode, RunNudge } from "../../actor/trigger-runner.js";
import type { RawProviderModelConfig } from "../../providers/model-config.js";
import type { CodingProvider, McpServerSpec, RunResult } from "../../providers/types.js";

// Commands/events multiplexed by actor ID over the authenticated instance connection.
export const INSTANCE_PROTOCOL_VERSION = 2;
export interface Bootstrap {
  id: string;
  cwd: string;
  sessionId?: string;
  /**
   * The actor's declared candidate pool. Remote placement carries a single
   * candidate today: the follower builds one provider from `providerOptions`,
   * so a longer pool has nothing to resolve a second candidate with.
   */
  modelConfig?: RawProviderModelConfig[];
  providerOptions?: Record<string, unknown>;
  mcpServers?: McpServerSpec[];
  actorOptions?: Pick<
    ActorOptions,
    "sandbox" | "addDirs" | "timeoutMs" | "yieldGraceMs" | "debounceMs"
  >;
}

export interface RunSnapshot {
  record: ActorRecord;
  prompt: string;
  promptBuild?: PromptBuild;
  mcpServers?: McpServerSpec[];
  /** The candidate the leader's pacing gate reserved for this run. */
  selected?: RawProviderModelConfig;
}

export interface ProviderBridge {
  sendMessage(to: string, body: string): Promise<unknown>;
  yieldRun(status?: string, note?: string): void;
}

export type ProviderFactory = (
  bridge: ProviderBridge,
  options: Record<string, unknown>
) => CodingProvider | Promise<CodingProvider>;

export type Request =
  | { op: "beforeRun"; mode: ActorRunMode }
  | { op: "prepareMount" }
  | { op: "complete"; result: RunResult }
  | { op: "admit"; candidates: RawProviderModelConfig[]; responsive: boolean }
  | { op: "sendMessage"; to: string; body: string };

export type LeaderCommand =
  | { type: "init"; bootstrap: Bootstrap }
  | { type: "wake"; nudge?: RunNudge }
  | { type: "yield"; status?: string; note?: string }
  | { type: "unkillable" }
  | { type: "stop" }
  | { type: "reply"; requestId: number; value?: unknown; error?: string };

export type ActorEvent =
  | { type: "ready"; pid: number }
  | { type: "request"; requestId: number; request: Request }
  | { type: "release"; requestId: number }
  | { type: "state"; state: ActorRuntimeState; yielded: boolean }
  | { type: "session"; sessionId: string }
  | { type: "queued"; responsive: boolean; mode: ActorRunMode }
  | { type: "result"; result: RunResult }
  | {
      type: "runStart";
      responsive: boolean;
      injectRecord?: PromptBuild["injectRecord"];
      /** The candidate this run actually launched on, for leader-side accounting. */
      selected: RawProviderModelConfig;
    }
  | { type: "firstChunk" }
  | { type: "abandoned"; abandon: RunAbandon }
  | { type: "continue"; count: number }
  | { type: "capped"; count: number }
  | { type: "coalesced"; count: number; ageMs: number }
  | { type: "log"; chunk: string }
  | { type: "fatal"; error: string };
