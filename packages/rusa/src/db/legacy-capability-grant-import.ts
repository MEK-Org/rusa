import { existsSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { z } from "zod";
import { CAPABILITY_GRANTS_FILENAME, type CapabilityGrant } from "../actor/capability-grants.js";
import type { Repositories } from "./repositories/index.js";

/** The read-only slice of {@link Repositories} a plan is allowed to touch. */
interface PlanRepositories {
  actors: Pick<Repositories["actors"], "list">;
  capabilityGrants: Pick<Repositories["capabilityGrants"], "list">;
}

const legacyGrantSchema = z
  .object({
    actorId: z.string().min(1),
    capability: z.string().min(1),
    grantedBy: z.string().min(1),
    grantedAt: z.string().datetime({ offset: true }),
    revokedAt: z.string().datetime({ offset: true }).optional(),
  })
  .strict();
const legacyFileSchema = z.object({ grants: z.array(legacyGrantSchema) }).strict();

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (cause) {
    throw new Error(`Legacy capability-grant import: cannot parse ${path}`, { cause });
  }
}

/** Normalize an accepted ISO-8601 datetime (Z or offset form) to canonical trailing-Z. */
function toCanonicalTimestamp(value: string): string {
  return new Date(value).toISOString();
}

// Mirrors legacy-actor-import.ts's archive helpers: rename rather than
// delete, so the pre-import file is always recoverable after a commit.
function backupPath(path: string): string {
  const timestamp = new Date().toISOString().replaceAll(":", "-");
  let candidate = `${path}.imported-${timestamp}.bak`;
  let suffix = 1;
  while (existsSync(candidate)) candidate = `${path}.imported-${timestamp}-${suffix++}.bak`;
  return candidate;
}

function archive(path: string): string {
  const destination = backupPath(path);
  renameSync(path, destination);
  return destination;
}

function grantKey(g: { actorId: string; capability: string }): string {
  return `${g.actorId} ${g.capability}`;
}

function canonical(g: CapabilityGrant): string {
  return JSON.stringify({
    actorId: g.actorId,
    capability: g.capability,
    grantedBy: g.grantedBy,
    grantedAt: g.grantedAt,
    revokedAt: g.revokedAt ?? null,
  });
}

export interface LegacyCapabilityGrantImportResult {
  importedGrants: number;
  backupFiles: string[];
}

/** A read-only plan of what {@link applyLegacyCapabilityGrantImport} would do, with no writes performed. */
export type LegacyCapabilityGrantImportPlan =
  | { kind: "noop" }
  | { kind: "already-imported" }
  | { kind: "import"; grants: CapabilityGrant[] };

export interface LegacyCapabilityGrantImportPlanResult {
  plan: LegacyCapabilityGrantImportPlan;
  hasFile: boolean;
  filePath: string;
}

/**
 * Parse, normalize, and validate `capability-grants.json` against the current
 * `capability_grants` projection — including the divergence check that guards
 * SQLite from being overwritten by a stale/recreated file — without
 * performing any write. Only accepts a read-only slice of {@link Repositories}
 * (`actors.list` and `capabilityGrants.list`), so it cannot open a DB
 * transaction, write a grant, or archive the legacy file.
 */
export function planLegacyCapabilityGrantImport(options: {
  mcHome: string;
  repositories: PlanRepositories;
}): LegacyCapabilityGrantImportPlanResult {
  const filePath = join(options.mcHome, CAPABILITY_GRANTS_FILENAME);
  const hasFile = existsSync(filePath);
  if (!hasFile) {
    return { plan: { kind: "noop" }, hasFile, filePath };
  }

  const parsed = legacyFileSchema.parse(readJson(filePath));
  // A hand-edited/corrupt file could repeat a (actorId, capability) pair;
  // later entries win, matching FileCapabilityGrantStore.refreshFromDisk().
  const byKey = new Map<string, CapabilityGrant>();
  for (const g of parsed.grants) {
    byKey.set(grantKey(g), {
      actorId: g.actorId,
      capability: g.capability,
      grantedBy: g.grantedBy,
      grantedAt: toCanonicalTimestamp(g.grantedAt),
      ...(g.revokedAt ? { revokedAt: toCanonicalTimestamp(g.revokedAt) } : {}),
    });
  }
  const expected = [...byKey.values()];

  const actorIds = new Set(options.repositories.actors.list().map((a) => a.id));
  for (const g of expected) {
    if (!actorIds.has(g.actorId)) {
      throw new Error(
        `Legacy capability-grant import: grant references unknown actor '${g.actorId}'`
      );
    }
  }

  const existing = options.repositories.capabilityGrants.list();
  if (existing.length > 0) {
    const expectedByKey = new Map(expected.map((g) => [grantKey(g), canonical(g)]));
    const existingByKey = new Map(existing.map((g) => [grantKey(g), canonical(g)]));
    const diverges =
      expectedByKey.size !== existingByKey.size ||
      [...expectedByKey].some(([key, value]) => existingByKey.get(key) !== value);
    if (diverges) {
      throw new Error(
        "Legacy capability-grant import: capability-grants.json diverges from SQLite; refusing to overwrite durable grants"
      );
    }
    return { plan: { kind: "already-imported" }, hasFile, filePath };
  }

  return { plan: { kind: "import", grants: expected }, hasFile, filePath };
}

/**
 * Apply a {@link LegacyCapabilityGrantImportPlan} produced by
 * {@link planLegacyCapabilityGrantImport} for the same home: write the durable
 * rows in one transaction, then archive the legacy file. SQLite is
 * authoritative for capability grants after commit. If a crash leaves the
 * source file in place, a later boot re-plans, finds the committed rows
 * already match the file exactly, and archives it without writing again.
 */
export function applyLegacyCapabilityGrantImport(
  planResult: LegacyCapabilityGrantImportPlanResult,
  options: { db: Database.Database; repositories: Repositories }
): LegacyCapabilityGrantImportResult {
  const { plan, filePath } = planResult;

  switch (plan.kind) {
    case "noop":
      return { importedGrants: 0, backupFiles: [] };

    case "already-imported":
      return { importedGrants: 0, backupFiles: [archive(filePath)] };

    case "import": {
      const { grants } = plan;
      options.db.transaction(() => {
        for (const g of grants) {
          options.repositories.capabilityGrants.grant({
            actorId: g.actorId,
            capability: g.capability,
            grantedBy: g.grantedBy,
            grantedAt: g.grantedAt,
          });
          if (g.revokedAt) {
            options.repositories.capabilityGrants.revoke(g.actorId, g.capability, g.revokedAt);
          }
        }
      })();
      return { importedGrants: grants.length, backupFiles: [archive(filePath)] };
    }
  }
}

/**
 * Import the retired `capability-grants.json` file exactly once: plan, then
 * apply. See {@link planLegacyCapabilityGrantImport} and
 * {@link applyLegacyCapabilityGrantImport}.
 */
export function importLegacyCapabilityGrantState(options: {
  mcHome: string;
  db: Database.Database;
  repositories: Repositories;
}): LegacyCapabilityGrantImportResult {
  const planResult = planLegacyCapabilityGrantImport(options);
  return applyLegacyCapabilityGrantImport(planResult, options);
}
