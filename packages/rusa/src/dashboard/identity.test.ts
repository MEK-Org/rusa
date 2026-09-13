import Database from "better-sqlite3";
import type { DecodedIdToken } from "firebase-admin/auth";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { runMigrations } from "../db/migrations/runner.js";
import { PrincipalRepository } from "../db/repositories/principal-repository.js";
import { nullLogger } from "../observability/logger.js";
import { DashboardIdentityResolver } from "./identity.js";

let db: Database.Database;
let repo: PrincipalRepository;
let resolver: DashboardIdentityResolver;
const ISSUER = "https://securetoken.google.com/project";
const token = (extra: Partial<DecodedIdToken> = {}) =>
  ({
    iss: ISSUER,
    sub: "uid",
    uid: "uid",
    email: "OWNER@example.com",
    ...extra,
  }) as DecodedIdToken;
beforeEach(() => {
  db = new Database(":memory:");
  runMigrations(db);
  repo = new PrincipalRepository(db);
  resolver = new DashboardIdentityResolver(() => repo, "project");
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
    { issuer: ISSUER, subject: "different" },
    new Date().toISOString()
  );
  expect(() => resolver.resolve(token())).toThrow();
  expect(repo.getUser(pending.id)?.identity?.subject).toBe("different");
});

it("keys on the canonical project issuer and subject, whatever the token's transport issuer", () => {
  const first = resolver.resolve(token());
  expect(repo.getUser(first.id)?.identity).toEqual({ issuer: ISSUER, subject: "uid" });
  // A session cookie carries a different transport issuer for the same verified person.
  expect(resolver.resolve(token({ iss: "https://session.firebase.google.com/project" })).id).toBe(
    first.id
  );
  // A different subject is a different person, even from the same project.
  const second = resolver.resolve(token({ uid: "other", sub: "other", email: "other@x.test" }));
  expect(second.id).not.toBe(first.id);
});

it("names the colliding row when a verified email is already held by another user", () => {
  const warn = vi.fn();
  const logged = new DashboardIdentityResolver(() => repo, "project", {
    ...nullLogger,
    warn,
  });
  const pending = repo.createUser({
    email: "owner@example.com",
    createdAt: new Date().toISOString(),
  });
  expect(() => logged.resolve(token())).toThrow(/already registered/);
  expect(warn).toHaveBeenCalledWith("dashboard_identity_email_conflict", {
    holderId: pending.id,
    holderBound: false,
  });
  // The same collision on a returning user's email change is reported the same way.
  const returning = logged.resolve(token({ email: "other@example.com" }));
  warn.mockClear();
  expect(() => logged.resolve(token())).toThrow(/already registered/);
  expect(warn).toHaveBeenCalledWith("dashboard_identity_email_conflict", {
    holderId: pending.id,
    holderBound: false,
  });
  expect(repo.getUser(returning.id)?.email).toBe("other@example.com");
  // The address itself never reaches the record.
  expect(JSON.stringify(warn.mock.calls)).not.toContain("owner@example.com");
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
  { email: undefined },
])("refuses incomplete verified identity %j", (extra) => {
  expect(() => resolver.resolve(token(extra))).toThrow();
  expect(db.prepare("SELECT COUNT(*) AS n FROM users").get()).toEqual({ n: 0 });
});
