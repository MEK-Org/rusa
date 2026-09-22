import type { ActorOptions, PromptBuild, RunAbandon } from "../../actor/actor.js";
import type { ActorRuntimeState } from "../../actor/actor-mesh.js";
import type { ActorRecord } from "../../actor/actor-record.js";
import type { ActorRunMode, RunNudge } from "../../actor/trigger-runner.js";
import type { RawProviderModelConfig } from "../../providers/model-config.js";
import type { CodingProvider, McpServerSpec, RunResult } from "../../providers/types.js";

// Commands/events multiplexed by actor ID over the authenticated instance connection.
export const INSTANCE_PROTOCOL_VERSION = 4;
export const COORDINATOR_RECONNECTED_ERROR = "Coordinator reconnected";
export const COORDINATOR_RECONNECTED_WITHOUT_ADMISSION_ERROR =
  "Coordinator reconnected without the queued admission";
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
  /** True when reconnecting to an existing actor runtime (avoids duplicate host error). */
  reconnect?: boolean;
  /**
   * True when the leader kept an unstarted admission for this actor across the
   * transport loss. The follower answers by re-announcing that one pending
   * request; every other pending call is still rejected on reconnect.
   */
  resumeAdmission?: boolean;
}

export interface RunSnapshot {
  record: ActorRecord;
  prompt: string;
  promptBuild?: PromptBuild;
  mcpServers?: McpServerSpec[];
  /** The candidate the leader's pacing gate reserved for this run. */
  selected?: RawProviderModelConfig;
  /**
   * True when the leader admitted this run at responsive priority. A promotion
   * decided on the leader is only reliably visible to the follower here; the
   * responsive wake behind it can lose the race with this reply on the wire.
   */
  responsive?: boolean;
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
  | {
      op: "admit";
      candidates: RawProviderModelConfig[];
      responsive: boolean;
      /** The final admission check must distinguish ordinary work from session work. */
      mode: ActorRunMode;
      /**
       * True when this is the follower re-announcing an admission the leader
       * retained, under the request id the leader's gate still answers on.
       */
      resume?: boolean;
    }
  | { op: "sendMessage"; to: string; body: string };

export type LeaderCommand =
  | { type: "init"; bootstrap: Bootstrap }
  | { type: "wake"; nudge?: RunNudge }
  /** Ask the follower to replace its current opportunity with responsive work. */
  | { type: "preempt"; requestId: number }
  | { type: "yield"; status?: string; note?: string }
  | { type: "unkillable" }
  | { type: "stop" }
  | { type: "reply"; requestId: number; value?: unknown; error?: string };

export type ActorEvent =
  | { type: "ready"; pid: number }
  /** The follower's observed outcome of a leader preemption request. */
  | {
      type: "preempted";
      requestId: number;
      preempted: boolean;
      phase?: "running" | "winding_down" | "queued";
    }
  | { type: "request"; requestId: number; request: Request }
  | { type: "release"; requestId: number }
  | { type: "state"; state: ActorRuntimeState; yielded: boolean }
  | { type: "session"; sessionId: string }
  | { type: "queued"; responsive: boolean; mode: ActorRunMode; runId?: string }
  | { type: "error"; error: string }
  | { type: "result"; result: RunResult }
  | {
      type: "runStart";
      responsive: boolean;
      injectRecord?: PromptBuild["injectRecord"];
      /** The candidate this run actually launched on, for leader-side accounting. */
      selected: RawProviderModelConfig;
      runId?: string;
    }
  | { type: "firstChunk" }
  | { type: "abandoned"; abandon: RunAbandon }
  | { type: "continue"; count: number }
  | { type: "capped"; count: number }
  | { type: "coalesced"; count: number; ageMs: number }
  | { type: "log"; chunk: string }
  | { type: "fatal"; error: string };
