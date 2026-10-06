import type { ReferenceCacheRepository } from "../db/repositories/reference-cache-repository.js";
import { asGitHubIssue, parseReference, type Reference } from "./reference.js";
import {
  githubSubResourceLabel,
  type ReferenceEntity,
  type ReferenceResolverDeps,
  type ResolvedReferenceWithEntity,
  resolveReference,
  resolveReferenceSync,
} from "./resolve.js";

/**
 * A human-safe display title for a cached entity, derived only from the
 * entity itself and the reference's own path segments — never a network
 * call, so it's cheap to reconstruct on every cache hit. Without this, the
 * cache boundary would fall back to `base.title`, which for every non-mesh
 * scheme is the raw canonical ref (see `resolveReferenceSync`'s `unresolved`
 * fallback) — exactly the id/ref leak the dashboard must never render.
 */
function deriveDisplayTitle(reference: Reference, entity: ReferenceEntity): string | undefined {
  switch (entity.type) {
    case "github_issue":
    case "github_pull_request":
      return entity.title;
    case "github_comment": {
      const sub = githubSubResourceLabel(reference);
      return sub ? `${sub.label} — comment` : undefined;
    }
    case "github_review": {
      const sub = githubSubResourceLabel(reference);
      return sub ? `${sub.label} — review` : undefined;
    }
    case "gchat_space":
      return entity.name;
    case "gchat_message":
      // The provider author is intentionally not preserved in the cached
      // entity (only what the widget renders is), so this stays generic.
      return "Chat message";
    case "slack_channel":
      return entity.name;
    case "slack_message":
      return "Slack message";
    case "mesh_message":
      return undefined; // mesh is resolved locally, never cached here.
  }
}

/** A provider read in flight, and whether some get answered "pending" on it. */
interface InFlightRead {
  read: Promise<ReferenceEntity | null>;
  answeredPending: boolean;
}

/**
 * One request's foreground wait for cold references (#933). Every get given
 * the same budget gives up at the same instant, so a request that resolves
 * many references waits one deadline in total rather than one per reference.
 */
export interface ReferenceBudget {
  readonly deadlineAt: number;
}

export interface ReferenceCacheServiceOptions {
  repo: ReferenceCacheRepository;
  ttlMs?: number;
  deadlineMs?: number;
  /**
   * How long a provider read that was answered "pending" and then failed
   * answers a cold get as unavailable before the provider is asked again.
   * Long enough to outlast the dashboard's bounded retries of that pending
   * card (about 15 s), so they settle on a terminal state (#595); short
   * enough that a transient failure or a newly granted permission recovers
   * on its own.
   */
  unavailableTtlMs?: number;
  /** Provider reads allowed out at once; further reads queue for a slot. */
  maxConcurrentReads?: number;
  /**
   * Reads allowed to wait for a slot. Beyond it a cold get answers "pending"
   * without starting a read, and a stale hit skips its refresh, so one large
   * page cannot queue unbounded provider work; a later get asks again.
   */
  maxQueuedReads?: number;
  logger?: {
    info: (event: string, data?: Record<string, unknown>) => void;
    error: (event: string, data?: Record<string, unknown>) => void;
  };
}

export class ReferenceCacheService {
  private readonly repo: ReferenceCacheRepository;
  private readonly ttlMs: number;
  private readonly deadlineMs: number;
  private readonly unavailableTtlMs: number;
  private readonly maxConcurrentReads: number;
  private readonly maxQueuedReads: number;
  private activeReads = 0;
  private readonly queuedReads: Array<() => void> = [];
  private readonly logger?: ReferenceCacheServiceOptions["logger"];
  /**
   * The provider read currently out for each canonical ref. A cold get, a
   * stale refresh and a client retry that overlap all await this one read, so
   * a pending card's retries can never multiply provider traffic (#595).
   * `answeredPending` records that some get gave up waiting on it.
   */
  private readonly inFlight = new Map<string, InFlightRead>();
  /**
   * Canonical ref → epoch ms until which its last failed read stands. Only a
   * read some caller was told is pending lands here: that caller retries,
   * and has no other way to learn the outcome. In memory only.
   */
  private readonly unavailableUntil = new Map<string, number>();

