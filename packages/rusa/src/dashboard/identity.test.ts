import Database from "better-sqlite3";
import type { DecodedIdToken } from "firebase-admin/auth";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { runMigrations } from "../db/migrations/runner.js";
import { PrincipalRepository } from "../db/repositories/principal-repository.js";
import { nullLogger } from "../observability/logger.js";
import { IMPLICIT_USER_EMAIL } from "../principals/operator-principal.js";
import { DashboardIdentityClaimError, DashboardIdentityResolver } from "./identity.js";

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
  expect(repo.get("00000000-0000-4000-8000-000000000001")).toBeUndefined();
  expect(db.prepare("SELECT COUNT(*) AS n FROM users").get()).toEqual({ n: 1 });
});

it("claims the explicitly provisioned unbound user matching a verified email", () => {
  const pending = repo.createUser({
    email: "owner@example.com",
    createdAt: new Date().toISOString(),
  });
  expect(resolver.resolve(token()).id).toBe(pending.id);
  expect(repo.getUser(pending.id)?.identity).toEqual({ issuer: ISSUER, subject: "uid" });
});

it("claims the local implicit user once, then provisions distinct verified users", () => {
  const local = repo.ensureImplicitUser("2026-10-01T00:00:00Z");
  if (!local) throw new Error("Expected durable user fixture");
  expect(resolver.resolve(token()).id).toBe(local.id);
  expect(resolver.resolve(token()).id).toBe(local.id);
  expect(
    resolver.resolve(token({ uid: "other", sub: "other", email: "other@example.com" })).id
  ).not.toBe(local.id);
  expect(repo.listUsers()).toHaveLength(2);
});

it("does not resolve reserved bootstrap email as a verified login", () => {
  const local = repo.ensureImplicitUser("2026-10-01T00:00:00Z");
  if (!local) throw new Error("Expected durable user fixture");
  expect(() => resolver.resolve(token({ email: IMPLICIT_USER_EMAIL }))).toThrow(
    "Reserved admission email"
  );
  expect(repo.getUser(local.id)?.identity).toBeUndefined();
});

it("never rebinds a user already held by another identity", () => {
  const pending = repo.createUser({
    email: "owner@example.com",
    createdAt: new Date().toISOString(),
  });
  repo.bindExternalIdentity(
    pending.id,
    { issuer: ISSUER, subject: "different" },
    new Date().toISOString()
  );
  expect(() => resolver.resolve(token())).toThrow(DashboardIdentityClaimError);
  expect(repo.getUser(pending.id)?.identity?.subject).toBe("different");
});

