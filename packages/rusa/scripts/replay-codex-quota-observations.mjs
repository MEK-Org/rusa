import { copyFile, mkdir, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import Database from "better-sqlite3";
import { SharedQuotaStore } from "../dist/quota/shared-store.js";

const OBSERVATION_COLUMNS = [
  "provider",
  "kind",
  "observed_slot",
  "label",
  "observed_at",
  "percent_left",
  "reset_at_iso",
  "window_ms",
  "processed",
  "controller_error",
  "controller_derivative",
  "controller_integral",
  "uncapped_interval_seconds",
  "interval_seconds",
  "commanded_interval_seconds",
  "commanded_uncapped_interval_seconds",
  "recovery_credit_seconds",
];

function getObservationProjection(db) {
  const existing = new Set(
    db
      .prepare("PRAGMA table_info(quota_observations)")
      .all()
      .map((c) => c.name)
  );
  return OBSERVATION_COLUMNS.map((col) => (existing.has(col) ? col : `NULL AS ${col}`)).join(", ");
}

function usage() {
  return [
    "Usage:",
    "  pnpm --filter rusa run replay:codex-observations -- \\",
    "    --database /absolute/path/to/quota.db --since <ISO timestamp> \\",
    "    --max-interval-seconds 36000 --report /absolute/path/to/report.md [--apply]",
    "",
    "Without --apply, rebuilds and validates observations in a temporary database only.",
    "With --apply, keeps the verified snapshot as a backup and atomically replaces the live rows.",
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
    else if (flag === "--since") result.since = new Date(value).toISOString();
    else if (flag === "--max-interval-seconds") result.maxIntervalSeconds = Number(value);
    else if (flag === "--report") result.report = resolve(value);
    else if (flag === "--backup-dir") result.backupDir = resolve(value);
    else throw new Error(`unknown argument ${flag}`);
  }
  if (!result.database || !result.since || !result.report) {
    throw new Error("--database, --since, and --report are required");
  }
  if (!Number.isFinite(result.maxIntervalSeconds) || result.maxIntervalSeconds <= 0) {
    throw new Error("--max-interval-seconds must be positive");
  }
  return result;
}

function parseState(value, id) {
  if (!value) throw new Error(`Codex scrape ${id} has no parsed_state`);
  let state;
  try {
    state = JSON.parse(value);
  } catch {
    throw new Error(`Codex scrape ${id} has malformed parsed_state`);
  }
  if (state.provider !== "codex") throw new Error(`Codex scrape ${id} has the wrong provider`);
  if (!["available", "exhausted", "unknown"].includes(state.status)) {
    throw new Error(`Codex scrape ${id} has an invalid status`);
  }
  for (const limit of state.limits ?? []) {
    if (limit.scope !== "provider") {
      throw new Error(`Codex scrape ${id} still contains a non-provider limit`);
    }
    if (!Number.isFinite(limit.percentLeft) || limit.percentLeft < 0 || limit.percentLeft > 100) {
      throw new Error(`Codex scrape ${id} contains an invalid percentage`);
    }
  }
  return state;
}

function timestampForPath() {
  return new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.(\d{3})Z$/, "$1Z");
}

async function onlineBackup(sourcePath, destinationPath) {
  await mkdir(dirname(destinationPath), { recursive: true });
  const source = new Database(sourcePath, { readonly: true, fileMustExist: true });
  try {
    await source.backup(destinationPath);
  } finally {
    source.close();
  }
  const backup = new Database(destinationPath, { readonly: true, fileMustExist: true });
  try {
    const integrity = backup.pragma("integrity_check", { simple: true });
    if (integrity !== "ok") throw new Error(`snapshot integrity check failed: ${integrity}`);
  } finally {
    backup.close();
  }
}

function snapshotMetadata(databasePath, since) {
  const db = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    const scrapes = db
      .prepare(
        `SELECT id, scraped_at AS scrapedAt, parsed_state AS parsedState
         FROM quota_scrapes
         WHERE provider = 'codex' AND scraped_at >= ?
         ORDER BY scraped_at ASC, rowid ASC`
      )
      .all(since);
    const projection = getObservationProjection(db);
    const observations = db
      .prepare(
        `SELECT ${projection}
         FROM quota_observations
         WHERE provider = 'codex' AND observed_at >= ?
         ORDER BY observed_at ASC, rowid ASC`
      )
      .all(since);
    return {
      scrapes,
      observations,
      totalCodexScrapes: db
        .prepare("SELECT COUNT(*) AS count FROM quota_scrapes WHERE provider = 'codex'")
        .get().count,
      totalCodexObservations: db
        .prepare("SELECT COUNT(*) AS count FROM quota_observations WHERE provider = 'codex'")
        .get().count,
      latestScrapeAt:
        db
          .prepare("SELECT MAX(scraped_at) AS value FROM quota_scrapes WHERE provider = 'codex'")
          .get().value ?? null,
      latestObservationAt:
        db
          .prepare(
            "SELECT MAX(observed_at) AS value FROM quota_observations WHERE provider = 'codex'"
          )
          .get().value ?? null,
    };
  } finally {
    db.close();
  }
}

