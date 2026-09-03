import type { ReferenceCacheRepository } from "../db/repositories/reference-cache-repository.js";
import { asGitHubIssue, parseReference } from "./reference.js";
import {
  type ReferenceEntity,
  type ReferenceResolverDeps,
  type ResolvedReferenceWithEntity,
  resolveReference,
  resolveReferenceSync,
} from "./resolve.js";

export interface ReferenceCacheServiceOptions {
  repo: ReferenceCacheRepository;
  ttlMs?: number;
  deadlineMs?: number;
  logger?: {
    info: (event: string, data?: Record<string, unknown>) => void;
    error: (event: string, data?: Record<string, unknown>) => void;
  };
}

export class ReferenceCacheService {
  private readonly repo: ReferenceCacheRepository;
  private readonly ttlMs: number;
  private readonly deadlineMs: number;
  private readonly logger?: ReferenceCacheServiceOptions["logger"];

  constructor(options: ReferenceCacheServiceOptions) {
    this.repo = options.repo;
    this.ttlMs = options.ttlMs ?? 1000 * 60 * 60; // 1 hour
    this.deadlineMs = options.deadlineMs ?? 250; // 250ms for UI deadline
    this.logger = options.logger;
  }

  async get(ref: string, deps: ReferenceResolverDeps): Promise<ResolvedReferenceWithEntity> {
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

      if (valid) {
        const base = resolveReferenceSync(key, deps);
        if (now < refreshAfter) {
          // Fresh external hit
          this.logger?.info("reference_cache_hit", {
            state: "fresh",
            scheme: reference.scheme,
            type: getResourceShape(reference),
          });
          return { ...base, entity, unavailable: null, cacheState: "fresh" };
        }

        // Stale external hit
        this.logger?.info("reference_cache_hit", {
          state: "stale",
          scheme: reference.scheme,
          type: getResourceShape(reference),
        });
        this.triggerRefresh(key, deps).catch(() => {}); // Fire and forget
        return { ...base, entity, unavailable: null, cacheState: "stale" };
      }
    }

    // Cold miss
    this.logger?.info("reference_cache_miss", {
      scheme: reference.scheme,
      type: getResourceShape(reference),
    });
    const readPromise = this.performProviderRead(key, deps);
    const deadlinePromise = new Promise<"deadline">((resolve) =>
      setTimeout(() => resolve("deadline"), this.deadlineMs)
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
      return { ...base, entity: result, unavailable: null, cacheState: "fresh" };
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
    try {
      const result = await this.performProviderRead(ref, deps);
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
   * Reads through the shared async resolver seam rather than fetching and
   * normalizing providers here, so authorization/error/shape behavior cannot
   * drift between two implementations of the same GitHub/Google Chat reads.
   * This service owns only cache policy: whether to persist, and for how long.
   */
  private async performProviderRead(
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
  }
  return undefined;
}