it("never reassigns an existing identity holder to a provisioned email", () => {
  const pending = repo.createUser({
    email: "owner@example.com",
    createdAt: new Date().toISOString(),
  });
  const holder = repo.createUser({
    email: "other@example.com",
    identity: { issuer: ISSUER, subject: "uid" },
    createdAt: new Date().toISOString(),
  });

  let resolutionError: unknown;
  try {
    resolver.resolve(token());
  } catch (error) {
    resolutionError = error;
  }
  expect(resolutionError).toBeInstanceOf(Error);
  expect(resolutionError).not.toBeInstanceOf(DashboardIdentityClaimError);

  expect(repo.getUser(pending.id)?.identity).toBeUndefined();
  expect(repo.getUser(holder.id)?.identity).toEqual({ issuer: ISSUER, subject: "uid" });
  expect(repo.getUser(holder.id)?.email).toBe("other@example.com");
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

it("names the conflicting bound row without logging its email", () => {
  const warn = vi.fn();
  const logged = new DashboardIdentityResolver(() => repo, "project", {
    ...nullLogger,
    warn,
  });
  const pending = repo.createUser({
    email: "owner@example.com",
    identity: { issuer: ISSUER, subject: "different" },
    createdAt: new Date().toISOString(),
  });
  expect(() => logged.resolve(token())).toThrow(DashboardIdentityClaimError);
  expect(warn).toHaveBeenCalledWith("dashboard_identity_email_conflict", {
    holderId: pending.id,
    holderBound: true,
  });
  // A returning-user email collision preserves the staging 401 boundary.
  const returning = logged.resolve(token({ email: "other@example.com" }));
  warn.mockClear();
  let updateError: unknown;
  try {
    logged.resolve(token());
  } catch (error) {
    updateError = error;
  }
  expect(updateError).toBeInstanceOf(Error);
  expect(updateError).not.toBeInstanceOf(DashboardIdentityClaimError);
  expect(warn).toHaveBeenCalledWith("dashboard_identity_email_conflict", {
    holderId: pending.id,
    holderBound: true,
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

it("records the Google account id from the verified sign-in token, never moving one another user holds", () => {
  const warn = vi.fn();
  const logged = new DashboardIdentityResolver(() => repo, "project", { ...nullLogger, warn });
  // Synthetic Google account ids; never a real person's.
  const google = (id: string) =>
    token({
      firebase: { identities: { "google.com": [id] }, sign_in_provider: "google.com" },
    } as Partial<DecodedIdToken>);
  const at = new Date().toISOString();

  const owner = logged.resolve(google("100000000000000000001"));
  logged.recordAuthentication(owner, at, google("100000000000000000001"));
  expect(repo.getUser(owner.id)?.googleAccountId).toBe("100000000000000000001");
  expect(repo.findUserByGoogleAccountId("100000000000000000001")?.id).toBe(owner.id);

  // A token without a Google identity leaves the recorded id alone.
  logged.recordAuthentication(owner, at, token());
  expect(repo.getUser(owner.id)?.googleAccountId).toBe("100000000000000000001");

  // Another user presenting the same Google id is logged by id and not rebound.
  const other = repo.createUser({
    email: "other@example.com",
    identity: { issuer: ISSUER, subject: "other" },
    createdAt: at,
  });
  logged.recordAuthentication(other, at, google("100000000000000000001"));
  expect(repo.getUser(other.id)?.googleAccountId).toBeUndefined();
  expect(repo.getUser(owner.id)?.googleAccountId).toBe("100000000000000000001");
  expect(warn).toHaveBeenCalledWith("dashboard_google_account_conflict", {
    userId: other.id,
    holderId: owner.id,
  });
  expect(repo.getUser(other.id)?.lastAuthenticatedAt).toBe(at);
});

it("treats a Google id taken by a concurrent sign-in as the same logged conflict", () => {
  const warn = vi.fn();
  const logged = new DashboardIdentityResolver(() => repo, "project", { ...nullLogger, warn });
  const at = new Date().toISOString();
  // Synthetic Google account id; never a real person's.
  const googleId = "100000000000000000002";
  const owner = repo.createUser({
    email: "owner@example.com",
    identity: { issuer: ISSUER, subject: "owner" },
    createdAt: at,
  });
  repo.setGoogleAccountId(owner.id, googleId);
  const other = repo.createUser({
    email: "other@example.com",
    identity: { issuer: ISSUER, subject: "other" },
    createdAt: at,
  });
  // The other sign-in read the id as free just before the owner's write landed.
  vi.spyOn(repo, "findUserByGoogleAccountId").mockReturnValueOnce(undefined);

  logged.recordAuthentication(
    other,
    at,
    token({
      firebase: { identities: { "google.com": [googleId] }, sign_in_provider: "google.com" },
    } as Partial<DecodedIdToken>)
  );
  expect(repo.getUser(other.id)?.googleAccountId).toBeUndefined();
  expect(repo.getUser(owner.id)?.googleAccountId).toBe(googleId);
  expect(repo.getUser(other.id)?.lastAuthenticatedAt).toBe(at);
  expect(warn).toHaveBeenCalledWith("dashboard_google_account_conflict", {
    userId: other.id,
    holderId: owner.id,
  });
});
