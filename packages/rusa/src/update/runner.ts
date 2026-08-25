import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { writeBuildSentinel } from "./build-sentinel.js";
import { type BuildSeam, type GitSeam, StepError } from "./orchestrator.js";

/**
 * Run a command with a HARD timeout (elder fix #2). A *hung* step — a wedged
 * compile, a stalled network install — would otherwise block the `update` tool,
 * which blocks root's single run, silently wedging the human-facing actor with no
 * exit, no restart, and no alert. So every step is bounded: on timeout we SIGKILL
 * the whole process group (the child is `detached` to get its own group, so
 * pnpm/flutter grandchildren die too) and throw a {@link StepError}.
 *
 * `spawnImpl` is injectable so the timeout/kill logic is unit-tested without real
 * subprocesses.
 */
export function runTimedStep(
  step: string,
  cmd: string,
  args: string[],
  opts: {
    cwd: string;
    timeoutMs: number;
    env?: NodeJS.ProcessEnv;
    log?: (msg: string) => void;
    spawnImpl?: typeof spawn;
  }
): Promise<void> {
  const spawnFn = opts.spawnImpl ?? spawn;
  const log = opts.log ?? (() => {});
  return new Promise<void>((resolve, reject) => {
    log(
      `[update] ${step}: ${cmd} ${args.join(" ")} (timeout ${Math.round(opts.timeoutMs / 1000)}s)`
    );
    const child = spawnFn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      detached: true, // own process group, so a timeout kill reaps the whole subtree
      stdio: ["ignore", "inherit", "pipe"],
    });

    const errTail: string[] = [];
    child.stderr?.on("data", (chunk: Buffer) => {
      process.stderr.write(chunk);
      errTail.push(chunk.toString());
      while (errTail.join("").length > 4096) errTail.shift();
    });

    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    const timer = setTimeout(() => {
      // Kill the whole group (negative pid); fall back to the child if that fails.
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
      finish(() =>
        reject(new StepError(step, `${step} timed out after ${opts.timeoutMs}ms`, true))
      );
    }, opts.timeoutMs);
    timer.unref?.();

    child.on("error", (err) =>
      finish(() => reject(new StepError(step, `${step}: ${err.message}`)))
    );
    child.on("close", (code) => {
      if (code === 0) {
        finish(resolve);
        return;
      }
      const tail = errTail.join("").trim().split("\n").slice(-6).join(" / ");
      finish(() => reject(new StepError(step, `${step} exited ${code}${tail ? `: ${tail}` : ""}`)));
    });
  });
}

/** Capture stdout of a (short) command with a timeout. */
function captureTimed(
  step: string,
  cmd: string,
  args: string[],
  opts: { cwd: string; timeoutMs: number; spawnImpl?: typeof spawn }
): Promise<string> {
  const spawnFn = opts.spawnImpl ?? spawn;
  return new Promise<string>((resolve, reject) => {
    const child = spawnFn(cmd, args, {
      cwd: opts.cwd,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout?.on("data", (c: Buffer) => (out += c.toString()));
    child.stderr?.on("data", (c: Buffer) => (err += c.toString()));
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
      finish(() =>
        reject(new StepError(step, `${step} timed out after ${opts.timeoutMs}ms`, true))
      );
    }, opts.timeoutMs);
    timer.unref?.();
    child.on("error", (e) => finish(() => reject(new StepError(step, `${step}: ${e.message}`))));
    child.on("close", (code) =>
      code === 0
        ? finish(() => resolve(out.trim()))
        : finish(() => reject(new StepError(step, `${step} exited ${code}: ${err.trim()}`)))
    );
  });
}

const GIT_TIMEOUT_MS = 60_000;

export function submodulePathsFromGitmodules(gitmodulesPath: string): string[] {
  if (!existsSync(gitmodulesPath)) return [];
  const text = readFileSync(gitmodulesPath, "utf8");
  const paths: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*path\s*=\s*(.+?)\s*$/);
    if (match) paths.push(match[1]);
  }
  return paths;
}

export function assertSubmodulesMaterialized(repoRoot: string): void {
  const paths = submodulePathsFromGitmodules(join(repoRoot, ".gitmodules"));
  for (const path of paths) {
    const fullPath = join(repoRoot, path);
    if (!existsSync(fullPath) || readdirSync(fullPath).length === 0) {
      throw new StepError(
        "pull",
        `submodule working tree is empty after git submodule update: ${path}. ` +
          "Recovery: run git submodule update --init --recursive, verify submodule access, then retry update."
      );
    }
  }
}

