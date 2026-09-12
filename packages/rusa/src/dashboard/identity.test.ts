import Database from "better-sqlite3";
import type { DecodedIdToken } from "firebase-admin/auth";
import { afterEach, beforeEach, expect, it } from "vitest";
import { runMigrations } from "../db/migrations/runner.js";
import { PrincipalRepository } from "../db/repositories/principal-repository.js";
import { DashboardIdentityResolver } from "./identity.js";

let db: Database.Database;
let repo: PrincipalRepository;
let resolver: DashboardIdentityResolver;
const token = (extra: Partial<DecodedIdToken> = {}) =>
  ({
    iss: "https://securetoken.google.com/project",
    sub: "uid",
    uid: "uid",
    email: "OWNER@example.com",
    ...extra,
  }) as DecodedIdToken;
beforeEach(() => {
  db = new Database(":memory:");
  runMigrations(db);
  repo = new PrincipalRepository(db);
  resolver = new DashboardIdentityResolver(() => repo);
});
afterEach(() => db.close());

it("keeps one stable user across repeated verified logins and admission email changes", () => {
  const user = resolver.resolve(token());
  expect(user.email).toBe("owner@example.com");
  expect(resolver.resolve(token()).id).toBe(user.id);
  expect(resolver.resolve(token({ email: "new@example.com" })).id).toBe(user.id);
  expect(repo.getUser(user.id)?.email).toBe("new@example.com");
  expect(user.rootActorId).toBeUndefined();
  expect(repo.get("human:operator")).toBeUndefined();
  expect(db.prepare("SELECT COUNT(*) AS n FROM users").get()).toEqual({ n: 1 });
});

it("never claims another identity or a pending owner by matching email", () => {
  const pending = repo.createUser({
    email: "owner@example.com",
    createdAt: new Date().toISOString(),
  });
  expect(() => resolver.resolve(token())).toThrow();
  expect(repo.getUser(pending.id)?.identity).toBeUndefined();
  repo.bindExternalIdentity(
    pending.id,
    { issuer: token().iss, subject: "different" },
    new Date().toISOString()
  );
  expect(() => resolver.resolve(token())).toThrow();
  expect(repo.getUser(pending.id)?.identity?.subject).toBe("different");
});

it("treats issuer and subject together as the key, not email or uid alone", () => {
  const first = resolver.resolve(token());
  expect(() => resolver.resolve(token({ iss: "different-project" }))).toThrow();
  expect(() => resolver.resolve(token({ uid: "other", sub: "other" }))).toThrow();
  expect(repo.getUser(first.id)?.identity).toEqual({ issuer: token().iss, subject: "uid" });
});

it("checks disablement on every resolution and never updates disabled users", () => {
  const user = resolver.resolve(token());
  repo.setDisabled(user.id, new Date().toISOString());
  expect(() => resolver.resolve(token({ email: "renamed@example.com" }))).toThrow("User disabled");
  expect(repo.getUser(user.id)?.email).toBe("owner@example.com");
  repo.setDisabled(user.id, null);
  expect(resolver.resolve(token()).id).toBe(user.id);
});

it.each([
  { uid: "mismatch" },
  { sub: "" },
  { iss: "" },
  { email: undefined },
])("refuses incomplete verified identity %j", (extra) => {
  expect(() => resolver.resolve(token(extra))).toThrow();
  expect(db.prepare("SELECT COUNT(*) AS n FROM users").get()).toEqual({ n: 0 });
});
