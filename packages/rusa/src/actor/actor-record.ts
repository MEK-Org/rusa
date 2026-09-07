import type { ProviderModelConfig } from "../providers/model-config.js";

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
  /** Bounded, non-empty, validated pool of provider/model/effort candidates. */
  modelConfig?: ProviderModelConfig[];
  /**
   * Named runtime model class that produced [modelConfig]'s resolved snapshot.
   * Omitted for an explicitly declared tuple or pool, including records written
   * before class provenance was retained. The original class cannot be
   * truthfully recovered from a historical resolved pool, so those records
   * remain on the explicit-pool dashboard fallback until reconfigured.
   */
  modelClass?: string;
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
  createdAt: string;
}
