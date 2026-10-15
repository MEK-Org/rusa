import type Database from "better-sqlite3";
import { z } from "zod";
import { normalizeModel, normalizeProvider } from "../../actor/halt-switch.js";

/**
 * Version of the `availability_holds.scope` document. The column carries no
 * database-level shape constraint (0057_availability_holds); the shape is owned
 * and validated here, at the point of consumption, as `host_jobs.manifest` is
 * owned by `DbHostJobStore`.
 */
export const AVAILABILITY_HOLD_SCOPE_SCHEMA_VERSION = 1;

const scopeDocumentSchema = z
  .object({
    schemaVersion: z.literal(AVAILABILITY_HOLD_SCOPE_SCHEMA_VERSION),
    provider: z.string().min(1),
    model: z.string().min(1).optional(),
  })
  .strict();

/**
 * One stored availability hold (#539). `model` is absent for a hold on the
 * whole provider lane; `expiry` is absent for a hold that lasts until cleared.
 */
export interface AvailabilityHold {
  provider: string;
  model?: string;
  expiry?: string;
  reason: string;
  createdBy: string;
  createdAt: string;
}

/** A requested hold scope: the whole provider, or the listed models on it. */
export interface AvailabilityHoldScope {
  provider: string;
  models?: string[];
}

export interface SetAvailabilityHold extends AvailabilityHoldScope {
  expiry?: string;
  reason?: string;
  createdBy: string;
  createdAt: string;
}

type AvailabilityHoldRow = {
  scope: string;
  expiry: string | null;
  reason: string;
  created_by: string;
  created_at: string;
};

const COLUMNS = "scope, expiry, reason, created_by, created_at";

/**
 * Data access for durable availability holds (`availability_holds`).
 *
 * A hold takes a provider, or some of its models, out of model selection
 * without touching any configured pool. Provider and model names are
 * normalized the same way `/halt` normalizes them, so `agy` and `antigravity`
 * name the same lane. Expiry is evaluated against the caller's clock on every
 * read; expired rows stay until they are cleared. Each row's scope is stored
 * as one versioned JSON document, `{"schemaVersion":1,"provider":…}` or
 * `{"schemaVersion":1,"provider":…,"model":…}`, always serialized the same way
 * so the unique index on `scope` sees a repeated scope. Reads parse and
 * validate every row they touch and throw on a scope they do not understand,
 * including one that is not in that canonical form.
 */
export class AvailabilityHoldRepository {
  constructor(private readonly db: Database.Database) {}

  /**
   * Hold `provider` (every model when `models` is omitted or empty), replacing
   * any stored hold with the same scope. Returns the stored rows.
   */
  set(hold: SetAvailabilityHold): AvailabilityHold[] {
    const provider = requireProvider(hold.provider);
    const models = normalizeModels(hold.models);
    const expiry = hold.expiry === undefined ? null : canonicalTimestamp(hold.expiry, "expiry");
    const createdAt = canonicalTimestamp(hold.createdAt, "createdAt");
    const upsert = this.db.prepare(
      `INSERT INTO availability_holds (${COLUMNS}) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (scope) DO UPDATE SET
         expiry = excluded.expiry,
         reason = excluded.reason,
         created_by = excluded.created_by,
         created_at = excluded.created_at`
    );
    return this.db.transaction(() =>
      (models ?? [null]).map((model) => {
        const scope = scopeJson(provider, model);
        upsert.run(scope, expiry, hold.reason ?? "", hold.createdBy, createdAt);
        return toHold({
          scope,
          expiry,
          reason: hold.reason ?? "",
          created_by: hold.createdBy,
          created_at: createdAt,
        });
      })
    )();
  }

  /**
   * Delete stored holds. Without `models`, every hold on the provider goes,
   * whether provider-wide or model-scoped; with `models`, only those model
   * rows go and a provider-wide hold stays. Returns the deleted rows.
   */
  clear(scope: AvailabilityHoldScope): AvailabilityHold[] {
    const provider = requireProvider(scope.provider);
    const models = normalizeModels(scope.models);
    return this.db.transaction(() => {
      const scopes = models
        ? new Set(models.map((model) => scopeJson(provider, model)))
        : undefined;
      const rows = this.selectAll()
        .map((row) => ({ scope: row.scope, hold: toHold(row) }))
        .filter((row) => (scopes ? scopes.has(row.scope) : row.hold.provider === provider));
      const remove = this.db.prepare("DELETE FROM availability_holds WHERE scope = ?");
      for (const row of rows) remove.run(row.scope);
      return rows.map((row) => row.hold).sort(compareHolds);
    })();
  }

