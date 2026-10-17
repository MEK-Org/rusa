import { randomUUID } from "node:crypto";
import type {
  QuotaCoordinatorError,
  QuotaSprintArmRequest,
  QuotaSprintBucket,
  QuotaSprintCancelRequest,
  QuotaSprintCurrent,
  QuotaSprintEnded,
  QuotaSprintEndReason,
  QuotaSprintPolicy,
  QuotaSprintState,
} from "./coordinator-protocol.js";
import {
  type QuotaCycleObservation,
  quotaCycleChanged,
  verifiedQuotaCycleTransition,
} from "./quota-cycle.js";
import {
  modelScopeKey,
  PROVIDER_SCOPE_KEY,
  type QuotaLaneObservation,
  type QuotaReadingMode,
  type QuotaThrottleElectionOptions,
  type SharedQuotaStore,
} from "./shared-store.js";

/**
 * The operator-armed weekly sprint (#861), held in coordinator memory only.
 *
 * An arm is a single-use, expiring permission to drop one canonical weekly
 * bucket's even-spread delay from the governing election. It is not quota: the
 * store's observations, controller decisions and exhaustion gate are never
 * touched here, and every other window keeps binding. Nothing is persisted, so
 * a coordinator restart (including every deploy) disarms; the boot ID in each
 * request makes a request aimed at an earlier boot refuse rather than re-arm.
 *
 * Retained state is bounded to the current arm and the latest ended one per
 * provider. A retry of either's request returns its recorded result; anything
 * older is refused on its stale revision.
 */
export interface QuotaSprintRegistryOptions {
  store: SharedQuotaStore;
  now: () => number;
  /** The soft-stale horizon of a reading mode, as `/v1/throttle` resolves it. */
  freshness: (mode: QuotaReadingMode) => { staleAfterMs: number; hardStaleAfterMs: number };
  bootId?: string;
}

export type QuotaSprintResult =
  | { ok: true; duplicate: boolean }
  | { ok: false; status: number; error: QuotaCoordinatorError };

export interface QuotaSprintSnapshot {
  boot: { id: string; startedAt: string };
  revision: number;
  readingMode: { mode: QuotaReadingMode; generation: number };
  buckets: QuotaSprintBucket[];
  policy: QuotaSprintCurrent | null;
  lastEnded: QuotaSprintEnded | null;
  notes: string[];
}

interface Retained<T> {
  value: T;
  /** The arm request's identity, so a retry with a changed body is refused. */
  fingerprint: string;
}

interface ProviderSprint {
  revision: number;
  current: (Retained<QuotaSprintPolicy> & { modelScope: string; state: QuotaSprintState }) | null;
  lastEnded: Retained<QuotaSprintEnded> | null;
  /** The newest refused request that named an earlier coordinator boot. */
  staleBoot: { bootId: string; at: string } | null;
}

const WEEKLY = "weekly";

const END_MESSAGES: Record<QuotaSprintEndReason, string> = {
  cancelled: "The operator cancelled the sprint; ordinary pacing applies to the same cycle.",
  expired: "The sprint reached its expiry; ordinary pacing applies to the same cycle.",
  exhausted:
    "An actual reading showed the target bucket exhausted, which ended the sprint. The " +
    "exhausted-lane gate stays until a fresh actual reading shows headroom.",
  new_cycle:
    "A fresh actual reading showed a new weekly cycle with headroom. The arm was consumed; " +
    "ordinary pacing applies to the new cycle.",
  deadline_moved:
    "The target bucket's reset deadline moved without a verified new cycle. The arm ended; " +
    "ordinary pacing applies.",
  cycle_ambiguous:
    "An actual reading of the target bucket carried no usable reset deadline, so the bound " +
    "cycle could not be confirmed. The arm ended; ordinary pacing applies.",
  reading_mode_changed:
    "The provider's reading-mode generation changed. The arm ended; ordinary pacing resumes " +
    "with the next accepted reading.",
  model_scope_changed:
    "The provider now reports the target models under a different model set. The arm ended; " +
    "arm the new bucket deliberately if a sprint is still wanted.",
};

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function sameInstant(left: string, right: string | null): boolean {
  if (right === null) return false;
  const leftMs = Date.parse(left);
  return Number.isFinite(leftMs) && leftMs === Date.parse(right);
}

function hasFutureReset(observation: { observedAt: string; resetAtIso: string | null }): boolean {
  if (!observation.resetAtIso) return false;
  const resetMs = Date.parse(observation.resetAtIso);
  return Number.isFinite(resetMs) && resetMs > Date.parse(observation.observedAt);
}

