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
  provider?: string;
  model?: string;
  effort?: string;
  /** Process-local staged model changes; deliberately not durable. */
  desiredModel?: string;
  desiredEffort?: string | null;
  desiredProvider?: string;
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