async function removeWorkingDatabase(path) {
  for (const candidate of [path, `${path}-wal`, `${path}-shm`]) {
    try {
      await unlink(candidate);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
}

function replayWorkingDatabase(path, since, scrapes, maxIntervalSeconds) {
  const prune = new Database(path, { fileMustExist: true });
  try {
    prune.pragma("busy_timeout = 30000");
    prune
      .prepare("DELETE FROM quota_observations WHERE provider = 'codex' AND observed_at >= ?")
      .run(since);
  } finally {
    prune.close();
  }

  const store = new SharedQuotaStore(path);
  try {
    store.configureController({ maxIntervalSeconds });
    for (const scrape of scrapes) {
      const state = parseState(scrape.parsedState, scrape.id);
      store.recordParsed(scrape.id, state, state);
    }
  } finally {
    store.close();
  }
}

function observationKey(row) {
  return `${row.provider}\0${row.kind}\0${row.observed_slot}`;
}

function countChanged(before, after) {
  const beforeByKey = new Map(before.map((row) => [observationKey(row), JSON.stringify(row)]));
  const afterByKey = new Map(after.map((row) => [observationKey(row), JSON.stringify(row)]));
  const keys = new Set([...beforeByKey.keys(), ...afterByKey.keys()]);
  let changed = 0;
  for (const key of keys) {
    if (beforeByKey.get(key) !== afterByKey.get(key)) changed += 1;
  }
  return changed;
}

function validateReplay(metadata, since) {
  if (metadata.scrapes.length === 0) throw new Error("no Codex scrapes matched the cutoff");
  for (const scrape of metadata.scrapes) parseState(scrape.parsedState, scrape.id);
  for (const row of metadata.observations) {
    if (row.provider !== "codex" || row.observed_at < since) {
      throw new Error("replay produced an observation outside the requested range");
    }
    if (row.kind !== "weekly") {
      throw new Error(`replay produced unexpected Codex observation kind '${row.kind}'`);
    }
    if (/reserve|spark/i.test(row.label)) {
      throw new Error(`replay retained a model-specific observation label '${row.label}'`);
    }
    if (!Number.isFinite(row.percent_left) || row.percent_left < 0 || row.percent_left > 100) {
      throw new Error("replay produced an invalid observation percentage");
    }
    if (row.processed !== 1) throw new Error("replay left an observation unprocessed");
  }
  const expectedSlots = new Set(
    metadata.scrapes.flatMap((scrape) => {
      const state = parseState(scrape.parsedState, scrape.id);
      return (state.limits ?? []).map(
        (limit) => `${limit.kind ?? "other"}\0${Math.floor(Date.parse(scrape.scrapedAt) / 300000)}`
      );
    })
  );
  const actualSlots = new Set(
    metadata.observations.map((row) => `${row.kind}\0${row.observed_slot}`)
  );
  if (expectedSlots.size !== actualSlots.size) {
    throw new Error(
      `replay slot count ${actualSlots.size} does not match parsed-state slot count ${expectedSlots.size}`
    );
  }
  for (const key of expectedSlots) {
    if (!actualSlots.has(key)) throw new Error(`replay omitted expected observation slot ${key}`);
  }
}

function ensureReplayColumns(db) {
  const columns = new Set(
    db
      .prepare("PRAGMA table_info(quota_observations)")
      .all()
      .map((c) => c.name)
  );
  if (!columns.has("controller_integral")) {
    db.exec("ALTER TABLE quota_observations ADD COLUMN controller_integral REAL");
  }
  if (!columns.has("commanded_interval_seconds")) {
    db.exec("ALTER TABLE quota_observations ADD COLUMN commanded_interval_seconds REAL");
  }
  if (!columns.has("commanded_uncapped_interval_seconds")) {
    db.exec("ALTER TABLE quota_observations ADD COLUMN commanded_uncapped_interval_seconds REAL");
  }
  if (!columns.has("recovery_credit_seconds")) {
    db.exec("ALTER TABLE quota_observations ADD COLUMN recovery_credit_seconds REAL");
  }
}

function applyReplay(databasePath, since, snapshot, rebuilt) {
  const db = new Database(databasePath, { fileMustExist: true });
  db.pragma("busy_timeout = 30000");
  try {
    ensureReplayColumns(db);
    const insert = db.prepare(
      `INSERT INTO quota_observations (${OBSERVATION_COLUMNS.join(", ")})
       VALUES (${OBSERVATION_COLUMNS.map(() => "?").join(", ")})`
    );
    const apply = db.transaction(() => {
      const current = {
        totalCodexScrapes: db
          .prepare("SELECT COUNT(*) AS count FROM quota_scrapes WHERE provider = 'codex'")
          .get().count,
        totalCodexObservations: db
          .prepare("SELECT COUNT(*) AS count FROM quota_observations WHERE provider = 'codex'")
          .get().count,
        latestScrapeAt:
          db
            .prepare("SELECT MAX(scraped_at) AS value FROM quota_scrapes WHERE provider = 'codex'")
            .get().value ?? null,
        latestObservationAt:
          db
            .prepare(
              "SELECT MAX(observed_at) AS value FROM quota_observations WHERE provider = 'codex'"
            )
            .get().value ?? null,
      };
      if (JSON.stringify(current) !== JSON.stringify(snapshot)) {
        throw new Error(
          "live Codex quota data changed during replay; no observations were replaced"
        );
      }
      db.prepare(
        "DELETE FROM quota_observations WHERE provider = 'codex' AND observed_at >= ?"
      ).run(since);
      for (const row of rebuilt) {
        insert.run(...OBSERVATION_COLUMNS.map((column) => row[column]));
      }
    });
    apply.immediate();
  } finally {
    db.close();
  }
}

function renderReport(summary) {
  return (
    "# Codex quota observation replay\n\n" +
    `Mode: **${summary.applied ? "applied" : "dry run"}**\n\n` +
    `Cutoff: \`${summary.since}\`  \n` +
    `Maximum controller interval: **${summary.maxIntervalSeconds} seconds**\n\n` +
    `Corrected scrapes replayed: **${summary.scrapes}**  \n` +
    `Observation rows before/after: **${summary.before}/${summary.after}**  \n` +
    `Observation keys or values changed: **${summary.changed}**  \n` +
    `Latest rebuilt observation: \`${summary.latestObservationAt}\`\n\n` +
    (summary.backup
      ? `Backup: \`${summary.backup}\`\n`
      : "Backup: temporary dry-run snapshot removed.\n")
  );
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  const stamp = timestampForPath();
  const backupDir = args.backupDir ?? join(dirname(args.database), "backups");
  const snapshotPath = join(
    backupDir,
    args.apply
      ? `quota-before-codex-observation-replay-${stamp}.db`
      : `.quota-codex-observation-replay-${stamp}.db`
  );
  const workingPath = join(backupDir, `.quota-codex-observation-working-${stamp}.db`);
  await onlineBackup(args.database, snapshotPath);
  await copyFile(snapshotPath, workingPath);

  let snapshot;
  let rebuilt;
  try {
    snapshot = snapshotMetadata(snapshotPath, args.since);
    for (const scrape of snapshot.scrapes) parseState(scrape.parsedState, scrape.id);
    process.stdout.write(
      `[codex-observation-replay] replaying ${snapshot.scrapes.length} corrected scrapes from ${args.since}\n`
    );
    replayWorkingDatabase(workingPath, args.since, snapshot.scrapes, args.maxIntervalSeconds);
    rebuilt = snapshotMetadata(workingPath, args.since);
    validateReplay(rebuilt, args.since);

    const changed = countChanged(snapshot.observations, rebuilt.observations);
    if (args.apply) {
      applyReplay(
        args.database,
        args.since,
        {
          totalCodexScrapes: snapshot.totalCodexScrapes,
          totalCodexObservations: snapshot.totalCodexObservations,
          latestScrapeAt: snapshot.latestScrapeAt,
          latestObservationAt: snapshot.latestObservationAt,
        },
        rebuilt.observations
      );
    }

    const summary = {
      applied: args.apply,
      since: args.since,
      maxIntervalSeconds: args.maxIntervalSeconds,
      scrapes: snapshot.scrapes.length,
      before: snapshot.observations.length,
      after: rebuilt.observations.length,
      changed,
      latestObservationAt: rebuilt.latestObservationAt,
      backup: args.apply ? snapshotPath : null,
    };
    await mkdir(dirname(args.report), { recursive: true });
    await writeFile(args.report, renderReport(summary));
    process.stdout.write(
      `[codex-observation-replay] ${args.apply ? "replaced" : "validated"} ${rebuilt.observations.length} observations; ${changed} changed; report ${args.report}\n`
    );
  } finally {
    await removeWorkingDatabase(workingPath);
    if (!args.apply) await removeWorkingDatabase(snapshotPath);
  }
}

main().catch((error) => {
  process.stderr.write(
    `[codex-observation-replay] ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
  );
  process.exitCode = 1;
});