function armFingerprint(request: QuotaSprintArmRequest): string {
  return JSON.stringify([
    request.bucket,
    Date.parse(request.cycleAnchor),
    request.generation,
    Date.parse(request.expiresAt),
  ]);
}

function refuse(status: number, code: QuotaCoordinatorError["code"], message: string) {
  return { ok: false as const, status, error: { code, message, retryable: false } };
}

export class QuotaSprintRegistry {
  readonly bootId: string;
  readonly bootStartedAt: string;
  private readonly providers = new Map<string, ProviderSprint>();

  constructor(private readonly options: QuotaSprintRegistryOptions) {
    this.bootId = options.bootId ?? randomUUID();
    this.bootStartedAt = iso(options.now());
  }

  private entry(provider: string): ProviderSprint {
    let entry = this.providers.get(provider);
    if (!entry) {
      entry = { revision: 0, current: null, lastEnded: null, staleBoot: null };
      this.providers.set(provider, entry);
    }
    return entry;
  }

  /**
   * Refresh once for a publication, so its policy block and effective election
   * cannot disagree at an expiry, staleness, or observation boundary.
   */
  publication(
    provider: string,
    nowMs = this.options.now()
  ): {
    policy: QuotaSprintCurrent | null;
    relax: QuotaThrottleElectionOptions["relax"];
  } {
    const current = this.refresh(provider, nowMs);
    return {
      policy: current ? { ...current.value, state: current.state } : null,
      relax:
        current?.state === "active" ? { modelScope: current.modelScope, kind: WEEKLY } : undefined,
    };
  }

  snapshot(
    provider: string,
    nowMs = this.options.now(),
    publication = this.publication(provider, nowMs)
  ): QuotaSprintSnapshot {
    const policy = publication.policy;
    const entry = this.entry(provider);
    const { mode, generation } = this.options.store.getQuotaReadingMode(provider);
    const { staleAfterMs, hardStaleAfterMs } = this.options.freshness(mode);
    const buckets = this.options.store
      .listLatestLaneObservations(provider, WEEKLY)
      .map((lane): QuotaSprintBucket => {
        const ageMs = Math.max(0, nowMs - Date.parse(lane.observedAt));
        return {
          key: lane.key,
          models: lane.models,
          latest: {
            observedAt: lane.observedAt,
            percentLeft: lane.percentLeft,
            resetAtIso: lane.resetAtIso,
          },
          cycleAnchor: hasFutureReset(lane) ? lane.resetAtIso : null,
          freshness: { ageMs, stale: ageMs > staleAfterMs, hardStale: ageMs > hardStaleAfterMs },
        };
      });
    const notes: string[] = [];
    if (!policy) {
      notes.push(
        `No sprint is armed for ${provider} in coordinator boot ${this.bootId}, started ` +
          `${this.bootStartedAt}. Sprint policy is held in memory only: any sprint armed ` +
          "before this boot was disarmed when it started and will not resume. Arm again " +
          "deliberately if a sprint is still wanted."
      );
    } else if (policy.state === "suspended_stale") {
      notes.push(
        "The sprint is suspended because the target bucket's latest actual reading is stale; " +
          "ordinary pacing applies until a fresh reading of the same cycle arrives. The " +
          "expiry does not move."
      );
    }
    if (entry.staleBoot) {
      notes.push(
        `A request for earlier coordinator boot ${entry.staleBoot.bootId} was refused at ` +
          `${entry.staleBoot.at}. Any policy from that boot was lost when this boot started.`
      );
    }
    return {
      boot: { id: this.bootId, startedAt: this.bootStartedAt },
      revision: entry.revision,
      readingMode: { mode, generation },
      buckets,
      policy,
      lastEnded: entry.lastEnded?.value ?? null,
      notes,
    };
  }

  /** The current and latest ended policy, as an action response reports them. */
  retained(provider: string): {
    revision: number;
    policy: QuotaSprintCurrent | null;
    lastEnded: QuotaSprintEnded | null;
  } {
    const entry = this.entry(provider);
    return {
      revision: entry.revision,
      policy: entry.current ? { ...entry.current.value, state: entry.current.state } : null,
      lastEnded: entry.lastEnded?.value ?? null,
    };
  }

