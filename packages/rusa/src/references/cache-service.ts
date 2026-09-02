import type { ReferenceCacheRepository } from "../db/repositories/reference-cache-repository.js";
import { asGitHubIssue, parseReference } from "./reference.js";
import {
  type ReferenceEntity,
  type ReferenceResolverDeps,
  type ResolvedReferenceWithEntity,
  resolveReferenceSync,
} from "./resolve.js";

const DEFAULT_TTL_MS = 1000 * 60 * 60; // 1 hour
const DEADLINE_MS = 250; // 250ms for UI deadline

export class ReferenceCacheService {
  constructor(private readonly repo: ReferenceCacheRepository) {}

  async get(ref: string, deps: ReferenceResolverDeps): Promise<ResolvedReferenceWithEntity> {
    const reference = parseReference(ref);
    if (reference.scheme === "mesh" || reference.scheme === "system") {
      // Local reference
      const resolved = resolveReferenceSync(ref, deps);
      return { ...resolved, cacheState: "local" };
    }

    const cached = this.repo.get(ref);
    const now = new Date();

    if (cached) {
      const refreshAfter = new Date(cached.refresh_after);
      let entity: ReferenceEntity | undefined;
      try {
        entity = JSON.parse(cached.entity_json) as ReferenceEntity;
      } catch {
        // Ignore parse error, treat as unavailable
      }

      const base = resolveReferenceSync(ref, deps);
      if (now < refreshAfter) {
        // Fresh external hit
        return { ...base, entity, unavailable: null, cacheState: "fresh" };
      }

      // Stale external hit
      this.triggerRefresh(ref, deps).catch(() => {}); // Fire and forget
      return { ...base, entity, unavailable: null, cacheState: "stale" };
    }

    // Cold miss
    const readPromise = this.performProviderRead(ref, deps);
    const deadlinePromise = new Promise<"deadline">((resolve) =>
      setTimeout(() => resolve("deadline"), DEADLINE_MS)
    );

    const result = await Promise.race([readPromise, deadlinePromise]);

    if (result === "deadline") {
      // Background the read
      readPromise.catch(() => {});
      const base = resolveReferenceSync(ref, deps);
      return { ...base, cacheState: "pending" };
    }

    if (result) {
      // Success
      const base = resolveReferenceSync(ref, deps);
      return { ...base, entity: result, unavailable: null, cacheState: "fresh" };
    }

    // Unavailable result
    const base = resolveReferenceSync(ref, deps);
    return { ...base, cacheState: "unavailable" };
  }

  private async triggerRefresh(ref: string, deps: ReferenceResolverDeps): Promise<void> {
    await this.performProviderRead(ref, deps);
  }

  private async performProviderRead(
    ref: string,
    deps: ReferenceResolverDeps
  ): Promise<ReferenceEntity | null> {
    const reference = parseReference(ref);
    let entity: ReferenceEntity | null = null;

    if (reference.scheme === "github" && deps.issueClient?.getIssue) {
      const issue = asGitHubIssue(reference);
      if (issue) {
        try {
          const found = (await deps.issueClient.getIssue(
            `${issue.owner}/${issue.repo}`,
            issue.number
          )) as unknown as Record<string, unknown>;
          if (found) {
            if (issue.collection === "pulls") {
              entity = {
                type: "github_pull_request",
                title: (found.title as string | undefined) ?? "",
                description: (found.body as string | undefined) ?? "",
              };
            } else {
              entity = {
                type: "github_issue",
                title: (found.title as string | undefined) ?? "",
                description: (found.body as string | undefined) ?? "",
              };
            }
          }
        } catch {
          // ignore
        }
      }
    } else if (reference.scheme === "gchat" && deps.chatClient) {
      const segments = reference.segments;
      const resourceName = segments.join("/");
      try {
        if (segments.length === 2 && segments[0] === "spaces") {
          const found = await deps.chatClient.getSpace(resourceName);
          if (found?.displayName) {
            entity = { type: "gchat_space", name: found.displayName };
          }
        } else if (segments.length >= 4 && segments[2] === "messages") {
          const found = await deps.chatClient.getMessage(resourceName);
          const text = found.text ?? found.formattedText ?? null;
          if (text) {
            entity = { type: "gchat_message", contents: text };
          }
        }
      } catch {
        // ignore
      }
    }

    if (entity) {
      const now = new Date();
      const refreshAfter = new Date(now.getTime() + DEFAULT_TTL_MS);
      this.repo.set({
        ref,
        document_version: 1,
        entity_json: JSON.stringify(entity),
        fetched_at: now.toISOString(),
        refresh_after: refreshAfter.toISOString(),
      });
      return entity;
    }

    return null;
  }
}
