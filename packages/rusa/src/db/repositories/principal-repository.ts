import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type {
  ExternalIdentity,
  PrincipalRef,
  UserPrincipal,
} from "../../principals/principal-ref.js";

type PrincipalRow = {
  id: string;
  kind: string;
  actor_id: string | null;
  created_at: string;
};

type UserRow = {
  principal_id: string;
  email: string;
  firebase_issuer: string | null;
  firebase_subject: string | null;
  root_actor_id: string | null;
  disabled_at: string | null;
  last_authenticated_at: string | null;
  created_at: string;
};

export interface CreateUserInput {
  /** Admission email; normalized to lowercase before it is stored. */
  email: string;
  /** Supplied only when a verified login is what created the user. */
  identity?: ExternalIdentity;
  /** Supplied only when the user's root actor already exists. */
  rootActorId?: string;
  createdAt: string;
}

/** Lowercase + trim, the one normalization every email comparison goes through. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function toUser(row: UserRow, createdAt: string): UserPrincipal {
  return {
    kind: "user",
    id: row.principal_id,
    createdAt,
    email: row.email,
    ...(row.firebase_issuer !== null && row.firebase_subject !== null
      ? { identity: { issuer: row.firebase_issuer, subject: row.firebase_subject } }
      : {}),
    ...(row.root_actor_id !== null ? { rootActorId: row.root_actor_id } : {}),
    ...(row.disabled_at !== null ? { disabledAt: row.disabled_at } : {}),
    ...(row.last_authenticated_at !== null
      ? { lastAuthenticatedAt: row.last_authenticated_at }
      : {}),
  };
}

/**
 * Authoritative storage for principals and the user subtype.
 *
 * Two properties are the point of this class rather than incidental to it.
 * **Kind is answered by a row, never by a prefix** — `get` returns a typed
 * {@link PrincipalRef} only for an id that exists, and the user accessors
 * refuse an id whose row is some other kind, so an unknown or mistyped id
 * resolves as nothing rather than as a plausible identity. And **a user
 * principal's id is always minted here**: there is no way to ask for a chosen
 * one, which is what structurally prevents a caller from turning an arbitrary
 * owner string it found in an attribution column into a user.
 */
export class PrincipalRepository {
  constructor(private readonly db: Database.Database) {}

  /**
   * Record the principal for an actor. Idempotent by primary key, so the actor
   * repository can call it on every upsert and a re-run of an import writes
   * nothing new. Refuses if the id is already held by a principal of another
   * kind, rather than leaving an actor attributed to a foreign identity.
   *
   * Caller must be inside the same transaction as the `actors` write — see
   * `SqliteActorRepository.upsert`, which is the only production caller.
   */
  ensureActorPrincipal(actorId: string, createdAt: string): void {
    const result = this.db
      .prepare(
        `INSERT INTO principals (id, kind, actor_id, created_at) VALUES (?, 'actor', ?, ?)
         ON CONFLICT(id) DO NOTHING`
      )
      .run(actorId, actorId, createdAt);
    if (result.changes === 0) this.assertKind(actorId, "actor");
  }

  /** Record a `system:*` infrastructure identity. Idempotent, as above. */
  ensureSystemPrincipal(id: string, createdAt: string): void {
    const result = this.db
      .prepare(
        `INSERT INTO principals (id, kind, actor_id, created_at) VALUES (?, 'system', NULL, ?)
         ON CONFLICT(id) DO NOTHING`
      )
      .run(id, createdAt);
    if (result.changes === 0) this.assertKind(id, "system");
  }

  /** The principal for `id`, or undefined when no row holds it. */
  get(id: string): PrincipalRef | undefined {
    const row = this.principalRow(id);
    if (!row) return undefined;
    if (row.kind === "actor") {
      // The CHECK constraints make this unreachable for an actor row; narrowing
      // rather than asserting keeps the null out of the returned type.
      if (row.actor_id === null) return undefined;
      return { kind: "actor", id: row.id, actorId: row.actor_id, createdAt: row.created_at };
    }
    if (row.kind === "system") {
      return { kind: "system", id: row.id, createdAt: row.created_at };
    }
    const user = this.userRow(id);
    return user ? toUser(user, row.created_at) : undefined;
  }

  /** The user for `principalId`, or undefined for an unknown id or another kind. */
  getUser(principalId: string): UserPrincipal | undefined {
    const principal = this.get(principalId);
    return principal?.kind === "user" ? principal : undefined;
  }

  /** Lookup by the durable key. Never falls back to email. */
  findUserByExternalIdentity(identity: ExternalIdentity): UserPrincipal | undefined {
    const row = this.db
      .prepare("SELECT * FROM users WHERE firebase_issuer = ? AND firebase_subject = ?")
      .get(identity.issuer, identity.subject) as UserRow | undefined;
    return row ? this.getUser(row.principal_id) : undefined;
  }

