import { beforeEach, describe, expect, it, vi } from "vitest";

const execFileSyncMock = vi.fn();
const execSyncMock = vi.fn();
const existsSyncMock = vi.fn();
const mkdirSyncMock = vi.fn();
const rmSyncMock = vi.fn();
const copyFileSyncMock = vi.fn();
const chmodSyncMock = vi.fn();
const writeFileSyncMock = vi.fn();
const readdirSyncMock = vi.fn();
const statSyncMock = vi.fn();

// Mock node:child_process
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFileSync: (...args: unknown[]) => execFileSyncMock(...args),
    execSync: (...args: unknown[]) => execSyncMock(...args),
    default: {
      /* @ts-expect-error: I don't really know what's going on here but this is a test so w/e.  */
      ...actual.default,
      execFileSync: (...args: unknown[]) => execFileSyncMock(...args),
      execSync: (...args: unknown[]) => execSyncMock(...args),
    },
  };
});

// Mock node:fs - need to match the import style used in worktree.ts
vi.mock("node:fs", async () => {
  return {
    existsSync: (...args: unknown[]) => existsSyncMock(...args),
    mkdirSync: (...args: unknown[]) => mkdirSyncMock(...args),
    rmSync: (...args: unknown[]) => rmSyncMock(...args),
    copyFileSync: (...args: unknown[]) => copyFileSyncMock(...args),
    chmodSync: (...args: unknown[]) => chmodSyncMock(...args),
    writeFileSync: (...args: unknown[]) => writeFileSyncMock(...args),
    readdirSync: (...args: unknown[]) => readdirSyncMock(...args),
    statSync: (...args: unknown[]) => statSyncMock(...args),
    default: {
      existsSync: (...args: unknown[]) => existsSyncMock(...args),
      mkdirSync: (...args: unknown[]) => mkdirSyncMock(...args),
      rmSync: (...args: unknown[]) => rmSyncMock(...args),
      copyFileSync: (...args: unknown[]) => copyFileSyncMock(...args),
      chmodSync: (...args: unknown[]) => chmodSyncMock(...args),
      writeFileSync: (...args: unknown[]) => writeFileSyncMock(...args),
      readdirSync: (...args: unknown[]) => readdirSyncMock(...args),
      statSync: (...args: unknown[]) => statSyncMock(...args),
    },
  };
});

import {
  addWorktree,
  generateRepoKey,
  getBareClonePath,
  getWorkspaceRoot,
  getWorktreesDir,
  listWorktrees,
} from "./worktree.js";

function makeGitError(message: string): Error {
  const err = new Error(message);
  return err;
}

function setGitResponses(responses: Record<string, string | Error>): void {
  execFileSyncMock.mockReset();
  execSyncMock.mockReset();

  execFileSyncMock.mockImplementation(
    (
      _cmd: string,
      args: string[],
      _opts: {
        cwd: string;
        encoding: string;
        stdio: [string, string, string];
      }
    ) => {
      const key = args.join(" ");
      const response = responses[key];
      if (response === undefined) {
        throw new Error(`Unexpected git command: ${key}`);
      }
      if (response instanceof Error) {
        throw response;
      }
      return response;
    }
  );

  execSyncMock.mockImplementation((command: string, _opts: unknown) => {
    // For execSync, the command itself is the key
    const response = responses[command];
    if (response === undefined) {
      // Return empty string by default for commands not explicitly mocked in responses
      return "";
    }
    if (response instanceof Error) {
      throw response;
    }
    return response as string;
  });
}

beforeEach(() => {
  execFileSyncMock.mockReset();
  execSyncMock.mockReset();
  existsSyncMock.mockReset();
  mkdirSyncMock.mockReset();
  rmSyncMock.mockReset();
  copyFileSyncMock.mockReset();
  chmodSyncMock.mockReset();
  writeFileSyncMock.mockReset();
  readdirSyncMock.mockReset();
  statSyncMock.mockReset();
  existsSyncMock.mockReturnValue(false);
  readdirSyncMock.mockReturnValue([]);
});

