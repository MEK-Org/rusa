import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import Database from "better-sqlite3";
import { normalizeEmail, PrincipalRepository } from "../db/repositories/principal-repository.js";
import { HUMAN_OPERATOR } from "../mcp/stamp.js";

/** Exact authoritative references whose value is migrated to the durable principal ID. */
export const AUTHORITATIVE_REFERENCES = [
  { table: "obligations", column: "owner_id" },
  { table: "obligations", column: "creator_id" },
  { table: "obligation_history", column: "acting_principal" },
  { table: "mesh_chat", column: "sender_id" },
  { table: "mesh_chat", column: "recipient_id" },
  { table: "capability_grants", column: "granted_by" },
] as const;

/**
 * Historical references preserved untouched: free text, prose, logs, historical
 * payload bodies, and provenance strings.
 */
export const UNTOUCHED_REFERENCES = [
  { table: "mesh_events", column: "actor_id", reason: "observability log identity (append-only)" },
  { table: "mesh_events", column: "body", reason: "observability log body (free text)" },
  { table: "mesh_events", column: "payload", reason: "observability log payload" },
  { table: "mesh_chat", column: "body", reason: "message body (free text)" },
  { table: "obligations", column: "title", reason: "obligation title (prose)" },
  { table: "obligations", column: "intent", reason: "obligation intent (prose)" },
  { table: "obligations", column: "terminal_note", reason: "obligation terminal note (prose)" },
  { table: "obligations", column: "external_ref", reason: "provenance reference string" },
  { table: "obligations", column: "resolution_ref", reason: "provenance reference string" },
  { table: "obligation_history", column: "payload", reason: "historical audit payload body" },
  { table: "actor_inbox_entries", column: "source", reason: "inbox provenance source" },
  { table: "actor_inbox_entries", column: "payload_json", reason: "inbox payload body" },
] as const;

export interface AuthoritativeCount {
  table: string;
  column: string;
  count: number;
}

export interface UntouchedCount {
  table: string;
  column: string;
  count: number;
  reason: string;
}

export interface DanglingReferenceCount {
  table: string;
  column: string;
  count: number;
}

export interface LegacyReferenceInventory {
  authoritative: AuthoritativeCount[];
  totalAuthoritative: number;
  untouched: UntouchedCount[];
  totalUntouched: number;
  dangling: DanglingReferenceCount[];
  totalDangling: number;
}

export interface MigrationOptions {
  email: string;
  issuer?: string;
  subject?: string;
  apply?: boolean;
}

export interface MigrationResult {
  email: string;
  principalId: string;
  principalCreated: boolean;
  principalReused: boolean;
  externalIdentityBound: boolean;
  applied: boolean;
  preInventory: LegacyReferenceInventory;
  postInventory?: LegacyReferenceInventory;
  rewritesApplied: number;
}

function tableExists(db: Database.Database, tableName: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName);
  return row !== undefined;
}

function columnExists(db: Database.Database, tableName: string, columnName: string): boolean {
  if (!tableExists(db, tableName)) return false;
  const cols = db.prepare(`PRAGMA table_info("${tableName}")`).all() as Array<{ name: string }>;
  return cols.some((c) => c.name === columnName);
}

/**
 * Dynamically sweep every user table and column in the SQLite schema for exact matches
 * to `human:operator` that are outside the classified authoritative and untouched inventories.
 */
export function sweepSchemaForExactMatches(
  db: Database.Database,
  knownKeys: Set<string>
): DanglingReferenceCount[] {
  const tables = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_litestream_%'"
    )
    .all() as Array<{ name: string }>;
  const dangling: DanglingReferenceCount[] = [];
  for (const { name: tableName } of tables) {
    let cols: Array<{ name: string; type: string }>;
    try {
      cols = db.prepare(`PRAGMA table_info("${tableName}")`).all() as Array<{
        name: string;
        type: string;
      }>;
    } catch {
      continue;
    }
    for (const col of cols) {
      const key = `${tableName}.${col.name}`;
      if (knownKeys.has(key)) continue;
      try {
        const row = db
          .prepare(`SELECT COUNT(*) AS count FROM "${tableName}" WHERE "${col.name}" = ?`)
          .get(HUMAN_OPERATOR) as { count: number } | undefined;
        const count = row ? Number(row.count) : 0;
        if (count > 0) {
          dangling.push({ table: tableName, column: col.name, count });
        }
      } catch {
        // Skip non-queryable columns (e.g. virtual tables)
      }
    }
  }
  return dangling;
}