  arm(request: QuotaSprintArmRequest): QuotaSprintResult {
    const { provider } = request;
    const bootRefusal = this.checkBoot(provider, request.bootId);
    if (bootRefusal) return bootRefusal;
    this.refresh(provider);
    const entry = this.entry(provider);
    const fingerprint = armFingerprint(request);
    for (const retained of [entry.current, entry.lastEnded]) {
      if (retained?.value.requestId !== request.requestId) continue;
      return retained.fingerprint === fingerprint
        ? { ok: true, duplicate: true }
        : refuse(409, "idempotency_conflict", "requestId was already used for a different arm");
    }
    if (request.revision !== entry.revision) {
      return refuse(
        409,
        "sprint_revision_conflict",
        `Sprint revision is ${entry.revision}, not ${request.revision}; read status again`
      );
    }
    if (entry.current) {
      return refuse(
        409,
        "sprint_already_armed",
        `Sprint ${entry.current.value.armId} is already armed; cancel it first`
      );
    }
    const lanes = this.options.store.listLatestLaneObservations(provider, WEEKLY);
    const lane = lanes.find((candidate) => candidate.key === request.bucket);
    if (!lane) {
      return refuse(
        409,
        "sprint_bucket_unknown",
        `${request.bucket} is not a weekly bucket ${provider} currently reports`
      );
    }
    const nowMs = this.options.now();
    const mode = this.options.store.getQuotaReadingMode(provider);
    const evidenceProblem = this.evidenceProblem(lane, mode.mode, nowMs);
    if (evidenceProblem) return refuse(409, "sprint_evidence_unusable", evidenceProblem);
    if (!sameInstant(request.cycleAnchor, lane.resetAtIso)) {
      return refuse(
        409,
        "sprint_cycle_mismatch",
        `The bucket's observed cycle anchor is ${lane.resetAtIso}, not ${request.cycleAnchor}`
      );
    }
    if (request.generation !== mode.generation) {
      return refuse(
        409,
        "mode_generation_mismatch",
        `Reading-mode generation is ${mode.generation}, not ${request.generation}`
      );
    }
    const expiresMs = Date.parse(request.expiresAt);
    if (expiresMs <= nowMs) {
      return refuse(409, "sprint_expiry_invalid", "expiresAt has already passed");
    }
    if (expiresMs > Date.parse(lane.resetAtIso as string)) {
      return refuse(
        409,
        "sprint_expiry_invalid",
        `expiresAt must not be later than the observed weekly reset ${lane.resetAtIso}`
      );
    }
    entry.revision += 1;
    entry.current = {
      value: {
        armId: randomUUID(),
        requestId: request.requestId,
        provider,
        bucketKey: lane.key,
        models: [...lane.models],
        readingModeGeneration: mode.generation,
        cycleAnchor: {
          resetAtIso: lane.resetAtIso as string,
          observedAt: lane.observedAt,
          percentLeft: lane.percentLeft,
        },
        armedAt: iso(nowMs),
        expiresAt: iso(expiresMs),
      },
      fingerprint,
      modelScope: lane.models.length === 0 ? PROVIDER_SCOPE_KEY : modelScopeKey(lane.models),
      state: "active",
    };
    return { ok: true, duplicate: false };
  }

  cancel(request: QuotaSprintCancelRequest): QuotaSprintResult {
    const { provider } = request;
    const bootRefusal = this.checkBoot(provider, request.bootId);
    if (bootRefusal) return bootRefusal;
    this.refresh(provider);
    const entry = this.entry(provider);
    if (entry.current?.value.armId === request.armId) {
      if (request.revision !== entry.revision) {
        return refuse(
          409,
          "sprint_revision_conflict",
          `Sprint revision is ${entry.revision}, not ${request.revision}; read status again`
        );
      }
      this.end(entry, "cancelled", iso(this.options.now()));
      return { ok: true, duplicate: false };
    }
    // The arm already ended, by this cancel or anything else: nothing to undo,
    // and the newer state is left exactly as it is.
    if (entry.lastEnded?.value.armId === request.armId) return { ok: true, duplicate: true };
    return refuse(
      409,
      "sprint_arm_not_current",
      `Sprint ${request.armId} is neither armed nor the latest ended arm`
    );
  }

  private checkBoot(provider: string, bootId: string): QuotaSprintResult | null {
    if (bootId === this.bootId) return null;
    this.entry(provider).staleBoot = { bootId, at: iso(this.options.now()) };
    return refuse(
      409,
      "sprint_boot_mismatch",
      `The coordinator restarted: this is boot ${this.bootId}, not ${bootId}. Any sprint ` +
        "from the earlier boot was disarmed; read status and arm again deliberately."
    );
  }

