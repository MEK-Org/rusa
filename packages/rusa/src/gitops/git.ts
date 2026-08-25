import { execFileSync } from "node:child_process";

const MAX_COMMIT_ERROR_OUTPUT_CHARS = 20000;
const PRECOMMIT_OUTPUT_MARKERS = [
  "pre-commit",
  "pre commit",
  "husky",
  "hook declined",
  ".git/hooks/pre-commit",
];

function git(repoPath: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd: repoPath,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
    maxBuffer: 50 * 1024 * 1024, // 50 MB – repos with node_modules can produce large diffs
  }).trim();
}

function localBranchExists(repoPath: string, branchName: string): boolean {
  try {
    git(repoPath, "show-ref", "--verify", `refs/heads/${branchName}`);
    return true;
  } catch {
    return false;
  }
}

function remoteBranchExists(repoPath: string, branchName: string): boolean {
  try {
    git(repoPath, "ls-remote", "--exit-code", "--heads", "origin", branchName);
    return true;
  } catch {
    return false;
  }
}

function hasWorkingTreeChanges(repoPath: string): boolean {
  return git(repoPath, "status", "--porcelain").length > 0;
}

export interface BranchSyncState {
  hasWorkingTreeChanges: boolean;
  remoteExists: boolean;
  aheadCount: number;
  behindCount: number;
  localOnlyCommitCount: number;
}

export interface PrepareImplementBranchResult {
  mode: "resume" | "reset";
  branchState: "local" | "remote" | "created";
  hasLocalChanges: boolean;
  remoteExists: boolean;
}

export interface RebasePendingBranchResult {
  branchName: string;
  usedConflictFallback: boolean;
}

export type CommitFailureKind = "precommit_failed" | "commit_failed";

export type CommitResult =
  | { ok: true; committed: false }
  | { ok: true; committed: true; commitSha: string }
  | {
      ok: false;
      kind: CommitFailureKind;
      retryable: boolean;
      output: string;
    };

function toErrorText(value: unknown): string {
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  if (typeof value === "string") return value;
  return "";
}

function truncateCommitErrorOutput(output: string): string {
  if (output.length <= MAX_COMMIT_ERROR_OUTPUT_CHARS) return output;
  return (
    `[truncated to last ${MAX_COMMIT_ERROR_OUTPUT_CHARS} chars]\n` +
    output.slice(-MAX_COMMIT_ERROR_OUTPUT_CHARS)
  );
}

function normalizeCommitErrorOutput(error: unknown): string {
  const maybeError = (error ?? {}) as {
    stdout?: unknown;
    stderr?: unknown;
    message?: unknown;
  };
  const stdout = toErrorText(maybeError.stdout).trim();
  const stderr = toErrorText(maybeError.stderr).trim();
  const message = typeof maybeError.message === "string" ? maybeError.message.trim() : "";

  const output =
    [stdout, stderr].filter((part) => part.length > 0).join("\n\n") ||
    message ||
    "git commit failed";
  return truncateCommitErrorOutput(output);
}

function isLikelyPrecommitFailureOutput(output: string): boolean {
  const haystack = output.toLowerCase();
  return PRECOMMIT_OUTPUT_MARKERS.some((marker) => haystack.includes(marker));
}

export function classifyCommitFailure(error: unknown): {
  kind: CommitFailureKind;
  retryable: boolean;
  output: string;
} {
  const output = normalizeCommitErrorOutput(error);
  const kind: CommitFailureKind = isLikelyPrecommitFailureOutput(output)
    ? "precommit_failed"
    : "commit_failed";
  return {
    kind,
    retryable: kind === "precommit_failed",
    output,
  };
}

function getCurrentBranch(repoPath: string): string {
  return git(repoPath, "rev-parse", "--abbrev-ref", "HEAD");
}

/**
 * Pull the latest default branch.
 */
export function pullDefault(repoPath: string, defaultBranch: string): void {
  git(repoPath, "checkout", defaultBranch);
  git(repoPath, "pull", "--ff-only", "origin", defaultBranch);
}

/**
 * Checkout an implementation branch with explicit retry semantics.
 * - `resume`: continue from existing branch state when possible.
 * - `reset`: recreate branch from default branch tip without deleting it.
 */
