import { beforeEach, expect, it, vi } from "vitest";

const execFileSyncMock = vi.fn();

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const mockExecFileSync = (...args: unknown[]) =>
    execFileSyncMock(
      ...(args as [
        string,
        string[],
        { cwd: string; encoding: string; stdio: [string, string, string] },
      ])
    );
  // node: builtins gain a synthetic `default` under ESM interop that the
  // module's type declarations don't carry.
  const actualDefault = (actual as unknown as { default: Record<string, unknown> }).default;
  return {
    ...actual,
    execFileSync: mockExecFileSync,
    default: {
      ...actualDefault,
      execFileSync: mockExecFileSync,
    },
  };
});

import {
  commitAllDetailed,
  getBranchSyncState,
  prepareImplementBranch,
  pullBranch,
  push,
  rebasePendingBranchOntoDefault,
} from "./git.js";

function makeGitError(message: string): Error {
  const err = new Error(message);
  return err;
}

function makeGitExecError(
  message: string,
  opts: {
    stdout?: string | Buffer;
    stderr?: string | Buffer;
  } = {}
): Error & { stdout?: string | Buffer; stderr?: string | Buffer } {
  const err = new Error(message) as Error & { stdout?: string | Buffer; stderr?: string | Buffer };
  err.stdout = opts.stdout;
  err.stderr = opts.stderr;
  return err;
}

function setGitResponses(responses: Record<string, string | Error>): void {
  execFileSyncMock.mockReset();
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
}

function executedCommands(): string[] {
  return execFileSyncMock.mock.calls.map((call) => (call[1] as string[]).join(" "));
}

beforeEach(() => {
  execFileSyncMock.mockReset();
});

it("resume mode: existing local+remote branch continues and pulls when clean", () => {
  setGitResponses({
    "show-ref --verify refs/heads/mc/issue-79": "",
    "ls-remote --exit-code --heads origin mc/issue-79": "abc\trefs/heads/mc/issue-79",
    "checkout mc/issue-79": "",
    "status --porcelain": "",
    "pull --ff-only origin mc/issue-79": "",
  });

  const result = prepareImplementBranch("/tmp/repo", "mc/issue-79", "main", { mode: "resume" });

  expect(result).toEqual({
    mode: "resume",
    branchState: "local",
    hasLocalChanges: false,
    remoteExists: true,
  });
  expect(executedCommands()).toEqual([
    "show-ref --verify refs/heads/mc/issue-79",
    "ls-remote --exit-code --heads origin mc/issue-79",
    "checkout mc/issue-79",
    "status --porcelain",
    "pull --ff-only origin mc/issue-79",
  ]);
});

it("resume mode: interrupted local branch with partial changes skips pull", () => {
  setGitResponses({
    "show-ref --verify refs/heads/mc/issue-79": "",
    "ls-remote --exit-code --heads origin mc/issue-79": "abc\trefs/heads/mc/issue-79",
    "checkout mc/issue-79": "",
    "status --porcelain": " M src/work-in-progress.ts\n",
  });

  const result = prepareImplementBranch("/tmp/repo", "mc/issue-79", "main", { mode: "resume" });

  expect(result).toEqual({
    mode: "resume",
    branchState: "local",
    hasLocalChanges: true,
    remoteExists: true,
  });
  expect(executedCommands().includes("pull --ff-only origin mc/issue-79")).toBe(false);
});

it("resume mode: remote branch without local branch tracks remote", () => {
  setGitResponses({
    "show-ref --verify refs/heads/mc/issue-79": makeGitError("missing local"),
    "ls-remote --exit-code --heads origin mc/issue-79": "abc\trefs/heads/mc/issue-79",
    "fetch origin mc/issue-79": "",
    "checkout --track origin/mc/issue-79": "",
  });

  const result = prepareImplementBranch("/tmp/repo", "mc/issue-79", "main", { mode: "resume" });

  expect(result).toEqual({
    mode: "resume",
    branchState: "remote",
    hasLocalChanges: false,
    remoteExists: true,
  });
});

