import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { stringify as toYaml } from "yaml";
import { loadConfig, type RusaConfig } from "../config/index.js";

/**
 * Harness-neutral provisioning + teardown for a self-contained e2e instance.
 *
 * This module holds the pieces shared by the actor-mesh e2e runner
 * (`e2e-actor-mesh.ts`): build a config, lay down a disposable instance on disk,
 * and tear it back down. The v2 `runE2EUp` runner (scheduler + dashboard + model
 * seeding) was removed with the rest of v2; only these harness-neutral helpers
 * remain. See devlog/2026-06-07-self-contained-runner/design.md §5.1 / §6.
 */

/** Dedicated dashboard port so an e2e instance doesn't collide with prod/staging/dev. */
const E2E_DASHBOARD_PORT = 8083;
/** Synthetic repo identity for the self-contained scratch repo. */
const E2E_REPO = "rusa-e2e/scratch";
/** Bot account name the instance runs as. */
const E2E_BOT = "rusa-e2e-bot";
/** Stable local-only IU scope anchor, preserved across `am-up --resume`. */
export const E2E_IU_ROOT_NODE_ID = "e2eIUroot0000000000000";
/** Pidfile (under the instance root) recording the running instance's PID. */
export const PID_FILE = "instance.pid";
/** Host-home-relative directory holding disposable/preserved e2e instance roots. */
export const E2E_RUNS_DIR_NAME = ".rusa-e2e";

/**
 * A provisioned, self-contained e2e instance. Everything mutable lives under
 * `root`, so teardown is `rm -rf root`.
 */
export interface E2EInstance {
  /** The disposable root holding all instance state. */
  root: string;
  /** RUSA_HOME — DB, workspaces, worktrees, invocation artifacts. */
  home: string;
  /** The local bare repo standing in for the remote ("origin"). */
  remotePath: string;
  /** The scratch working clone the agents act on (target.localPath). */
  scratchPath: string;
  /** The generated config written to `home/config.yaml`. */
  config: RusaConfig;
  /** The E2E repository name. */
  repo: string;
}

/**
 * Build the config for an e2e instance. Pure (no filesystem side effects) so it
 * can be unit-tested. Providers and the Gemini API key are seeded from a base
 * config when available (so real coding-CLI calls work), falling back to a
 * minimal-but-valid shape otherwise.
 */
export function buildE2EConfig(opts: {
  scratchPath: string;
  baseConfig?: RusaConfig | null;
  /** Actor-mesh root config (provider/charter). */
  rootActor?: RusaConfig["rootActor"];
  /** Chat config; set (with fakes injected at runtime) to exercise the chat edge. */
  chat?: RusaConfig["chat"];
}): RusaConfig {
  const base = opts.baseConfig ?? null;
  return {
    ...(opts.rootActor ? { rootActor: opts.rootActor } : {}),
    ...(opts.chat ? { chat: opts.chat } : {}),
    github: {
      account: E2E_BOT,
      // No real polling surface; keep the fallback interval long.
      pollIntervalSeconds: 3600,
    },
    providers: {
      ...(base?.providers ?? { antigravity: { cliCommand: "agy" } }),
      fake: { cliCommand: "fake" },
    },
    geminiApiKey: base?.geminiApiKey ?? "MISSING",
    // Required by the schema; the e2e instance never starts a webhook server.
    webhook: { port: 0, secret: "" },
    dashboard: { port: E2E_DASHBOARD_PORT },
    understanding: { rootNodeId: E2E_IU_ROOT_NODE_ID },
    // Capture full prompts/transcripts so an agent can inspect what happened.
    invocationDebug: { enabled: true },
  };
}

/**
 * Create a disposable e2e instance on disk: a bare "remote", a seeded scratch
 * repo, redirected env so all state roots under `root`, and a written config.
 *
 * Note on env redirection: we redirect RUSA_HOME / GIT_CONFIG_GLOBAL /
 * XDG_* / TMPDIR into `root`, but deliberately NOT HOME. The sandbox derives
 * the coding-CLI credential mounts from process.env.HOME, so redirecting it
 * would strip the agents' auth. Cleanup still holds because bwrap confines an
 * agent's writes to its worktree, which lives under RUSA_HOME=root.
 */