export function prepareImplementBranch(
  repoPath: string,
  branchName: string,
  defaultBranch: string,
  opts: { mode?: "resume" | "reset" } = {}
): PrepareImplementBranchResult {
  const mode = opts.mode ?? "resume";
  const localExists = localBranchExists(repoPath, branchName);
  const remoteExists = remoteBranchExists(repoPath, branchName);

  if (mode === "resume") {
    if (localExists) {
      git(repoPath, "checkout", branchName);
      const dirty = hasWorkingTreeChanges(repoPath);
      if (!dirty && remoteExists) {
        git(repoPath, "pull", "--ff-only", "origin", branchName);
      }
      return {
        mode,
        branchState: "local",
        hasLocalChanges: dirty,
        remoteExists,
      };
    }

    if (remoteExists) {
      git(repoPath, "fetch", "origin", branchName);
      git(repoPath, "checkout", "--track", `origin/${branchName}`);
      return {
        mode,
        branchState: "remote",
        hasLocalChanges: false,
        remoteExists: true,
      };
    }

    git(repoPath, "checkout", defaultBranch);
    git(repoPath, "pull", "--ff-only", "origin", defaultBranch);
    git(repoPath, "checkout", "-b", branchName);
    return {
      mode,
      branchState: "created",
      hasLocalChanges: false,
      remoteExists: false,
    };
  }

  git(repoPath, "checkout", defaultBranch);
  git(repoPath, "pull", "--ff-only", "origin", defaultBranch);
  git(repoPath, "checkout", "-B", branchName, defaultBranch);
  return {
    mode,
    branchState: localExists || remoteExists ? "local" : "created",
    hasLocalChanges: false,
    remoteExists,
  };
}

/**
 * Stage all changes and commit with a subject and optional body.
 * Returns structured status and commit-failure diagnostics.
 */
export function commitAllDetailed(repoPath: string, subject: string, body?: string): CommitResult {
  const status = git(repoPath, "status", "--porcelain");
  if (!status) {
    return { ok: true, committed: false };
  }

  git(repoPath, "add", "-A");
  try {
    if (body?.trim()) {
      git(repoPath, "commit", "-m", subject, "-m", body);
    } else {
      git(repoPath, "commit", "-m", subject);
    }
    const commitSha = git(repoPath, "rev-parse", "HEAD");
    return { ok: true, committed: true, commitSha };
  } catch (error) {
    return {
      ok: false,
      ...classifyCommitFailure(error),
    };
  }
}

/**
 * List changed file paths from git status.
 */
export function getChangedFiles(repoPath: string): string[] {
  // Deliberately NOT the trimming `git()` helper: porcelain lines are
  // positional ("XY path", path at column 3), and an unstaged-modification
  // first line starts with a space that trim() would eat — corrupting the
  // first filename (" M index.js" → "M index.js" → "ndex.js").
  const status = execFileSync("git", ["status", "--porcelain"], {
    cwd: repoPath,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
    maxBuffer: 50 * 1024 * 1024,
  });
  if (!status.trim()) return [];

  const out: string[] = [];
  const seen = new Set<string>();

  for (const rawLine of status.split("\n")) {
    const line = rawLine.trimEnd();
    if (!line) continue;
    const pathPart = line.slice(3).trim();
    if (!pathPart) continue;
    const normalized = pathPart.includes(" -> ")
      ? (pathPart.split(" -> ").pop() ?? pathPart)
      : pathPart;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }

  return out;
}

export function getWorkingTreePatch(repoPath: string): string {
  try {
    // Include untracked files as intent-to-add so they appear in the diff.
    git(repoPath, "add", "-N", ".");
  } catch {
    // Best effort: tracked changes are still useful if intent-to-add fails.
  }
  const patch = git(repoPath, "diff", "--binary", "HEAD");
  const stagedPatch = git(repoPath, "diff", "--cached", "--binary", "HEAD");
  return [patch, stagedPatch].filter(Boolean).join("\n");
}

export function discardWorkingTreeChanges(repoPath: string, ref = "HEAD"): void {
  git(repoPath, "reset", "--hard", ref);
  git(repoPath, "clean", "-fd");
}

/**
 * Push a branch to origin.
 */
export function push(
  repoPath: string,
  branchName: string,
  opts: { forceWithLease?: boolean } = {}
): void {
  if (opts.forceWithLease) {
    git(repoPath, "push", "--force-with-lease", "-u", "origin", branchName);
  } else {
    git(repoPath, "push", "--force", "-u", "origin", branchName);
  }
}

/**
 * Inspect whether a local branch is synchronized with origin.
 */
export function getBranchSyncState(repoPath: string, branchName: string): BranchSyncState {
  const dirty = hasWorkingTreeChanges(repoPath);
  const remoteExists = remoteBranchExists(repoPath, branchName);
  if (!remoteExists) {
    const localOnlyCommitCountRaw = git(
      repoPath,
      "rev-list",
      "--count",
      branchName,
      "--not",
      "--remotes=origin"
    );
    const localOnlyCommitCount = Number.parseInt(localOnlyCommitCountRaw.trim(), 10);
    if (!Number.isFinite(localOnlyCommitCount)) {
      throw new Error(
        `Unable to parse local-only commit count for ${branchName}: "${localOnlyCommitCountRaw}"`
      );
    }
    return {
      hasWorkingTreeChanges: dirty,
      remoteExists: false,
      aheadCount: 0,
      behindCount: 0,
      localOnlyCommitCount,
    };
  }

  // Refresh tracking refs before comparing local and remote commit graphs.
  git(repoPath, "fetch", "origin", branchName);
  const divergence = git(
    repoPath,
    "rev-list",
    "--left-right",
    "--count",
    `${branchName}...origin/${branchName}`
  );
  const [aheadRaw = "0", behindRaw = "0"] = divergence.trim().split(/\s+/);
  const aheadCount = Number.parseInt(aheadRaw, 10);
  const behindCount = Number.parseInt(behindRaw, 10);

  if (!Number.isFinite(aheadCount) || !Number.isFinite(behindCount)) {
    throw new Error(`Unable to parse branch divergence for ${branchName}: "${divergence}"`);
  }

  return {
    hasWorkingTreeChanges: dirty,
    remoteExists: true,
    aheadCount,
    behindCount,
    localOnlyCommitCount: 0,
  };
}

