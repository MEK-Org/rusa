import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { generateHandle } from "./handle-generator.js";

/**
 * A thread's lease — the finite rope a parent hands a child (design Part E). The
 * subtree is bounded so self-similar spawning can't run away. v1 bounds the
 * number of wakes; depth/token bounds can join later.
 */
export interface ActorBudget {
  /** Max number of times this actor may run before it's force-retired. */
  maxRuns?: number;
  /** Runs consumed so far (maintained by the mesh). */
  runsUsed?: number;
}

export type ThreadStatus = "active" | "retired";

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

export interface PendingMessageDelivery {
  id: string;
  fromId: string;
  body: string;
  deliverAt: string;
  sessionId?: string;
}

/**
 * A capability to message another actor: an unguessable thread id, plus an
 * optional role label set by whoever *granted* the handle, framing the target
 * for that holder's specific purpose (e.g. "code reviewer for security"). The id
 * *is* the capability — knowing it is permission to message it (object-capability
 * style), which is why communication can be a general graph without a separate
 * ACL. When `role` is omitted the holder falls back to the target's own charter
 * as the label, so a handle is never unlabeled and the role never drifts from a
 * stale copy — the granter only sets it to override that default with intent.
 */
export interface ActorHandle {
  id: string;
  role?: string;
}

/**
 * The durable record for one actor/thread (design B.6): existence, charter,
 * parent, working-memory session handle, status, and lease. This is the *only*
 * state not re-derivable from the humans' tools — it's what lets the root
 * reconstitute "who's working on what" after a restart. Working memory itself
 * (the compacted session) stays a losable cache; only the record is durable.
 */
export interface ThreadRecord {
  /** Stable actor id (the thread handle used for routing). */
  id: string;
  /** What this actor owns — authored by the spawning message, refinable later. */
  charter: string;
  /**
   * Owning parent (the *ownership tree* edge): who can retire this actor and
   * whose budget bounds it. `null` only for the root (whose parent is the human).
   * Communication, by contrast, follows {@link handles}, which can reach beyond
   * the parent — ownership is a tree, messaging is a graph.
   */
  parentId: string | null;
  /**
   * Address book: extra actors this one may message beyond its parent — peers a
   * parent introduced (e.g. a coder given the reviewer's handle) and children it
   * spawned. The parent handle is implicit via {@link parentId}.
   */
  handles?: ActorHandle[];
  /**
   * Which coding harness this actor runs on — a key under `providers` (e.g.
   * "claude", "antigravity"). Undefined means "use the default" (the root's
   * provider). Lets a parent delegate to a different harness/tier than itself.
   */
  provider?: string;
  /** Optional model/tier id passed to the provider (e.g. a stronger model for review). */
  model?: string;
  /** Model/tier id read back from the provider session after the actor first runs. */
  boundModel?: string;
  /** Provider session/conversation id = the working-memory handle (B.2); set after first run. */
  sessionId?: string;
  /**
   * Working-memory ownership and policy (design ISSUE_NUM). Missing records are native
   * for backward compatibility. Portable actors run without provider sessions and
   * receive mesh-managed context assembled according to the selected mode.
   */
  context?: ContextConfig;
  /** Optional parent-authored brief title/description of what this actor is tasked with */
  title?: string;
  /**
   * Explicit authority flag : true ONLY for the genuine mesh root actor.
   * Decoupled from `parentId == null` (which represents top-level topology).
   * Used for capability grant/revoke authority checks.
   */
  isRoot?: boolean;
  status: ThreadStatus;
  budget?: ActorBudget;
  /** Pending scheduled deliveries for this actor. */
  pendingDeliveries?: PendingMessageDelivery[];
  /** Whether the operator has ever messaged this actor, unlocking the reply channel. */
  humanUnlocked?: boolean;
  /** The most recent chat session ID from the operator. */
  lastChatSessionId?: string;
  /** ISO timestamp of creation. */
  createdAt: string;
}

/**
 * Persistence boundary for the thread registry. Today: a local JSON file
 * ({@link FileThreadRegistry}); in-memory for tests. Increment 3 swaps the impl
 * for the understanding-MCP without touching the mesh — the "no third store"
 * principle survives as an interface-isolated, temporary exception.
 */