/**
 * Mechanically inventory every exact authoritative reference to `human:operator`
 * as well as untouched log, prose, and provenance reference sites across the database,
 * plus a dynamic sweep for any unclassified/dangling references.
 */
export function inventoryLegacyReferences(db: Database.Database): LegacyReferenceInventory {
  const authoritative: AuthoritativeCount[] = [];
  let totalAuthoritative = 0;

  for (const item of AUTHORITATIVE_REFERENCES) {
    if (!columnExists(db, item.table, item.column)) {
      authoritative.push({ table: item.table, column: item.column, count: 0 });
      continue;
    }
    const row = db
      .prepare(`SELECT COUNT(*) AS count FROM "${item.table}" WHERE "${item.column}" = ?`)
      .get(HUMAN_OPERATOR) as { count: number };
    const count = row ? Number(row.count) : 0;
    authoritative.push({ table: item.table, column: item.column, count });
    totalAuthoritative += count;
  }

  const untouched: UntouchedCount[] = [];
  let totalUntouched = 0;

  for (const item of UNTOUCHED_REFERENCES) {
    if (!columnExists(db, item.table, item.column)) {
      untouched.push({ table: item.table, column: item.column, count: 0, reason: item.reason });
      continue;
    }
    let count = 0;
    if (item.column === "actor_id") {
      const row = db
        .prepare(`SELECT COUNT(*) AS count FROM "${item.table}" WHERE "${item.column}" = ?`)
        .get(HUMAN_OPERATOR) as { count: number };
      count = row ? Number(row.count) : 0;
    } else {
      const row = db
        .prepare(
          `SELECT COUNT(*) AS count FROM "${item.table}" WHERE instr("${item.column}", ?) > 0`
        )
        .get(HUMAN_OPERATOR) as { count: number };
      count = row ? Number(row.count) : 0;
    }
    untouched.push({ table: item.table, column: item.column, count, reason: item.reason });
    totalUntouched += count;
  }

  const knownKeys = new Set<string>();
  for (const item of AUTHORITATIVE_REFERENCES) knownKeys.add(`${item.table}.${item.column}`);
  for (const item of UNTOUCHED_REFERENCES) knownKeys.add(`${item.table}.${item.column}`);
  const dangling = sweepSchemaForExactMatches(db, knownKeys);
  const totalDangling = dangling.reduce((acc, cur) => acc + cur.count, 0);

  return {
    authoritative,
    totalAuthoritative,
    untouched,
    totalUntouched,
    dangling,
    totalDangling,
  };
}

/**
 * Execute the legacy principal migration against the provided database.
 * Supports no-write dry-run mode, single-transaction atomic apply, and idempotent reruns.
 */