  private evidenceProblem(
    lane: QuotaLaneObservation,
    mode: QuotaReadingMode,
    nowMs: number
  ): string | null {
    const ageMs = nowMs - Date.parse(lane.observedAt);
    if (!(ageMs <= this.options.freshness(mode).staleAfterMs)) {
      return `The latest ${lane.key} reading (${lane.observedAt}) is stale`;
    }
    if (lane.percentLeft <= 0) return `The latest ${lane.key} reading shows it exhausted`;
    if (!hasFutureReset(lane) || Date.parse(lane.resetAtIso as string) <= nowMs) {
      return `The latest ${lane.key} reading carries no future reset deadline`;
    }
    return null;
  }

  /**
   * End the current arm when its evidence no longer supports it, then settle
   * whether a surviving arm is active or suspended. Readings are walked in
   * order from the bound observation, so the first event that happened is the
   * reason reported; a reading taken after the expiry cannot outrank it.
   */
  private refresh(provider: string, nowMs = this.options.now()): ProviderSprint["current"] {
    const entry = this.entry(provider);
    const current = entry.current;
    if (!current) return null;
    const policy = current.value;
    const expiresMs = Date.parse(policy.expiresAt);
    const mode = this.options.store.getQuotaReadingMode(provider);
    if (mode.generation !== policy.readingModeGeneration) {
      this.end(entry, "reading_mode_changed", iso(nowMs));
      return null;
    }

    const anchorMs = Date.parse(policy.cycleAnchor.observedAt);
    let previous: QuotaCycleObservation = {
      observedAt: policy.cycleAnchor.observedAt,
      percentLeft: policy.cycleAnchor.percentLeft,
      resetAtIso: policy.cycleAnchor.resetAtIso,
    };
    let latest: QuotaCycleObservation = previous;
    const rows = this.options.store.listLaneObservationsSince(
      provider,
      current.modelScope,
      WEEKLY,
      policy.cycleAnchor.observedAt
    );
    for (const row of rows) {
      const observedMs = Date.parse(row.observedAt);
      if (!(observedMs > anchorMs)) continue;
      if (observedMs >= expiresMs) break;
      // Compare against the bound deadline, not the previous row's, so many
      // small moves cannot add up to a silent rebind.
      const bound = { ...previous, resetAtIso: policy.cycleAnchor.resetAtIso };
      const reason: QuotaSprintEndReason | null =
        row.percentLeft <= 0
          ? "exhausted"
          : !hasFutureReset(row)
            ? "cycle_ambiguous"
            : verifiedQuotaCycleTransition(bound, row)
              ? "new_cycle"
              : quotaCycleChanged(bound, row, row.windowMs)
                ? "deadline_moved"
                : null;
      if (reason) {
        this.end(entry, reason, row.observedAt);
        return null;
      }
      previous = row;
      latest = row;
    }

    if (policy.models.length > 0 && this.modelScopeChanged(provider, policy, latest)) {
      this.end(entry, "model_scope_changed", iso(nowMs));
      return null;
    }
    if (nowMs >= expiresMs) {
      this.end(entry, "expired", policy.expiresAt);
      return null;
    }
    const ageMs = nowMs - Date.parse(latest.observedAt);
    current.state =
      ageMs <= this.options.freshness(mode.mode).staleAfterMs ? "active" : "suspended_stale";
    return current;
  }

  /**
   * A model target whose models the provider now reports under a different
   * model set, in a reading newer than the target's own. An alias change must
   * not silently retarget the arm; an omitted lane alone only goes stale.
   */
  private modelScopeChanged(
    provider: string,
    policy: QuotaSprintPolicy,
    latest: QuotaCycleObservation
  ): boolean {
    const latestMs = Date.parse(latest.observedAt);
    return this.options.store
      .listLatestLaneObservations(provider, WEEKLY)
      .some(
        (lane) =>
          lane.key !== policy.bucketKey &&
          lane.models.some((model) => policy.models.includes(model)) &&
          Date.parse(lane.observedAt) > latestMs
      );
  }

  private end(entry: ProviderSprint, reason: QuotaSprintEndReason, endedAt: string): void {
    const current = entry.current;
    if (!current) return;
    entry.revision += 1;
    entry.current = null;
    entry.lastEnded = {
      value: { ...current.value, reason, endedAt, message: END_MESSAGES[reason] },
      fingerprint: current.fingerprint,
    };
  }
}