/** Production {@link GitSeam} over `git -C <repoRoot>`, every step bounded. */
export class GitRunner implements GitSeam {
  constructor(
    private readonly repoRoot: string,
    private readonly remote = "origin"
  ) {}

  private git(step: string, args: string[], timeoutMs = GIT_TIMEOUT_MS): Promise<string> {
    return captureTimed(step, "git", ["-C", this.repoRoot, ...args], {
      cwd: this.repoRoot,
      timeoutMs,
    });
  }

  headSha(): Promise<string> {
    return this.git("git-head", ["rev-parse", "HEAD"]);
  }
  subject(sha: string): Promise<string> {
    return this.git("git-subject", ["log", "-1", "--pretty=%s", sha]);
  }
  async fetch(branch: string): Promise<void> {
    await this.git("git-fetch", ["fetch", this.remote, branch], 120_000);
  }
  remoteSha(branch: string): Promise<string> {
    return this.git("git-remote-sha", ["rev-parse", `${this.remote}/${branch}`]);
  }
  async resetHard(ref: string): Promise<void> {
    await this.git("git-reset", ["reset", "--hard", ref]);
  }
  async updateSubmodules(): Promise<void> {
    // First init clones the submodule (e.g. private glass_goals) → allow a generous
    // timeout for the clone; subsequent updates are fast no-ops when already in sync.
    await this.git("git-submodule", ["submodule", "update", "--init", "--recursive"], 300_000);
    assertSubmodulesMaterialized(this.repoRoot);
  }
}

export interface BuildTimeouts {
  installMs: number;
  buildMs: number;
}

/**
 * Production {@link BuildSeam}: install deps, typecheck, then build — each with a
 * HARD timeout — using STAGING + ATOMIC SWAP so a failed build is a pure no-op on
 * boot-relevant state (ISSUE_NUM, elder require #1).
 *
 * The build writes to `dist.new` (via `RUSA_DIST_DIR`), leaving the live
 * `dist/` and its sentinel UNTOUCHED throughout. We deliberately do NOT clear the
 * live sentinel up front: an in-place build had to (else a partial dist could keep a
 * passing sentinel and boot corrupt), but that decoupling left the box one restart
 * from refuse-to-boot for the whole window. With staging, the live `dist`↔sentinel
 * pair stays valid until — on a GREEN build only — we stamp the sentinel INTO the
 * staging dir and cut over atomically (dist + sentinel move together). A
 * failed/hung build just discards `dist.new`; live state is byte-identical.
 *
 * `pnpm build` chains the TS bundle AND `flutter build web`; all honour
 * `RUSA_DIST_DIR`, so one build step stages both halves.
 */
export class BuildRunner implements BuildSeam {
  constructor(
    private readonly packageDir: string,
    private readonly timeouts: BuildTimeouts,
    private readonly log: (msg: string) => void = () => {},
    private readonly pnpm = "pnpm",
    private readonly spawnImpl?: typeof spawn
  ) {}

  private get distDir(): string {
    return join(this.packageDir, "dist");
  }

  async build(sha: string): Promise<void> {
    const live = this.distDir;
    const staging = `${live}.new`;
    const previous = `${live}.old`;

    // Start from a clean staging dir. Live `dist/` is never touched during the build.
    rmSync(staging, { recursive: true, force: true });
    const env = { ...process.env, RUSA_DIST_DIR: staging };
    const common = { cwd: this.packageDir, log: this.log, spawnImpl: this.spawnImpl, env };

    try {
      await runTimedStep("install", this.pnpm, ["install", "--frozen-lockfile"], {
        ...common,
        timeoutMs: this.timeouts.installMs,
      });
      await runTimedStep("typecheck", this.pnpm, ["run", "typecheck"], {
        ...common,
        timeoutMs: this.timeouts.buildMs,
      });
      await runTimedStep("build", this.pnpm, ["run", "build"], {
        ...common,
        timeoutMs: this.timeouts.buildMs,
      });
    } catch (err) {
      // FAILED/HUNG: live dist + its sentinel are byte-identical (never touched).
      // Best-effort discard the partial staging; the orchestrator rolls git back.
      rmSync(staging, { recursive: true, force: true });
      throw err;
    }

    // GREEN: stamp the sentinel INTO staging (dist + sentinel are one unit), then cut
    // over atomically. The sub-ms gap between the two renames self-heals: a boot in
    // that window finds no dist, refuses, and Restart=always retries onto the new dist.
    writeBuildSentinel(staging, sha);
    rmSync(previous, { recursive: true, force: true });
    if (existsSync(live)) renameSync(live, previous);
    renameSync(staging, live);
    this.log(`[update] atomically swapped dist → ${sha.slice(0, 7)} (previous at dist.old)`);
  }
}
