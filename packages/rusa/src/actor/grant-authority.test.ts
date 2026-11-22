import { describe, expect, it } from "vitest";
import {
  ACTOR_ADMIN_CAPABILITY,
  CAPABILITY_ADMIN_CAPABILITY,
  defaultActorBootstrapCapabilities,
  defaultActorCapabilityPolicy,
} from "./administrative-capabilities.js";
import {
  type CapabilityGrant,
  type DelegationReach,
  effectiveActiveGrants,
  effectiveCapabilities,
} from "./capability-grants.js";
import { assertGrantAuthority, type GrantAuthorityReader } from "./grant-authority.js";

function makeReader(
  actors: Record<string, { parentId?: string | null; status?: string }>,
  grants: readonly CapabilityGrant[],
  policy: ReturnType<ReturnType<typeof defaultActorCapabilityPolicy>> | null = null
): GrantAuthorityReader {
  return {
    actor: (id) => actors[id],
    capabilities: (id) => effectiveCapabilities(grants, id, policy),
    activeGrants: (id) => effectiveActiveGrants(grants, id, policy),
  };
}

function grantRow(
  actorId: string,
  capability: string,
  grantedBy: string,
  delegable?: DelegationReach
): CapabilityGrant {
  return {
    actorId,
    capability,
    grantedBy,
    grantedAt: "2026-11-22T13:00:00.000Z",
    ...(delegable ? { delegable } : {}),
  };
}

