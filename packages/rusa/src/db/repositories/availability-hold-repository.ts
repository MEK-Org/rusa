import type Database from "better-sqlite3";
import { normalizeModel, normalizeProvider } from "../../actor/halt-switch.js";

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
  provider: string;
  model: string | null;
  expiry: string | null;
  reason: string;
  created_by: string;
  created_at: string;
};

const COLUMNS = "provider, model, expiry, reason, created_by, created_at";

/**
 * Data access for durable availability holds (`availability_holds`).
 *
 * A hold takes a provider, or some of its models, out of model selection
 * without touching any configured pool. Provider and model names are
 * normalized the same way `/halt` normalizes them, so `agy` and `antigravity`
 * name the same lane. Expiry is evaluated against the caller's clock on every
 * read; expired rows stay until they are cleared.
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
      `INSERT INTO availability_holds (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (provider, COALESCE(model, '')) DO UPDATE SET
         expiry = excluded.expiry,
         reason = excluded.reason,
         created_by = excluded.created_by,
         created_at = excluded.created_at`
    );
    return this.db.transaction(() =>
      (models ?? [null]).map((model) => {
        upsert.run(provider, model, expiry, hold.reason ?? "", hold.createdBy, createdAt);
        return toHold({
          provider,
          model,
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
      const rows = models
        ? models.flatMap(
            (model) =>
              this.db
                .prepare(
                  `SELECT ${COLUMNS} FROM availability_holds WHERE provider = ? AND model = ?`
                )
                .all(provider, model) as AvailabilityHoldRow[]
          )
        : (this.db
            .prepare(
              `SELECT ${COLUMNS} FROM availability_holds WHERE provider = ? ORDER BY model IS NOT NULL, model`
            )
            .all(provider) as AvailabilityHoldRow[]);
      if (models) {
        const remove = this.db.prepare(
          "DELETE FROM availability_holds WHERE provider = ? AND model = ?"
        );
        for (const model of models) remove.run(provider, model);
      } else {
        this.db.prepare("DELETE FROM availability_holds WHERE provider = ?").run(provider);
      }
      return rows.map(toHold);
    })();
  }

  /**
   * Stored holds ordered by provider, then provider-wide before model rows.
   * Pass `now` to see only holds still active at that instant.
   */
  list(options: { now?: number } = {}): AvailabilityHold[] {
    const holds = this.selectAll().map(toHold);
    const { now } = options;
    return now === undefined ? holds : holds.filter((hold) => isActive(hold, now));
  }

  /**
   * True iff an active hold covers `provider`, or `model` on it. A caller that
   * cannot name its model is treated as held when any model on the provider is
   * held, matching the `/halt` brake: it must not run on a held lane.
   */
  isHeld(provider: string, model: string | undefined, now: number): boolean {
    const normalizedProvider = normalizeProvider(provider);
    if (!normalizedProvider) return false;
    const rows = this.db
      .prepare(`SELECT ${COLUMNS} FROM availability_holds WHERE provider = ?`)
      .all(normalizedProvider) as AvailabilityHoldRow[];
    const normalizedModel = model === undefined ? undefined : normalizeModel(model);
    return rows.some((row) => {
      if (!isActive(toHold(row), now)) return false;
      if (row.model === null || !normalizedModel) return true;
      return row.model === normalizedModel;
    });
  }

  private selectAll(): AvailabilityHoldRow[] {
    return this.db
      .prepare(
        `SELECT ${COLUMNS} FROM availability_holds ORDER BY provider, model IS NOT NULL, model`
      )
      .all() as AvailabilityHoldRow[];
  }
}

function isActive(hold: AvailabilityHold, now: number): boolean {
  return hold.expiry === undefined || Date.parse(hold.expiry) > now;
}

function toHold(row: AvailabilityHoldRow): AvailabilityHold {
  return {
    provider: row.provider,
    ...(row.model === null ? {} : { model: row.model }),
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
