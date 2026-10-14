import type Database from "better-sqlite3";
import { parseReference } from "../../references/reference.js";
import type { PrincipalRepository } from "./principal-repository.js";

/** One operator-attested Slack identity for a human principal (#1038). */
export interface SlackPrincipalBinding {
  workspaceId: string;
  slackUserId: string;
  principalId: string;
  grantedAt: string;
  grantedBy: string;
  grantRef: string;
  revokedAt?: string;
  revokedBy?: string;
  revokeRef?: string;
}

export type SlackPrincipalBindingErrorCode = "invalid" | "not_found" | "conflict";

/** A refused grant or revoke; `code` maps to the API status. */
export class SlackPrincipalBindingError extends Error {
  constructor(
    readonly code: SlackPrincipalBindingErrorCode,
    message: string
  ) {
    super(message);
    this.name = "SlackPrincipalBindingError";
  }
}

export interface SlackPrincipalBindingGrant {
  workspaceId: string;
  slackUserId: string;
  principalId: string;
  operatorId: string;
  decisionRef: string;
  at: string;
}

export interface SlackPrincipalBindingRevoke {
  workspaceId: string;
  slackUserId: string;
  operatorId: string;
  decisionRef: string;
  at: string;
}

/** `changed` is false for an idempotent repeat, which writes nothing. */
export interface SlackPrincipalBindingChange {
  changed: boolean;
  binding: SlackPrincipalBinding;
}

type BindingRow = {
  workspace_id: string;
  slack_user_id: string;
  principal_id: string;
  granted_at: string;
  granted_by: string;
  grant_ref: string;
  revoked_at: string | null;
  revoked_by: string | null;
  revoke_ref: string | null;
};

/**
 * Slack team and user ids are opaque alphanumerics; anything else is not one.
 * The migration's GLOB is the backstop for writes; this turns bad input into
 * a typed refusal and checks payload fields that never reach the table.
 */
export const SLACK_ID = /^[A-Za-z0-9]+$/;

function toBinding(row: BindingRow): SlackPrincipalBinding {
  return {
    workspaceId: row.workspace_id,
    slackUserId: row.slack_user_id,
    principalId: row.principal_id,
    grantedAt: row.granted_at,
    grantedBy: row.granted_by,
    grantRef: row.grant_ref,
    ...(row.revoked_at !== null ? { revokedAt: row.revoked_at } : {}),
    ...(row.revoked_by !== null ? { revokedBy: row.revoked_by } : {}),
    ...(row.revoke_ref !== null ? { revokeRef: row.revoke_ref } : {}),
  };
}

/**
 * Operator-managed Slack identity bindings (#1038). The repository is the
 * only writer: each grant or revoke checks that the bound human and the
 * acting operator are enabled users, requires a parseable decision reference,
 * and appends its audit row in the same transaction. Nothing here derives a
 * binding from a display name, an email or a message; the caller supplies
 * the exact pair an operator attested.
 */
export class SlackPrincipalBindingRepository {
  constructor(
    private readonly db: Database.Database,
    private readonly principals: PrincipalRepository
  ) {}

  get(workspaceId: string, slackUserId: string): SlackPrincipalBinding | undefined {
    const row = this.db
      .prepare(
        "SELECT * FROM slack_principal_bindings WHERE workspace_id = ? AND slack_user_id = ?"
      )
      .get(workspaceId, slackUserId) as BindingRow | undefined;
    return row ? toBinding(row) : undefined;
  }

  private mustGet(workspaceId: string, slackUserId: string): SlackPrincipalBinding {
    const binding = this.get(workspaceId, slackUserId);
    if (!binding) throw new Error("Slack principal binding vanished inside its transaction");
    return binding;
  }

  /** Every binding, active and revoked, in key order. */
  list(): SlackPrincipalBinding[] {
    const rows = this.db
      .prepare("SELECT * FROM slack_principal_bindings ORDER BY workspace_id, slack_user_id")
      .all() as BindingRow[];
    return rows.map(toBinding);
  }

  /** The principal an active binding names, or undefined. Does not check the user. */
  activePrincipalId(workspaceId: string, slackUserId: string): string | undefined {
    const row = this.db
      .prepare(
        `SELECT principal_id FROM slack_principal_bindings
         WHERE workspace_id = ? AND slack_user_id = ? AND revoked_at IS NULL`
      )
      .get(workspaceId, slackUserId) as { principal_id: string } | undefined;
    return row?.principal_id;
  }

