import type { QuotaLimit, QuotaWindowKind } from "../mcp/quota-mcp.js";

const KNOWN_KINDS = new Set<QuotaWindowKind>(["session", "five_hour", "weekly", "other"]);

export interface CanonicalQuotaBucketIdentity {
  poolId: string;
  provider: string;
  scope: "provider" | "model";
  kind: QuotaWindowKind;
  key: string;
}

function keyPart(value: string): string {
  return encodeURIComponent(value.normalize("NFKC").trim().toLocaleLowerCase("en-US"));
}

/**
 * Stable identity for one quota pool. Human labels deliberately do not participate:
 * provider TUIs and LLM parsing routinely vary "Weekly Limit" into
 * "Weekly Limit Remaining" without changing the underlying pool.
 */
export function canonicalQuotaBucketIdentity(
  poolId: string,
  provider: string,
  limit: Pick<QuotaLimit, "kind" | "scope">
): CanonicalQuotaBucketIdentity {
  const scope = limit.scope === "model" ? "model" : "provider";
  const kind = limit.kind && KNOWN_KINDS.has(limit.kind) ? limit.kind : "other";
  const normalizedPoolId = poolId.trim() || "default";
  const normalizedProvider = provider.trim().toLocaleLowerCase("en-US");
  return {
    poolId: normalizedPoolId,
    provider: normalizedProvider,
    scope,
    kind,
    key: [normalizedPoolId, normalizedProvider, scope, kind].map(keyPart).join(":"),
  };
}

export function quotaWindowMs(kind: QuotaWindowKind): number {
  if (kind === "weekly") return 7 * 24 * 60 * 60 * 1000;
  return 5 * 60 * 60 * 1000;
}