  constructor(options: ReferenceCacheServiceOptions) {
    this.repo = options.repo;
    this.ttlMs = options.ttlMs ?? 1000 * 60 * 60; // 1 hour
    this.deadlineMs = options.deadlineMs ?? 250; // 250ms for UI deadline
    this.unavailableTtlMs = options.unavailableTtlMs ?? 30_000;
    this.maxConcurrentReads = Math.max(1, options.maxConcurrentReads ?? 8);
    this.maxQueuedReads = Math.max(0, options.maxQueuedReads ?? 128);
    this.logger = options.logger;
  }

  /** Starts a foreground budget of one UI deadline, to share across a request's gets. */
  startBudget(): ReferenceBudget {
    return { deadlineAt: Date.now() + this.deadlineMs };
  }

  async get(
    ref: string,
    deps: ReferenceResolverDeps,
    budget?: ReferenceBudget
  ): Promise<ResolvedReferenceWithEntity> {
    const reference = parseReference(ref);
    const key = reference.key;

    if (reference.scheme === "mesh" || reference.scheme === "system") {
      // Local reference
      const resolved = resolveReferenceSync(key, deps);
      return { ...resolved, cacheState: "local" };
    }

    let cached: ReturnType<ReferenceCacheRepository["get"]> | undefined;
    try {
      cached = this.repo.get(key);
    } catch {
      cached = null;
    }
    const now = new Date();

    if (cached) {
      const refreshAfter = new Date(cached.refresh_after);
      let entity: ReferenceEntity | undefined;
      let valid = false;
      if (cached.document_version === 1) {
        try {
          const parsed = JSON.parse(cached.entity_json);
          entity = decodeV1Entity(parsed);
          const expectedShape = getResourceShape(reference);
          valid = entity !== undefined && (!expectedShape || entity.type === expectedShape);
        } catch {
          // Ignore parse error, treat as unavailable
        }
      }

      if (valid && entity) {
        const base = resolveReferenceSync(key, deps);
        const title = deriveDisplayTitle(reference, entity) ?? base.title;
        if (now < refreshAfter) {
          // Fresh external hit
          this.logger?.info("reference_cache_hit", {
            state: "fresh",
            scheme: reference.scheme,
            type: getResourceShape(reference),
          });
          return { ...base, title, entity, unavailable: null, cacheState: "fresh" };
        }

        // Stale external hit
        this.logger?.info("reference_cache_hit", {
          state: "stale",
          scheme: reference.scheme,
          type: getResourceShape(reference),
        });
        this.triggerRefresh(key, deps).catch(() => {}); // Fire and forget
        return { ...base, title, entity, unavailable: null, cacheState: "stale" };
      }
    }

    // A read that outlived the deadline and then failed is reported
    // unavailable without asking the provider again, so the retry of the
    // caller told "pending" reaches a terminal state.
    const failedUntil = this.unavailableUntil.get(key);
    if (failedUntil !== undefined) {
      if (now.getTime() < failedUntil) {
        this.logger?.info("reference_cache_unavailable", {
          scheme: reference.scheme,
          type: getResourceShape(reference),
          recent: true,
        });
        const base = resolveReferenceSync(key, deps);
        return { ...base, unavailable: "could not load context", cacheState: "unavailable" };
      }
      this.unavailableUntil.delete(key);
    }

    // Cold miss
    this.logger?.info("reference_cache_miss", {
      scheme: reference.scheme,
      type: getResourceShape(reference),
    });
    const shared = this.sharedProviderRead(key, deps);
    if (!shared) {
      // Every slot and queue place is taken: answer pending without adding
      // provider work. Nothing was read, so nothing is remembered as failed.
      this.logger?.info("reference_cache_saturated", {
        scheme: reference.scheme,
        type: getResourceShape(reference),
      });
      const base = resolveReferenceSync(key, deps);
      return { ...base, unavailable: "loading context", cacheState: "pending" };
    }
    const readPromise = shared.read;
    const waitMs = budget ? Math.max(0, budget.deadlineAt - Date.now()) : this.deadlineMs;
    const deadlinePromise = new Promise<"deadline">((resolve) =>
      setTimeout(() => {
        shared.answeredPending = true;
        resolve("deadline");
      }, waitMs)
    );

    const result = await Promise.race([readPromise, deadlinePromise]);

    if (result === "deadline") {
      // Background the read
      this.logger?.info("reference_cache_deadline", {
        scheme: reference.scheme,
        type: getResourceShape(reference),
      });
      readPromise.catch(() => {});
      const base = resolveReferenceSync(key, deps);
      return { ...base, unavailable: "loading context", cacheState: "pending" };
    }

    if (result) {
      // Success
      this.logger?.info("reference_cache_resolved", {
        scheme: reference.scheme,
        type: result.type,
      });
      const base = resolveReferenceSync(key, deps);
      const title = deriveDisplayTitle(reference, result) ?? base.title;
      return { ...base, title, entity: result, unavailable: null, cacheState: "fresh" };
    }

    // Unavailable result
    this.logger?.info("reference_cache_unavailable", {
      scheme: reference.scheme,
      type: getResourceShape(reference),
    });
    const base = resolveReferenceSync(key, deps);
    return { ...base, unavailable: "could not load context", cacheState: "unavailable" };
  }

