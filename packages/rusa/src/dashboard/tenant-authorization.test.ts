import type { IncomingMessage, ServerResponse } from "node:http";
import type { DecodedIdToken } from "firebase-admin/auth";
import { beforeEach, expect, it, vi } from "vitest";
import type { ActorRecord } from "../actor/actor-record.js";
import type { PrincipalRepository } from "../db/repositories/principal-repository.js";
import type { UserPrincipal } from "../principals/principal-ref.js";
import { DashboardAuth } from "./auth.js";
import { DashboardIdentityResolver } from "./identity.js";
import { TenantAccessDenied, TenantAuthorization } from "./tenant-authorization.js";

// Two-root repository fixture; deliberately not a claim that the current single-root
// database/runtime can already host two users. No production constraints are disabled.
let actors: Map<string, ActorRecord>;
let users: Map<string, UserPrincipal>;
let authorization: TenantAuthorization;
let alice: IncomingMessage;
let bob: IncomingMessage;
const actor = (id: string, parentId: string | null): ActorRecord => ({
  id,
  parentId,
  charter: "fixture",
  status: "active",
  createdAt: "2026-09-12T00:00:00Z",
});

beforeEach(async () => {
  actors = new Map(
    [
      actor("root-a", null),
      actor("root-b", null),
      actor("child-a", "root-a"),
      actor("grandchild-a", "child-a"),
      actor("child-b", "root-b"),
      actor("root", null),
      actor("orphan", "missing"),
      actor("cycle-a", "cycle-b"),
      actor("cycle-b", "cycle-a"),
    ].map((record) => [record.id, record])
  );
  users = new Map(
    ["a", "b"].map((id) => [
      `user-${id}`,
      {
        kind: "user" as const,
        id: `user-${id}`,
        email: `${id}@example.com`,
        rootActorId: `root-${id}`,
        identity: { issuer: "https://securetoken.google.com/project", subject: id },
        createdAt: "2026-09-12T00:00:00Z",
      },
    ])
  );
  const repository = {
    getUser: (id: string) => users.get(id),
    findUserByExternalIdentity: (identity: { issuer: string; subject: string }) =>
      [...users.values()].find(
        (user) =>
          user.identity?.issuer === identity.issuer && user.identity.subject === identity.subject
      ),
  } as unknown as PrincipalRepository;
  authorization = new TenantAuthorization(repository, {
    get: (id) => actors.get(id),
    list: () => [...actors.values()],
  });
  const request = async (subject: string) => {
    const token = {
      iss: "https://session.firebase.google.com/project",
      sub: subject,
      uid: subject,
      email: `${subject}@example.com`,
      email_verified: true,
      exp: Date.now() / 1000 + 3600,
      firebase: { sign_in_provider: "google.com" },
    } as DecodedIdToken;
    const auth = new DashboardAuth(
      {
        email: token.email ?? "",
        firebase: {
          projectId: "project",
          apiKey: "test",
          authDomain: "localhost",
          serviceAccountKeyPath: "/unused",
        },
      },
      {
        verifySessionCookie: async () => token,
        verifyIdToken: async () => token,
        createSessionCookie: async () => "unused",
      },
      new DashboardIdentityResolver(() => repository)
    );
    const req = {
      method: "GET",
      headers: { cookie: "__Host-rusa_session=verified-fixture" },
    } as IncomingMessage;
    const res = {
      setHeader: vi.fn(),
      writeHead: vi.fn(),
      end: vi.fn(),
    } as unknown as ServerResponse;
    expect(await auth.authorize(req, res)).toBe(true);
    await auth.close();
    return req;
  };
  alice = await request("a");
  bob = await request("b");
});

it("scopes each verified user to its own opaque root and descendants", () => {
  expect(authorization.visibleActorIds(alice)).toEqual(["root-a", "child-a", "grandchild-a"]);
  expect(authorization.visibleActorIds(bob)).toEqual(["root-b", "child-b"]);
  expect(authorization.requireActor(alice, "grandchild-a").id).toBe("grandchild-a");
  expect(authorization.requireActor(bob, "child-b").id).toBe("child-b");
});

it.each([
  "root-b",
  "child-b",
  "root",
  "missing",
  "orphan",
  "cycle-a",
  "cycle-b",
])("denies foreign, aliased or broken actor path %s", (id) => {
  expect(() => authorization.requireActor(alice, id)).toThrow(TenantAccessDenied);
});

it("rejects mixed-tenant selections instead of treating filters as authority", () => {
  expect(() => authorization.requireActors(alice, ["child-a", "child-b"])).toThrow("Access denied");
  expect(authorization.requireActors(alice, [])).toEqual([]);
});

it("requires a server-bound authenticated request, ignoring caller-shaped headers", () => {
  const forged = {
    headers: { "x-user-id": "user-a", "x-root-id": "root-a", "x-principal": "human:operator" },
  } as unknown as IncomingMessage;
  expect(() => authorization.requireActor(forged, "child-a")).toThrow(TenantAccessDenied);
});

it("does not trust stale disablement, root bindings, or topology", () => {
  const user = users.get("user-a");
  if (!user) throw new Error("fixture");
  user.disabledAt = "now";
  expect(() => authorization.visibleActorIds(alice)).toThrow(TenantAccessDenied);
  delete user.disabledAt;
  delete user.rootActorId;
  expect(() => authorization.requireOwner(alice, "user-a")).toThrow(TenantAccessDenied);
  user.rootActorId = "child-a";
  expect(() => authorization.visibleActorIds(alice)).toThrow(TenantAccessDenied);
  user.rootActorId = "root-a";
  actors.set("child-a", actor("child-a", "root-b"));
  expect(() => authorization.requireActor(alice, "grandchild-a")).toThrow(TenantAccessDenied);
  users.delete("user-a");
  expect(() => authorization.visibleActorIds(alice)).toThrow(TenantAccessDenied);
});

it("allows only the user's own principal or actors as an object owner", () => {
  expect(() => authorization.requireOwner(alice, "user-a")).not.toThrow();
  expect(() => authorization.requireOwner(alice, "child-a")).not.toThrow();
  for (const owner of ["user-b", "child-b", "human:operator", "system:mesh", "missing"]) {
    expect(() => authorization.requireOwner(alice, owner)).toThrow(TenantAccessDenied);
  }
});

it("refuses a request whose durable external identity was cleared or reassigned", () => {
  const user = users.get("user-a");
  if (!user) throw new Error("fixture");
  delete user.identity;
  expect(() => authorization.visibleActorIds(alice)).toThrow(TenantAccessDenied);
  user.identity = { issuer: "https://securetoken.google.com/project", subject: "replacement" };
  expect(() => authorization.visibleActorIds(alice)).toThrow(TenantAccessDenied);
});

it("checks both reparent endpoints and refuses root moves and ancestry cycles", () => {
  expect(() => authorization.requireReparent(alice, "grandchild-a", "root-a")).not.toThrow();
  for (const [source, destination] of [
    ["child-a", "child-b"],
    ["child-b", "child-a"],
    ["root-a", "child-a"],
    ["child-a", "child-a"],
    ["child-a", "grandchild-a"],
  ]) {
    expect(() => authorization.requireReparent(alice, source, destination)).toThrow(
      TenantAccessDenied
    );
  }
});
