import { describe, expect, it, vi } from "vitest";
import type {
  ReferenceCacheRepository,
  ReferenceCacheRow,
} from "../db/repositories/reference-cache-repository.js";
import type { IssueDetails } from "../gitops/issue-client.js";
import { ReferenceCacheService } from "./cache-service.js";

/** A production-shaped `IssueDetails`, as `GitHubIssueClient.getIssue` really returns. */
function issueDetails(overrides: Partial<IssueDetails> = {}): IssueDetails {
  return { number: 1, title: "T", body: "D", state: "open", author: "octocat", ...overrides };
}

describe("ReferenceCacheService", () => {
  it("bypasses local reference", async () => {
    const repo = {
      get: vi.fn(),
      set: vi.fn(),
      delete: vi.fn(),
    } as unknown as ReferenceCacheRepository;

    const logger = { info: vi.fn(), error: vi.fn() };
    const svc = new ReferenceCacheService({ repo, logger });
    const deps = {
      meshChat: { getById: vi.fn().mockReturnValue(null) },
    };

    const res = await svc.get("mesh:messages/123", deps);
    expect(res.cacheState).toBe("local");
    expect(repo.get).not.toHaveBeenCalled();
  });

  it("handles fresh external hit", async () => {
    const row: ReferenceCacheRow = {
      ref: "github:a/b/issues/1",
      document_version: 1,
      entity_json: JSON.stringify({ type: "github_issue", title: "T", description: "D" }),
      fetched_at: new Date().toISOString(),
      refresh_after: new Date(Date.now() + 100000).toISOString(),
    };
    const repo = {
      get: vi.fn().mockReturnValue(row),
      set: vi.fn(),
      delete: vi.fn(),
    } as unknown as ReferenceCacheRepository;

    const logger = { info: vi.fn(), error: vi.fn() };
    const svc = new ReferenceCacheService({ repo, logger });
    const res = await svc.get("github:a/b/issues/1", {});

    expect(res.cacheState).toBe("fresh");
    expect(res.entity).toEqual({ type: "github_issue", title: "T", description: "D" });
    expect(logger.info).toHaveBeenCalledWith(
      "reference_cache_hit",
      expect.objectContaining({ type: "github_issue" })
    );
  });

  it("handles stale external hit", async () => {
    const row: ReferenceCacheRow = {
      ref: "github:a/b/issues/1",
      document_version: 1,
      entity_json: JSON.stringify({ type: "github_issue", title: "T", description: "D" }),
      fetched_at: new Date(Date.now() - 200000).toISOString(),
      refresh_after: new Date(Date.now() - 100000).toISOString(), // In the past
    };
    const repo = {
      get: vi.fn().mockReturnValue(row),
      set: vi.fn(),
      delete: vi.fn(),
    } as unknown as ReferenceCacheRepository;

    const deps = {
      issueClient: {
        getIssue: vi.fn().mockResolvedValue(issueDetails({ title: "T2", body: "D2" })),
      },
    };
    const logger = { info: vi.fn(), error: vi.fn() };
    const svc = new ReferenceCacheService({ repo, logger });
    const res = await svc.get("github:a/b/issues/1", deps);

    expect(res.cacheState).toBe("stale");
    expect(res.entity).toEqual({ type: "github_issue", title: "T", description: "D" });

    // allow async refresh to run
    await new Promise((r) => setTimeout(r, 0));
    expect(deps.issueClient.getIssue).toHaveBeenCalled();
    expect(repo.set).toHaveBeenCalled();
  });

  it("handles cold miss with success", async () => {
    const repo = {
      get: vi.fn().mockReturnValue(null),
      set: vi.fn(),
      delete: vi.fn(),
    } as unknown as ReferenceCacheRepository;

    const deps = {
      issueClient: {
        getIssue: vi.fn().mockResolvedValue(issueDetails()),
      },
    };
    const logger = { info: vi.fn(), error: vi.fn() };
    const svc = new ReferenceCacheService({ repo, logger });
    const res = await svc.get("github:a/b/issues/1", deps);

    expect(res.cacheState).toBe("fresh");
    expect(res.entity).toEqual({ type: "github_issue", title: "T", description: "D" });
    expect(repo.set).toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      "reference_cache_miss",
      expect.objectContaining({ type: "github_issue" })
    );
  });

  it("handles cold miss with timeout and resolves background write", async () => {
    const repo = {
      get: vi.fn().mockReturnValue(null),
      set: vi.fn(),
      delete: vi.fn(),
    } as unknown as ReferenceCacheRepository;

    let resolvePromise!: (value: unknown) => void;
    const providerPromise = new Promise((resolve) => {
      resolvePromise = resolve;
    });

    const deps = {
      issueClient: {
        getIssue: vi.fn().mockReturnValue(providerPromise),
      },
    };
    const logger = { info: vi.fn(), error: vi.fn() };
    const svc = new ReferenceCacheService({ repo, deadlineMs: 50, logger });
    const res = await svc.get("github:a/b/issues/1", deps);

    expect(res.cacheState).toBe("pending");
    expect(res.unavailable).toBe("loading context");
    expect(res.entity).toBeUndefined();
    expect(repo.set).not.toHaveBeenCalled();

    // Resolve the background promise
    resolvePromise?.(issueDetails());
    await new Promise((r) => setTimeout(r, 0)); // tick
    await new Promise((r) => setTimeout(r, 0)); // tick

    expect(repo.set).toHaveBeenCalled();
  });

  it("handles unavailable result", async () => {
    const repo = {
      get: vi.fn().mockReturnValue(null),
      set: vi.fn(),
      delete: vi.fn(),
    } as unknown as ReferenceCacheRepository;

    const deps = {
      issueClient: {
        getIssue: vi.fn().mockResolvedValue(null),
      },
    };
    const logger = { info: vi.fn(), error: vi.fn() };
    const svc = new ReferenceCacheService({ repo, logger });
    const res = await svc.get("github:a/b/issues/1", deps);

    expect(res.cacheState).toBe("unavailable");
    expect(res.unavailable).toBe("could not load context");
    expect(repo.set).not.toHaveBeenCalled();
  });

  it("preserves stale entity on failed stale refresh", async () => {
    const row: ReferenceCacheRow = {
      ref: "github:a/b/issues/1",
      document_version: 1,
      entity_json: JSON.stringify({ type: "github_issue", title: "T", description: "D" }),
      fetched_at: new Date(Date.now() - 200000).toISOString(),
      refresh_after: new Date(Date.now() - 100000).toISOString(),
    };
    const repo = {
      get: vi.fn().mockReturnValue(row),
      set: vi.fn(),
      delete: vi.fn(),
    } as unknown as ReferenceCacheRepository;

    const deps = {
      issueClient: {
        getIssue: vi.fn().mockRejectedValue(new Error("failed")),
      },
    };
    const logger = { info: vi.fn(), error: vi.fn() };
    const svc = new ReferenceCacheService({ repo, logger });
    const res = await svc.get("github:a/b/issues/1", deps);

    expect(res.cacheState).toBe("stale");
    expect(res.entity).toEqual({ type: "github_issue", title: "T", description: "D" });

    // allow async refresh to run
    await new Promise((r) => setTimeout(r, 0));
    expect(deps.issueClient.getIssue).toHaveBeenCalled();
    // Repo should NOT have been updated with a successful result
    expect(repo.set).not.toHaveBeenCalled();
  });

  it("normalizes GitHub PR and omits raw provider fields", async () => {
    const repo = {
      get: vi.fn().mockReturnValue(null),
      set: vi.fn(),
      delete: vi.fn(),
    } as unknown as ReferenceCacheRepository;

    const deps = {
      issueClient: {
        getIssue: vi.fn().mockResolvedValue({
          ...issueDetails({ title: "PR Title", body: "PR Body with secrets" }),
          secret_field: "SHOULD_NOT_BE_SAVED",
          html_url: "https://example.com",
        }),
      },
    };
    const logger = { info: vi.fn(), error: vi.fn() };
    const svc = new ReferenceCacheService({ repo, logger });
    const res = await svc.get("github:a/b/pulls/2", deps);

    expect(res.cacheState).toBe("fresh");
    expect(res.entity).toEqual({
      type: "github_pull_request",
      title: "PR Title",
      description: "PR Body with secrets",
    });

    // Check what was saved to the repo
    const saved = (repo.set as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(saved.ref).toBe("github:a/b/pulls/2");
    expect(saved.entity_json).not.toContain("SHOULD_NOT_BE_SAVED");
    expect(saved.entity_json).toContain("github_pull_request");
  });

  it("normalizes a GitHub issue comment and omits raw provider fields", async () => {
    const repo = {
      get: vi.fn().mockReturnValue(null),
      set: vi.fn(),
      delete: vi.fn(),
    } as unknown as ReferenceCacheRepository;

    const deps = {
      issueClient: {
        listIssueComments: vi.fn().mockResolvedValue([
          {
            id: 12345,
            author: "octocat",
            body: "The actual comment",
            createdAt: "2026-09-01T10:00:00Z",
            node_id: "SHOULD_NOT_BE_SAVED",
          },
        ]),
      },
    };
    const logger = { info: vi.fn(), error: vi.fn() };
    const svc = new ReferenceCacheService({ repo, logger });
    const res = await svc.get("github:a/b/issues/1/comments/12345", deps);

    expect(res.cacheState).toBe("fresh");
    expect(res.entity).toEqual({ type: "github_comment", body: "The actual comment" });
    // The title is a safe, resolved label derived from the reference's own
    // path — never the raw canonical ref (see the cache-boundary title test
    // below for the case that would otherwise leak it).
    expect(res.title).toBe("a/b issues/1 — comment");
    expect(res.title).not.toBe("github:a/b/issues/1/comments/12345");

    const saved = (repo.set as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(saved.entity_json).not.toContain("SHOULD_NOT_BE_SAVED");
    expect(saved.entity_json).toContain("github_comment");
  });

  it("reconstructs a safe title for a comment served from a stored cache hit, not the canonical ref", async () => {
    const row: ReferenceCacheRow = {
      ref: "github:a/b/issues/1/comments/12345",
      document_version: 1,
      entity_json: JSON.stringify({ type: "github_comment", body: "The actual comment" }),
      fetched_at: new Date().toISOString(),
      refresh_after: new Date(Date.now() + 100000).toISOString(),
    };
    const repo = {
      get: vi.fn().mockReturnValue(row),
      set: vi.fn(),
      delete: vi.fn(),
    } as unknown as ReferenceCacheRepository;

    const logger = { info: vi.fn(), error: vi.fn() };
    const svc = new ReferenceCacheService({ repo, logger });
    const res = await svc.get("github:a/b/issues/1/comments/12345", {});

    expect(res.cacheState).toBe("fresh");
    expect(res.title).toBe("a/b issues/1 — comment");
    expect(res.title).not.toBe("github:a/b/issues/1/comments/12345");
  });

  it("normalizes a GitHub PR review and omits raw provider fields", async () => {
    const repo = {
      get: vi.fn().mockReturnValue(null),
      set: vi.fn(),
      delete: vi.fn(),
    } as unknown as ReferenceCacheRepository;

    const deps = {
      issueClient: {
        getPullRequestReview: vi.fn().mockResolvedValue({
          id: 9001,
          state: "APPROVED",
          body: "Ship it.",
          author: "octocat",
          node_id: "SHOULD_NOT_BE_SAVED",
        }),
      },
    };
    const logger = { info: vi.fn(), error: vi.fn() };
    const svc = new ReferenceCacheService({ repo, logger });
    const res = await svc.get("github:a/b/pulls/76/reviews/9001", deps);

    expect(res.cacheState).toBe("fresh");
    expect(res.entity).toEqual({ type: "github_review", body: "Ship it.", state: "APPROVED" });
    expect(res.title).toBe("a/b pulls/76 — review");
    expect(res.title).not.toBe("github:a/b/pulls/76/reviews/9001");

    const saved = (repo.set as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(saved.entity_json).not.toContain("SHOULD_NOT_BE_SAVED");
    expect(saved.entity_json).toContain("github_review");
  });

  it("reconstructs a safe title for a review served from a stored cache hit, not the canonical ref", async () => {
    const row: ReferenceCacheRow = {
      ref: "github:a/b/pulls/76/reviews/9001",
      document_version: 1,
      entity_json: JSON.stringify({ type: "github_review", body: "Ship it.", state: "APPROVED" }),
      fetched_at: new Date().toISOString(),
      refresh_after: new Date(Date.now() + 100000).toISOString(),
    };
    const repo = {
      get: vi.fn().mockReturnValue(row),
      set: vi.fn(),
      delete: vi.fn(),
    } as unknown as ReferenceCacheRepository;

    const logger = { info: vi.fn(), error: vi.fn() };
    const svc = new ReferenceCacheService({ repo, logger });
    const res = await svc.get("github:a/b/pulls/76/reviews/9001", {});

    expect(res.cacheState).toBe("fresh");
    expect(res.title).toBe("a/b pulls/76 — review");
    expect(res.title).not.toBe("github:a/b/pulls/76/reviews/9001");
  });

  it("normalizes Chat space", async () => {
    const repo = {
      get: vi.fn().mockReturnValue(null),
      set: vi.fn(),
      delete: vi.fn(),
    } as unknown as ReferenceCacheRepository;

    const deps = {
      chatClient: {
        getSpace: vi.fn().mockResolvedValue({
          name: "spaces/abc",
          displayName: "My Space Name",
          raw_internal_id: "secret_123",
        }),
        getMessage: vi.fn(),
      },
    };
    const logger = { info: vi.fn(), error: vi.fn() };
    const svc = new ReferenceCacheService({ repo, logger });
    const res = await svc.get("gchat:spaces/abc", deps);

    expect(res.cacheState).toBe("fresh");
    expect(res.entity).toEqual({ type: "gchat_space", name: "My Space Name" });
    expect(res.title).toBe("My Space Name");

    const saved = (repo.set as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(saved.entity_json).not.toContain("secret_123");
  });

  it("normalizes Chat space without displayName using name", async () => {
    const repo = {
      get: vi.fn().mockReturnValue(null),
      set: vi.fn(),
      delete: vi.fn(),
    } as unknown as ReferenceCacheRepository;

    const deps = {
      chatClient: {
        getSpace: vi.fn().mockResolvedValue({
          name: "spaces/def",
        }),
        getMessage: vi.fn(),
      },
    };
    const logger = { info: vi.fn(), error: vi.fn() };
    const svc = new ReferenceCacheService({ repo, logger });
    const res = await svc.get("gchat:spaces/def", deps);

    expect(res.cacheState).toBe("fresh");
    expect(res.entity).toEqual({ type: "gchat_space", name: "spaces/def" });
  });

  it("normalizes Chat message", async () => {
    const repo = {
      get: vi.fn().mockReturnValue(null),
      set: vi.fn(),
      delete: vi.fn(),
    } as unknown as ReferenceCacheRepository;

    const deps = {
      chatClient: {
        getMessage: vi.fn().mockResolvedValue({
          name: "spaces/abc/messages/123",
          text: "Full text content",
          internal_auth_token: "secret",
        }),
        getSpace: vi.fn(),
      },
    };
    const logger = { info: vi.fn(), error: vi.fn() };
    const svc = new ReferenceCacheService({ repo, logger });
    const res = await svc.get("gchat:spaces/abc/messages/123", deps);

    expect(res.cacheState).toBe("fresh");
    expect(res.entity).toEqual({ type: "gchat_message", contents: "Full text content" });
    expect(res.title).not.toBe("gchat:spaces/abc/messages/123");

    const saved = (repo.set as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(saved.entity_json).not.toContain("secret");
  });

  it("exposes only generic unavailable state for inaccessible resource", async () => {
    const repo = {
      get: vi.fn().mockReturnValue(null),
      set: vi.fn(),
      delete: vi.fn(),
    } as unknown as ReferenceCacheRepository;

    const deps = {
      chatClient: {
        getMessage: vi
          .fn()
          .mockRejectedValue(new Error("Permission denied: user does not have access")),
        getSpace: vi.fn(),
      },
    };
    const logger = { info: vi.fn(), error: vi.fn() };
    const svc = new ReferenceCacheService({ repo, logger });
    const res = await svc.get("gchat:spaces/abc/messages/403", deps);

    expect(res.cacheState).toBe("unavailable");
    expect(res.unavailable).toBe("could not load context");
    expect(res.unavailable).not.toContain("Permission denied");
    expect(repo.set).not.toHaveBeenCalled();
  });

  it("treats invalid cached entity as cold miss/unavailable", async () => {
    const row: ReferenceCacheRow = {
      ref: "github:a/b/issues/1",
      document_version: 1,
      entity_json: JSON.stringify({ type: "gchat_message", contents: 1 }), // contents should be string
      fetched_at: new Date().toISOString(),
      refresh_after: new Date(Date.now() + 100000).toISOString(),
    };
    const repo = {
      get: vi.fn().mockReturnValue(row),
      set: vi.fn(),
      delete: vi.fn(),
    } as unknown as ReferenceCacheRepository;

    const deps = {
      issueClient: {
        getIssue: vi.fn().mockResolvedValue(null), // cold miss will fail
      },
    };
    const logger = { info: vi.fn(), error: vi.fn() };
    const svc = new ReferenceCacheService({ repo, logger });
    const res = await svc.get("github:a/b/issues/1", deps);

    expect(res.cacheState).toBe("unavailable");
    expect(res.unavailable).toBe("could not load context");
    expect(res.entity).toBeUndefined();
  });

  it("treats unknown document version as cold miss/unavailable", async () => {
    const row: ReferenceCacheRow = {
      ref: "github:a/b/issues/1",
      document_version: 99, // unknown
      entity_json: JSON.stringify({ type: "github_issue", title: "T", description: "D" }),
      fetched_at: new Date().toISOString(),
      refresh_after: new Date(Date.now() + 100000).toISOString(),
    };
    const repo = {
      get: vi.fn().mockReturnValue(row),
      set: vi.fn(),
      delete: vi.fn(),
    } as unknown as ReferenceCacheRepository;

    const deps = {
      issueClient: {
        getIssue: vi.fn().mockResolvedValue(null), // cold miss will fail
      },
    };
    const logger = { info: vi.fn(), error: vi.fn() };
    const svc = new ReferenceCacheService({ repo, logger });
    const res = await svc.get("github:a/b/issues/1", deps);

    expect(res.cacheState).toBe("unavailable");
    expect(res.unavailable).toBe("could not load context");
    expect(res.entity).toBeUndefined();
  });

  it("isolates repository read faults", async () => {
    const repo = {
      get: vi.fn().mockImplementation(() => {
        throw new Error("db fault");
      }),
      set: vi.fn(),
      delete: vi.fn(),
    } as unknown as ReferenceCacheRepository;

    const deps = {
      issueClient: {
        getIssue: vi.fn().mockResolvedValue(issueDetails()),
      },
    };
    const logger = { info: vi.fn(), error: vi.fn() };
    const svc = new ReferenceCacheService({ repo, logger });
    const res = await svc.get("github:a/b/issues/1", deps);

    expect(res.cacheState).toBe("fresh"); // Because it misses cache, does a provider read, and succeeds
    expect(res.entity).toEqual({ type: "github_issue", title: "T", description: "D" });
  });

  it("rejects a cached comment row served for a review reference", async () => {
    const row: ReferenceCacheRow = {
      ref: "github:a/b/pulls/76/reviews/9001",
      document_version: 1,
      entity_json: JSON.stringify({ type: "github_comment", body: "wrong shape" }),
      fetched_at: new Date().toISOString(),
      refresh_after: new Date(Date.now() + 100000).toISOString(),
    };
    const repo = {
      get: vi.fn().mockReturnValue(row),
      set: vi.fn(),
      delete: vi.fn(),
    } as unknown as ReferenceCacheRepository;

    const deps = {
      issueClient: {
        getPullRequestReview: vi.fn().mockResolvedValue(null),
      },
    };
    const logger = { info: vi.fn(), error: vi.fn() };
    const svc = new ReferenceCacheService({ repo, logger });
    const res = await svc.get("github:a/b/pulls/76/reviews/9001", deps);

    // It should ignore the mismatched cache row, miss the provider (mocked to null), and return unavailable
    expect(res.cacheState).toBe("unavailable");
  });

  it("rejects cached row with incorrect discriminator", async () => {
    const row: ReferenceCacheRow = {
      ref: "github:a/b/issues/1",
      document_version: 1,
      entity_json: JSON.stringify({ type: "gchat_message", contents: "wrong shape" }),
      fetched_at: new Date().toISOString(),
      refresh_after: new Date(Date.now() + 100000).toISOString(),
    };
    const repo = {
      get: vi.fn().mockReturnValue(row),
      set: vi.fn(),
      delete: vi.fn(),
    } as unknown as ReferenceCacheRepository;

    const deps = {
      issueClient: {
        getIssue: vi.fn().mockResolvedValue(null),
      },
    };
    const logger = { info: vi.fn(), error: vi.fn() };
    const svc = new ReferenceCacheService({ repo, logger });
    const res = await svc.get("github:a/b/issues/1", deps);

    // It should ignore the bad cache row, miss the provider (mocked to null), and return unavailable
    expect(res.cacheState).toBe("unavailable");
  });
});