  private async triggerRefresh(ref: string, deps: ReferenceResolverDeps): Promise<void> {
    const reference = parseReference(ref);
    const shared = this.sharedProviderRead(ref, deps);
    if (!shared) return; // saturated: a later stale hit refreshes it.
    try {
      const result = await shared.read;
      if (result) {
        this.logger?.info("reference_cache_refresh", {
          scheme: reference.scheme,
          type: result.type,
          outcome: "success",
        });
      } else {
        this.logger?.info("reference_cache_refresh", {
          scheme: reference.scheme,
          outcome: "unavailable",
        });
      }
    } catch (_e) {
      this.logger?.error("reference_cache_refresh", { scheme: reference.scheme, outcome: "error" });
    }
  }

  /**
   * Joins the read already out for `key`, or starts one. Either way its
   * outcome is recorded once: a failure (null or thrown) of a read some get
   * answered "pending" is remembered for `unavailableTtlMs`; a success clears
   * that memory. Null when no read is out for `key` and the provider slots
   * and queue are full.
   */
  private sharedProviderRead(key: string, deps: ReferenceResolverDeps): InFlightRead | null {
    const existing = this.inFlight.get(key);
    if (existing) return existing;
    if (
      this.activeReads >= this.maxConcurrentReads &&
      this.queuedReads.length >= this.maxQueuedReads
    ) {
      return null;
    }
    // The handlers run only after the provider read settles, by which time
    // `shared` exists and any get that gave up on it has marked it.
    const failed = () => {
      if (shared.answeredPending) this.rememberUnavailable(key);
    };
    const shared: InFlightRead = {
      read: this.performProviderRead(key, deps)
        .then(
          (entity) => {
            if (entity) this.unavailableUntil.delete(key);
            else failed();
            return entity;
          },
          (err: unknown) => {
            failed();
            throw err;
          }
        )
        .finally(() => this.inFlight.delete(key)),
      answeredPending: false,
    };
    this.inFlight.set(key, shared);
    return shared;
  }

  private rememberUnavailable(key: string): void {
    const now = Date.now();
    // Bound the memo: refs that failed once and were never asked about again
    // are dropped as soon as they have expired.
    for (const [ref, until] of this.unavailableUntil) {
      if (until <= now) this.unavailableUntil.delete(ref);
    }
    this.unavailableUntil.set(key, now + this.unavailableTtlMs);
  }

