import type { ProviderModelConfig } from "../providers/model-config.js";
import type { VoiceConfigDocument } from "../voice/voice-config.js";

export type ActorStatus = "active" | "retired";

export interface NativeContextConfig {
  type: "native";
}

export interface PortableContextConfig {
  type: "portable";
  mode: "tail" | "ledger";
  /** Gemini model used to compact ledger context; omitted to use the system default. */
  compactionModel?: string;
}

export type ContextConfig = NativeContextConfig | PortableContextConfig;

/** A capability to message another actor. The unguessable id is the capability. */
export interface ActorHandle {
  id: string;
  role?: string;
}

/** Actor identity and configuration; non-durable projection fields are marked explicitly below. */
export interface ActorRecord {
  id: string;
  charter: string;
  parentId: string | null;
  handles?: ActorHandle[];
  /**
   * Bounded, non-empty, validated pool of provider/model/effort candidates.
   * A durable snapshot for an explicitly declared tuple or pool; for a
   * class-bound actor ([modelClass] set) it is instead resolved from the
   * class's current definition on every read, and is unset when that class
   * cannot be resolved ([modelClassError]).
   */
  modelConfig?: ProviderModelConfig[];
  /**
   * The runtime model class this actor is bound to — its single durable source
   * of model selection truth. Nothing copies the class's entries onto the
   * actor: [modelConfig] above reads through to the class row, so a class edit
   * reaches the dashboard and the actor's next scheduled run without any
   * restart (#626). An already-launched run keeps the pool it launched on, in
   * its own run record.
   *
   * Omitted for an explicitly declared tuple or pool, which stays a durable
   * snapshot that class edits never touch — including records written before
   * class provenance was retained, whose original class cannot be truthfully
   * recovered from a historical resolved pool.
   */
  modelClass?: string;
  /**
   * Why [modelClass] could not be resolved on this read — missing, deleted,
   * empty or invalid. Set only for a class-bound actor, and then [modelConfig]
   * is deliberately left unset: a broken binding fails visibly at the dispatch
   * gate and on the dashboard rather than quietly running on a stale pool.
   * Derived per read, never stored on the actor row.
   */
  modelClassError?: string;
  /** Process-local staged full-pool replacement; deliberately not durable. */
  desiredModelConfig?: ProviderModelConfig[];
  /** Process-local provenance for [desiredModelConfig], cleared with that staged pool. */
  desiredModelClass?: string;
  sessionId?: string;
  context?: ContextConfig;
  title?: string;
  /** Compatibility view of root topology; repositories derive this from parentId. */
  isRoot?: boolean;
  status: ActorStatus;
  /** Derived from durable operator chat, never stored on the actor row. */
  humanUnlocked?: boolean;
  /** Derived from the latest durable operator chat, never stored on the actor row. */
  lastChatSessionId?: string;
  /** Initiating human operator/user principal of the latest chat session, never stored on the actor row. */
  lastChatPrincipalId?: string;
  createdAt: string;
  /** Registered follower ID where this actor is placed remotely; unset for leader-local execution. */
  executionTarget?: string;
  /** Per-actor walkie-talkie voice; absent follows the instance-wide default. */
  voiceConfig?: VoiceConfigDocument;
}