export function executeLegacyPrincipalMigration(
  db: Database.Database,
  options: MigrationOptions
): MigrationResult {
  if (!options.email || typeof options.email !== "string" || !options.email.trim()) {
    throw new Error("An explicit email is required to migrate legacy human identity");
  }
  const email = normalizeEmail(options.email);
  if (!email.includes("@") || email.startsWith("@") || email.endsWith("@")) {
    throw new Error(`Invalid email address: ${options.email}`);
  }

  const issuer = typeof options.issuer === "string" ? options.issuer.trim() : "";
  const subject = typeof options.subject === "string" ? options.subject.trim() : "";
  const hasIssuer = issuer.length > 0;
  const hasSubject = subject.length > 0;
  if (hasIssuer !== hasSubject) {
    throw new Error(
      "Both issuer and subject must be supplied together when binding external identity"
    );
  }
  const externalIdentity = hasIssuer && hasSubject ? { issuer, subject } : undefined;

  const repo = new PrincipalRepository(db);
  const preInventory = inventoryLegacyReferences(db);

  // Check existing user principal
  const existingUser = repo.findUserByEmail(email);
  let principalId: string;
  let principalCreated = false;
  let principalReused = false;
  let externalIdentityBound = false;

  if (existingUser) {
    principalId = existingUser.id;
    principalReused = true;

    if (externalIdentity) {
      if (existingUser.identity) {
        if (
          existingUser.identity.issuer !== externalIdentity.issuer ||
          existingUser.identity.subject !== externalIdentity.subject
        ) {
          throw new Error(
            `Conflicting identity binding for email '${email}': user is already bound to issuer '${existingUser.identity.issuer}' and subject '${existingUser.identity.subject}'`
          );
        }
      } else {
        // Unbound user being bound now
        const conflictingHolder = repo.findUserByExternalIdentity(externalIdentity);
        if (conflictingHolder && conflictingHolder.id !== existingUser.id) {
          throw new Error(
            `Conflicting identity binding: external identity is already bound to user '${conflictingHolder.id}'`
          );
        }
        externalIdentityBound = true;
      }
    }
  } else {
    // New user
    principalCreated = true;
    if (externalIdentity) {
      const conflictingHolder = repo.findUserByExternalIdentity(externalIdentity);
      if (conflictingHolder) {
        throw new Error(
          `Conflicting identity binding: external identity is already bound to user '${conflictingHolder.id}'`
        );
      }
    }
    // Mint temporary id for dry-run preview if needed
    principalId = "";
  }

  if (!options.apply) {
    return {
      email,
      principalId: principalId || "(will be generated upon apply)",
      principalCreated,
      principalReused,
      externalIdentityBound,
      applied: false,
      preInventory,
      rewritesApplied: 0,
    };
  }

  // Apply all rewrites and principal initialization atomically in one transaction
  const now = new Date().toISOString();
  db.transaction(() => {
    if (principalCreated) {
      const created = repo.createUser({
        email,
        identity: externalIdentity,
        createdAt: now,
      });
      principalId = created.id;
    } else if (externalIdentityBound && externalIdentity) {
      repo.bindExternalIdentity(principalId, externalIdentity, now);
    }

    // Rewrite each authoritative reference column whose value is exactly `human:operator`
    for (const item of AUTHORITATIVE_REFERENCES) {
      if (!columnExists(db, item.table, item.column)) continue;
      db.prepare(`UPDATE "${item.table}" SET "${item.column}" = ? WHERE "${item.column}" = ?`).run(
        principalId,
        HUMAN_OPERATOR
      );
    }

    // In-transaction postcondition: check that 0 authoritative or dangling references remain before commit
    const inTxInventory = inventoryLegacyReferences(db);
    if (inTxInventory.totalAuthoritative !== 0) {
      throw new Error(
        `Migration integrity check failed: ${inTxInventory.totalAuthoritative} authoritative references remain after apply`
      );
    }
    if (inTxInventory.totalDangling !== 0) {
      throw new Error(
        `Migration integrity check failed: ${inTxInventory.totalDangling} unclassified legacy references detected: ${JSON.stringify(inTxInventory.dangling)}`
      );
    }
  })();

  const postInventory = inventoryLegacyReferences(db);

  return {
    email,
    principalId,
    principalCreated,
    principalReused,
    externalIdentityBound,
    applied: true,
    preInventory,
    postInventory,
    rewritesApplied: preInventory.totalAuthoritative,
  };
}

/**
 * Generate a Markdown report detailing the migration inventory, plan, and execution results.
 */
