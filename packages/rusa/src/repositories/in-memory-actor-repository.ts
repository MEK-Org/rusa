import type { ActorRecord } from "../actor/actor-record.js";
import type { ActorRepository } from "./actor-repository.js";

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

  patch(id: string, changes: Partial<Omit<ActorRecord, "id">>): void {
    const existing = this.records.get(id);
    if (existing) this.upsert({ ...existing, ...changes, id });
  }
}
