// One-off backfill for #1282. Throwaway: delete it once the production store
// has been migrated.
//
// Moves the Claude Fable quota lanes that are keyed by an explicit model list
// (`claude-fable-5,claude-fable-5-1`, then the same list with a third model)
// onto the one lane keyed `claude-fable-*`, which the quota reader emits from
// now on. Run it once, after the reader has switched to the wildcard and with
// the quota coordinator stopped:
//
//   1. deploy the code that understands `claude-fable-*`
//   2. have the Claude quota reader emit `claude-fable-*` for the Fable window
//   3. stop the quota coordinator, run this with --apply, start it again
//
// What it does, per window kind, to the rows of every covered lane taken
// together in time order:
//   - rows of the oldest lane, up to the first row any other lane recorded,
//     are renamed in place: readings, period start and controller memory carry
//     unchanged;
//   - every row from that point on is re-inserted in order under the wildcard
//     key with its window duration derived again and its controller columns
//     cleared, then the controller reasons them again, as if the key had
//     always been the wildcard. A row whose five-minute slot is already taken
//     is dropped.
//
// Without --apply it does all of that on a temporary copy and only reports.

import { mkdir, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import Database from "better-sqlite3";
import {
  modelScopeKey,
  parseModelScopeKey,
  SharedQuotaStore,
} from "../build/maintenance/quota/shared-store.js";

const PROVIDER = "claude";
const PATTERN = "claude-fable-*";
const PREFIX = PATTERN.slice(0, -1);
const TARGET_SCOPE = modelScopeKey([PATTERN]);
const CONTROLLER_COLUMNS = [
  "controller_error",
  "controller_derivative",
  "controller_integral",
  "uncapped_interval_seconds",
  "interval_seconds",
];

function usage() {
  return [
    "Usage:",
    "  pnpm --filter rusa run backfill:fable-wildcard-lane -- \\",
    "    --database /absolute/path/to/quota.db --max-interval-seconds <n> [--apply] [--backup-dir <dir>]",
    "",
    "Without --apply, runs on a temporary copy and reports what would change.",
    "With --apply, keeps a backup beside the database and rewrites the live rows.",
    "Stop the quota coordinator before --apply and start it again afterwards.",
  ].join("\n");
}

function parseArgs(argv) {
  const result = { apply: false };
  for (let index = 2; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--") continue;
    if (flag === "--help") return { help: true };
    if (flag === "--apply") {
      result.apply = true;
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`missing value for ${flag}`);
    index += 1;
    if (flag === "--database") result.database = resolve(value);
    else if (flag === "--max-interval-seconds") result.maxIntervalSeconds = Number(value);
    else if (flag === "--backup-dir") result.backupDir = resolve(value);
    else throw new Error(`unknown argument ${flag}`);
  }
  if (!result.database) throw new Error("--database is required");
  if (!Number.isFinite(result.maxIntervalSeconds) || result.maxIntervalSeconds <= 0) {
    throw new Error("--max-interval-seconds must be positive (the coordinator's configured cap)");
  }
  return result;
}

/** True for a lane this backfill moves: an explicit list of Fable models only. */
function isCoveredListScope(modelScope) {
  if (modelScope === TARGET_SCOPE) return false;
  const models = parseModelScopeKey(modelScope);
  return (
    Array.isArray(models) &&
    models.length > 0 &&
    models.every((model) => !model.includes("*") && model.startsWith(PREFIX) && model !== PREFIX)
  );
}

function laneSummary(db) {
  return db
    .prepare(
      `SELECT model_scope AS modelScope, kind, COUNT(*) AS rows,
              MIN(observed_at) AS first, MAX(observed_at) AS last
       FROM quota_observations WHERE provider = ? AND model_scope <> ''
       GROUP BY model_scope, kind ORDER BY kind, first`
    )
    .all(PROVIDER)
    .map((lane) => ({
      ...lane,
      models: (parseModelScopeKey(lane.modelScope) ?? ["<undecodable>"]).join(","),
    }));
}

function newestTargetRows(db) {
  return db
    .prepare(
      `SELECT kind, observed_at AS observedAt, percent_left AS percentLeft,
              reset_at_iso AS resetAtIso, window_ms AS windowMs,
              controller_error AS error, controller_integral AS integral,
              interval_seconds AS intervalSeconds
       FROM quota_observations o
       WHERE provider = ? AND model_scope = ?
         AND observed_at = (SELECT MAX(observed_at) FROM quota_observations n
                            WHERE n.provider = o.provider AND n.model_scope = o.model_scope
                              AND n.kind = o.kind)
       ORDER BY kind`
    )
    .all(PROVIDER, TARGET_SCOPE)
    .map((row) => ({
      ...row,
      periodStart:
        row.resetAtIso && Number.isFinite(Date.parse(row.resetAtIso))
          ? new Date(Date.parse(row.resetAtIso) - row.windowMs).toISOString()
          : null,
    }));
}

function backfill(databasePath, maxIntervalSeconds) {
  const store = new SharedQuotaStore(databasePath);
  const counts = { renamed: 0, replayed: 0, dropped: 0 };
  try {
    const db = store.db;
    const before = laneSummary(db);
    const move = db.transaction(() => {
      const scopes = db
        .prepare(
          `SELECT DISTINCT model_scope AS modelScope FROM quota_observations
           WHERE provider = ? AND model_scope <> ''`
        )
        .all(PROVIDER)
        .map((row) => row.modelScope)
        .filter(isCoveredListScope);
      if (scopes.length === 0) return;
      const lanes = [...scopes, TARGET_SCOPE];
      const marks = lanes.map(() => "?").join(", ");
      const kinds = db
        .prepare(
          `SELECT DISTINCT kind FROM quota_observations
           WHERE provider = ? AND model_scope IN (${marks})`
        )
        .all(PROVIDER, ...lanes)
        .map((row) => row.kind);
      for (const kind of kinds) {
        const rows = db
          .prepare(
            `SELECT rowid AS _rowid, * FROM quota_observations
             WHERE provider = ? AND kind = ? AND model_scope IN (${marks})
             ORDER BY observed_at ASC, rowid ASC`
          )
          .all(PROVIDER, kind, ...lanes);
        if (rows.length === 0) continue;
        const oldest = rows[0].model_scope;
        const split = rows.findIndex((row) => row.model_scope !== oldest);
        const kept = split < 0 ? rows : rows.slice(0, split);
        const replay = split < 0 ? [] : rows.slice(split);

        // Replayed rows leave first so the renamed lane's slots are free.
        const remove = db.prepare("DELETE FROM quota_observations WHERE rowid = ?");
        for (const row of replay) remove.run(row._rowid);
        if (oldest !== TARGET_SCOPE) {
          const rename = db.prepare(
            "UPDATE quota_observations SET model_scope = ? WHERE rowid = ?"
          );
          for (const row of kept) rename.run(TARGET_SCOPE, row._rowid);
          counts.renamed += kept.length;
        }
        const occupied = db.prepare(
          `SELECT 1 FROM quota_observations
           WHERE provider = ? AND model_scope = ? AND kind = ? AND observed_slot = ?`
        );
        for (const row of replay) {
          if (occupied.get(PROVIDER, TARGET_SCOPE, kind, row.observed_slot)) {
            counts.dropped += 1;
            continue;
          }
          const { _rowid, ...values } = row;
          values.model_scope = TARGET_SCOPE;
          // The store's own window rule, read against the merged lane so far.
          // It is not part of the store's typed surface; this script is the
          // one caller outside it, and goes away with the backfill.
          values.window_ms = store.windowMsForCandidate({
            provider: PROVIDER,
            modelScope: TARGET_SCOPE,
            kind,
            observedAt: row.observed_at,
            percentLeft: row.percent_left,
            resetAtIso: row.reset_at_iso ?? null,
          });
          values.processed = 0;
          for (const column of CONTROLLER_COLUMNS) values[column] = null;
          const columns = Object.keys(values);
          db.prepare(
            `INSERT INTO quota_observations (${columns.join(", ")})
             VALUES (${columns.map((column) => `@${column}`).join(", ")})`
          ).run(values);
          counts.replayed += 1;
        }
      }
    });
    move.immediate();
    // Reasons every row left unprocessed above, oldest first.
    store.configureController({ maxIntervalSeconds });
    return { before, after: laneSummary(db), newest: newestTargetRows(db), counts };
  } finally {
    store.close();
  }
}

async function onlineBackup(source, destination) {
  await mkdir(dirname(destination), { recursive: true });
  const db = new Database(source, { fileMustExist: true });
  try {
    db.pragma("busy_timeout = 30000");
    await db.backup(destination);
  } finally {
    db.close();
  }
}

async function removeDatabase(path) {
  for (const candidate of [path, `${path}-wal`, `${path}-shm`]) {
    try {
      await unlink(candidate);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
}

function render(result, applied, backup) {
  const lane = (row) =>
    `  ${row.kind} [${row.models}] rows=${row.rows} first=${row.first} last=${row.last}`;
  return [
    `[fable-wildcard-backfill] mode: ${applied ? "applied" : "dry run (temporary copy)"}`,
    "lanes before:",
    ...result.before.map(lane),
    "lanes after:",
    ...result.after.map(lane),
    `rows renamed=${result.counts.renamed} replayed=${result.counts.replayed} dropped=${result.counts.dropped}`,
    "newest reading on the wildcard lane:",
    ...result.newest.map(
      (row) =>
        `  ${row.kind} at ${row.observedAt}: ${row.percentLeft}% left, period start ${row.periodStart}, ` +
        `error ${row.error}, integral ${row.integral}, interval ${row.intervalSeconds}s`
    ),
    backup ? `backup: ${backup}` : "backup: none (dry run)",
    "",
  ].join("\n");
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupDir = args.backupDir ?? join(dirname(args.database), "backups");
  const copyPath = join(
    backupDir,
    args.apply
      ? `quota-before-fable-wildcard-backfill-${stamp}.db`
      : `.quota-fable-wildcard-backfill-${stamp}.db`
  );
  await onlineBackup(args.database, copyPath);
  try {
    const result = backfill(args.apply ? args.database : copyPath, args.maxIntervalSeconds);
    process.stdout.write(render(result, args.apply, args.apply ? copyPath : null));
  } finally {
    if (!args.apply) await removeDatabase(copyPath);
  }
}

main().catch((error) => {
  process.stderr.write(
    `[fable-wildcard-backfill] ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
  );
  process.exitCode = 1;
});