export interface ThreadRegistry {
  /** Insert or fully replace a record. */
  upsert(rec: ThreadRecord): void;
  get(id: string): ThreadRecord | undefined;
  /** All records (active and retired). */
  list(): ThreadRecord[];
  /** Direct children of a parent (active and retired). */
  children(parentId: string): ThreadRecord[];
  /**
   * Resolve a generated display handle (or direct id) back to a durable thread id.
   * Handle matches are scoped to ACTIVE records only — a retired record must never
   * shadow a live actor on a handle collision, or routing (e.g. tracker-hygiene
   * owner pings, ISSUE_NUM/ISSUE_NUM) would silently drop to the dead thread. A direct id
   * still resolves regardless of status (an explicit id is not a collision).
   */
  resolveHandle(handleOrId: string, handleForId?: (id: string) => string): string | null;
  /** Shallow-merge changes into an existing record (no-op if id is unknown). */
  patch(id: string, changes: Partial<Omit<ThreadRecord, "id">>): void;
}

/**
 * Select the durable root identity for startup. Existing explicit roots keep
 * their id; pre-ISSUE_NUM installs are grandfathered by stamping the historical
 * `"root"` record. Only an empty registry mints a new opaque id.
 */
export function resolveRootThreadId(
  registry: ThreadRegistry,
  idgen: () => string = randomUUID
): string {
  const explicitRoots = registry.list().filter((record) => record.isRoot === true);
  if (explicitRoots.length > 1) {
    throw new Error(
      `multiple root records found: ${explicitRoots.map((record) => record.id).join(", ")}`
    );
  }
  if (explicitRoots[0]) return explicitRoots[0].id;

  const legacyRoot = registry.get("root");
  if (legacyRoot) {
    registry.patch(legacyRoot.id, { isRoot: true });
    return legacyRoot.id;
  }
  return idgen();
}

/** In-memory registry — for tests and the e2e runner. */
export class InMemoryThreadRegistry implements ThreadRegistry {
  private readonly records = new Map<string, ThreadRecord>();

  upsert(rec: ThreadRecord): void {
    this.records.set(rec.id, { ...rec });
  }

  get(id: string): ThreadRecord | undefined {
    const r = this.records.get(id);
    return r ? { ...r } : undefined;
  }

  list(): ThreadRecord[] {
    return [...this.records.values()].map((r) => ({ ...r }));
  }

  children(parentId: string): ThreadRecord[] {
    return this.list().filter((r) => r.parentId === parentId);
  }

  resolveHandle(
    handleOrId: string,
    handleForId: (id: string) => string = generateHandle
  ): string | null {
    if (this.records.has(handleOrId)) return handleOrId;
    for (const [id, record] of this.records) {
      if (record.status !== "active") continue;
      if (handleForId(id) === handleOrId) return id;
    }
    return null;
  }

  patch(id: string, changes: Partial<Omit<ThreadRecord, "id">>): void {
    const existing = this.records.get(id);
    if (!existing) return;
    this.records.set(id, { ...existing, ...changes, id });
  }
}

/**
 * JSON-file-backed registry — the durable interim store (until understanding-MCP
 * in Increment 3). Loads once on construction and rewrites the whole file on
 * every mutation; best-effort (a write failure is logged-by-throwing-up to the
 * caller's discretion is avoided — the in-memory copy stays authoritative for
 * the process so the mesh keeps working even if disk is momentarily unwritable).
 */
export class FileThreadRegistry implements ThreadRegistry {
  private readonly mem = new InMemoryThreadRegistry();

  constructor(private readonly file: string) {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf-8")) as { threads?: ThreadRecord[] };
      for (const rec of parsed.threads ?? []) this.mem.upsert(rec);
    } catch {
      /* missing / empty / invalid → start empty */
    }
  }

  private flush(): void {
    try {
      writeFileSync(this.file, JSON.stringify({ threads: this.mem.list() }, null, 2));
    } catch {
      /* best effort — in-memory copy remains authoritative for this process */
    }
  }

  upsert(rec: ThreadRecord): void {
    this.mem.upsert(rec);
    this.flush();
  }

  get(id: string): ThreadRecord | undefined {
    return this.mem.get(id);
  }

  list(): ThreadRecord[] {
    return this.mem.list();
  }

  children(parentId: string): ThreadRecord[] {
    return this.mem.children(parentId);
  }

  resolveHandle(handleOrId: string, handleForId?: (id: string) => string): string | null {
    return this.mem.resolveHandle(handleOrId, handleForId);
  }

  patch(id: string, changes: Partial<Omit<ThreadRecord, "id">>): void {
    this.mem.patch(id, changes);
    this.flush();
  }
}
