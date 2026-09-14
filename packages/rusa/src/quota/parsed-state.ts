import type { ProviderQuotaSnapshot, QuotaLimit, QuotaWindowKind } from "../mcp/quota-mcp.js";

/**
 * Versioned `quota_scrapes.parsed_state` blob, written by
 * `SharedQuotaStore.recordParsed` and read back by every consumer of persisted
 * parse state (`getLatestSnapshot`, `listSince`, and the coordinator's
 * boot-time prevState hydration).
 *
 * The blob is validated here, in consuming code — deliberately not with SQLite
 * `json_*` functions or CHECK constraints: the column stays an opaque TEXT
 * blob the database never interprets, and a malformed or unsupported blob is
 * rejected conservatively (read as absent) rather than trusted partially.
 */

export const QUOTA_PARSED_STATE_VERSION = 1;

export interface VersionedQuotaParsedState {
  version: number;
  snapshot: ProviderQuotaSnapshot;
}

const VALID_STATUSES = new Set(["available", "exhausted", "unknown", "unsupported"]);
const VALID_KINDS = new Set(["session", "five_hour", "weekly", "other"]);
const VALID_EXPLANATION_FIELDS = new Set(["resetAtIso"]);
const VALID_INFERENCE_RULES = new Set([
  "sibling_window_copy",
  "assumed_window_starts_now",
  "carried_forward_bad_read",
]);

function isValidScope(raw: unknown, provider: string): boolean {
  if (raw === undefined || raw === null) return true;
  if (typeof raw !== "object" || Array.isArray(raw)) return false;
  const scope = raw as { provider?: unknown; models?: unknown };
  if (typeof scope.provider !== "string" || scope.provider !== provider) return false;
  if (scope.models !== undefined) {
    if (!Array.isArray(scope.models) || scope.models.length === 0) return false;
    const seen = new Set<string>();
    for (const model of scope.models) {
      if (typeof model !== "string" || !model.trim()) return false;
      if (seen.has(model)) return false;
      seen.add(model);
    }
  }
  return true;
}

/**
 * Normalise the pre-envelope, read-only compatibility format. The old parser
 * wrote `scope: "provider"` directly; turn that into the canonical object.
 * A legacy `scope: "model"` carries no canonical model IDs, so discard that
 * row rather than letting it become provider evidence after an upgrade.
 */
function normalizeLegacySnapshot(raw: unknown): unknown | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const state = raw as Record<string, unknown>;
  if ("version" in state || "snapshot" in state) return null;
  if (state.limits === undefined || state.limits === null) return { ...state };
  if (!Array.isArray(state.limits)) return null;

  const limits: unknown[] = [];
  for (const rawLimit of state.limits) {
    if (!rawLimit || typeof rawLimit !== "object" || Array.isArray(rawLimit)) return null;
    const limit = rawLimit as Record<string, unknown>;
    if (limit.scope === "model") continue;
    if (limit.scope !== undefined && limit.scope !== null && limit.scope !== "provider") {
      if (typeof limit.scope !== "object" || Array.isArray(limit.scope)) return null;
    }
    limits.push(
      limit.scope === "provider" ? { ...limit, scope: { provider: state.provider } } : { ...limit }
    );
  }
  return { ...state, limits };
}

function isValidLimit(raw: unknown, provider: string): boolean {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const limit = raw as Record<string, unknown>;
  if (typeof limit.label !== "string" || !limit.label.trim()) return false;
  if (limit.kind !== undefined && !VALID_KINDS.has(limit.kind as QuotaWindowKind)) {
    return false;
  }
  if (
    typeof limit.percentLeft !== "number" ||
    !Number.isFinite(limit.percentLeft) ||
    limit.percentLeft < 0 ||
    limit.percentLeft > 100
  ) {
    return false;
  }
  if (limit.resetAtIso !== undefined && limit.resetAtIso !== null) {
    if (typeof limit.resetAtIso !== "string" || !Number.isFinite(Date.parse(limit.resetAtIso))) {
      return false;
    }
  }
  return isValidScope(limit.scope, provider);
}