describe("assertGrantAuthority (#1346 grant delegation flag)", () => {
  const tree = {
    root: { parentId: null, status: "active" },
    parent: { parentId: "root", status: "active" },
    child: { parentId: "parent", status: "active" },
    grandchild: { parentId: "child", status: "active" },
    sibling: { parentId: "root", status: "active" },
    otherRoot: { parentId: null, status: "active" },
    otherChild: { parentId: "otherRoot", status: "active" },
  };

  it("refuses delegation when the grantor holds the capability without a delegable flag", () => {
    const reader = makeReader(tree, [grantRow("parent", "secret:gemini-api-key", "root")]);
    expect(() =>
      assertGrantAuthority(reader, {
        grantorId: "parent",
        granteeId: "child",
        capability: "secret:gemini-api-key",
        verb: "grant",
      })
    ).toThrow();
  });

  it("refuses delegation when the grantor does not hold the capability (old parent-grantable list removed)", () => {
    const reader = makeReader(tree, []);
    expect(() =>
      assertGrantAuthority(reader, {
        grantorId: "parent",
        granteeId: "child",
        capability: "secret:gemini-api-key",
        verb: "grant",
      })
    ).toThrow();
  });

  it("allows descendants-flagged grant to whole subtree (child and grandchild), refuses outside subtree", () => {
    const reader = makeReader(tree, [
      grantRow("parent", "secret:gemini-api-key", "root", "descendants"),
    ]);

    expect(() =>
      assertGrantAuthority(reader, {
        grantorId: "parent",
        granteeId: "child",
        capability: "secret:gemini-api-key",
        verb: "grant",
      })
    ).not.toThrow();

    expect(() =>
      assertGrantAuthority(reader, {
        grantorId: "parent",
        granteeId: "grandchild",
        capability: "secret:gemini-api-key",
        verb: "grant",
      })
    ).not.toThrow();

    expect(() =>
      assertGrantAuthority(reader, {
        grantorId: "parent",
        granteeId: "sibling",
        capability: "secret:gemini-api-key",
        verb: "grant",
      })
    ).toThrow();

    expect(() =>
      assertGrantAuthority(reader, {
        grantorId: "parent",
        granteeId: "otherRoot",
        capability: "secret:gemini-api-key",
        verb: "grant",
      })
    ).toThrow();
  });

  it("allows anyone-flagged grant to any existing actor, including another tree", () => {
    const reader = makeReader(tree, [grantRow("parent", "understanding-write", "root", "anyone")]);

    expect(() =>
      assertGrantAuthority(reader, {
        grantorId: "parent",
        granteeId: "otherChild",
        capability: "understanding-write",
        verb: "grant",
      })
    ).not.toThrow();
  });

  it("allows passing a delegable flag no wider than the grantor's own reach, refuses widening", () => {
    const reader = makeReader(tree, [
      grantRow("parent", "secret:gemini-api-key", "root", "descendants"),
      grantRow("sibling", "understanding-write", "root", "anyone"),
    ]);

    expect(() =>
      assertGrantAuthority(reader, {
        grantorId: "parent",
        granteeId: "child",
        capability: "secret:gemini-api-key",
        verb: "grant",
        delegable: "descendants",
      })
    ).not.toThrow();

    expect(() =>
      assertGrantAuthority(reader, {
        grantorId: "parent",
        granteeId: "child",
        capability: "secret:gemini-api-key",
        verb: "grant",
        delegable: "anyone",
      })
    ).toThrow();

    expect(() =>
      assertGrantAuthority(reader, {
        grantorId: "sibling",
        granteeId: "otherChild",
        capability: "understanding-write",
        verb: "grant",
        delegable: "descendants",
      })
    ).not.toThrow();

    expect(() =>
      assertGrantAuthority(reader, {
        grantorId: "sibling",
        granteeId: "otherChild",
        capability: "understanding-write",
        verb: "grant",
        delegable: "anyone",
      })
    ).not.toThrow();
  });

  it("ruling 1: default actor policy communication capabilities are delegable to anyone, admin capabilities stay subtree-bound", () => {
    const caps = defaultActorBootstrapCapabilities({
      chat: { gchat: ["spaces/S1"] },
      slack: { appToken: "xapp", botToken: "xoxb" },
    } as never);
    const policy = defaultActorCapabilityPolicy(() => "root", caps)();
    const reader = makeReader(tree, [], policy);

    // Communication capabilities cross trees (whole space and narrowed thread)
    expect(() =>
      assertGrantAuthority(reader, {
        grantorId: "root",
        granteeId: "otherChild",
        capability: "chat-write:spaces/S1/threads/T1",
        verb: "grant",
      })
    ).not.toThrow();

    expect(() =>
      assertGrantAuthority(reader, {
        grantorId: "root",
        granteeId: "otherChild",
        capability: "chat-write:spaces/S1",
        verb: "grant",
      })
    ).not.toThrow();

    expect(() =>
      assertGrantAuthority(reader, {
        grantorId: "root",
        granteeId: "otherChild",
        capability: "slack-write:*",
        verb: "grant",
      })
    ).not.toThrow();

    // Admin capabilities stay subtree-bound
    expect(() =>
      assertGrantAuthority(reader, {
        grantorId: "root",
        granteeId: "otherChild",
        capability: CAPABILITY_ADMIN_CAPABILITY,
        verb: "grant",
      })
    ).toThrow();

    expect(() =>
      assertGrantAuthority(reader, {
        grantorId: "root",
        granteeId: "otherChild",
        capability: ACTOR_ADMIN_CAPABILITY,
        verb: "grant",
      })
    ).toThrow();
  });

  it("ruling 2: whole-space chat-write without flag cannot grant threads; with descendants flag can grant space or thread in subtree", () => {
    const unflagged = makeReader(tree, [grantRow("parent", "chat-write:spaces/S1", "root")]);
    expect(() =>
      assertGrantAuthority(unflagged, {
        grantorId: "parent",
        granteeId: "child",
        capability: "chat-write:spaces/S1/threads/T1",
        verb: "grant",
      })
    ).toThrow();

    const flagged = makeReader(tree, [
      grantRow("parent", "chat-write:spaces/S1", "root", "descendants"),
    ]);
    expect(() =>
      assertGrantAuthority(flagged, {
        grantorId: "parent",
        granteeId: "child",
        capability: "chat-write:spaces/S1/threads/T1",
        verb: "grant",
      })
    ).not.toThrow();

    expect(() =>
      assertGrantAuthority(flagged, {
        grantorId: "parent",
        granteeId: "grandchild",
        capability: "chat-write:spaces/S1",
        verb: "grant",
      })
    ).not.toThrow();

    expect(() =>
      assertGrantAuthority(flagged, {
        grantorId: "parent",
        granteeId: "sibling",
        capability: "chat-write:spaces/S1/threads/T1",
        verb: "grant",
      })
    ).toThrow();
  });

  it("ruling 3: delegator may revoke what it granted, refuses revoking another grantor's row; admin revokes any row in subtree", () => {
    const reader = makeReader(tree, [
      grantRow("root", CAPABILITY_ADMIN_CAPABILITY, "system:test"),
      grantRow("parent", "secret:gemini-api-key", "root", "descendants"),
      grantRow("child", "secret:gemini-api-key", "parent"),
      grantRow("grandchild", "secret:gemini-api-key", "root"),
    ]);

    // Parent can revoke what parent granted
    expect(() =>
      assertGrantAuthority(reader, {
        grantorId: "parent",
        granteeId: "child",
        capability: "secret:gemini-api-key",
        verb: "revoke",
      })
    ).not.toThrow();

    // Parent cannot revoke what root granted
    expect(() =>
      assertGrantAuthority(reader, {
        grantorId: "parent",
        granteeId: "grandchild",
        capability: "secret:gemini-api-key",
        verb: "revoke",
      })
    ).toThrow();

    // Admin can revoke what parent granted inside admin's subtree
    expect(() =>
      assertGrantAuthority(reader, {
        grantorId: "root",
        granteeId: "child",
        capability: "secret:gemini-api-key",
        verb: "revoke",
      })
    ).not.toThrow();
  });

  it("ruling 4: re-grant refuses overwriting another grantor's active row, allows original grantor to update flag, allows admin in subtree", () => {
    const reader = makeReader(tree, [
      grantRow("root", CAPABILITY_ADMIN_CAPABILITY, "system:test"),
      grantRow("parent", "secret:gemini-api-key", "root", "descendants"),
      grantRow("child", "secret:gemini-api-key", "parent"),
      grantRow("grandchild", "secret:gemini-api-key", "root"),
    ]);

    // Original grantor can re-grant its own row (e.g. to change delegable flag)
    expect(() =>
      assertGrantAuthority(reader, {
        grantorId: "parent",
        granteeId: "child",
        capability: "secret:gemini-api-key",
        verb: "grant",
        delegable: "descendants",
      })
    ).not.toThrow();

    // Non-admin cannot overwrite an active row granted by someone else
    expect(() =>
      assertGrantAuthority(reader, {
        grantorId: "parent",
        granteeId: "grandchild",
        capability: "secret:gemini-api-key",
        verb: "grant",
      })
    ).toThrow();

    // Admin can replace any row in its subtree
    expect(() =>
      assertGrantAuthority(reader, {
        grantorId: "root",
        granteeId: "child",
        capability: "secret:gemini-api-key",
        verb: "grant",
        delegable: "anyone",
      })
    ).not.toThrow();
  });
});
