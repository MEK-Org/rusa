import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../migrations/runner.js";
import { Repositories } from "./index.js";
import {
  SlackPrincipalBindingError,
  type SlackPrincipalBindingRepository,
} from "./slack-principal-binding-repository.js";

const AT = "2026-10-14T00:00:00.000Z";
const LATER = "2026-10-14T01:00:00.000Z";
// Synthetic Slack ids; not a real workspace or user.
const HOME = "T0HOME";
const U1 = "U0ONE";

/** The audit trail for one pair, read straight from its table, oldest first. */
function auditEvents(db: Database.Database, workspaceId: string, slackUserId: string) {
  const rows = db
    .prepare(
      `SELECT * FROM slack_principal_binding_events
       WHERE workspace_id = ? AND slack_user_id = ? ORDER BY id`
    )
    .all(workspaceId, slackUserId) as Array<{
    id: number;
    workspace_id: string;
    slack_user_id: string;
    action: string;
    principal_id: string;
    operator_id: string;
    decision_ref: string;
    occurred_at: string;
    prior_json: string | null;
  }>;
  return rows.map(({ prior_json, ...row }) => ({
    ...row,
    prior: prior_json === null ? null : (JSON.parse(prior_json) as Record<string, unknown>),
  }));
}

describe("SlackPrincipalBindingRepository (#1038)", () => {
  let db: Database.Database;
  let bindings: SlackPrincipalBindingRepository;
  let repos: Repositories;
  let alice: string;
  let bob: string;
  let operator: string;

  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db);
    db.pragma("foreign_keys = ON");
    db.prepare(
      "INSERT INTO actors (id, charter, parent_id, created_at) VALUES ('some-actor', 'c', NULL, ?)"
    ).run(AT);
    repos = new Repositories(db);
    bindings = repos.slackPrincipalBindings;
    alice = repos.principals.createUser({ email: "alice@example.test", createdAt: AT }).id;
    bob = repos.principals.createUser({ email: "bob@example.test", createdAt: AT }).id;
    operator = repos.principals.createUser({ email: "operator@example.test", createdAt: AT }).id;
  });

  const grant = (principalId: string, overrides: Record<string, string> = {}) =>
    bindings.grant({
      workspaceId: HOME,
      slackUserId: U1,
      principalId,
      operatorId: operator,
      decisionRef: "mesh:messages/grant-1",
      at: AT,
      ...overrides,
    });
  const revoke = (overrides: Record<string, string> = {}) =>
    bindings.revoke({
      workspaceId: HOME,
      slackUserId: U1,
      operatorId: operator,
      decisionRef: "mesh:messages/revoke-1",
      at: LATER,
      ...overrides,
    });
  const refusal = (fn: () => unknown) => {
    try {
      fn();
    } catch (error) {
      if (error instanceof SlackPrincipalBindingError) return error.code;
      throw error;
    }
    return "accepted";
  };

  it("grants an exact pair once and audits it", () => {
    expect(grant(alice)).toEqual({
      changed: true,
      binding: {
        workspaceId: HOME,
        slackUserId: U1,
        principalId: alice,
        grantedAt: AT,
        grantedBy: operator,
        grantRef: "mesh:messages/grant-1",
      },
    });
    expect(bindings.activePrincipalId(HOME, U1)).toBe(alice);
    // Only that exact pair.
    expect(bindings.activePrincipalId("T0OTHER", U1)).toBeUndefined();
    expect(bindings.activePrincipalId(HOME, U1.toLowerCase())).toBeUndefined();

    // A repeat is a no-op that writes no second audit row.
    expect(grant(alice, { decisionRef: "mesh:messages/grant-again", at: LATER })).toMatchObject({
      changed: false,
      binding: { grantRef: "mesh:messages/grant-1", grantedAt: AT },
    });
    expect(auditEvents(db, HOME, U1)).toEqual([
      {
        id: expect.any(Number),
        workspace_id: HOME,
        slack_user_id: U1,
        action: "grant",
        principal_id: alice,
        operator_id: operator,
        decision_ref: "mesh:messages/grant-1",
        occurred_at: AT,
        prior: null,
      },
    ]);
  });

  it("refuses a silent rebind and records an explicit one with its prior states", () => {
    grant(alice);
    expect(refusal(() => grant(bob))).toBe("conflict");
    expect(bindings.activePrincipalId(HOME, U1)).toBe(alice);

    expect(revoke()).toMatchObject({
      changed: true,
      binding: { principalId: alice, revokedAt: LATER, revokedBy: operator },
    });
    expect(bindings.activePrincipalId(HOME, U1)).toBeUndefined();
    expect(revoke({ decisionRef: "mesh:messages/revoke-again" })).toMatchObject({
      changed: false,
      binding: { revokeRef: "mesh:messages/revoke-1" },
    });

    const rebound = grant(bob, { decisionRef: "mesh:messages/grant-2", at: LATER });
    expect(rebound).toEqual({
      changed: true,
      binding: {
        workspaceId: HOME,
        slackUserId: U1,
        principalId: bob,
        grantedAt: LATER,
        grantedBy: operator,
        grantRef: "mesh:messages/grant-2",
      },
    });
    expect(bindings.activePrincipalId(HOME, U1)).toBe(bob);

    const events = auditEvents(db, HOME, U1);
    expect(events.map((event) => [event.action, event.principal_id, event.decision_ref])).toEqual([
      ["grant", alice, "mesh:messages/grant-1"],
      ["revoke", alice, "mesh:messages/revoke-1"],
      ["grant", bob, "mesh:messages/grant-2"],
    ]);
    expect(events[1]?.prior).toMatchObject({ principalId: alice });
    expect(events[1]?.prior).not.toHaveProperty("revokedAt");
    expect(events[2]?.prior).toMatchObject({
      principalId: alice,
      revokedAt: LATER,
      revokeRef: "mesh:messages/revoke-1",
    });
  });

  it("binds only enabled human users, granted by an enabled user", () => {
    const disabled = repos.principals.createUser({
      email: "disabled@example.test",
      createdAt: AT,
    }).id;
    repos.principals.setDisabled(disabled, AT);

    for (const target of ["some-actor", "system:mesh", disabled, "no-such-principal"]) {
      expect(
        refusal(() => grant(target)),
        target
      ).toBe("invalid");
    }
    for (const actingAs of ["some-actor", "system:mesh", disabled]) {
      expect(
        refusal(() => grant(alice, { operatorId: actingAs })),
        actingAs
      ).toBe("invalid");
    }
    grant(alice);
    expect(refusal(() => revoke({ operatorId: "some-actor" }))).toBe("invalid");
    expect(bindings.activePrincipalId(HOME, U1)).toBe(alice);
    expect(auditEvents(db, HOME, U1)).toHaveLength(1);
  });

  it("refuses names, emails, malformed ids, missing decisions and unknown pairs", () => {
    const cases: Array<[string, Record<string, string>]> = [
      ["email as user", { slackUserId: "alice@example.test" }],
      ["display name as user", { slackUserId: "Alice Example" }],
      ["empty user", { slackUserId: "" }],
      ["empty workspace", { workspaceId: "" }],
      ["workspace with a path", { workspaceId: "T0/HOME" }],
      ["empty decision", { decisionRef: "" }],
      ["prose decision", { decisionRef: "operator said so" }],
    ];
    for (const [name, overrides] of cases) {
      expect(
        refusal(() => grant(alice, overrides)),
        name
      ).toBe("invalid");
    }
    expect(refusal(() => revoke())).toBe("not_found");
    expect(bindings.list()).toEqual([]);
  });

  it("stores the decision reference in canonical form", () => {
    expect(grant(alice, { decisionRef: "github:MEK-Org/rusa/issues/1038" }).binding.grantRef).toBe(
      "github:MEK-Org/rusa/issues/1038"
    );
  });
});
