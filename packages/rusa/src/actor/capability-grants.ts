import { readFileSync, writeFileSync } from "node:fs";

/**
 * Basename of the durable grant-store JSON under `$RUSA_HOME` — shared by
 * the wiring (start.ts) and the sandbox layer (sandbox.ts reads the store
 * directly, keyed by the spawning actor's id, to decide whether to re-bind a
 * granted secret over its tmpfs mask — ISSUE_NUM) so the two can never drift.
 */
export const CAPABILITY_GRANTS_FILENAME = "capability-grants.json";

/**
 * The grantable secret capability for the host's Gemini API key . Unlike
 * MCP-server capabilities it mounts no server: the sandbox honors an active
 * grant by ro-binding `$RUSA_HOME/secrets/gemini-api-key` back over the
 * secrets-dir tmpfs mask, so the grantee reads the key at that well-known path.
 * Evaluated per-spawn; fail-closed to masked.
 */
export const SECRET_GEMINI_API_KEY_CAPABILITY = "secret:gemini-api-key";

/**
 * The grantable secret capability for the host's Mistral API key .
 * Mirrors {@link SECRET_GEMINI_API_KEY_CAPABILITY}: the sandbox re-binds the
 * single key file over the secrets-directory mask for an actively granted actor.
 */
export const SECRET_MISTRAL_API_KEY_CAPABILITY = "secret:mistral-api-key";

/**
 * Capabilities a NON-root parent may grant to / revoke from its DIRECT children
 * . Everything else stays root-only. Enforced in the mesh
 * (`ActorMesh.grantCapability`/`revokeCapability`), not just the tool layer, so
 * the invariant holds for any caller.
 */
export const PARENT_GRANTABLE_CAPABILITIES: ReadonlySet<string> = new Set([
  SECRET_GEMINI_API_KEY_CAPABILITY,
  SECRET_MISTRAL_API_KEY_CAPABILITY,
]);

/**
 * A grant of an extra MCP capability to a specific actor, beyond the default
 * worker tool set (design ISSUE_NUM, phase 1a). The IU steward, for example, is
 * granted the glass-goals *write* capability so it can write the library directly
 * while every other worker stays read-only.
 *
 * Grants attach to the grantee's **actor id** (its stable thread id). The IU
 * steward is a single long-running actor that root wakes, so its id is stable for
 * its lifetime — no indirection needed. If it is ever retired and re-spawned with
 * a new id, root simply re-grants (the permanent-actor model). Only the root
 * grants, and grants are drawn from an allow-list — both enforced one layer up
 * (the mesh + the root-only grant tools); this module is pure persistence.
 */
export interface CapabilityGrant {
  /** The grantee's actor id (stable thread id). */
  actorId: string;
  /** The grantable capability name (an allow-listed MCP server name). */
  capability: string;
  /** Who granted it (the root, in v1). */
  grantedBy: string;
  /** ISO timestamp of the (most recent) grant. */
  grantedAt: string;
  /** ISO timestamp of revocation; absent while the grant is active. */
  revokedAt?: string;
}

/**
 * Persistence boundary for capability grants — mirrors {@link ThreadRegistry}:
 * a local JSON file in production ({@link FileCapabilityGrantStore}), in-memory
 * for tests. Keyed on (actorId, capability); one record per pair.
 */
export interface CapabilityGrantStore {
  /**
   * Grant `capability` to `actorId`. Idempotent on (actorId, capability):
   * re-granting sets/keeps it active (clearing any prior revocation) and updates
   * the grant metadata.
   */
  grant(grant: CapabilityGrant): void;
  /** Revoke the active grant of (actorId, capability); no-op if none is active. */
  revoke(actorId: string, capability: string, at: string): void;
  /** Every grant, active and revoked — the audit/inspection view. */
  list(): CapabilityGrant[];
  /** The capabilities currently active (granted, not revoked) for an actor. */
  activeFor(actorId: string): string[];
}

const key = (actorId: string, capability: string): string => `${actorId} ${capability}`;

/** In-memory grant store — for tests and the e2e runner. */
export class InMemoryCapabilityGrantStore implements CapabilityGrantStore {
  private readonly grants = new Map<string, CapabilityGrant>();

  grant(grant: CapabilityGrant): void {
    // Re-granting reactivates: drop any prior revocation, refresh metadata.
    this.grants.set(key(grant.actorId, grant.capability), { ...grant, revokedAt: undefined });
  }

  revoke(actorId: string, capability: string, at: string): void {
    const existing = this.grants.get(key(actorId, capability));
    if (!existing || existing.revokedAt) return;
    this.grants.set(key(actorId, capability), { ...existing, revokedAt: at });
  }

  list(): CapabilityGrant[] {
    return [...this.grants.values()].map((g) => ({ ...g }));
  }

  activeFor(actorId: string): string[] {
    return this.list()
      .filter((g) => g.actorId === actorId && !g.revokedAt)
      .map((g) => g.capability);
  }
}

/**
 * JSON-file-backed grant store — the durable store, mirroring
 * {@link FileThreadRegistry}: rewrites the whole file on every mutation, and
 * refreshes successful reads from disk so grants recorded by another process are
 * visible to the next actor construction without an orchestrator restart.
 */
export class FileCapabilityGrantStore implements CapabilityGrantStore {
  private mem = new InMemoryCapabilityGrantStore();

  constructor(private readonly file: string) {
    this.refreshFromDisk();
  }

  private refreshFromDisk(): void {
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf-8")) as { grants?: CapabilityGrant[] };
      const next = new InMemoryCapabilityGrantStore();
      for (const g of parsed.grants ?? []) {
        next.grant(g); // grant() clears revokedAt on insert…
        if (g.revokedAt) next.revoke(g.actorId, g.capability, g.revokedAt); // …re-apply it.
      }
      this.mem = next;
    } catch {
      /* missing / empty / invalid → keep the current in-memory view */
    }
  }

  private flush(): void {
    try {
      writeFileSync(this.file, JSON.stringify({ grants: this.mem.list() }, null, 2));
    } catch {
      /* best effort — in-memory copy remains authoritative for this process */
    }
  }

  grant(grant: CapabilityGrant): void {
    this.mem.grant(grant);
    this.flush();
  }

  revoke(actorId: string, capability: string, at: string): void {
    this.mem.revoke(actorId, capability, at);
    this.flush();
  }

  list(): CapabilityGrant[] {
    this.refreshFromDisk();
    return this.mem.list();
  }

  activeFor(actorId: string): string[] {
    this.refreshFromDisk();
    return this.mem.activeFor(actorId);
  }
}
