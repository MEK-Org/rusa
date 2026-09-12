import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import {
  analyzeTokenRecords,
  applyTokenRecordsBackfill,
  backupDatabase,
  generateReport,
} from "../dist/actor/backfill-run-token-records.js";

export function usage() {
  return [
    "Usage:",
    "  pnpm --filter rusa run backfill:token-records -- \\",
    "    --database /path/to/mesh.db [--report /path/to/report.md] [--apply] [--backup-dir /path/to/backups]",
    "",
    "Without --apply, analyzes and reports proposed changes without writing the database (dry-run).",
    "With --apply, creates a verified SQLite backup before atomically updating deterministically resolved rows.",
    "Ambiguous rows, unresolvable rows, and collisions are never guessed and remain untouched.",
  ].join("\n");
}

export function parseArgs(argv) {
  const result = { apply: false };
  for (let index = 2; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--") continue;
    if (flag === "--help" || flag === "-h") return { help: true };
    if (flag === "--apply") {
      result.apply = true;
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`missing value for ${flag}`);
    index += 1;
    if (flag === "--database") result.database = resolve(value);
    else if (flag === "--report") result.report = resolve(value);
    else if (flag === "--backup-dir") result.backupDir = resolve(value);
    else throw new Error(`unknown argument ${flag}`);
  }
  if (!result.database && !result.help) {
    throw new Error("--database is required");
  }
  return result;
}

export async function run(argv = process.argv) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  const readDb = new Database(args.database, { readonly: true, fileMustExist: true });
  let plan;
  try {
    plan = analyzeTokenRecords(readDb);
  } finally {
    readDb.close();
  }

  process.stdout.write(
    `[token-records-backfill] Analyzed ${plan.totalRecords} token records:\n` +
      `  - Already correct: ${plan.alreadyCorrect.length}\n` +
      `  - Deterministically resolved: ${plan.deterministicallyResolved.length}\n` +
      `  - Ambiguous: ${plan.ambiguous.length}\n` +
      `  - Unresolvable: ${plan.unresolvable.length}\n` +
      `  - Collisions: ${plan.collisions.length}\n`
  );

  let applied = false;
  if (args.apply) {
    if (plan.deterministicallyResolved.length === 0) {
      process.stdout.write("[token-records-backfill] No rows to backfill.\n");
    } else {
      const backupPath = await backupDatabase(args.database, args.backupDir);
      process.stdout.write(`[token-records-backfill] Verified backup at ${backupPath}\n`);
      const writeDb = new Database(args.database, { fileMustExist: true });
      writeDb.pragma("busy_timeout = 30000");
      try {
        const { updated } = applyTokenRecordsBackfill(writeDb, plan);
        process.stdout.write(`[token-records-backfill] Successfully updated ${updated} rows.\n`);
        applied = true;
      } finally {
        writeDb.close();
      }
    }
  } else {
    process.stdout.write(
      `[token-records-backfill] Dry run complete. Pass --apply to write changes.\n`
    );
  }

  if (args.report) {
    await mkdir(dirname(args.report), { recursive: true });
    await writeFile(args.report, generateReport(plan, applied), "utf8");
    process.stdout.write(`[token-records-backfill] Report written to ${args.report}\n`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  run().catch((err) => {
    process.stderr.write(`[token-records-backfill] Error: ${err.message}\n`);
    process.exit(1);
  });
}
