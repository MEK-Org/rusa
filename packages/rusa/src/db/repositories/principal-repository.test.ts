import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { IMPLICIT_USER_EMAIL } from "../../principals/operator-principal.js";
import { runMigrations } from "../migrations/runner.js";
import { PrincipalRepository } from "./principal-repository.js";

const IDENTITY = { issuer: "https://securetoken.google.com/example", subject: "firebase-uid-1" };
const OTHER_IDENTITY = { ...IDENTITY, subject: "firebase-uid-2" };
const CREATED_AT = "2026-09-05T00:00:00.000Z";

function makeDb(): Database.Database {
  const db = new Database(":memory:");
  runMigrations(db);
  db.pragma("foreign_keys = ON");
  db.prepare(
    "INSERT INTO actors (id, charter, parent_id, created_at) VALUES ('root', 'Own the mesh', NULL, ?)"
  ).run(CREATED_AT);
  db.prepare(
    "INSERT INTO actors (id, charter, parent_id, created_at) VALUES ('worker', 'Do work', 'root', ?)"
  ).run(CREATED_AT);
  return db;
}

describe("PrincipalRepository", () => {
  let db: Database.Database;
  let principals: PrincipalRepository;

  beforeEach(() => {
    db = makeDb();
    principals = new PrincipalRepository(db);
  });

  it("bootstraps exactly one durable user and does not bypass disabled users", () => {
    const local = principals.ensureImplicitUser(CREATED_AT);
    if (!local) throw new Error("Expected durable user fixture");
    expect(local.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(local.email).toBe(IMPLICIT_USER_EMAIL);
    expect(local.identity).toBeUndefined();
    expect(principals.ensureImplicitUser(CREATED_AT)).toBeUndefined();
    principals.setDisabled(local.id, CREATED_AT);
    expect(principals.ensureImplicitUser(CREATED_AT)).toBeUndefined();
    expect(principals.listUsers()).toHaveLength(1);
  });

  it("does not bootstrap alongside an existing named user", () => {
    principals.createUser({ email: "owner@example.com", createdAt: CREATED_AT });
    expect(principals.ensureImplicitUser(CREATED_AT)).toBeUndefined();
    expect(principals.listUsers()).toHaveLength(1);
  });

  it("enriches the sole implicit user without changing its id, root, or attributed history", () => {
    const local = principals.ensureImplicitUser(CREATED_AT);
    if (!local) throw new Error("Expected durable user fixture");
    principals.setRootActor(local.id, "root");
    db.prepare(
      "INSERT INTO mesh_chat (id, ts, sender_id, recipient_id, body) VALUES ('m', ?, ?, 'root', 'local question')"
    ).run(CREATED_AT, local.id);
    const claimed = principals.claimUnboundUserByEmail("owner@example.com", IDENTITY, CREATED_AT);
    if (!claimed) throw new Error("Expected durable user fixture");
    expect(claimed).toMatchObject({
      id: local.id,
      email: "owner@example.com",
      rootActorId: "root",
      identity: IDENTITY,
    });
    expect(principals.claimUnboundUserByEmail("owner@example.com", IDENTITY, CREATED_AT)?.id).toBe(
      local.id
    );
    expect(db.prepare("SELECT sender_id FROM mesh_chat WHERE id = 'm'").get()).toEqual({
      sender_id: local.id,
    });
    expect(principals.listUsers()).toHaveLength(1);
    expect(() =>
      principals.claimUnboundUserByEmail("owner@example.com", OTHER_IDENTITY, CREATED_AT)
    ).toThrow("another external identity");
  });

  it("does not guess an implicit claim among multiple users or rebind a disabled user", () => {
    const local = principals.ensureImplicitUser(CREATED_AT);
    if (!local) throw new Error("Expected durable user fixture");
    principals.setDisabled(local.id, CREATED_AT);
    expect(
      principals.claimUnboundUserByEmail("owner@example.com", IDENTITY, CREATED_AT)?.disabledAt
    ).toBe(CREATED_AT);
    expect(principals.getUser(local.id)?.identity).toBeUndefined();
    principals.setDisabled(local.id, null);
    principals.createUser({ email: "colleague@example.com", createdAt: CREATED_AT });
    expect(
      principals.claimUnboundUserByEmail("owner@example.com", IDENTITY, CREATED_AT)
    ).toBeUndefined();
    expect(principals.getUser(local.id)?.identity).toBeUndefined();
  });

  it("rejects a reserved-email claim without writing", () => {
    const local = principals.ensureImplicitUser(CREATED_AT);
    if (!local) throw new Error("Expected durable user fixture");
    expect(() =>
      principals.claimUnboundUserByEmail(IMPLICIT_USER_EMAIL, IDENTITY, CREATED_AT)
    ).toThrow("Reserved admission email");
    expect(principals.getUser(local.id)).toEqual(local);
  });

  it("keeps an actor principal creation time synchronized with its actor row", () => {
    principals.ensureActorPrincipal("root", CREATED_AT);
    principals.ensureActorPrincipal("root", "2026-10-01T00:00:00.000Z");

    expect(principals.get("root")).toEqual({
      kind: "actor",
      id: "root",
      actorId: "root",
      createdAt: "2026-10-01T00:00:00.000Z",
    });
    expect(db.prepare("SELECT COUNT(*) AS n FROM principals").get()).toEqual({ n: 2 });
  });

  it("resolves nothing for an unknown id and refuses to answer across kinds", () => {
    principals.ensureActorPrincipal("root", CREATED_AT);
    const user = principals.createUser({ email: "owner@example.com", createdAt: CREATED_AT });

    expect(principals.get("no-such-id")).toBeUndefined();
    expect(principals.get("system:events")).toBeUndefined();
    expect(principals.getUser("no-such-id")).toBeUndefined();
    expect(principals.getUser("root")).toBeUndefined();
    expect(principals.get("system:mesh")).toEqual({
      kind: "system",
      id: "system:mesh",
      createdAt: expect.any(String),
    });
    expect(principals.get(user.id)).toEqual(user);
  });

  it("refuses to reuse an id that already names a principal of another kind", () => {
    expect(() => principals.ensureActorPrincipal("system:mesh", CREATED_AT)).toThrow(
      /already exists as kind 'system'/
    );
    const user = principals.createUser({ email: "owner@example.com", createdAt: CREATED_AT });
    expect(() => principals.ensureActorPrincipal(user.id, CREATED_AT)).toThrow(
      /already exists as kind 'user'/
    );
  });

  it("mints an opaque user id and starts the user unbound", () => {
    const user = principals.createUser({ email: "  Owner@Example.COM ", createdAt: CREATED_AT });

    expect(user).toEqual({
      kind: "user",
      id: expect.any(String),
      email: "owner@example.com",
      createdAt: CREATED_AT,
    });
    expect(user.id).not.toBe("owner@example.com");
    expect(user.identity).toBeUndefined();
    expect(principals.findUserByEmail("OWNER@example.com")).toEqual(user);
    expect(principals.findUserByExternalIdentity(IDENTITY)).toBeUndefined();
  });

  it("binds a verified identity to a user provisioned before any login", () => {
    const owner = principals.createUser({ email: "owner@example.com", createdAt: CREATED_AT });

    const bound = principals.bindExternalIdentity(owner.id, IDENTITY, "2026-09-06T10:00:00.000Z");

    expect(bound).toEqual({
      ...owner,
      identity: IDENTITY,
      lastAuthenticatedAt: "2026-09-06T10:00:00.000Z",
    });
    expect(principals.findUserByExternalIdentity(IDENTITY)).toEqual(bound);
  });

  it("refuses an unbound-email claim when another principal already holds the identity", () => {
    const pending = principals.createUser({ email: "owner@example.com", createdAt: CREATED_AT });
    const holder = principals.createUser({
      email: "other@example.com",
      identity: IDENTITY,
      createdAt: CREATED_AT,
    });

    expect(() =>
      principals.claimUnboundUserByEmail("owner@example.com", IDENTITY, "2026-09-06T10:00:00.000Z")
    ).toThrow(/identity is already bound to user/);
    expect(principals.getUser(pending.id)?.identity).toBeUndefined();
    expect(principals.getUser(holder.id)?.identity).toEqual(IDENTITY);
  });

  it("refuses to rebind a bound user or to take an identity another user holds", () => {
    const owner = principals.createUser({
      email: "owner@example.com",
      identity: IDENTITY,
      createdAt: CREATED_AT,
    });
    const pending = principals.createUser({
      email: "colleague@example.com",
      createdAt: CREATED_AT,
    });

    expect(() => principals.bindExternalIdentity(pending.id, IDENTITY, CREATED_AT)).toThrow(
      /already bound to user/
    );
    expect(() => principals.bindExternalIdentity(owner.id, OTHER_IDENTITY, CREATED_AT)).toThrow(
      /already bound to an external identity/
    );
    expect(() =>
      principals.createUser({
        email: "third@example.com",
        identity: IDENTITY,
        createdAt: CREATED_AT,
      })
    ).toThrow(/already bound to user/);

    expect(principals.getUser(pending.id)?.identity).toBeUndefined();
    expect(principals.getUser(owner.id)?.identity).toEqual(IDENTITY);
  });

  it("survives an email change with the same principal id, identity and root", () => {
    const owner = principals.createUser({
      email: "owner@example.com",
      identity: IDENTITY,
      rootActorId: "root",
      createdAt: CREATED_AT,
    });

    const renamed = principals.updateEmail(owner.id, "New.Owner@Example.com");

    expect(renamed).toEqual({ ...owner, email: "new.owner@example.com" });
    expect(principals.findUserByExternalIdentity(IDENTITY)).toEqual(renamed);
    expect(principals.findUserByEmail("owner@example.com")).toBeUndefined();
  });

  it("keeps root, identity and history when a user is disabled and re-enabled", () => {
    const owner = principals.createUser({
      email: "owner@example.com",
      identity: IDENTITY,
      rootActorId: "root",
      createdAt: CREATED_AT,
    });

    const disabled = principals.setDisabled(owner.id, "2026-09-07T00:00:00.000Z");
    expect(disabled).toEqual({ ...owner, disabledAt: "2026-09-07T00:00:00.000Z" });
    expect(db.prepare("SELECT COUNT(*) AS n FROM actors WHERE id = 'root'").get()).toEqual({
      n: 1,
    });

    expect(principals.setDisabled(owner.id, null)).toEqual(owner);
  });

  it("gives one root to one user", () => {
    const owner = principals.createUser({ email: "owner@example.com", createdAt: CREATED_AT });
    const colleague = principals.createUser({
      email: "colleague@example.com",
      createdAt: CREATED_AT,
    });

    expect(principals.setRootActor(owner.id, "root").rootActorId).toBe("root");
    expect(() => principals.setRootActor(colleague.id, "root")).toThrow();
    expect(principals.getUser(colleague.id)?.rootActorId).toBeUndefined();
    expect(() => principals.setRootActor(owner.id, "worker")).toThrow(/already has root 'root'/);
    expect(principals.getUser(owner.id)?.rootActorId).toBe("root");
  });

  it("refuses a missing or non-root actor for a root association", () => {
    const owner = principals.createUser({ email: "owner@example.com", createdAt: CREATED_AT });
    expect(() => principals.setRootActor(owner.id, "no-such-actor")).toThrow(/does not exist/);
    expect(() => principals.setRootActor(owner.id, "worker")).toThrow(/not a root actor/);
    expect(() =>
      principals.createUser({
        email: "worker-owner@example.com",
        rootActorId: "worker",
        createdAt: CREATED_AT,
      })
    ).toThrow(/not a root actor/);
  });

  it("names the missing principal when a mutation targets one that is not a user", () => {
    principals.ensureActorPrincipal("root", CREATED_AT);

    expect(() => principals.updateEmail("root", "owner@example.com")).toThrow(
      /no user principal 'root'/
    );
    expect(() => principals.recordAuthentication("ghost", CREATED_AT)).toThrow(
      /no user principal 'ghost'/
    );
  });

  it("persists a bound user across a file-backed database reopen", () => {
    const directory = mkdtempSync(join(tmpdir(), "rusa-principals-"));
    const file = join(directory, "mesh.db");
    try {
      const first = new Database(file);
      runMigrations(first);
      first.pragma("foreign_keys = ON");
      const created = new PrincipalRepository(first).createUser({
        email: "owner@example.com",
        identity: IDENTITY,
        createdAt: CREATED_AT,
      });
      first.close();

      const reopened = new Database(file);
      reopened.pragma("foreign_keys = ON");
      expect(new PrincipalRepository(reopened).findUserByExternalIdentity(IDENTITY)).toEqual(
        created
      );
      reopened.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
