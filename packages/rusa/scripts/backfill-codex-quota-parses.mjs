import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { inferQuotaState, parseCodexQuota } from "../dist/mcp/quota-mcp.js";

const HOUR_MS = 60 * 60 * 1000;

function usage() {
  return [
    "Usage:",
    "  GEMINI_API_KEY=... pnpm --filter rusa run backfill:codex-quota -- \\",
    "    --database /absolute/path/to/quota.db --hours 48 \\",
    "    --report /absolute/path/to/report.md [--concurrency 3] [--attempts 3] [--apply]",
    "",
    "Without --apply, parses and reports the proposed changes without writing the database.",
    "With --apply, creates an online SQLite backup before atomically replacing parsed_state.",
    "Raw scrape text and quota_observations are never modified.",
  ].join("\n");
}

function parseArgs(argv) {
  const result = { hours: 48, concurrency: 3, attempts: 3, apply: false };
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
    else if (flag === "--hours") result.hours = Number(value);
    else if (flag === "--through") result.through = value;
    else if (flag === "--report") result.report = resolve(value);
    else if (flag === "--backup-dir") result.backupDir = resolve(value);
    else if (flag === "--concurrency") result.concurrency = Number(value);
    else if (flag === "--attempts") result.attempts = Number(value);
    else throw new Error(`unknown argument ${flag}`);
  }
  if (!result.database || !result.report) {
    throw new Error("--database and --report are required");
  }
  for (const field of ["hours", "concurrency", "attempts"]) {
    if (!Number.isInteger(result[field]) || result[field] < 1) {
      throw new Error(`--${field} must be a positive integer`);
    }
  }
  if (result.concurrency > 10) throw new Error("--concurrency must be at most 10");
  if (result.through && !Number.isFinite(Date.parse(result.through))) {
    throw new Error("--through must be an ISO-8601 timestamp");
  }
  return result;
}

function shortHash(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function parsedJson(value) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function isModelFailure(parsed) {
  return (
    parsed?.status === "unknown" &&
    typeof parsed.message === "string" &&
    parsed.message.startsWith("LLM quota parsing failed:")
  );
}

async function parseRow(row, apiKey, attempts) {
  let lastFailure;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const parsed = await parseCodexQuota(row.rawOutput, apiKey, Date.parse(row.scrapedAt));
    if (!isModelFailure(parsed)) {
      return {
        provider: "codex",
        status: parsed.status ?? "unknown",
        ...(parsed.message ? { message: parsed.message } : {}),
        ...(parsed.limits ? { limits: parsed.limits } : {}),
        scrapedAt: row.scrapedAt,
      };
    }
    lastFailure = parsed.message;
    if (attempt < attempts) await new Promise((done) => setTimeout(done, attempt * 250));
  }
  throw new Error(`model failed after ${attempts} row attempt(s): ${lastFailure}`);
}

async function mapConcurrent(rows, concurrency, worker) {
  const results = new Array(rows.length);
  let nextIndex = 0;
  let completed = 0;
  const startedAt = Date.now();
  const runners = Array.from({ length: Math.min(concurrency, rows.length) }, async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= rows.length) return;
      results[index] = await worker(rows[index], index);
      completed += 1;
      if (completed === rows.length || completed % 10 === 0) {
        const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
        process.stdout.write(
          `[codex-backfill] parsed ${completed}/${rows.length} rows (${elapsedSeconds}s)\n`
        );
      }
    }
  });
  await Promise.all(runners);
  return results;
}

async function backupDatabase(databasePath, backupDir) {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.(\d{3})Z$/, "$1Z");
  const destination = join(
    backupDir ?? join(dirname(databasePath), "backups"),
    `quota-before-codex-backfill-${stamp}.db`
  );
  await mkdir(dirname(destination), { recursive: true });
  const source = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    await source.backup(destination);
  } finally {
    source.close();
  }
  const backup = new Database(destination, { readonly: true, fileMustExist: true });
  try {
    const integrity = backup.pragma("integrity_check", { simple: true });
    if (integrity !== "ok") throw new Error(`backup integrity check failed: ${integrity}`);
  } finally {
    backup.close();
  }
  return destination;
}

function validateState(state, rowHash) {
  if (!state || !["available", "exhausted", "unknown"].includes(state.status)) {
    throw new Error(`invalid status for row ${rowHash}`);
  }
  for (const limit of state.limits ?? []) {
    if (limit.scope !== "provider") {
      throw new Error(`non-provider limit survived for row ${rowHash}`);
    }
    if (!Number.isFinite(limit.percentLeft) || limit.percentLeft < 0 || limit.percentLeft > 100) {
      throw new Error(`invalid percentage survived for row ${rowHash}`);
    }
  }
}

function renderReport(summary) {
  return (
    "# Codex quota parse backfill\n\n" +
    `Mode: **${summary.applied ? "applied" : "dry run"}**\n\n` +
    `Range: \`${summary.since}\` through \`${summary.through}\`\n\n` +
    `Rows selected: **${summary.selected}**  \n` +
    `Rows whose normalized parse changed: **${summary.changed}**  \n` +
    `Old model-scoped windows removed: **${summary.oldModelWindows}**  \n` +
    `New provider-scoped windows: **${summary.newProviderWindows}**  \n` +
    `New available/exhausted/unknown states: **${summary.statuses.available}/${summary.statuses.exhausted}/${summary.statuses.unknown}**\n\n` +
    (summary.backup
      ? `Backup: \`${summary.backup}\`\n\n`
      : "Backup: not created for dry run.\n\n") +
    "Only `quota_scrapes.parsed_state` and its `parse_error` were updated. Raw scrape evidence and `quota_observations` were left unchanged.\n"
  );
}