  /**
   * Reads through the shared async resolver seam rather than fetching and
   * normalizing providers here, so authorization/error/shape behavior cannot
   * drift between two implementations of the same GitHub/Google Chat reads.
   * This service owns only cache policy: whether to persist, for how long,
   * and how many reads are out at once.
   */
  private async performProviderRead(
    ref: string,
    deps: ReferenceResolverDeps
  ): Promise<ReferenceEntity | null> {
    await this.acquireReadSlot();
    try {
      return await this.readAndStore(ref, deps);
    } finally {
      this.releaseReadSlot();
    }
  }

  /** Takes a provider slot now, or once a running read hands its slot on. */
  private acquireReadSlot(): Promise<void> {
    if (this.activeReads < this.maxConcurrentReads) {
      this.activeReads++;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.queuedReads.push(resolve));
  }

  private releaseReadSlot(): void {
    const next = this.queuedReads.shift();
    if (next) next();
    else this.activeReads--;
  }

  private async readAndStore(
    ref: string,
    deps: ReferenceResolverDeps
  ): Promise<ReferenceEntity | null> {
    const resolved = await resolveReference(ref, deps);
    const entity = resolved.entity ?? null;
    if (!entity) return null;

    const reference = parseReference(ref);
    const now = new Date();
    const refreshAfter = new Date(now.getTime() + this.ttlMs);
    try {
      this.repo.set({
        ref: reference.key,
        document_version: 1,
        entity_json: JSON.stringify(entity),
        fetched_at: now.toISOString(),
        refresh_after: refreshAfter.toISOString(),
      });
    } catch {
      // ignore cache write faults
    }
    return entity;
  }
}

function decodeV1Entity(raw: unknown): ReferenceEntity | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const obj = raw as Record<string, unknown>;

  if (obj.type === "github_issue" || obj.type === "github_pull_request") {
    if (typeof obj.title === "string" && typeof obj.description === "string") {
      return { type: obj.type, title: obj.title, description: obj.description };
    }
  } else if (obj.type === "github_comment") {
    if (typeof obj.body === "string") {
      return { type: obj.type, body: obj.body };
    }
  } else if (obj.type === "github_review") {
    if (typeof obj.body === "string" && typeof obj.state === "string") {
      return { type: obj.type, body: obj.body, state: obj.state };
    }
  } else if (obj.type === "gchat_message") {
    if (typeof obj.contents === "string") {
      return { type: obj.type, contents: obj.contents };
    }
  } else if (obj.type === "gchat_space") {
    if (typeof obj.name === "string") {
      return { type: obj.type, name: obj.name };
    }
  } else if (obj.type === "slack_message") {
    if (typeof obj.contents === "string") return { type: obj.type, contents: obj.contents };
  } else if (obj.type === "slack_channel") {
    if (typeof obj.name === "string") return { type: obj.type, name: obj.name };
  }

  return undefined;
}

function getResourceShape(reference: ReturnType<typeof parseReference>): string | undefined {
  if (reference.scheme === "github") {
    const issue = asGitHubIssue(reference);
    if (issue) {
      return issue.collection === "pulls" ? "github_pull_request" : "github_issue";
    }
    const [, , collection, rawNumber, subCollection, subId] = reference.segments;
    if (
      (collection === "issues" || collection === "pulls") &&
      subCollection &&
      subId &&
      /^[1-9]\d*$/.test(rawNumber ?? "")
    ) {
      if (subCollection === "comments") return "github_comment";
      if (subCollection === "reviews" && collection === "pulls") return "github_review";
    }
  } else if (reference.scheme === "gchat") {
    if (reference.segments.length === 2 && reference.segments[0] === "spaces") {
      return "gchat_space";
    }
    if (reference.segments.length >= 4 && reference.segments[2] === "messages") {
      return "gchat_message";
    }
  } else if (reference.scheme === "slack") {
    if (reference.segments.length === 2 && reference.segments[0] === "channels")
      return "slack_channel";
    if (reference.segments.length === 4 && reference.segments[2] === "messages")
      return "slack_message";
  }
  return undefined;
}
