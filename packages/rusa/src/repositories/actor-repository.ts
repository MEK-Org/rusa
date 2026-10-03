import type { ActorRecord, HumanChat } from "../actor/actor-record.js";

/**
 * The fields an explicit model-configuration change may set: the selection
 * itself plus the staged overlay it consumes.
 */
export type ModelSelectionChange = Partial<
  Pick<ActorRecord, "modelConfig" | "modelClass" | "desiredModelConfig" | "desiredModelClass">
>;

/** Incidental updates cannot alter the durable model-selection document. */
export type ActorRecordPatch = Partial<
  Omit<ActorRecord, "id" | "modelConfig" | "modelClass" | "modelClassError">
>;

/** Persistence boundary for actor records. */
export interface ActorRepository {
  upsert(record: ActorRecord): void;
  get(id: string): ActorRecord | undefined;
  list(): ActorRecord[];
  children(parentId: string): ActorRecord[];
  patch(id: string, changes: ActorRecordPatch): void;
  /**
   * Persist an explicit model-configuration change — a class selection, a
   * `set_actor_model` replacement, or the rebind that applies one.
   *
   * Separate from {@link patch} because it is the only write permitted to
   * restate an existing row's stored model-config document in the current
   * shape. An incidental write (a session id, a title) must leave whatever
   * document the row already holds exactly as it found it (#626).
   */
  setModelSelection(id: string, changes: ModelSelectionChange): void;
  /**
   * Return the parent thread ID for an actor, null if root, or undefined if unknown.
   * Efficient path for tree and ancestry traversal without loading full records or chat history.
   */
  parentOf(id: string): string | null | undefined;
  /**
   * The newest human chat addressed to an actor, or undefined if no human has
   * messaged it. Kept off {@link get} and the other record reads because only
   * the reply tool needs it and SQLite answers it from `mesh_chat` (#691).
   */
  lastHumanChat(id: string): HumanChat | undefined;
  /**
   * Note a human message just delivered to an actor. Repositories that derive
   * {@link lastHumanChat} from durable chat ignore it; the in-memory adapter has
   * no chat table and keeps it here.
   */
  noteHumanChat(id: string, chat: HumanChat): void;
}
