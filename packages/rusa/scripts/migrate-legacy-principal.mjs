import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import {
  backupDatabase,
  executeLegacyPrincipalMigration,
  generateMigrationReport,
} from "../build/maintenance/principals/legacy-migration.js";

export function usage() {
  return [
    "Usage:",
    "  pnpm --filter rusa run migrate:legacy-principal -- \\",
    "    --database /path/to/mesh.db --email operator@example.com [--apply] [--report /path/to/report.md] [--backup-dir /path/to/backups] [--issuer <issuer> --subject <subject>]",
    "",
    "Options:",
    "  --database    Required path to the SQLite database file.",
    "  --email       Required explicit email address for the durable principal bootstrap/reuse.",
    "  --apply       Apply changes in one atomic transaction. Omit for no-write dry-run analysis.",
    "  --issuer      Optional verified issuer (e.g. https://securetoken.google.com/<projectId>) for external identity binding.",
    "  --subject     Optional verified subject/uid for external identity binding.",
    "  --report      Optional file path to write a detailed markdown report.",
    "  --backup-dir  Optional directory to place a verified SQLite backup before apply.",
    "",
    "Without --apply, analyzes authoritative references and untouched reference sites without writing.",
    "With --apply, creates a verified backup (if backup-dir is set) and commits all rewrites and principal initialization in one transaction.",
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
    else if (flag === "--email") result.email = value;
    else if (flag === "--issuer") result.issuer = value;
    else if (flag === "--subject") result.subject = value;
    else if (flag === "--report") result.report = resolve(value);
    else if (flag === "--backup-dir") result.backupDir = resolve(value);
    else throw new Error(`unknown argument ${flag}`);
  }
  if (!result.help) {
    if (!result.database) throw new Error("--database is required");
    if (!result.email) throw new Error("--email is required");
  }
  return result;
}

export async function run(argv = process.argv) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  const db = new Database(args.database, { fileMustExist: true });
  db.pragma("busy_timeout = 30000");

  let result;
  try {
    if (args.apply && args.backupDir) {
      const backupPath = await backupDatabase(db, args.backupDir);
      process.stdout.write(`[legacy-migration] Backup created at ${backupPath}\n`);
    }

    result = executeLegacyPrincipalMigration(db, {
      email: args.email,
      issuer: args.issuer,
      subject: args.subject,
      apply: args.apply,
    });
  } finally {
    db.close();
  }

  process.stdout.write(
    `[legacy-migration] Mode: ${result.applied ? "APPLIED" : "DRY RUN"}\n` +
      `  - Email: ${result.email}\n` +
      `  - Principal ID: ${result.principalId}\n` +
      `  - Status: ${result.principalReused ? "Reused existing user principal" : "Created new durable user principal"}\n` +
      `  - Authoritative references found: ${result.preInventory.totalAuthoritative}\n`
  );

  for (const item of result.preInventory.authoritative) {
    if (item.count > 0) {
      process.stdout.write(`      * ${item.table}.${item.column}: ${item.count}\n`);
    }
  }

  if (result.applied) {
    process.stdout.write(
      `  - Rewrites committed: ${result.rewritesApplied}\n` +
        `  - Remaining authoritative references: ${result.postInventory?.totalAuthoritative ?? 0}\n`
    );
  } else {
    process.stdout.write(
      `[legacy-migration] Dry run complete. Pass --apply to write changes in one transaction.\n`
    );
  }

  if (args.report) {
    await mkdir(dirname(args.report), { recursive: true });
    await writeFile(args.report, generateMigrationReport(result, args.database), "utf8");
    process.stdout.write(`[legacy-migration] Report written to ${args.report}\n`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  run().catch((err) => {
    process.stderr.write(`[legacy-migration] Error: ${err.message}\n`);
    process.exit(1);
  });
}
