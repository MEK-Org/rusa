import type { ActorOptions, PromptBuild, RunAbandon } from "../../actor/actor.js";
import type { ActorRuntimeState } from "../../actor/actor-mesh.js";
import type { ActorRecord } from "../../actor/actor-record.js";
import type { ActorRunMode, RunNudge } from "../../actor/trigger-runner.js";
import type { RawProviderModelConfig } from "../../providers/model-config.js";
import type { CodingProvider, McpServerSpec, RunResult } from "../../providers/types.js";

// Commands/events multiplexed by actor ID over the authenticated instance connection.
export const INSTANCE_PROTOCOL_VERSION = 7;
export const COORDINATOR_RECONNECTED_ERROR = "Coordinator reconnected";
export const COORDINATOR_RECONNECTED_WITHOUT_ADMISSION_ERROR =
  "Coordinator reconnected without the queued admission";
/** The leader replaced a queued actor's pool; re-run the same admission against it. */
export const COORDINATOR_MODEL_CONFIG_CHANGED_ERROR = "Coordinator model configuration changed";
/** An operator interrupt or a provider halt cancelled the queued admission before it started. */
export const COORDINATOR_ADMISSION_CANCELLED_ERROR = "Coordinator cancelled the queued admission";
export interface Bootstrap {
  id: string;
  cwd: string;
  sessionId?: string;
  /** The actor's declared candidate pool. */
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
  options: Record<string, unknown>,
  /** The leader-admitted tuple that this adapter must execute. */
  selected?: RawProviderModelConfig
) => CodingProvider;

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
  /** Replace the follower Actor's next-run pool without resetting its runtime. */
  | { type: "modelConfig"; modelConfig: RawProviderModelConfig[] }
  | { type: "wake"; nudge?: RunNudge }
  /** Ask the follower to replace its current opportunity with responsive work. */
  | { type: "preempt"; requestId: number }
  /** Operator interrupt of the run the follower is executing. */
  | { type: "interrupt"; by: string }
  /**
   * The leader is cancelling this actor's unstarted admission. Sent before the
   * admission's error reply, so the follower's Actor keeps the opportunity for
   * `resumeCancelled` exactly as a local queued-start cancellation does.
   */
  | { type: "cancelQueued" }
  /** Replay a cancelled queued opportunity; `nudge` covers a follower that kept none. */
  | { type: "resumeCancelled"; nudge: RunNudge }
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
  | { type: "coalesced"; count: number; ageMs: number }
  | { type: "log"; chunk: string }
  | { type: "fatal"; error: string };

export type FollowerUpdateStatusPhase =
  | "pending"
  | "fetching"
  | "building"
  | "draining"
  | "restarting"
  | "failed"
  | "already_current";

export type FollowerUpdateStep = "pull" | "install" | "build" | "drain";

export interface FollowerUpdateStatus {
  updateId: string;
  status: FollowerUpdateStatusPhase;
  step?: FollowerUpdateStep;
  error?: string;
  oldSha?: string;
  newSha?: string;
  rollbackFailed?: boolean;
  timestamp: string;
}

export interface FollowerUpdateCommand {
  type: "update";
  updateId: string;
  targetSha?: string;
  branch?: string;
}

export interface FollowerUpdateStatusEvent {
  type: "update_status";
  updateId: string;
  status: FollowerUpdateStatusPhase;
  step?: FollowerUpdateStep;
  error?: string;
  oldSha?: string;
  newSha?: string;
  rollbackFailed?: boolean;
}
