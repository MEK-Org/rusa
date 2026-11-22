// One-off backfill for #1346. Throwaway: delete it once the production store
// has been migrated.
//
// Sets `delegable = 'descendants'` on every active (`revoked_at IS NULL`) row
// in `capability_grants` for the two formerly parent-grantable LLM secrets
// (`secret:gemini-api-key` and `secret:mistral-api-key`) whose `delegable`
// column is currently NULL. Leaves revoked rows, Chat rows, and all other
// capabilities untouched.
//
// Rollout order:
//   1. Deploy the release containing migration 0069_capability_grant_delegation.
//   2. Run this script in dry-run mode (default) on a copy or the live DB to
//      inspect before/after rows.
//   3. Run with --apply to flag the active LLM secret rows.
//      (Between step 1 and step 3, non-admin parents cannot delegate those
//      secrets until this script runs.)
//
// Without --apply, runs on a temporary copy and only reports.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";

const TARGET_CAPABILITIES = ["secret:gemini-api-key", "secret:mistral-api-key"];

function usage() {
  return [
    "Usage:",
    "  node packages/rusa/scripts/backfill-secret-delegation.mjs --database /path/to/mesh.db [--apply]",
    "",
    "Without --apply, runs on a temporary copy and reports rows before and after.",
    "With --apply, updates the database in place inside a single transaction.",
  ].join("\n");
}

function parseArgs(argv) {
  const result = { apply: false };
  for (let i = 2; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--") continue;
    if (flag === "--help") return { help: true };
    if (flag === "--apply") {
      result.apply = true;
      continue;
    }
    if (flag === "--database") {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) throw new Error("missing value for --database");
      result.database = resolve(value);
      i += 1;
      continue;
    }
    throw new Error(`unknown argument ${flag}`);
  }
  if (!result.database) throw new Error("--database is required");
  return result;
}

function readSnapshot(db) {
  const secretRows = db
    .prepare(
      `SELECT actor_id, capability, granted_by, granted_at, revoked_at, delegable
       FROM capability_grants
       WHERE capability IN (?, ?)
       ORDER BY capability, actor_id`
    )
    .all(...TARGET_CAPABILITIES);
  const activeChatRows = db
    .prepare(
      `SELECT actor_id, capability, granted_by, delegable
       FROM capability_grants
       WHERE capability LIKE 'chat-write:%' AND revoked_at IS NULL
       ORDER BY capability, actor_id`
    )
    .all();
  return { secretRows, activeChatRows };
}

function applyBackfill(db) {
  const tx = db.transaction(() => {
    return db
      .prepare(
        `UPDATE capability_grants
         SET delegable = 'descendants'
         WHERE capability IN (?, ?)
           AND revoked_at IS NULL
           AND delegable IS NULL`
      )
      .run(...TARGET_CAPABILITIES);
  });
  return tx().changes;
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log(usage());
    return;
  }

  let targetPath = args.database;
  let tempDir;
  let backupPath;
  if (!args.apply) {
    tempDir = await mkdtemp(join(tmpdir(), "rusa-backfill-1346-"));
    targetPath = join(tempDir, "mesh.db");
    const sourceDb = new Database(args.database, { fileMustExist: true, readonly: true });
    try {
      sourceDb.pragma("busy_timeout = 30000");
      await sourceDb.backup(targetPath);
    } finally {
      sourceDb.close();
    }
  } else {
    backupPath = `${args.database}.pre-1346-backfill-${Date.now()}.bak`;
    const sourceDb = new Database(args.database, { fileMustExist: true });
    try {
      sourceDb.pragma("busy_timeout = 30000");
      await sourceDb.backup(backupPath);
    } finally {
      sourceDb.close();
    }
  }

  try {
    const db = new Database(targetPath, { fileMustExist: true });
    try {
      db.pragma("busy_timeout = 30000");
      const columns = db.prepare("PRAGMA table_info(capability_grants)").all();
      if (!columns.some((col) => col.name === "delegable")) {
        throw new Error(
          "capability_grants.delegable column not found; apply migration 0069_capability_grant_delegation first"
        );
      }
      const before = readSnapshot(db);
      const updated = applyBackfill(db);
      const after = readSnapshot(db);
      console.log(
        JSON.stringify(
          {
            mode: args.apply ? "apply" : "dry-run",
            database: args.database,
            ...(backupPath ? { backupPath } : {}),
            updated,
            before,
            after,
          },
          null,
          2
        )
      );
    } finally {
      db.close();
    }
  } finally {
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