it("resume mode: creates new branch from default when absent locally/remotely", () => {
  setGitResponses({
    "show-ref --verify refs/heads/mc/issue-79": makeGitError("missing local"),
    "ls-remote --exit-code --heads origin mc/issue-79": makeGitError("missing remote"),
    "checkout main": "",
    "pull --ff-only origin main": "",
    "checkout -b mc/issue-79": "",
  });

  const result = prepareImplementBranch("/tmp/repo", "mc/issue-79", "main", { mode: "resume" });

  expect(result).toEqual({
    mode: "resume",
    branchState: "created",
    hasLocalChanges: false,
    remoteExists: false,
  });
});

it("push always force-pushes branches", () => {
  setGitResponses({
    "push --force -u origin mc/issue-79": "",
  });

  push("/tmp/repo", "mc/issue-79");
  expect(executedCommands()).toEqual(["push --force -u origin mc/issue-79"]);
});

it("push force-pushes branches without explicit options", () => {
  setGitResponses({
    "push --force -u origin mc/issue-80": "",
  });

  push("/tmp/repo", "mc/issue-80");
  expect(executedCommands()).toEqual(["push --force -u origin mc/issue-80"]);
});

it("getBranchSyncState returns ahead/behind counts when remote exists", () => {
  setGitResponses({
    "status --porcelain": "",
    "ls-remote --exit-code --heads origin mc/issue-79": "abc\trefs/heads/mc/issue-79",
    "fetch origin mc/issue-79": "",
    "rev-list --left-right --count mc/issue-79...origin/mc/issue-79": "2\t1",
  });

  const state = getBranchSyncState("/tmp/repo", "mc/issue-79");
  expect(state).toEqual({
    hasWorkingTreeChanges: false,
    remoteExists: true,
    aheadCount: 2,
    behindCount: 1,
    localOnlyCommitCount: 0,
  });
});

it("getBranchSyncState reports missing remote branch and local-only commits", () => {
  setGitResponses({
    "status --porcelain": " M src/dirty.ts\n",
    "ls-remote --exit-code --heads origin mc/issue-79": makeGitError("missing remote"),
    "rev-list --count mc/issue-79 --not --remotes=origin": "3",
  });

  const state = getBranchSyncState("/tmp/repo", "mc/issue-79");
  expect(state).toEqual({
    hasWorkingTreeChanges: true,
    remoteExists: false,
    aheadCount: 0,
    behindCount: 0,
    localOnlyCommitCount: 3,
  });
  expect(
    executedCommands().includes("rev-list --left-right --count mc/issue-79...origin/mc/issue-79")
  ).toBe(false);
});

it("rebasePendingBranchOntoDefault rebases and force-pushes a clean branch", () => {
  setGitResponses({
    "status --porcelain": "",
    "rev-parse --abbrev-ref HEAD": "master",
    "fetch origin master": "",
    "ls-remote --exit-code --heads origin mc/issue-79": "abc\trefs/heads/mc/issue-79",
    "fetch origin mc/issue-79": "",
    "show-ref --verify refs/heads/mc/issue-79": "",
    "checkout mc/issue-79": "",
    "pull --ff-only origin mc/issue-79": "",
    "rebase origin/master": "",
    "push --force-with-lease -u origin mc/issue-79": "",
    "rev-list --left-right --count mc/issue-79...origin/mc/issue-79": "0\t0",
  });

  const result = rebasePendingBranchOntoDefault("/tmp/repo", "mc/issue-79", "master");

  expect(result).toEqual({
    branchName: "mc/issue-79",
    usedConflictFallback: false,
  });
  expect(executedCommands()).toContain("rebase origin/master");
  expect(executedCommands()).toContain("push --force-with-lease -u origin mc/issue-79");
});

