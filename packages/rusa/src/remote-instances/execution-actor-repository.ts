import type { ActorRecord } from "../actor/actor-record.js";
import type { ReferenceCacheRepository } from "../db/repositories/reference-cache-repository.js";
import type {
  ActorRecordPatch,
  ActorRepository,
  ContextSelectionChange,
  ModelSelectionChange,
} from "../repositories/actor-repository.js";

/**
 * Keep installed address-book metadata without copying the global actor tree.
 * The existing actors table has local foreign keys for parent/handle targets;
 * this draft stores those foreign references in the existing entity cache and
 * keeps only hosted identities in actors. No peer is invented as a local actor.
 */
export class ExecutionActorRepository implements ActorRepository {
  constructor(
    private readonly local: ActorRepository,
    private readonly cache: ReferenceCacheRepository
  ) {}
  private key(id: string): string {
    return `system:execution/actors/${id}`;
  }
  private remember(record: Pick<ActorRecord, "id" | "parentId" | "handles">): void {
    const now = new Date().toISOString();
    this.cache.set({
      ref: this.key(record.id),
      document_version: 1,
      entity_json: JSON.stringify({
        version: 1,
        parentId: record.parentId,
        handles: record.handles,
      }),
      fetched_at: now,
      refresh_after: now,
    });
  }
  private project(record: ActorRecord): ActorRecord {
    const row = this.cache.get(this.key(record.id));
    if (!row) return record;
    const metadata = JSON.parse(row.entity_json);
    if (metadata.version !== 1) throw new Error("Unsupported installed actor metadata");
    return { ...record, parentId: metadata.parentId, handles: metadata.handles };
  }
  upsert(record: ActorRecord): void {
    this.remember(record);
    this.local.upsert({ ...record, parentId: null, handles: undefined });
  }
  get(id: string): ActorRecord | undefined {
    const record = this.local.get(id);
    return record && this.project(record);
  }
  list(): ActorRecord[] {
    return this.local.list().map((record) => this.project(record));
  }
  children(parentId: string): ActorRecord[] {
    return this.list().filter((record) => record.parentId === parentId);
  }
  parentOf(id: string): string | null | undefined {
    return this.get(id)?.parentId;
  }
  patch(id: string, changes: ActorRecordPatch): void {
    const record = this.get(id);
    if (!record) throw new Error("Installed actor is absent");
    if ("parentId" in changes || "handles" in changes) this.remember({ ...record, ...changes });
    this.local.patch(id, { ...changes, parentId: null, handles: undefined });
  }
  setModelSelection(id: string, changes: ModelSelectionChange): void {
    this.local.setModelSelection(id, changes);
  }
  applyPendingSelections(
    id: string,
    changes: { model?: ModelSelectionChange; context?: ContextSelectionChange }
  ): void {
    this.local.applyPendingSelections(id, changes);
  }
}