  /** Lookup by admission metadata — for provisioning decisions, not for auth. */
  findUserByEmail(email: string): UserPrincipal | undefined {
    const row = this.db.prepare("SELECT * FROM users WHERE email = ?").get(normalizeEmail(email)) as
      | UserRow
      | undefined;
    return row ? this.getUser(row.principal_id) : undefined;
  }

  /**
   * Create a user and its principal in one transaction. The id is minted here
   * and returned; callers do not choose it.
   */
  createUser(input: CreateUserInput): UserPrincipal {
    const email = normalizeEmail(input.email);
    const id = randomUUID();
    const created = this.db.transaction(() => {
      if (input.identity) this.assertIdentityAvailable(input.identity);
      this.db
        .prepare(
          `INSERT INTO principals (id, kind, actor_id, created_at) VALUES (?, 'user', NULL, ?)`
        )
        .run(id, input.createdAt);
      this.db
        .prepare(
          `INSERT INTO users (
             principal_id, email, firebase_issuer, firebase_subject, root_actor_id, created_at
           ) VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(
          id,
          email,
          input.identity?.issuer ?? null,
          input.identity?.subject ?? null,
          input.rootActorId ?? null,
          input.createdAt
        );
      return this.requireUser(id);
    })();
    return created;
  }

  /**
   * Bind a verified external identity to a user provisioned without one.
   *
   * Refuses a user that is already bound and an identity another user already
   * holds. Both refusals are the reason pre-binding state exists: an operator
   * names the instance owner up front, and a later login can only *confirm*
   * that choice, never redirect it or take an identity out from under someone.
   */
  bindExternalIdentity(
    principalId: string,
    identity: ExternalIdentity,
    authenticatedAt: string
  ): UserPrincipal {
    return this.db.transaction(() => {
      const user = this.requireUser(principalId);
      if (user.identity) {
        throw new Error(
          `PrincipalRepository: user '${principalId}' is already bound to an external identity`
        );
      }
      this.assertIdentityAvailable(identity);
      this.db
        .prepare(
          `UPDATE users SET firebase_issuer = ?, firebase_subject = ?, last_authenticated_at = ?
           WHERE principal_id = ?`
        )
        .run(identity.issuer, identity.subject, authenticatedAt, principalId);
      return this.requireUser(principalId);
    })();
  }

  /** Update admission metadata. The principal id and root are untouched. */
  updateEmail(principalId: string, email: string): UserPrincipal {
    return this.db.transaction(() => {
      this.requireUser(principalId);
      this.db
        .prepare("UPDATE users SET email = ? WHERE principal_id = ?")
        .run(normalizeEmail(email), principalId);
      return this.requireUser(principalId);
    })();
  }

  /** Associate a user with its root actor. One root belongs to one user. */
  setRootActor(principalId: string, rootActorId: string): UserPrincipal {
    return this.db.transaction(() => {
      this.requireUser(principalId);
      this.db
        .prepare("UPDATE users SET root_actor_id = ? WHERE principal_id = ?")
        .run(rootActorId, principalId);
      return this.requireUser(principalId);
    })();
  }

  /**
   * Disable or re-enable a user. Disablement is a timestamp precisely so the
   * root actor, the identity and the history stay exactly where they are.
   */
  setDisabled(principalId: string, disabledAt: string | null): UserPrincipal {
    return this.db.transaction(() => {
      this.requireUser(principalId);
      this.db
        .prepare("UPDATE users SET disabled_at = ? WHERE principal_id = ?")
        .run(disabledAt, principalId);
      return this.requireUser(principalId);
    })();
  }

  /** Stamp the most recent successful authentication. Metadata only. */
  recordAuthentication(principalId: string, authenticatedAt: string): UserPrincipal {
    return this.db.transaction(() => {
      this.requireUser(principalId);
      this.db
        .prepare("UPDATE users SET last_authenticated_at = ? WHERE principal_id = ?")
        .run(authenticatedAt, principalId);
      return this.requireUser(principalId);
    })();
  }

  private principalRow(id: string): PrincipalRow | undefined {
    return this.db.prepare("SELECT * FROM principals WHERE id = ?").get(id) as
      | PrincipalRow
      | undefined;
  }

  private userRow(principalId: string): UserRow | undefined {
    return this.db.prepare("SELECT * FROM users WHERE principal_id = ?").get(principalId) as
      | UserRow
      | undefined;
  }

  private assertKind(id: string, expected: PrincipalRef["kind"]): void {
    const row = this.principalRow(id);
    if (row && row.kind !== expected) {
      throw new Error(
        `PrincipalRepository: principal '${id}' already exists as kind '${row.kind}', not '${expected}'`
      );
    }
  }

  private assertIdentityAvailable(identity: ExternalIdentity): void {
    const holder = this.findUserByExternalIdentity(identity);
    if (holder) {
      throw new Error(
        `PrincipalRepository: external identity is already bound to user '${holder.id}'`
      );
    }
  }

  private requireUser(principalId: string): UserPrincipal {
    const user = this.getUser(principalId);
    if (!user) throw new Error(`PrincipalRepository: no user principal '${principalId}'`);
    return user;
  }
}