function isValidExplanation(raw: unknown, limitLabels: ReadonlySet<string>): boolean {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const explanation = raw as Record<string, unknown>;
  return (
    typeof explanation.window === "string" &&
    explanation.window.trim().length > 0 &&
    limitLabels.has(explanation.window) &&
    typeof explanation.field === "string" &&
    VALID_EXPLANATION_FIELDS.has(explanation.field) &&
    typeof explanation.rule === "string" &&
    VALID_INFERENCE_RULES.has(explanation.rule) &&
    typeof explanation.detail === "string"
  );
}

/**
 * Validate a decoded blob. Returns the snapshot only when the version is
 * exactly the one this build writes and every field that participates in a
 * downstream decision is well-formed; anything else — malformed JSON, a
 * missing/unknown version, an unsupported newer version, or a snapshot whose
 * shape does not hold — is rejected conservatively.
 */
function validateSnapshot(snapshot: unknown): ProviderQuotaSnapshot | null {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return null;
  const state = snapshot as Partial<ProviderQuotaSnapshot> & Record<string, unknown>;
  if (typeof state.provider !== "string" || !state.provider.trim()) return null;
  if (typeof state.status !== "string" || !VALID_STATUSES.has(state.status)) return null;
  if (state.limits !== undefined && state.limits !== null) {
    if (!Array.isArray(state.limits)) return null;
    for (const limit of state.limits) {
      if (!isValidLimit(limit, state.provider)) return null;
    }
  }
  const limitLabels = new Set(
    (state.limits ?? []).map((limit) => (limit as { label: string }).label)
  );
  if (state.scrapedAt !== undefined && state.scrapedAt !== null) {
    if (typeof state.scrapedAt !== "string" || !Number.isFinite(Date.parse(state.scrapedAt))) {
      return null;
    }
  }
  if (state.explanations !== undefined && state.explanations !== null) {
    if (!Array.isArray(state.explanations)) return null;
    for (const explanation of state.explanations) {
      if (!isValidExplanation(explanation, limitLabels)) return null;
    }
  }
  // Parsed snapshots are the normalized projection, never a second copy of
  // captured panel text. Rejecting `raw` here keeps a manually-corrupted blob
  // from escaping through a coordinator read response.
  if ("raw" in state) return null;
  return snapshot as ProviderQuotaSnapshot;
}

/**
 * Validate a decoded blob. Version 1 is the only persisted writer format.
 * Bare snapshots are the explicit version-0 compatibility input; they are
 * normalised then held to the same decision-bearing validation before use.
 */
export function validateParsedStateBlob(raw: unknown): ProviderQuotaSnapshot | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const blob = raw as { version?: unknown; snapshot?: unknown };
  if (blob.version === QUOTA_PARSED_STATE_VERSION) return validateSnapshot(blob.snapshot);
  if (blob.version !== undefined || "snapshot" in blob) return null;
  return validateSnapshot(normalizeLegacySnapshot(raw));
}

function normalizeSnapshotForStorage(snapshot: ProviderQuotaSnapshot): ProviderQuotaSnapshot {
  const limits = snapshot.limits
    // Runtime parser output never has this legacy spelling. Retain the filter
    // at the writer boundary so a stale in-process caller cannot create a v1
    // blob that the reader must reject.
    ?.filter((limit) => limit.scope !== "model")
    .map((limit): QuotaLimit => {
      if (limit.scope === "provider") {
        return { ...limit, scope: { provider: snapshot.provider } };
      }
      return { ...limit };
    });
  const { raw: _raw, ...withoutRaw } = snapshot;
  return { ...withoutRaw, ...(limits === undefined ? {} : { limits }) };
}

/** Serialize the inferred snapshot into the versioned persisted blob. */
export function serializeParsedState(snapshot: ProviderQuotaSnapshot): string {
  const blob: VersionedQuotaParsedState = {
    version: QUOTA_PARSED_STATE_VERSION,
    snapshot: normalizeSnapshotForStorage(snapshot),
  };
  return JSON.stringify(blob);
}

/**
 * Parse a persisted `parsed_state` column value. `null`/empty reads as absent
 * (the scrape was never successfully parsed); malformed or unsupported blobs
 * are rejected conservatively and also read as absent, so consuming code
 * never acts on a partially trusted shape.
 */
export function parseParsedState(value: string | null | undefined): ProviderQuotaSnapshot | null {
  if (!value) return null;
  try {
    return validateParsedStateBlob(JSON.parse(value));
  } catch {
    return null;
  }
}
