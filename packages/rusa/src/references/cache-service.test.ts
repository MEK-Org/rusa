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
});