export function provisionE2EInstance(opts: {
  root?: string;
  baseConfigHome?: string;
  rootActor?: RusaConfig["rootActor"];
  chat?: RusaConfig["chat"];
}): E2EInstance {
  const root = opts.root ?? mkdtempSync(join(tmpdir(), "rusa-e2e-"));
  const home = join(root, "home");
  const remotePath = join(root, "remote", "repo.git");
  const scratchPath = join(root, "scratch");
  const gitConfigGlobal = join(root, "gitconfig");
  const xdg = join(root, "xdg");
  const tmp = join(root, "tmp");

  for (const dir of [home, join(root, "remote"), xdg, tmp]) {
    mkdirSync(dir, { recursive: true });
  }

  // Root all rusa/git/cache state under `root` (but keep HOME real).
  process.env.RUSA_HOME = home;
  process.env.GIT_CONFIG_GLOBAL = gitConfigGlobal;
  process.env.XDG_CONFIG_HOME = join(xdg, "config");
  process.env.XDG_CACHE_HOME = join(xdg, "cache");
  process.env.TMPDIR = tmp;

  // Minimal, hermetic git identity so local commits succeed.
  writeFileSync(
    gitConfigGlobal,
    "[user]\n\tname = Rusa E2E\n\temail = e2e@rusa.local\n[init]\n\tdefaultBranch = main\n",
    "utf8"
  );

  // The "remote" — a local bare repo. A PR becomes a real branch here.
  execFileSync("git", ["init", "--bare", "-b", "main", remotePath]);

  // The scratch working repo: an initial commit pushed to the bare remote.
  mkdirSync(scratchPath, { recursive: true });
  execFileSync("git", ["init", "-b", "main", scratchPath]);
  writeFileSync(
    join(scratchPath, "README.md"),
    "# E2E scratch repo\n\nThrowaway repo for a self-contained rusa run.\n",
    "utf8"
  );
  writeFileSync(
    join(scratchPath, "package.json"),
    `${JSON.stringify({ name: "e2e-scratch", version: "0.0.0", private: true }, null, 2)}\n`,
    "utf8"
  );
  execFileSync("git", ["-C", scratchPath, "add", "."]);
  execFileSync("git", ["-C", scratchPath, "commit", "-m", "Initial scratch commit"]);
  execFileSync("git", ["-C", scratchPath, "remote", "add", "origin", remotePath]);
  execFileSync("git", ["-C", scratchPath, "push", "-u", "origin", "main"]);

  // Seed providers + Gemini key from a base config when present.
  let baseConfig: RusaConfig | null = null;
  try {
    baseConfig = loadConfig(opts.baseConfigHome ?? join(homedir(), ".rusa"));
  } catch {
    baseConfig = null;
  }

  const config = buildE2EConfig({
    scratchPath,
    baseConfig,
    rootActor: opts.rootActor,
    chat: opts.chat,
  });
  writeFileSync(join(home, "config.yaml"), toYaml(config), "utf8");

  return { root, home, remotePath, scratchPath, config, repo: E2E_REPO };
}

/**
 * Paths a resumable e2e root must have, relative to `root`, missing from it.
 * Shared by `resumeE2EInstance` and the e2e-instance helper's own resume
 * validation so the two structural checks cannot drift apart.
 */
export function missingResumeRequirements(root: string): string[] {
  const home = join(root, "home");
  const remotePath = join(root, "remote", "repo.git");
  const scratchPath = join(root, "scratch");
  const gitConfigGlobal = join(root, "gitconfig");
  const required = [
    join(home, "config.yaml"),
    join(home, "data", "mesh.db"),
    join(remotePath, "HEAD"),
    join(scratchPath, ".git"),
    gitConfigGlobal,
  ];
  return required.filter((path) => !existsSync(path));
}

/** Reopen a previously provisioned E2E root without rewriting any durable state. */
export function resumeE2EInstance(root: string): E2EInstance {
  const home = join(root, "home");
  const remotePath = join(root, "remote", "repo.git");
  const scratchPath = join(root, "scratch");
  const gitConfigGlobal = join(root, "gitconfig");
  const xdg = join(root, "xdg");
  const tmp = join(root, "tmp");
  const missing = missingResumeRequirements(root);
  if (missing.length > 0) {
    throw new Error(`cannot resume E2E instance; missing: ${missing.join(", ")}`);
  }

  const pidFile = join(root, PID_FILE);
  if (existsSync(pidFile)) {
    const pid = Number.parseInt(readFileSync(pidFile, "utf8").trim(), 10);
    if (Number.isInteger(pid) && isAlive(pid)) {
      throw new Error(`E2E instance is already running (pid ${pid})`);
    }
  }

  mkdirSync(xdg, { recursive: true });
  mkdirSync(tmp, { recursive: true });
  process.env.RUSA_HOME = home;
  process.env.GIT_CONFIG_GLOBAL = gitConfigGlobal;
  process.env.XDG_CONFIG_HOME = join(xdg, "config");
  process.env.XDG_CACHE_HOME = join(xdg, "cache");
  process.env.TMPDIR = tmp;

  return {
    root,
    home,
    remotePath,
    scratchPath,
    config: loadConfig(home),
    repo: E2E_REPO,
  };
}

/** Whether a process with the given pid is currently alive. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * `e2e down/am-down --root <path>` — stop a running instance (via its pidfile).
 * State is removed by default or retained for `--resume` when `preserve` is set.
 * This does not depend on signals reaching the instance through wrapper processes.
 */
export async function runE2EDown(opts: { root: string; preserve?: boolean }): Promise<void> {
  const pidFile = join(opts.root, PID_FILE);
  if (existsSync(pidFile)) {
    const pid = Number.parseInt(readFileSync(pidFile, "utf8").trim(), 10);
    if (Number.isFinite(pid) && isAlive(pid)) {
      console.log(`Stopping e2e instance (pid ${pid})...`);
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // Already gone.
      }
      // Give it a few seconds to close servers/DB before we remove the root.
      for (let i = 0; i < 50 && isAlive(pid); i++) {
        await new Promise<void>((resolve) => setTimeout(resolve, 100));
      }
      if (isAlive(pid)) {
        throw new Error(`e2e instance did not stop within 5 seconds (pid ${pid})`);
      }
    }
  }
  if (opts.preserve) {
    rmSync(pidFile, { force: true });
    console.log(`✓ Stopped e2e instance; preserved ${opts.root}`);
    return;
  }
  rmSync(opts.root, { recursive: true, force: true });
  console.log(`✓ Removed ${opts.root}`);
}