  /**
   * Stored holds ordered by provider, then provider-wide before model rows.
   * Pass `now` to see only holds still active at that instant.
   */
  list(options: { now?: number } = {}): AvailabilityHold[] {
    const holds = this.selectAll().map(toHold).sort(compareHolds);
    const { now } = options;
    return now === undefined ? holds : holds.filter((hold) => isActive(hold, now));
  }

  /**
   * True iff an active hold covers `provider`, or `model` on it. A caller that
   * cannot name its model is treated as held when any model on the provider is
   * held, matching the `/halt` brake: it must not run on a held lane.
   * Expired rows are skipped before their scope is parsed, so only an active
   * row this code cannot read blocks selection.
   */
  isHeld(provider: string, model: string | undefined, now: number): boolean {
    const normalizedProvider = normalizeProvider(provider);
    if (!normalizedProvider) return false;
    const normalizedModel = model === undefined ? undefined : normalizeModel(model);
    return this.selectAll().some((row) => {
      if (!isActiveAt(row.expiry ?? undefined, now)) return false;
      const hold = toHold(row);
      if (hold.provider !== normalizedProvider) return false;
      if (hold.model === undefined || !normalizedModel) return true;
      return hold.model === normalizedModel;
    });
  }

  /** Every stored row, unparsed and in no particular order. */
  private selectAll(): AvailabilityHoldRow[] {
    return this.db
      .prepare(`SELECT ${COLUMNS} FROM availability_holds`)
      .all() as AvailabilityHoldRow[];
  }
}

function compareHolds(a: AvailabilityHold, b: AvailabilityHold): number {
  if (a.provider !== b.provider) return a.provider < b.provider ? -1 : 1;
  if (a.model === b.model) return 0;
  if (a.model === undefined) return -1;
  if (b.model === undefined) return 1;
  return a.model < b.model ? -1 : 1;
}

function isActive(hold: AvailabilityHold, now: number): boolean {
  return isActiveAt(hold.expiry, now);
}

function isActiveAt(expiry: string | undefined, now: number): boolean {
  return expiry === undefined || Date.parse(expiry) > now;
}

/**
 * Canonical scope text for normalized names: fixed key order, no whitespace,
 * `model` only when present. Every write goes through here.
 */
function scopeJson(provider: string, model: string | null): string {
  return JSON.stringify({
    schemaVersion: AVAILABILITY_HOLD_SCOPE_SCHEMA_VERSION,
    provider,
    ...(model === null ? {} : { model }),
  });
}

/**
 * Parse a stored scope. Only the text {@link scopeJson} writes for normalized
 * names is accepted: any other spelling of the same scope would get past the
 * unique index and be missed by a clear that matches the stored text.
 */
function parseScope(scope: string): z.infer<typeof scopeDocumentSchema> {
  let document: z.infer<typeof scopeDocumentSchema>;
  try {
    document = scopeDocumentSchema.parse(JSON.parse(scope));
  } catch (cause) {
    throw new Error(`invalid availability hold scope ${JSON.stringify(scope)}`, { cause });
  }
  const canonical = scopeJson(
    normalizeProvider(document.provider),
    document.model === undefined ? null : normalizeModel(document.model)
  );
  if (scope !== canonical) {
    throw new Error(`invalid availability hold scope ${JSON.stringify(scope)}`);
  }
  return document;
}

function toHold(row: AvailabilityHoldRow): AvailabilityHold {
  const scope = parseScope(row.scope);
  return {
    provider: scope.provider,
    ...(scope.model === undefined ? {} : { model: scope.model }),
    ...(row.expiry === null ? {} : { expiry: row.expiry }),
    reason: row.reason,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

function requireProvider(provider: string): string {
  const normalized = normalizeProvider(provider);
  if (!normalized) throw new Error("availability hold requires a provider");
  return normalized;
}

function normalizeModels(models: string[] | undefined): string[] | undefined {
  if (!models) return undefined;
  const normalized = [...new Set(models.map(normalizeModel).filter(Boolean))];
  if (models.length > 0 && normalized.length === 0) {
    throw new Error("availability hold model list cannot be blank");
  }
  return normalized.length > 0 ? normalized : undefined;
}

function canonicalTimestamp(value: string, field: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error(`invalid availability hold ${field} "${value}"`);
  return new Date(timestamp).toISOString();
}
