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
} from "./capability-grants.js";
import { assertGrantAuthority, type GrantAuthorityReader } from "./grant-authority.js";

function makeReader(
  actors: Record<string, { parentId?: string | null; status?: string }>,
  grants: readonly CapabilityGrant[],
  policy: ReturnType<ReturnType<typeof defaultActorCapabilityPolicy>> | null = null
): GrantAuthorityReader {
  return {
    actor: (id) => actors[id],
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
    ).toThrow(/lacks capability-admin and holds no delegable grant covering secret:gemini-api-key/);
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
    ).toThrow(/lacks capability-admin and holds no delegable grant covering secret:gemini-api-key/);
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
    ).toThrow(/may only delegate secret:gemini-api-key within its own subtree/);

    expect(() =>
      assertGrantAuthority(reader, {
        grantorId: "parent",
        granteeId: "otherRoot",
        capability: "secret:gemini-api-key",
        verb: "grant",
      })
    ).toThrow(/may only delegate secret:gemini-api-key within its own subtree/);
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
    ).toThrow(
      /cannot grant secret:gemini-api-key with delegable="anyone": its own reach is "descendants"/
    );

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
    ).toThrow(/may only grant capabilities in its own subtree/);

    expect(() =>
      assertGrantAuthority(reader, {
        grantorId: "root",
        granteeId: "otherChild",
        capability: ACTOR_ADMIN_CAPABILITY,
        verb: "grant",
      })
    ).toThrow(/may only grant capabilities in its own subtree/);
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
    ).toThrow(
      /lacks capability-admin and holds no delegable grant covering chat-write:spaces\/S1\/threads\/T1/
    );

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
    ).toThrow(/may only delegate chat-write:spaces\/S1\/threads\/T1 within its own subtree/);
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
    ).toThrow(/cannot revoke secret:gemini-api-key from grandchild: it was granted by root/);

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
    ).toThrow(
      /cannot overwrite active grant of secret:gemini-api-key on grandchild granted by root/
    );

    // Admin can replace any row in its subtree
    expect(() =>
      assertGrantAuthority(reader, {
        grantorId: "root",
        granteeId: "child",
        capability: "secret:gemini-api-key",
        verb: "grant",
        delegable: "descendants",
      })
    ).not.toThrow();
  });

  it('requires "anyone" reach for any capability-admin (root or parentless non-root) to mint delegable="anyone"', () => {
    const policy = defaultActorCapabilityPolicy(
      () => "root",
      defaultActorBootstrapCapabilities({
        chat: { projectId: "p", subscription: "s", pubsubKeyPath: "/k" },
      })
    )();
    const reader = makeReader(
      tree,
      [
        grantRow("parent", CAPABILITY_ADMIN_CAPABILITY, "root"),
        grantRow("parent", "secret:gemini-api-key", "root", "descendants"),
        grantRow("parent", "understanding-write", "root", "anyone"),
        grantRow("otherRoot", CAPABILITY_ADMIN_CAPABILITY, "operator"),
        grantRow("otherRoot", "secret:gemini-api-key", "operator", "descendants"),
      ],
      policy
    );

    // (a) Default actor may mint "anyone" on a policy communication capability
    expect(() =>
      assertGrantAuthority(reader, {
        grantorId: "root",
        granteeId: "child",
        capability: "chat-write:spaces/S1",
        verb: "grant",
        delegable: "anyone",
      })
    ).not.toThrow();

    // (b) Default actor with capability-admin is refused "anyone" on a secret row
    expect(() =>
      assertGrantAuthority(reader, {
        grantorId: "root",
        granteeId: "child",
        capability: "secret:gemini-api-key",
        verb: "grant",
        delegable: "anyone",
      })
    ).toThrow(/cannot grant secret:gemini-api-key with delegable="anyone"/);

    // (c) Parentless non-default capability-admin is refused "anyone" (#549 cross-tree isolation)
    expect(() =>
      assertGrantAuthority(reader, {
        grantorId: "otherRoot",
        granteeId: "otherChild",
        capability: "secret:gemini-api-key",
        verb: "grant",
        delegable: "anyone",
      })
    ).toThrow(/cannot grant secret:gemini-api-key with delegable="anyone"/);

    expect(() =>
      assertGrantAuthority(reader, {
        grantorId: "parent",
        granteeId: "child",
        capability: "secret:gemini-api-key",
        verb: "grant",
        delegable: "anyone",
      })
    ).toThrow(/cannot grant secret:gemini-api-key with delegable="anyone"/);

    expect(() =>
      assertGrantAuthority(reader, {
        grantorId: "parent",
        granteeId: "parent",
        capability: "secret:gemini-api-key",
        verb: "grant",
        delegable: "anyone",
      })
    ).toThrow(/cannot grant secret:gemini-api-key with delegable="anyone"/);

    // Subtree admin can still grant delegable="descendants" in its subtree
    expect(() =>
      assertGrantAuthority(reader, {
        grantorId: "parent",
        granteeId: "child",
        capability: "secret:gemini-api-key",
        verb: "grant",
        delegable: "descendants",
      })
    ).not.toThrow();

    // Admin that already holds "anyone" reach may pass "anyone"
    expect(() =>
      assertGrantAuthority(reader, {
        grantorId: "parent",
        granteeId: "child",
        capability: "understanding-write",
        verb: "grant",
        delegable: "anyone",
      })
    ).not.toThrow();
  });

  it("refuses non-admin self-delegation for both descendants and anyone reach", () => {
    const reader = makeReader(tree, [
      grantRow("parent", "chat-write:spaces/S1", "root", "descendants"),
      grantRow("sibling", "chat-write:spaces/S1", "root", "anyone"),
    ]);

    expect(() =>
      assertGrantAuthority(reader, {
        grantorId: "parent",
        granteeId: "parent",
        capability: "chat-write:spaces/S1/threads/T1",
        verb: "grant",
        delegable: "descendants",
      })
    ).toThrow(/cannot delegate .* to itself/);

    expect(() =>
      assertGrantAuthority(reader, {
        grantorId: "sibling",
        granteeId: "sibling",
        capability: "chat-write:spaces/S1/threads/T1",
        verb: "grant",
        delegable: "anyone",
      })
    ).toThrow(/cannot delegate .* to itself/);
  });
});
