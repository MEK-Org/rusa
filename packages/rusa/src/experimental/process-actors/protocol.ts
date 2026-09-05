import type { ActorOptions, PromptBuild, RunAbandon } from "../../actor/actor.js";
import type { ActorRuntimeState } from "../../actor/actor-mesh.js";
import type { ActorRecord } from "../../actor/actor-record.js";
import type { ActorRunMode, RunNudge } from "../../actor/trigger-runner.js";
import type { CodingProvider, McpServerSpec, RunResult } from "../../providers/types.js";

// Local, trusted Node IPC only. These are data boundaries, not a network API.
export interface Bootstrap {
  id: string;
  cwd: string;
  providerModule: string;
  sessionId?: string;
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
  | { op: "admit"; provider: string; responsive: boolean }
  | { op: "sendMessage"; to: string; body: string };

export type ParentMessage =
  | { type: "init"; bootstrap: Bootstrap }
  | { type: "wake"; nudge?: RunNudge }
  | { type: "yield"; status?: string; note?: string }
  | { type: "unkillable" }
  | { type: "stop" }
  | { type: "reply"; requestId: number; value?: unknown; error?: string };

export type ChildMessage =
  | { type: "ready"; pid: number }
  | { type: "request"; requestId: number; request: Request }
  | { type: "release"; requestId: number }
  | { type: "state"; state: ActorRuntimeState; yielded: boolean }
  | { type: "session"; sessionId: string }
  | { type: "queued"; responsive: boolean; mode: ActorRunMode }
  | { type: "result"; result: RunResult }
  | { type: "runStart"; responsive: boolean; injectRecord?: PromptBuild["injectRecord"] }
  | { type: "firstChunk" }
  | { type: "abandoned"; abandon: RunAbandon }
  | { type: "continue"; count: number }
  | { type: "capped"; count: number }
  | { type: "coalesced"; count: number; ageMs: number }
  | { type: "log"; chunk: string }
  | { type: "fatal"; error: string };