describe("generateRepoKey", () => {
  it("should generate consistent keys for the same repo", () => {
    const key1 = generateRepoKey("github.com/myorg/myrepo");
    const key2 = generateRepoKey("github.com/myorg/myrepo");
    expect(key1).toBe(key2);
    expect(key1).toHaveLength(16);
  });

  it("should normalize case", () => {
    const key1 = generateRepoKey("GitHub.com/MyOrg/MyRepo");
    const key2 = generateRepoKey("github.com/myorg/myrepo");
    expect(key1).toBe(key2);
  });
});

describe("path helpers", () => {
  const mcHome = "/tmp/mc";
  const repoKey = "abc123";

  it("getWorkspaceRoot returns correct path", () => {
    expect(getWorkspaceRoot(mcHome, repoKey)).toBe("/tmp/mc/workspaces/abc123");
  });

  it("getBareClonePath returns correct path", () => {
    expect(getBareClonePath(mcHome, repoKey)).toBe("/tmp/mc/workspaces/abc123/repo.git");
  });

  it("getWorktreesDir returns correct path", () => {
    expect(getWorktreesDir(mcHome, repoKey)).toBe("/tmp/mc/workspaces/abc123/worktrees");
  });
});

describe("addWorktree", () => {
  const mcHome = "/tmp/mc";
  const repoKey = "abc123";
  const key = "wt-001";
  const branchName = "mc/issue-123";
  const baseBranch = "main";

  beforeEach(() => {
    existsSyncMock.mockReturnValue(false);
  });

  it("should create new worktree for non-existing branch", () => {
    setGitResponses({
      "worktree prune": "",
      "fetch origin main:main": "",
      "rev-parse --verify refs/heads/mc/issue-123": makeGitError("not found"),
      "rev-parse --verify refs/remotes/origin/mc/issue-123": makeGitError("not found"),
      "worktree list --porcelain": "worktree /tmp/mc/workspaces/abc123/repo.git\nbare\n\n",
      "worktree add -b mc/issue-123 /tmp/mc/workspaces/abc123/worktrees/wt-001 main": "",
      "config user.email rusa@localhost": "",
      "config user.name Meta Coder": "",
      "config --local safe.directory *": "",
    });

    const result = addWorktree({
      mcHome,
      repoKey,
      key,
      branchName,
      baseBranch,
    });

    expect(result.success).toBe(true);
    expect(result.path).toBe("/tmp/mc/workspaces/abc123/worktrees/wt-001");
    expect(result.isExisting).toBeUndefined();
  });

  it("should checkout existing branch", () => {
    setGitResponses({
      "worktree prune": "",
      "fetch origin main:main": "",
      "rev-parse --verify refs/heads/mc/issue-123": "def456",
      "worktree list --porcelain": "worktree /tmp/mc/workspaces/abc123/repo.git\nbare\n\n",
      "worktree add --checkout /tmp/mc/workspaces/abc123/worktrees/wt-001 mc/issue-123": "",
      "config user.email rusa@localhost": "",
      "config user.name Meta Coder": "",
      "config --local safe.directory *": "",
    });

    const result = addWorktree({
      mcHome,
      repoKey,
      key,
      branchName,
      baseBranch,
    });

    expect(result.success).toBe(true);
    expect(result.path).toBe("/tmp/mc/workspaces/abc123/worktrees/wt-001");
  });

  it("should return existing worktree when branch already checked out (an issue)", () => {
    const existingPath = "/tmp/mc/workspaces/abc123/worktrees/wt-002";

    // Simulate the scenario where:
    // 1. listWorktrees doesn't show the branch (race condition or stale state)
    // 2. git worktree add fails with "already checked out" error
    setGitResponses({
      "worktree prune": "",
      "fetch origin main:main": "",
      "rev-parse --verify refs/heads/mc/issue-123": "def456",
      // listWorktrees returns empty (simulating stale state)
      "worktree list --porcelain": "worktree /tmp/mc/workspaces/abc123/repo.git\nbare\n\n",
      // git worktree add fails because branch is already checked out elsewhere
      [`worktree add --checkout /tmp/mc/workspaces/abc123/worktrees/wt-001 ${branchName}`]:
        makeGitError(`fatal: '${branchName}' is already checked out at '${existingPath}'`),
    });

    const result = addWorktree({
      mcHome,
      repoKey,
      key,
      branchName,
      baseBranch,
    });

    // Should return success with the existing worktree path
    expect(result.success).toBe(true);
    expect(result.path).toBe(existingPath);
    expect(result.isExisting).toBe(true);
  });

  it("should handle error with branch name containing refs/heads/", () => {
    const existingPath = "/tmp/mc/workspaces/abc123/worktrees/wt-002";
    const fullBranchName = "refs/heads/mc/issue-123";

    setGitResponses({
      "worktree prune": "",
      "fetch origin main:main": "",
      "rev-parse --verify refs/heads/mc/issue-123": "def456",
      "worktree list --porcelain": "worktree /tmp/mc/workspaces/abc123/repo.git\nbare\n\n",
      [`worktree add --checkout /tmp/mc/workspaces/abc123/worktrees/wt-001 ${branchName}`]:
        makeGitError(`fatal: '${fullBranchName}' is already checked out at '${existingPath}'`),
    });

    const result = addWorktree({
      mcHome,
      repoKey,
      key,
      branchName,
      baseBranch,
    });

    expect(result.success).toBe(true);
    expect(result.path).toBe(existingPath);
    expect(result.isExisting).toBe(true);
  });

  it("should handle 'already checked out' error with double quotes in path", () => {
    const existingPath = "/tmp/mc/workspaces/abc123/worktrees/wt-002";

    setGitResponses({
      "worktree prune": "",
      "fetch origin main:main": "",
      "rev-parse --verify refs/heads/mc/issue-123": "def456",
      "worktree list --porcelain": "worktree /tmp/mc/workspaces/abc123/repo.git\nbare\n\n",
      [`worktree add --checkout /tmp/mc/workspaces/abc123/worktrees/wt-001 ${branchName}`]:
        makeGitError(`fatal: "${branchName}" is already checked out at "${existingPath}"`),
    });

    const result = addWorktree({
      mcHome,
      repoKey,
      key,
      branchName,
      baseBranch,
    });

    expect(result.success).toBe(true);
    expect(result.path).toBe(existingPath);
    expect(result.isExisting).toBe(true);
  });

  it("should handle 'already checked out' error without quotes and with trailing whitespace", () => {
    const existingPath = "/tmp/mc/workspaces/abc123/worktrees/wt-002";

    setGitResponses({
      "worktree prune": "",
      "fetch origin main:main": "",
      "rev-parse --verify refs/heads/mc/issue-123": "def456",
      "worktree list --porcelain": "worktree /tmp/mc/workspaces/abc123/repo.git\nbare\n\n",
      [`worktree add --checkout /tmp/mc/workspaces/abc123/worktrees/wt-001 ${branchName}`]:
        makeGitError(`fatal: '${branchName}' is already checked out at ${existingPath} \n`),
    });

    const result = addWorktree({
      mcHome,
      repoKey,
      key,
      branchName,
      baseBranch,
    });

    expect(result.success).toBe(true);
    expect(result.path).toBe(existingPath);
    expect(result.isExisting).toBe(true);
  });

  it("should re-throw non 'already checked out' errors", () => {
    setGitResponses({
      "worktree prune": "",
      "fetch origin main:main": "",
      "rev-parse --verify refs/heads/mc/issue-123": "def456",
      "worktree list --porcelain": "worktree /tmp/mc/workspaces/abc123/repo.git\nbare\n\n",
      [`worktree add --checkout /tmp/mc/workspaces/abc123/worktrees/wt-001 ${branchName}`]:
        makeGitError("fatal: some other error"),
    });

    const result = addWorktree({
      mcHome,
      repoKey,
      key,
      branchName,
      baseBranch,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Failed to add worktree");
    expect(result.error).toContain("some other error");
  });

  it("should return existing worktree from listWorktrees when found", () => {
    const existingPath = "/tmp/mc/workspaces/abc123/worktrees/wt-002";

    // Mock existsSync to return true for the existing worktree path
    existsSyncMock.mockImplementation((path) => path === existingPath);

    setGitResponses({
      "worktree prune": "",
      "fetch origin main:main": "",
      // listWorktrees returns the existing worktree with the branch
      "worktree list --porcelain": `worktree /tmp/mc/workspaces/abc123/repo.git\nbare\n\nworktree ${existingPath}\nbranch refs/heads/${branchName}\n\n`,
    });

    const result = addWorktree({
      mcHome,
      repoKey,
      key,
      branchName,
      baseBranch,
    });

    expect(result.success).toBe(true);
    expect(result.path).toBe(existingPath);
    expect(result.isExisting).toBe(true);
  });

  it("should fail when base branch not found", () => {
    setGitResponses({
      "worktree prune": "",
      "fetch origin nonexistent:nonexistent": makeGitError("fetch failed"),
      "rev-parse --verify refs/heads/nonexistent": makeGitError("not found"),
      "worktree list --porcelain": "worktree /tmp/mc/workspaces/abc123/repo.git\nbare\n\n",
    });

    const result = addWorktree({
      mcHome,
      repoKey,
      key,
      branchName,
      baseBranch: "nonexistent",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Base branch nonexistent not available");
  });

  it("should fall back to local base branch when fetch fails but local exists", () => {
    const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    setGitResponses({
      "worktree prune": "",
      "fetch origin main:main": makeGitError("network error"),
      "rev-parse --verify refs/heads/main": "abc123",
      "rev-parse --verify refs/heads/mc/issue-123": makeGitError("not found"),
      "rev-parse --verify refs/remotes/origin/mc/issue-123": makeGitError("not found"),
      "worktree list --porcelain": "worktree /tmp/mc/workspaces/abc123/repo.git\nbare\n\n",
      "worktree add -b mc/issue-123 /tmp/mc/workspaces/abc123/worktrees/wt-001 main": "",
      "config user.email rusa@localhost": "",
      "config user.name Meta Coder": "",
      "config --local safe.directory *": "",
    });

    const result = addWorktree({
      mcHome,
      repoKey,
      key,
      branchName,
      baseBranch,
    });

    expect(result.success).toBe(true);
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("Failed to fetch latest main from remote")
    );
    consoleSpy.mockRestore();
  });

  it("should copy .env file from sourceRepoPath if it exists", () => {
    const sourceRepoPath = "/src/repo";
    const sourceEnv = "/src/repo/.env";
    const targetEnv = "/tmp/mc/workspaces/abc123/worktrees/wt-001/.env";

    existsSyncMock.mockImplementation((path) => {
      if (path === sourceRepoPath) return true;
      if (path === sourceEnv) return true;
      return false;
    });

    readdirSyncMock.mockReturnValue([]);

    setGitResponses({
      "worktree prune": "",
      "fetch origin main:main": "",
      "rev-parse --verify refs/heads/mc/issue-123": makeGitError("not found"),
      "worktree list --porcelain": "worktree /tmp/mc/workspaces/abc123/repo.git\nbare\n\n",
      "worktree add -b mc/issue-123 /tmp/mc/workspaces/abc123/worktrees/wt-001 main": "",
      "config user.email rusa@localhost": "",
      "config user.name Meta Coder": "",
      "config --local safe.directory *": "",
    });

    const result = addWorktree({
      mcHome,
      repoKey,
      key,
      branchName,
      baseBranch,
      sourceRepoPath,
    });

    expect(result.success).toBe(true);
    expect(copyFileSyncMock).toHaveBeenCalledWith(sourceEnv, targetEnv);
  });

  it("should copy recursive .env files from sourceRepoPath if they exist", () => {
    const sourceRepoPath = "/src/repo";
    const sourceAppDir = "/src/repo/apps";
    const sourceAppFooDir = "/src/repo/apps/foo";
    const sourceSubEnv = "/src/repo/apps/foo/.env";
    const targetSubEnv = "/tmp/mc/workspaces/abc123/worktrees/wt-001/apps/foo/.env";

    existsSyncMock.mockImplementation((path) => {
      if (path === sourceRepoPath) return true;
      if (path === sourceAppDir) return true;
      if (path === sourceAppFooDir) return true;
      if (path === sourceSubEnv) return true;
      if (path === "/tmp/mc/workspaces/abc123/worktrees/wt-001/apps/foo") return true;
      return false;
    });

    readdirSyncMock.mockImplementation((path) => {
      if (path === sourceRepoPath) return ["apps"];
      if (path === sourceAppDir) return ["foo"];
      if (path === sourceAppFooDir) return [".env"];
      return [];
    });

    statSyncMock.mockImplementation((path) => {
      return {
        isDirectory: () => !path.endsWith(".env"),
        isFile: () => path.endsWith(".env"),
      };
    });

    setGitResponses({
      "worktree prune": "",
      "fetch origin main:main": "",
      "rev-parse --verify refs/heads/mc/issue-123": makeGitError("not found"),
      "worktree list --porcelain": "worktree /tmp/mc/workspaces/abc123/repo.git\nbare\n\n",
      "worktree add -b mc/issue-123 /tmp/mc/workspaces/abc123/worktrees/wt-001 main": "",
      "config user.email rusa@localhost": "",
      "config user.name Meta Coder": "",
      "config --local safe.directory *": "",
    });

    const result = addWorktree({
      mcHome,
      repoKey,
      key,
      branchName,
      baseBranch,
      sourceRepoPath,
    });

    expect(result.success).toBe(true);
    expect(copyFileSyncMock).toHaveBeenCalledWith(sourceSubEnv, targetSubEnv);
  });

  it("should copy .env files when reusing an existing worktree", () => {
    const existingPath = "/tmp/mc/workspaces/abc123/worktrees/wt-002";
    const sourceRepoPath = "/src/repo";
    const sourceEnv = "/src/repo/.env";
    const targetEnv = `${existingPath}/.env`;

    existsSyncMock.mockImplementation((path) => {
      if (path === existingPath) return true;
      if (path === sourceRepoPath) return true;
      if (path === sourceEnv) return true;
      return false;
    });

    readdirSyncMock.mockReturnValue([]);

    setGitResponses({
      "worktree prune": "",
      "fetch origin main:main": "",
      "worktree list --porcelain": `worktree /tmp/mc/workspaces/abc123/repo.git\nbare\n\nworktree ${existingPath}\nbranch refs/heads/${branchName}\n\n`,
    });

    const result = addWorktree({
      mcHome,
      repoKey,
      key,
      branchName,
      baseBranch,
      sourceRepoPath,
    });

    expect(result.success).toBe(true);
    expect(result.isExisting).toBe(true);
    expect(copyFileSyncMock).toHaveBeenCalledWith(sourceEnv, targetEnv);
  });
});

describe("listWorktrees", () => {
  const mcHome = "/tmp/mc";
  const repoKey = "abc123";

  it("should parse worktree list output correctly", () => {
    setGitResponses({
      "worktree list --porcelain":
        "worktree /tmp/mc/workspaces/abc123/repo.git\nbare\n\nworktree /tmp/mc/workspaces/abc123/worktrees/wt-001\nbranch refs/heads/mc/issue-123\n\nworktree /tmp/mc/workspaces/abc123/worktrees/wt-002\nbranch refs/heads/mc/issue-456\n\n",
    });

    const result = listWorktrees(mcHome, repoKey);

    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({
      path: "/tmp/mc/workspaces/abc123/repo.git",
      branch: null,
      isBare: true,
      isCurrent: false,
    });
    expect(result[1]).toEqual({
      path: "/tmp/mc/workspaces/abc123/worktrees/wt-001",
      branch: "mc/issue-123",
      isBare: false,
      isCurrent: false,
    });
    expect(result[2]).toEqual({
      path: "/tmp/mc/workspaces/abc123/worktrees/wt-002",
      branch: "mc/issue-456",
      isBare: false,
      isCurrent: false,
    });
  });

  it("should handle detached HEAD worktrees", () => {
    setGitResponses({
      "worktree list --porcelain":
        "worktree /tmp/mc/workspaces/abc123/repo.git\nbare\n\nworktree /tmp/mc/workspaces/abc123/worktrees/wt-001\ndetached\n\n",
    });

    const result = listWorktrees(mcHome, repoKey);

    expect(result).toHaveLength(2);
    expect(result[1]).toEqual({
      path: "/tmp/mc/workspaces/abc123/worktrees/wt-001",
      branch: null,
      isBare: false,
      isCurrent: false,
    });
  });

  it("should return empty array on error", () => {
    setGitResponses({
      "worktree list --porcelain": makeGitError("not a git repo"),
    });

    const result = listWorktrees(mcHome, repoKey);

    expect(result).toEqual([]);
  });
});
