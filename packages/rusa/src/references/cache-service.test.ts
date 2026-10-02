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

  describe("pending convergence (#595)", () => {
    /** A repository that really stores, so a later get can observe the background write. */
    function memoryRepo() {
      const rows = new Map<string, ReferenceCacheRow>();
      return {
        rows,
        repo: {
          get: vi.fn((ref: string) => rows.get(ref) ?? null),
          set: vi.fn((row: ReferenceCacheRow) => {
            rows.set(row.ref, row);
          }),
          delete: vi.fn(),
        } as unknown as ReferenceCacheRepository,
      };
    }

    function deferred<T>() {
      let resolve!: (value: T) => void;
      let reject!: (err: unknown) => void;
      const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      return { promise, resolve, reject };
    }

    const flush = async () => {
      for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 0));
    };

    const ref = "gchat:spaces/AAAA/messages/abc.def";

    it("shares one provider read across overlapping gets of the same canonical ref", async () => {
      const { repo } = memoryRepo();
      const read = deferred<{ name: string; text: string }>();
      const getMessage = vi.fn().mockReturnValue(read.promise);
      const deps = { chatClient: { getMessage, getSpace: vi.fn() } };
      const svc = new ReferenceCacheService({ repo, deadlineMs: 20 });

      // An API render and two UI retries landing while the first read is out.
      const overlapping = await Promise.all([svc.get(ref, deps), svc.get(ref, deps)]);
      const retry = await svc.get(ref, deps);
      expect([...overlapping, retry].map((r) => r.cacheState)).toEqual([
        "pending",
        "pending",
        "pending",
      ]);
      expect(getMessage).toHaveBeenCalledTimes(1);

      read.resolve({ name: "spaces/AAAA/messages/abc.def", text: "Once" });
      await flush();
      const after = await svc.get(ref, deps);
      expect(after.cacheState).toBe("fresh");
      expect(after.entity).toEqual({ type: "gchat_message", contents: "Once" });
      expect(getMessage).toHaveBeenCalledTimes(1);
      expect(repo.set).toHaveBeenCalledTimes(1);
    });

    it("joins a cold get to the read a stale refresh already started", async () => {
      const { repo, rows } = memoryRepo();
      rows.set("github:a/b/issues/1", {
        ref: "github:a/b/issues/1",
        document_version: 1,
        entity_json: JSON.stringify({ type: "github_issue", title: "T", description: "D" }),
        fetched_at: new Date(Date.now() - 200000).toISOString(),
        refresh_after: new Date(Date.now() - 100000).toISOString(),
      });
      const read = deferred<IssueDetails>();
      const getIssue = vi.fn().mockReturnValue(read.promise);
      const svc = new ReferenceCacheService({ repo, deadlineMs: 20 });

      expect((await svc.get("github:a/b/issues/1", { issueClient: { getIssue } })).cacheState).toBe(
        "stale"
      );
      // The row goes away while the refresh is out, so the next get is cold.
      rows.delete("github:a/b/issues/1");
      expect((await svc.get("github:a/b/issues/1", { issueClient: { getIssue } })).cacheState).toBe(
        "pending"
      );
      expect(getIssue).toHaveBeenCalledTimes(1);

      read.resolve(issueDetails({ title: "T2", body: "D2" }));
      await flush();
      const after = await svc.get("github:a/b/issues/1", { issueClient: { getIssue } });
      expect(after.cacheState).toBe("fresh");
      expect(after.entity).toEqual({ type: "github_issue", title: "T2", description: "D2" });
    });

    it("turns an inaccessible message that fails after the deadline terminally unavailable", async () => {
      const { repo } = memoryRepo();
      const read = deferred<never>();
      const getMessage = vi.fn().mockReturnValue(read.promise);
      const deps = { chatClient: { getMessage, getSpace: vi.fn() } };
      const svc = new ReferenceCacheService({ repo, deadlineMs: 20 });

      expect((await svc.get(ref, deps)).cacheState).toBe("pending");
      read.reject(new Error("PERMISSION_DENIED: caller lacks access to spaces/AAAA"));
      await flush();

      // The UI's retries now settle on the generic terminal state without
      // re-reading the provider, so they can stop rather than spin to their ceiling.
      for (let i = 0; i < 3; i += 1) {
        const res = await svc.get(ref, deps);
        expect(res.cacheState).toBe("unavailable");
        expect(res.unavailable).toBe("could not load context");
        expect(JSON.stringify(res)).not.toContain("PERMISSION_DENIED");
      }
      expect(getMessage).toHaveBeenCalledTimes(1);
      expect(repo.set).not.toHaveBeenCalled();
    });

    it("reads the provider again once a failed read's memo expires", async () => {
      const { repo } = memoryRepo();
      const read = deferred<never>();
      const getMessage = vi
        .fn()
        .mockReturnValueOnce(read.promise)
        .mockResolvedValueOnce({ name: "spaces/AAAA/messages/abc.def", text: "Back" });
      const deps = { chatClient: { getMessage, getSpace: vi.fn() } };
      const svc = new ReferenceCacheService({ repo, deadlineMs: 20, unavailableTtlMs: 1000 });

      expect((await svc.get(ref, deps)).cacheState).toBe("pending");
      read.reject(new Error("transient"));
      await flush();
      expect((await svc.get(ref, deps)).cacheState).toBe("unavailable");
      expect(getMessage).toHaveBeenCalledTimes(1);

      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        vi.setSystemTime(Date.now() + 1001);
        const res = await svc.get(ref, deps);
        expect(res.cacheState).toBe("fresh");
        expect(getMessage).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it("remembers no failure that was answered inside the deadline", async () => {
      const { repo } = memoryRepo();
      const getMessage = vi
        .fn()
        .mockRejectedValueOnce(new Error("transient"))
        .mockResolvedValueOnce({ name: "spaces/AAAA/messages/abc.def", text: "Back" });
      const deps = { chatClient: { getMessage, getSpace: vi.fn() } };
      const svc = new ReferenceCacheService({ repo });

      // The caller already holds a terminal answer, so nothing retries it;
      // the next view asks the provider again, as before #595.
      expect((await svc.get(ref, deps)).cacheState).toBe("unavailable");
      const res = await svc.get(ref, deps);
      expect(res.cacheState).toBe("fresh");
      expect(getMessage).toHaveBeenCalledTimes(2);
    });
  });
});
