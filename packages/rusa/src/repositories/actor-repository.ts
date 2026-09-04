import type { ActorRecord } from "../actor/actor-record.js";

/** Persistence boundary for actor records. */
export interface ActorRepository {
  upsert(record: ActorRecord): void;
  get(id: string): ActorRecord | undefined;
  list(): ActorRecord[];
  children(parentId: string): ActorRecord[];
  patch(id: string, changes: Partial<Omit<ActorRecord, "id">>): void;
}
