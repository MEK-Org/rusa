import type { ActorRecord } from "../actor/actor-record.js";
import type {
  ActorRecordPatch,
  ActorRepository,
  ModelSelectionChange,
} from "./actor-repository.js";

/** Lightweight repository adapter for isolated tests and embedders without SQLite. */
export class InMemoryActorRepository implements ActorRepository {
  private readonly records = new Map<string, ActorRecord>();

  upsert(record: ActorRecord): void {
    this.records.set(record.id, structuredClone(record));
  }

  get(id: string): ActorRecord | undefined {
    const record = this.records.get(id);
    return record ? structuredClone(record) : undefined;
  }

  list(): ActorRecord[] {
    return [...this.records.values()].map((record) => structuredClone(record));
  }

  children(parentId: string): ActorRecord[] {
    return this.list().filter((record) => record.parentId === parentId);
  }

  parentOf(id: string): string | null | undefined {
    return this.records.get(id)?.parentId;
  }

  patch(id: string, changes: ActorRecordPatch): void {
    const existing = this.records.get(id);
    if (existing) this.upsert({ ...existing, ...changes, id });
  }

  /**
   * Records here are held as objects, not as a persisted document, so there is
   * no stored encoding for an explicit model-configuration change to restate.
   */
  setModelSelection(id: string, changes: ModelSelectionChange): void {
    const existing = this.records.get(id);
    if (!existing)
      throw new Error(
        `InMemoryActorRepository: cannot set model selection on unknown actor '${id}'`
      );
    // `modelClassError` is a read-time projection in SQLite, never durable.
    // Mirror that fresh read when a test adapter applies a selection.
    const { modelClassError: _discardedProjection, ...stored } = existing;
    this.upsert({ ...stored, ...changes, id });
  }
}
