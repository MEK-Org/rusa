import type { ActorRecord } from "../actor/actor-record.js";

/**
 * The fields an explicit model-configuration change may set: the selection
 * itself plus the staged selection it consumes.
 */
export type ModelSelectionChange = Partial<
  Pick<ActorRecord, "modelConfig" | "modelClass" | "desiredModelConfig" | "desiredModelClass">
>;

/** The fields a context-configuration change may set when applying staged selections. */
export type ContextSelectionChange = Partial<
  Pick<ActorRecord, "context" | "desiredContextConfig" | "sessionId">
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
   * Persist combined model and context changes in a single atomic transaction.
   * Restates the stored model-config document when model changes are included.
   * Used at run boundaries to atomically apply and clear staged model and
   * context selections.
   */
  applyPendingSelections(
    id: string,
    changes: {
      model?: ModelSelectionChange;
      context?: ContextSelectionChange;
    }
  ): void;
  /**
   * Return the parent thread ID for an actor, null if root, or undefined if unknown.
   * Efficient path for tree and ancestry traversal without loading full records or chat history.
   */
  parentOf(id: string): string | null | undefined;
}
