import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
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
  return db;
}

describe("PrincipalRepository", () => {
  let db: Database.Database;
  let principals: PrincipalRepository;

  beforeEach(() => {
    db = makeDb();
    principals = new PrincipalRepository(db);
  });

  it("records an actor principal once and keeps its first creation time", () => {
    principals.ensureActorPrincipal("root", CREATED_AT);
    principals.ensureActorPrincipal("root", "2026-10-01T00:00:00.000Z");

    expect(principals.get("root")).toEqual({
      kind: "actor",
      id: "root",
      actorId: "root",
      createdAt: CREATED_AT,
    });
    expect(db.prepare("SELECT COUNT(*) AS n FROM principals").get()).toEqual({ n: 2 });
  });

  it("resolves nothing for an unknown id and refuses to answer across kinds", () => {
    principals.ensureActorPrincipal("root", CREATED_AT);
    const user = principals.createUser({ email: "owner@example.com", createdAt: CREATED_AT });

    expect(principals.get("no-such-id")).toBeUndefined();
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
    principals.ensureActorPrincipal("root", CREATED_AT);
    expect(() => principals.ensureSystemPrincipal("root", CREATED_AT)).toThrow(
      /already exists as kind 'actor'/
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
  });

  it("refuses a root actor that does not exist", () => {
    const owner = principals.createUser({ email: "owner@example.com", createdAt: CREATED_AT });
    expect(() => principals.setRootActor(owner.id, "no-such-actor")).toThrow();
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