export function applyBackfill(writable, replacements, since, through) {
  const update = writable.prepare(
    `UPDATE quota_scrapes
     SET parsed_state = ?, parse_error = NULL
     WHERE id = ? AND provider = 'codex' AND scraped_at = ?
       AND parsed_state IS ? AND parse_error IS ?`
  );
  const apply = writable.transaction(() => {
    if (since && through) {
      const sinceIso = since instanceof Date ? since.toISOString() : since;
      const throughIso = through instanceof Date ? through.toISOString() : through;
      const currentCount = writable
        .prepare(
          `SELECT COUNT(*) AS count
           FROM quota_scrapes
           WHERE provider = 'codex' AND scraped_at >= ? AND scraped_at <= ?`
        )
        .get(sinceIso, throughIso).count;
      if (currentCount !== replacements.length) {
        throw new Error("live Codex scrape count changed during backfill");
      }
    }
    for (const replacement of replacements) {
      const result = update.run(
        replacement.serialized,
        replacement.id,
        replacement.scrapedAt,
        replacement.parsedState ?? null,
        replacement.parseError ?? null
      );
      if (result.changes !== 1) {
        throw new Error(`row ${shortHash(replacement.id)} changed during the backfill`);
      }
    }
  });
  apply.immediate();
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) throw new Error("GEMINI_API_KEY is required");

  const through = new Date(args.through ?? Date.now());
  const since = new Date(through.getTime() - args.hours * HOUR_MS);
  const db = new Database(args.database, { readonly: true, fileMustExist: true });
  db.pragma("busy_timeout = 30000");
  let rows;
  let seed;
  try {
    rows = db
      .prepare(
        `SELECT id, scraped_at AS scrapedAt, raw_output AS rawOutput, parsed_state AS parsedState, parse_error AS parseError
         FROM quota_scrapes
         WHERE provider = 'codex' AND scraped_at >= ? AND scraped_at <= ?
         ORDER BY scraped_at ASC, rowid ASC`
      )
      .all(since.toISOString(), through.toISOString());
    seed = db
      .prepare(
        `SELECT id, scraped_at AS scrapedAt, raw_output AS rawOutput
         FROM quota_scrapes
         WHERE provider = 'codex' AND scraped_at < ?
         ORDER BY scraped_at DESC, rowid DESC LIMIT 1`
      )
      .get(since.toISOString());
  } finally {
    db.close();
  }
  if (rows.length === 0) throw new Error("no Codex scrapes matched the requested interval");

  process.stdout.write(
    `[codex-backfill] selected ${rows.length} rows from ${since.toISOString()} through ${through.toISOString()}\n`
  );
  const seedRaw = seed ? await parseRow(seed, apiKey, args.attempts) : null;
  const rawStates = await mapConcurrent(rows, args.concurrency, (row) =>
    parseRow(row, apiKey, args.attempts)
  );

  let previous = seedRaw ? inferQuotaState(seedRaw, undefined, seed.scrapedAt) : undefined;
  const replacements = [];
  const statuses = { available: 0, exhausted: 0, unknown: 0 };
  let changed = 0;
  let oldModelWindows = 0;
  let newProviderWindows = 0;
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const inferred = inferQuotaState(rawStates[index], previous, row.scrapedAt);
    const { raw: _raw, ...stored } = inferred;
    validateState(stored, shortHash(row.id));
    const serialized = JSON.stringify(stored);
    const oldState = parsedJson(row.parsedState);
    oldModelWindows += (oldState?.limits ?? []).filter((limit) => limit.scope === "model").length;
    newProviderWindows += (stored.limits ?? []).length;
    statuses[stored.status] += 1;
    if (serialized !== row.parsedState) changed += 1;
    replacements.push({ ...row, serialized });
    previous = inferred;
  }

  let backup;
  if (args.apply) {
    backup = await backupDatabase(args.database, args.backupDir);
    process.stdout.write(`[codex-backfill] verified backup ${backup}\n`);
    const writable = new Database(args.database, { fileMustExist: true });
    writable.pragma("busy_timeout = 30000");
    try {
      applyBackfill(writable, replacements, since, through);
    } finally {
      writable.close();
    }
  }

  const summary = {
    applied: args.apply,
    since: since.toISOString(),
    through: through.toISOString(),
    selected: rows.length,
    changed,
    oldModelWindows,
    newProviderWindows,
    statuses,
    backup,
  };
  await mkdir(dirname(args.report), { recursive: true });
  await writeFile(args.report, renderReport(summary));
  process.stdout.write(
    `[codex-backfill] ${args.apply ? "updated" : "would update"} ${rows.length} rows; ${changed} normalized parses changed; report ${args.report}\n`
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(
      `[codex-backfill] ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
    );
    process.exitCode = 1;
  });
}
