import type { PublishedThrottleProviderStatus } from "./coordinator-protocol.js";
import type { PersistedQuotaProviderStatus } from "./shared-store.js";

/** A bounded, panel-free result for the temporary stage-2 publication canary. */
export type ThrottleCompareOutcome =
  | "match"
  | "mismatch"
  | "cold"
  | "stale"
  | "unavailable"
  | "incompatible";

/** The only states emitted by the compare-only record. */
export type ThrottleCompareState =
  | "active"
  | "exhausted"
  | "cold"
  | "stale"
  | "unavailable"
  | "incompatible";

/**
 * The fields carried by `quota_throttle_compare`. They deliberately exclude
 * quota buckets, percentages, reset times, and controller panels: a canary
 * needs to say whether the two mapped decisions agree, not copy quota data
 * into every instance's journal.
 */
export interface ThrottleCompareRecord {
  outcome: ThrottleCompareOutcome;
  coordinatorState: ThrottleCompareState;
  legacyState: "active" | "exhausted" | "cold";
  intervalMatch: boolean | null;
  stateMatch: boolean | null;
}

export type CoordinatorComparisonInput =
  | PublishedThrottleProviderStatus
  | "cold"
  | "unavailable"
  | "incompatible";

function legacyState(status: PersistedQuotaProviderStatus | null): "active" | "exhausted" | "cold" {
  if (!status) return "cold";
  return status.expired ? "exhausted" : "active";
}

/**
 * Compare already-mapped coordinator output against the legacy local result.
 * The caller owns the two reads; this pure mapping keeps every emitted field
 * finite and prevents logging either side's raw quota panel.
 */
export function compareCoordinatorThrottle(
  coordinator: CoordinatorComparisonInput,
  legacy: PersistedQuotaProviderStatus | null
): ThrottleCompareRecord {
  const localState = legacyState(legacy);
  if (typeof coordinator === "string") {
    return {
      outcome: coordinator,
      coordinatorState: coordinator,
      legacyState: localState,
      intervalMatch: null,
      stateMatch: null,
    };
  }

  const coordinatorState: ThrottleCompareState = coordinator.freshness.stale
    ? "stale"
    : coordinator.expired
      ? "exhausted"
      : "active";
  const intervalMatch = legacy ? coordinator.intervalSeconds === legacy.intervalSeconds : null;
  const stateMatch = legacy ? coordinator.expired === legacy.expired : null;

  if (coordinatorState === "stale" || !legacy) {
    return {
      outcome: coordinatorState === "stale" ? "stale" : "cold",
      coordinatorState,
      legacyState: localState,
      intervalMatch,
      stateMatch,
    };
  }

  return {
    outcome: intervalMatch && stateMatch ? "match" : "mismatch",
    coordinatorState,
    legacyState: localState,
    intervalMatch,
    stateMatch,
  };
}