/**
 * Get the diff between two branches.
 */
export function getDiff(repoPath: string, baseBranch: string, headBranch: string): string {
  return git(repoPath, "diff", `${baseBranch}...${headBranch}`);
}

/**
 * Get a concise file-level diff summary between two branches.
 */
export function getDiffStat(repoPath: string, baseBranch: string, headBranch: string): string {
  return git(repoPath, "diff", "--stat", `${baseBranch}...${headBranch}`);
}

/**
 * Get commit subjects on a branch compared to a base branch, oldest first.
 */
export function getCommitSubjects(
  repoPath: string,
  baseBranch: string,
  headBranch: string
): string[] {
  const output = git(repoPath, "log", "--format=%s", "--reverse", `${baseBranch}..${headBranch}`);
  if (!output) return [];
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

/**
 * Checkout an existing branch.
 */
export function checkout(repoPath: string, branchName: string): void {
  git(repoPath, "checkout", branchName);
}

/**
 * Checkout a branch, creating a local tracking branch from origin if needed.
 */
export function checkoutWithRemoteFallback(repoPath: string, branchName: string): void {
  if (localBranchExists(repoPath, branchName)) {
    git(repoPath, "checkout", branchName);
    return;
  }

  // Branch is not local yet; fetch and track it from origin.
  git(repoPath, "fetch", "origin", branchName);
  git(repoPath, "checkout", "--track", `origin/${branchName}`);
}

/**
 * Pull the latest commits for the current branch from origin.
 */
export function pullBranch(repoPath: string, branchName: string): void {
  git(repoPath, "pull", "--ff-only", "origin", branchName);
}

/**
 * Get the local HEAD SHA of the current branch.
 */
export function getLocalHeadSha(repoPath: string): string {
  return git(repoPath, "rev-parse", "HEAD");
}

/**
 * Get the remote SHA for a branch from origin.
 * Returns null if the branch doesn't exist on origin.
 */
export function getRemoteBranchSha(repoPath: string, branchName: string): string | null {
  try {
    const output = git(repoPath, "ls-remote", "--heads", "origin", branchName);
    if (!output) return null;
    // Output format: "<sha>\trefs/heads/<branch>"
    const sha = output.split("\t")[0];
    return sha || null;
  } catch {
    return null;
  }
}

/**
 * Fetch and return the remote SHA for a branch.
 * This ensures we have the latest remote state.
 */
export function fetchAndGetRemoteSha(repoPath: string, branchName: string): string | null {
  try {
    git(repoPath, "fetch", "origin", branchName);
    return getRemoteBranchSha(repoPath, branchName);
  } catch {
    return null;
  }
}

/**
 * Rebase a pending issue branch onto the latest default branch.
 * Falls back to a conflict-tolerant strategy if a standard rebase fails.
 */
export function rebasePendingBranchOntoDefault(
  repoPath: string,
  branchName: string,
  defaultBranch: string
): RebasePendingBranchResult {
  if (hasWorkingTreeChanges(repoPath)) {
    throw new Error(`Cannot rebase ${branchName}: repository has uncommitted changes`);
  }

  const originalBranch = getCurrentBranch(repoPath);
  let usedConflictFallback = false;

  try {
    git(repoPath, "fetch", "origin", defaultBranch);
    if (remoteBranchExists(repoPath, branchName)) {
      git(repoPath, "fetch", "origin", branchName);
    }

    checkoutWithRemoteFallback(repoPath, branchName);

    if (remoteBranchExists(repoPath, branchName)) {
      git(repoPath, "pull", "--ff-only", "origin", branchName);
    }

    try {
      git(repoPath, "rebase", `origin/${defaultBranch}`);
    } catch {
      try {
        git(repoPath, "rebase", "--abort");
      } catch {
        // no-op
      }
      git(repoPath, "rebase", "-X", "theirs", `origin/${defaultBranch}`);
      usedConflictFallback = true;
    }

    push(repoPath, branchName, { forceWithLease: true });

    const sync = getBranchSyncState(repoPath, branchName);
    const isSynced =
      !sync.hasWorkingTreeChanges &&
      sync.remoteExists &&
      sync.aheadCount === 0 &&
      sync.behindCount === 0 &&
      sync.localOnlyCommitCount === 0;
    if (!isSynced) {
      throw new Error(`Branch ${branchName} did not synchronize cleanly after rebase`);
    }

    return { branchName, usedConflictFallback };
  } finally {
    if (getCurrentBranch(repoPath) !== originalBranch) {
      git(repoPath, "checkout", originalBranch);
    }
  }
}