export function generateMigrationReport(result: MigrationResult, databasePath: string): string {
  const lines: string[] = [];
  lines.push("# Legacy Principal Migration Report");
  lines.push("");
  lines.push(`- **Database**: \`${databasePath}\``);
  lines.push(`- **Mode**: ${result.applied ? "**APPLIED**" : "**DRY RUN**"}`);
  lines.push(`- **Admission Email**: \`${result.email}\``);
  lines.push(`- **Principal ID**: \`${result.principalId}\``);
  lines.push(
    `- **Principal Status**: ${result.principalReused ? "Reused existing user principal" : "Created new durable user principal"}`
  );
  if (result.externalIdentityBound) {
    lines.push(`- **External Identity**: Bound to verified issuer + subject`);
  }
  lines.push(
    `- **Authoritative References Migrated**: ${result.applied ? result.rewritesApplied : `${result.preInventory.totalAuthoritative} proposed`}`
  );
  lines.push("");

  lines.push("## Authoritative References Inventory");
  lines.push("");
  lines.push("| Table | Column | Pre-Migration Count | Post-Migration Count |");
  lines.push("| :--- | :--- | :---: | :---: |");
  for (const item of result.preInventory.authoritative) {
    const postCount = result.postInventory
      ? (result.postInventory.authoritative.find(
          (p) => p.table === item.table && p.column === item.column
        )?.count ?? 0)
      : result.applied
        ? 0
        : item.count;
    lines.push(`| \`${item.table}\` | \`${item.column}\` | ${item.count} | ${postCount} |`);
  }
  lines.push("");

  lines.push("## Untouched Reference Sites (Preserved Without Mutation)");
  lines.push("");
  lines.push("| Table | Column | References Found | Preservation Rationale |");
  lines.push("| :--- | :--- | :---: | :--- |");
  for (const item of result.preInventory.untouched) {
    lines.push(`| \`${item.table}\` | \`${item.column}\` | ${item.count} | ${item.reason} |`);
  }
  lines.push("");

  lines.push("## Dynamic Schema Sweep (Unclassified References)");
  lines.push("");
  if (result.preInventory.dangling.length === 0) {
    lines.push("- Zero unclassified exact `human:operator` references found across all tables.");
  } else {
    lines.push("| Table | Column | References Found |");
    lines.push("| :--- | :--- | :---: |");
    for (const item of result.preInventory.dangling) {
      lines.push(`| \`${item.table}\` | \`${item.column}\` | ${item.count} |`);
    }
  }
  lines.push("");

  lines.push("## Verification Summary");
  lines.push("");
  if (result.applied) {
    lines.push("- [x] Explicit email verified and recorded as mutable admission metadata.");
    lines.push(
      "- [x] Authoritative references whose value was exactly `human:operator` rewritten to durable principal ID."
    );
    lines.push(
      "- [x] Free text, prose, logs, historical payloads, and provenance preserved untouched."
    );
    lines.push(
      "- [x] Single atomic transaction executed with zero remaining authoritative legacy references."
    );
  } else {
    lines.push(
      "- [ ] Dry run complete. No rows or principals written. Rerun with `--apply` to commit."
    );
  }
  lines.push("");

  return lines.join("\n");
}

/**
 * Create a verified online backup of the SQLite database before applying migration changes.
 * Uses SQLite's online backup API so WAL pages are safely captured without corruption or staleness,
 * verified via PRAGMA integrity_check on the resulting backup.
 */
export async function backupDatabase(
  dbOrPath: Database.Database | string,
  backupDir?: string
): Promise<string> {
  const isDbInstance = typeof dbOrPath !== "string" && "name" in dbOrPath;
  const sourcePath = isDbInstance ? resolve(dbOrPath.name) : resolve(dbOrPath as string);
  const targetDir = backupDir ? resolve(backupDir) : dirname(sourcePath);
  await mkdir(targetDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = join(targetDir, `mesh-backup-${timestamp}.db`);

  let dbToClose: Database.Database | null = null;
  let db: Database.Database;
  if (isDbInstance) {
    db = dbOrPath as Database.Database;
  } else {
    dbToClose = new Database(sourcePath);
    db = dbToClose;
  }
  try {
    await db.backup(backupPath);
  } finally {
    if (dbToClose) dbToClose.close();
  }

  const verifyDb = new Database(backupPath, { readonly: true });
  try {
    const rows = verifyDb.pragma("integrity_check") as Array<{ integrity_check: string }>;
    if (!rows || rows.length === 0 || rows[0].integrity_check !== "ok") {
      throw new Error(`Backup integrity check failed for ${backupPath}: ${JSON.stringify(rows)}`);
    }
  } finally {
    verifyDb.close();
  }
  return backupPath;
}