it("rebasePendingBranchOntoDefault retries with conflict fallback", () => {
  setGitResponses({
    "status --porcelain": "",
    "rev-parse --abbrev-ref HEAD": "master",
    "fetch origin master": "",
    "ls-remote --exit-code --heads origin mc/issue-79": "abc\trefs/heads/mc/issue-79",
    "fetch origin mc/issue-79": "",
    "show-ref --verify refs/heads/mc/issue-79": "",
    "checkout mc/issue-79": "",
    "pull --ff-only origin mc/issue-79": "",
    "rebase origin/master": makeGitError("conflict"),
    "rebase --abort": "",
    "rebase -X theirs origin/master": "",
    "push --force-with-lease -u origin mc/issue-79": "",
    "rev-list --left-right --count mc/issue-79...origin/mc/issue-79": "0\t0",
  });

  const result = rebasePendingBranchOntoDefault("/tmp/repo", "mc/issue-79", "master");

  expect(result).toEqual({
    branchName: "mc/issue-79",
    usedConflictFallback: true,
  });
  expect(executedCommands()).toContain("rebase --abort");
  expect(executedCommands()).toContain("rebase -X theirs origin/master");
});

it("commitAllDetailed returns committed:false when there are no staged changes", () => {
  setGitResponses({
    "status --porcelain": "",
  });

  const result = commitAllDetailed("/tmp/repo", "feat: noop");

  expect(result).toEqual({ ok: true, committed: false });
  expect(executedCommands()).toEqual(["status --porcelain"]);
});

it("commitAllDetailed returns commit SHA on success", () => {
  setGitResponses({
    "status --porcelain": " M src/index.ts\n",
    "add -A": "",
    "commit -m feat: add thing -m body text": "",
    "rev-parse HEAD": "abc123def",
  });

  const result = commitAllDetailed("/tmp/repo", "feat: add thing", "body text");

  expect(result).toEqual({ ok: true, committed: true, commitSha: "abc123def" });
  expect(executedCommands()).toEqual([
    "status --porcelain",
    "add -A",
    "commit -m feat: add thing -m body text",
    "rev-parse HEAD",
  ]);
});

it("commitAllDetailed classifies hook output as precommit_failed", () => {
  setGitResponses({
    "status --porcelain": " M src/index.ts\n",
    "add -A": "",
    "commit -m feat: add thing": makeGitExecError("commit failed", {
      stderr: Buffer.from("husky - pre-commit script failed\nlint error", "utf8"),
    }),
  });

  const result = commitAllDetailed("/tmp/repo", "feat: add thing");

  expect(result).toEqual({
    ok: false,
    kind: "precommit_failed",
    retryable: true,
    output: "husky - pre-commit script failed\nlint error",
  });
});

it("commitAllDetailed classifies non-hook failures as commit_failed", () => {
  setGitResponses({
    "status --porcelain": " M src/index.ts\n",
    "add -A": "",
    "commit -m feat: add thing": makeGitExecError("commit failed", {
      stderr:
        "Author identity unknown\n*** Please tell me who you are.\nRun git config --global user.email",
    }),
  });

  const result = commitAllDetailed("/tmp/repo", "feat: add thing");

  expect(result).toEqual({
    ok: false,
    kind: "commit_failed",
    retryable: false,
    output:
      "Author identity unknown\n*** Please tell me who you are.\nRun git config --global user.email",
  });
});

it("commitAllDetailed truncates oversized commit output and keeps tail", () => {
  const prefix = "x".repeat(25000);
  const tail = "husky - pre-commit failed on final check";
  setGitResponses({
    "status --porcelain": " M src/index.ts\n",
    "add -A": "",
    "commit -m feat: add thing": makeGitExecError("commit failed", {
      stderr: `${prefix}${tail}`,
    }),
  });

  const result = commitAllDetailed("/tmp/repo", "feat: add thing");
  expect(result.ok).toBe(false);
  if (result.ok) {
    throw new Error("Expected commit failure result");
  }
  expect(result.output.startsWith("[truncated to last 20000 chars]")).toBe(true);
  expect(result.output.endsWith(tail)).toBe(true);
  expect(result.output.length).toBe(20032);
});
it("pullBranch uses ff-only to avoid implicit merge behavior", () => {
  setGitResponses({
    "pull --ff-only origin mc/issue-79": "",
  });

  pullBranch("/tmp/repo", "mc/issue-79");

  expect(executedCommands()).toEqual(["pull --ff-only origin mc/issue-79"]);
});
