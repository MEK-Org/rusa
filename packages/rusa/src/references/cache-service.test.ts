import { describe, expect, it, vi } from "vitest";
import type {
  ReferenceCacheRepository,
  ReferenceCacheRow,
} from "../db/repositories/reference-cache-repository.js";
import { ReferenceCacheService } from "./cache-service.js";

describe("ReferenceCacheService", () => {
  it("bypasses local reference", async () => {
    const repo = {
      get: vi.fn(),
      set: vi.fn(),
      delete: vi.fn(),
    } as unknown as ReferenceCacheRepository;

    const svc = new ReferenceCacheService({ repo });
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

    const svc = new ReferenceCacheService({ repo });
    const res = await svc.get("github:a/b/issues/1", {});

    expect(res.cacheState).toBe("fresh");
    expect(res.entity).toEqual({ type: "github_issue", title: "T", description: "D" });
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
        getIssue: vi.fn().mockResolvedValue({ title: "T2", body: "D2" }),
      },
    };
    const svc = new ReferenceCacheService({ repo });
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
        getIssue: vi.fn().mockResolvedValue({ title: "T", body: "D" }),
      },
    };
    const svc = new ReferenceCacheService({ repo });
    const res = await svc.get("github:a/b/issues/1", deps);

    expect(res.cacheState).toBe("fresh");
    expect(res.entity).toEqual({ type: "github_issue", title: "T", description: "D" });
    expect(repo.set).toHaveBeenCalled();
  });

  it("handles cold miss with timeout", async () => {
    const repo = {
      get: vi.fn().mockReturnValue(null),
      set: vi.fn(),
      delete: vi.fn(),
    } as unknown as ReferenceCacheRepository;

    const deps = {
      issueClient: {
        getIssue: vi.fn().mockImplementation(() => new Promise((r) => setTimeout(r, 500))),
      },
    };
    const svc = new ReferenceCacheService({ repo, deadlineMs: 50 });
    const res = await svc.get("github:a/b/issues/1", deps);

    expect(res.cacheState).toBe("pending");
    expect(res.unavailable).toBe("loading context");
    expect(res.entity).toBeUndefined();
    expect(repo.set).not.toHaveBeenCalled();
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
    const svc = new ReferenceCacheService({ repo });
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
    const svc = new ReferenceCacheService({ repo });
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
          title: "PR Title",
          body: "PR Body with secrets",
          secret_field: "SHOULD_NOT_BE_SAVED",
          html_url: "https://example.com",
        }),
      },
    };
    const svc = new ReferenceCacheService({ repo });
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
      },
    };
    const svc = new ReferenceCacheService({ repo });
    const res = await svc.get("gchat:spaces/abc", deps);

    expect(res.cacheState).toBe("fresh");
    expect(res.entity).toEqual({ type: "gchat_space", name: "My Space Name" });

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
      },
    };
    const svc = new ReferenceCacheService({ repo });
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
      },
    };
    const svc = new ReferenceCacheService({ repo });
    const res = await svc.get("gchat:spaces/abc/messages/123", deps);

    expect(res.cacheState).toBe("fresh");
    expect(res.entity).toEqual({ type: "gchat_message", contents: "Full text content" });

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
      },
    };
    const svc = new ReferenceCacheService({ repo });
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
    const svc = new ReferenceCacheService({ repo });
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
    const svc = new ReferenceCacheService({ repo });
    const res = await svc.get("github:a/b/issues/1", deps);

    expect(res.cacheState).toBe("unavailable");
    expect(res.unavailable).toBe("could not load context");
    expect(res.entity).toBeUndefined();
  });
});