  /**
   * Bind the exact pair to an existing enabled human. Repeating an active
   * binding to the same human is a no-op. An active binding to someone else
   * is refused: rebinding is an explicit revoke and then a new grant.
   */
  grant(input: SlackPrincipalBindingGrant): SlackPrincipalBindingChange {
    const decisionRef = this.validate(input);
    this.requireEnabledUser(input.principalId, "principalId");
    return this.db.transaction((): SlackPrincipalBindingChange => {
      const prior = this.get(input.workspaceId, input.slackUserId);
      if (prior && prior.revokedAt === undefined) {
        if (prior.principalId === input.principalId) return { changed: false, binding: prior };
        throw new SlackPrincipalBindingError(
          "conflict",
          "this Slack identity is bound to another principal; revoke it before granting it again"
        );
      }
      this.db
        .prepare(
          `INSERT INTO slack_principal_bindings
             (workspace_id, slack_user_id, principal_id, granted_at, granted_by, grant_ref)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (workspace_id, slack_user_id) DO UPDATE SET
             principal_id = excluded.principal_id,
             granted_at = excluded.granted_at,
             granted_by = excluded.granted_by,
             grant_ref = excluded.grant_ref,
             revoked_at = NULL, revoked_by = NULL, revoke_ref = NULL`
        )
        .run(
          input.workspaceId,
          input.slackUserId,
          input.principalId,
          input.at,
          input.operatorId,
          decisionRef
        );
      this.appendEvent("grant", input.principalId, input, decisionRef, prior);
      return { changed: true, binding: this.mustGet(input.workspaceId, input.slackUserId) };
    })();
  }

  /** End an active binding. Repeating a revoke is a no-op; an unknown pair is refused. */
  revoke(input: SlackPrincipalBindingRevoke): SlackPrincipalBindingChange {
    const decisionRef = this.validate(input);
    return this.db.transaction((): SlackPrincipalBindingChange => {
      const prior = this.get(input.workspaceId, input.slackUserId);
      if (!prior) {
        throw new SlackPrincipalBindingError(
          "not_found",
          "no binding exists for this Slack identity"
        );
      }
      if (prior.revokedAt !== undefined) return { changed: false, binding: prior };
      this.db
        .prepare(
          `UPDATE slack_principal_bindings SET revoked_at = ?, revoked_by = ?, revoke_ref = ?
           WHERE workspace_id = ? AND slack_user_id = ?`
        )
        .run(input.at, input.operatorId, decisionRef, input.workspaceId, input.slackUserId);
      this.appendEvent("revoke", prior.principalId, input, decisionRef, prior);
      return { changed: true, binding: this.mustGet(input.workspaceId, input.slackUserId) };
    })();
  }

  /** Shape checks shared by grant and revoke; returns the canonical decision ref. */
  private validate(input: {
    workspaceId: string;
    slackUserId: string;
    operatorId: string;
    decisionRef: string;
  }): string {
    if (!SLACK_ID.test(input.workspaceId)) {
      throw new SlackPrincipalBindingError("invalid", "workspaceId must be a Slack team id");
    }
    if (!SLACK_ID.test(input.slackUserId)) {
      throw new SlackPrincipalBindingError("invalid", "slackUserId must be a Slack user id");
    }
    this.requireEnabledUser(input.operatorId, "operator");
    try {
      return parseReference(input.decisionRef).key;
    } catch {
      throw new SlackPrincipalBindingError(
        "invalid",
        "decisionRef must be a reference to the decision, such as mesh:messages/<id>"
      );
    }
  }

  private requireEnabledUser(principalId: string, role: string): void {
    const user = this.principals.getUser(principalId);
    if (!user || user.disabledAt !== undefined) {
      throw new SlackPrincipalBindingError("invalid", `${role} must be an enabled user principal`);
    }
  }

  private appendEvent(
    action: "grant" | "revoke",
    principalId: string,
    input: { workspaceId: string; slackUserId: string; operatorId: string; at: string },
    decisionRef: string,
    prior: SlackPrincipalBinding | undefined
  ): void {
    this.db
      .prepare(
        `INSERT INTO slack_principal_binding_events
           (workspace_id, slack_user_id, action, principal_id, operator_id, decision_ref,
            occurred_at, prior_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.workspaceId,
        input.slackUserId,
        action,
        principalId,
        input.operatorId,
        decisionRef,
        input.at,
        prior ? JSON.stringify(prior) : null
      );
  }
}
