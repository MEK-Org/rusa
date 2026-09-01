import type { Database } from "better-sqlite3";
import type { Migration } from "./types.js";

/**
 * Move every stored reference onto the one URL-style grammar.
 *
 * Before this, the same idea had three independent spellings in the codebase:
 * `obligations.external_ref` (`github_issue:OWNER/REPO#N`), the artifact kinds
 * added days earlier (`mesh_chat:<id>`), and `event-subscriptions.resourceKey`
 * (`github_issue:REPO#N`). One grammar was always the intent; it just never got
 * written down, so each surface invented its own.
 *
 * The new form is `<scheme>:<path>` where the path is ours, not the provider's
 * URL — alternating `collection/id` pairs, rooted for GitHub at the standard
 * `OWNER/REPO` repository name:
 *
 *   github_issue:MEK-Org/rusa#33  ->  github:MEK-Org/rusa/issues/33
 *   github_pr:MEK-Org/rusa#76     ->  github:MEK-Org/rusa/pulls/76
 *   mesh_chat:<uuid>              ->  mesh:messages/<uuid>
 *   inbox_entry:<id>              ->  (dropped; see below)
 *   gchat_message:spaces/S/messages/M -> gchat:spaces/S/messages/M
 *
 * Rewritten in place rather than dual-read. Obligations are not meaningfully
 * adopted on staging or production (operator, 2026-08-30), so there is no
 * migration window to protect and a compatibility shim would only preserve the
 * ambiguity this exists to remove.
 *
 * `inbox_entry:<id>` cannot be rewritten: the new form addresses an entry as
 * `mesh:actors/<actor>/inbox/<entry>` because the store is keyed by (actor,
 * entry), and the old form recorded only the entry. Rather than guess an owner,
 * such rows are left untouched and will read as unparseable — which is the
 * honest outcome, and affects nothing today since no such ref has been written.
 */

/** `kind:value` in the retired grammar → a path in the new one. */
function rewrite(value: string): string | null {
  const separator = value.indexOf(":");
  if (separator <= 0) return null;
  const kind = value.slice(0, separator);
  const rest = value.slice(separator + 1);

  switch (kind) {
    case "github_issue":
    case "github_pr": {
      const match = /^(.+?)\/(.+?)#([1-9]\d*)$/.exec(rest);
      if (!match) return null;
      const collection = kind === "github_pr" ? "pulls" : "issues";
      return `github:${match[1]}/${match[2]}/${collection}/${match[3]}`;
    }
    case "mesh_chat":
      return rest ? `mesh:messages/${rest}` : null;
    case "gchat_message":
      return rest ? `gchat:${rest}` : null;
    default:
      return null;
  }
}

export const referenceGrammar: Migration = {
  id: "0029_reference_grammar",
  up: (db: Database) => {
    const tables = new Set(
      (
        db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
          name: string;
        }>
      ).map((row) => row.name)
    );

    const columns = new Set(
      (
        db.prepare("PRAGMA table_info(obligations)").all() as Array<{
          name: string;
        }>
      ).map((column) => column.name)
    );

    const rewriteColumn = (table: string, column: string): void => {
      const rows = db
        .prepare(
          `SELECT rowid AS rowid, ${column} AS value FROM ${table} WHERE ${column} IS NOT NULL`
        )
        .all() as Array<{ rowid: number; value: string }>;
      const update = db.prepare(`UPDATE ${table} SET ${column} = ? WHERE rowid = ?`);
      for (const row of rows) {
        const next = rewrite(row.value);
        // A value that does not match the retired grammar is either already in
        // the new one or something we cannot safely reinterpret; leaving it is
        // preferable to writing a guess.
        if (next !== null && next !== row.value) update.run(next, row.rowid);
      }
    };

    if (tables.has("obligations")) {
      if (columns.has("external_ref")) rewriteColumn("obligations", "external_ref");
      if (columns.has("resolution_ref")) rewriteColumn("obligations", "resolution_ref");
    }
    if (tables.has("obligation_artifacts")) {
      rewriteColumn("obligation_artifacts", "ref");
    }
  },
};
