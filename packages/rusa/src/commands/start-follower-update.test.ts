import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { stringify as toYaml } from "yaml";
import { closeDb } from "../db/index.js";
import { nullLogger } from "../observability/logger.js";
import type { RunOptions } from "../providers/types.js";
import { FollowerHub } from "../remote-instances/follower-hub.js";
import type { FollowerInstance } from "../remote-instances/follower-instance.js";
import { FollowerUpdateTriggerStore } from "../remote-instances/follower-update-trigger-store.js";
import type { FollowerBuildSeam, FollowerGitSeam } from "../remote-instances/follower-updater.js";
import { waitUntil } from "../remote-instances/harness.js";
import type {
  ActorEvent,
  FollowerUpdateStatus,
  ProviderFactory,
} from "../remote-instances/protocol.js";
import { writeBuildSentinel } from "../update/build-sentinel.js";
import { StepError } from "../update/orchestrator.js";
import { BuildRunner } from "../update/runner.js";
import { runStart } from "./start.js";
import { resolveStartFollowerRelease, type StartFollowerRelease } from "./start-follower.js";
import {
  START_FOLLOWER_UPDATE_LAUNCHER_ENV,
  START_FOLLOWER_UPDATE_LAUNCHER_VERSION,
} from "./start-follower-launcher-contract.js";

// The bwrap preflight is host-specific; these fixtures never spawn a sandbox.
vi.mock("../providers/sandbox.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../providers/sandbox.js")>();
  return { ...actual, assertBwrapAvailable: () => {} };
});

const OLD_SHA = "1".repeat(40);
const NEW_SHA = "2".repeat(40);
const TOKEN = "t".repeat(40);
const FOLLOWER_ID = "follower-start-update";

const originalHome = process.env.RUSA_HOME;
const originalLauncherContract = process.env[START_FOLLOWER_UPDATE_LAUNCHER_ENV];
const cleanups: Array<() => Promise<void> | void> = [];
let originalExit: typeof process.exit;
const originalArgv1 = process.argv[1];

beforeEach(() => {
  originalExit = process.exit;
  process.exit = vi.fn() as unknown as typeof process.exit;
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    try {
      await cleanup();
    } catch {}
  }
  process.exit = originalExit;
  process.argv[1] = originalArgv1;
  closeDb();
  if (originalHome !== undefined) process.env.RUSA_HOME = originalHome;
  else delete process.env.RUSA_HOME;
  if (originalLauncherContract !== undefined) {
    process.env[START_FOLLOWER_UPDATE_LAUNCHER_ENV] = originalLauncherContract;
  } else {
    delete process.env[START_FOLLOWER_UPDATE_LAUNCHER_ENV];
  }
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A disposable checkout: records every step instead of touching git. */
function syntheticGit(head: string, remote: string) {
  const calls: string[] = [];
  let sha = head;
  const git: FollowerGitSeam = {
    headSha: async () => sha,
    subject: async () => "synthetic subject",
    fetch: async (branch) => {
      calls.push(`fetch ${branch}`);
    },
    remoteSha: async () => remote,
    isAncestor: async (ancestor, descendant) => {
      calls.push(`isAncestor ${ancestor.slice(0, 7)} ${descendant}`);
      return ancestor === remote || ancestor === head;
    },
    resetHard: async (ref) => {
      calls.push(`reset ${ref.slice(0, 7)}`);
      sha = ref;
    },
    updateSubmodules: async () => {
      calls.push("submodules");
    },
  };
  return { git, calls };
}

function syntheticBuild(fail?: StepError) {
  const calls: string[] = [];
  const build: FollowerBuildSeam = {
    build: async (sha) => {
      calls.push(`build ${sha.slice(0, 7)}`);
      if (fail) throw fail;
    },
    rollback: () => {
      calls.push("rollback");
    },
  };
  return { build, calls };
}

async function startLeader(home: string) {
  const store = new FollowerUpdateTriggerStore(join(home, "leader"));
  const hub = new FollowerHub(TOKEN, { triggerStore: store });
  const url = await hub.listen("127.0.0.1", 0);
  const statuses: FollowerUpdateStatus[] = [];
  hub.onUpdateStatus((_id, status) => statuses.push(structuredClone(status)));
  cleanups.push(() => hub.close());
  return { hub, store, url, statuses };
}

/** Boot one `rusa start` follower process incarnation against `leaderUrl`. */
async function bootFollower(
  home: string,
  leaderUrl: string,
  release: StartFollowerRelease,
  providerFactory?: ProviderFactory
) {
  writeFileSync(
    join(home, "config.yaml"),
    toYaml({
      providers: { codex: { cliCommand: "codex" } },
      peers: [{ type: "leader", url: leaderUrl, token: TOKEN }],
      instance: { id: FOLLOWER_ID },
      observability: { logging: { level: "error" } },
    }),
    "utf8"
  );
  process.env.RUSA_HOME = home;
  let handles: { instance: FollowerInstance; shutdown: () => Promise<void> } | undefined;
  await runStart({
    e2e: {
      connectPeer: true,
      followerPolling: true,
      followerRelease: release,
      followerProviderFactory: providerFactory,
      onFollowerReady: (ready) => {
        handles = ready;
      },
    },
  });
  if (!handles) throw new Error("follower did not boot");
  cleanups.push(handles.shutdown);
  return handles;
}

const statusNames = (statuses: FollowerUpdateStatus[]) => statuses.map((s) => s.status);

it("updates a rusa start follower to the leader's requested release and reconnects running it", async () => {
  const home = tempDir("rusa-start-follower-update-");
  const leader = await startLeader(home);
  const oldGit = syntheticGit(OLD_SHA, NEW_SHA);
  const oldBuild = syntheticBuild();

  await bootFollower(home, leader.url, {
    runningSha: OLD_SHA,
    update: { git: oldGit.git, build: oldBuild.build, drainTimeoutMs: 50 },
  });
  // The follower reports the release it booted, so the leader can see it lags.
  expect(leader.hub.list()).toEqual([
    expect.objectContaining({ id: FOLLOWER_ID, commitSha: OLD_SHA }),
  ]);

  // The leader's own committed deploy persists the trigger; arming dispatches it.
  leader.store.createTrigger({ targetSha: NEW_SHA, branch: "staging" });
  leader.hub.armReconciliation();

  await waitUntil(() => vi.mocked(process.exit).mock.calls.length > 0);
  expect(process.exit).toHaveBeenCalledWith(0);
  expect(oldGit.calls).toEqual([
    "fetch staging",
    `isAncestor ${NEW_SHA.slice(0, 7)} origin/staging`,
    `reset ${NEW_SHA.slice(0, 7)}`,
    "submodules",
  ]);
  expect(oldBuild.calls).toEqual([`build ${NEW_SHA.slice(0, 7)}`]);
  // `restarting` is the last status the old process can report, and it is delivered.
  await waitUntil(() => statusNames(leader.statuses).includes("restarting"));
  expect(statusNames(leader.statuses)).toEqual([
    "pending",
    "fetching",
    "building",
    "draining",
    "restarting",
  ]);
  expect(leader.store.getActiveTrigger()?.attempts[FOLLOWER_ID]?.status).toBe("pending");
  // Orderly shutdown unregistered the old process.
  await waitUntil(() => leader.hub.list().length === 0);

  // The supervisor restarts the process onto the new build.
  vi.mocked(process.exit).mockClear();
  await bootFollower(home, leader.url, {
    runningSha: NEW_SHA,
    update: { git: syntheticGit(NEW_SHA, NEW_SHA).git, build: syntheticBuild().build },
  });

  expect(leader.hub.list()).toEqual([
    expect.objectContaining({ id: FOLLOWER_ID, commitSha: NEW_SHA }),
  ]);
  expect(leader.store.getActiveTrigger()?.attempts[FOLLOWER_ID]).toMatchObject({
    status: "success",
    targetSha: NEW_SHA,
  });
  expect(leader.hub.getReconciliationStatus().allConnectedCurrent).toBe(true);
  expect(process.exit).not.toHaveBeenCalled();
}, 20_000);

it("rebuilds and restarts when only the checkout, not the running release, is at the target", async () => {
  const home = tempDir("rusa-start-follower-update-head-");
  const leader = await startLeader(home);
  // The checkout already reached the target, but this process booted the old dist.
  const git = syntheticGit(NEW_SHA, NEW_SHA);
  const build = syntheticBuild();

  await bootFollower(home, leader.url, {
    runningSha: OLD_SHA,
    update: { git: git.git, build: build.build, drainTimeoutMs: 50 },
  });
  leader.hub.updateFollower(FOLLOWER_ID, { targetSha: NEW_SHA, branch: "staging" });

  await waitUntil(() =>
    statusNames(leader.statuses).some((s) => s === "already_current" || s === "restarting")
  );
  expect(statusNames(leader.statuses)).not.toContain("already_current");
  expect(build.calls).toEqual([`build ${NEW_SHA.slice(0, 7)}`]);
  await waitUntil(() => vi.mocked(process.exit).mock.calls.length > 0);
  expect(process.exit).toHaveBeenCalledWith(0);
  // Success is recorded only once a process registers running the target.
  expect(leader.store.hasSucceeded(FOLLOWER_ID, NEW_SHA)).toBe(false);
}, 20_000);

it("never treats an unproven running release as current", async () => {
  const home = tempDir("rusa-start-follower-update-unproven-");
  const leader = await startLeader(home);
  const build = syntheticBuild();

  await bootFollower(home, leader.url, {
    update: { git: syntheticGit(NEW_SHA, NEW_SHA).git, build: build.build, drainTimeoutMs: 50 },
  });
  leader.hub.updateFollower(FOLLOWER_ID, { targetSha: NEW_SHA, branch: "staging" });

  await waitUntil(() =>
    statusNames(leader.statuses).some((s) => s === "already_current" || s === "restarting")
  );
  expect(statusNames(leader.statuses)).not.toContain("already_current");
  expect(build.calls).toEqual([`build ${NEW_SHA.slice(0, 7)}`]);
}, 20_000);

it("passes a proven start-mode release through to already_current", async () => {
  const home = tempDir("rusa-start-follower-current-");
  const leader = await startLeader(home);
  const git = syntheticGit(OLD_SHA, NEW_SHA);
  const build = syntheticBuild();

  await bootFollower(home, leader.url, {
    runningSha: NEW_SHA,
    update: { git: git.git, build: build.build, drainTimeoutMs: 50 },
  });
  leader.hub.updateFollower(FOLLOWER_ID, { targetSha: NEW_SHA, branch: "staging" });

  await waitUntil(() => statusNames(leader.statuses).includes("already_current"));
  expect(statusNames(leader.statuses)).toEqual(["pending", "fetching", "already_current"]);
  expect(git.calls).toEqual(["fetch staging", `isAncestor ${NEW_SHA.slice(0, 7)} origin/staging`]);
  expect(build.calls).toEqual([]);
  expect(process.exit).not.toHaveBeenCalled();
}, 20_000);

it("reports a failed start-mode build truthfully, restores the checkout and keeps serving", async () => {
  const home = tempDir("rusa-start-follower-update-fail-");
  const leader = await startLeader(home);
  const git = syntheticGit(OLD_SHA, NEW_SHA);
  const build = syntheticBuild(new StepError("build", "synthetic build timed out", true));

  await bootFollower(home, leader.url, {
    runningSha: OLD_SHA,
    update: { git: git.git, build: build.build },
  });
  leader.hub.updateFollower(FOLLOWER_ID, { targetSha: NEW_SHA, branch: "staging" });

  await waitUntil(() => statusNames(leader.statuses).includes("failed"));
  expect(leader.statuses.at(-1)).toMatchObject({
    status: "failed",
    step: "build",
    error: "synthetic build timed out",
  });
  // The checkout returns to the running release; the unpromoted build is not rolled back.
  expect(git.calls.slice(-2)).toEqual([`reset ${OLD_SHA.slice(0, 7)}`, "submodules"]);
  expect(build.calls).toEqual([`build ${NEW_SHA.slice(0, 7)}`]);
  expect(process.exit).not.toHaveBeenCalled();
  expect(leader.hub.list()).toEqual([
    expect.objectContaining({ id: FOLLOWER_ID, commitSha: OLD_SHA }),
  ]);
}, 20_000);

it("holds an in-flight run through the bounded drain and settles it before restart", async () => {
  const home = tempDir("rusa-start-follower-update-drain-");
  const leader = await startLeader(home);
  const drainStartedAt: number[] = [];
  leader.hub.onUpdateStatus((_id, status) => {
    if (status.status === "draining") drainStartedAt.push(Date.now());
  });
  // The run stays open until shutdown aborts it, so the drain runs to its bound.
  let runStarted: () => void = () => {};
  const started = new Promise<void>((resolveStarted) => {
    runStarted = resolveStarted;
  });
  const providerFactory: ProviderFactory = (_bridge, _options, selected) => ({
    name: "held-provider",
    providerName: "held-provider",
    model: selected?.model,
    async run(run: RunOptions) {
      run.onPromptLaunched?.(run.prompt);
      runStarted();
      await new Promise<void>((resolveAbort) => {
        if (!run.signal || run.signal.aborted) resolveAbort();
        else run.signal.addEventListener("abort", () => resolveAbort(), { once: true });
      });
      return {
        success: false,
        output: "Interrupted by restart",
        exitCode: 1,
        model: selected?.model,
      };
    },
  });
  const { instance } = await bootFollower(
    home,
    leader.url,
    {
      runningSha: OLD_SHA,
      update: {
        git: syntheticGit(OLD_SHA, NEW_SHA).git,
        build: syntheticBuild().build,
        drainTimeoutMs: 400,
      },
    },
    providerFactory
  );

  // The leader places the actor and answers its run requests, as a leader actor host does.
  const host = leader.hub.createHost(FOLLOWER_ID, "actor-hosted");
  const reply = (requestId: number, value?: unknown) =>
    host.send({ type: "reply", requestId, value }, () => {});
  let ready = false;
  host.on("message", (message: ActorEvent) => {
    if (message.type === "ready") ready = true;
    if (message.type !== "request") return;
    const { op } = message.request as { op: string };
    if (op === "beforeRun") reply(message.requestId, { allowed: true });
    else if (op === "admit")
      reply(message.requestId, {
        record: {
          id: "actor-hosted",
          charter: "Drain test charter",
          status: "active",
          createdAt: new Date().toISOString(),
        },
        prompt: "Drain test prompt",
        selected: { provider: "codex", model: "gpt-5.6-sol" },
      });
    else reply(message.requestId);
  });
  const bootstrap = (id: string) => ({
    id,
    cwd: home,
    modelConfig: [{ provider: "codex" as const, model: "gpt-5.6-sol" }],
  });
  host.send({ type: "init", bootstrap: bootstrap("actor-hosted") }, () => {});
  await waitUntil(() => ready);
  host.send({ type: "wake" }, () => {});
  await started;

  leader.hub.updateFollower(FOLLOWER_ID, { targetSha: NEW_SHA, branch: "staging" });
  await waitUntil(() => drainStartedAt.length > 0);
  instance.dispatch({
    actorId: "actor-late",
    message: { type: "init", bootstrap: bootstrap("actor-late") },
  });
  expect(instance.actorIds).toEqual(["actor-hosted"]);
  expect(process.exit).not.toHaveBeenCalled();

  await waitUntil(() => vi.mocked(process.exit).mock.calls.length > 0);
  // The status is observed after a flush, so the measured wait can only be shorter.
  expect(Date.now() - drainStartedAt[0]).toBeGreaterThanOrEqual(300);
  expect(statusNames(leader.statuses).slice(-2)).toEqual(["draining", "restarting"]);

  // Shutdown closed the database only after the open run reached a terminal record.
  const db = new Database(join(home, "data", "mesh.db"), { readonly: true });
  try {
    const runs = db
      .prepare("SELECT outcome, success, output FROM actor_runs WHERE actor_id = ?")
      .all("actor-hosted");
    expect(runs).toEqual([expect.objectContaining({ outcome: "completed", success: 0 })]);
    expect(db.prepare("SELECT 1 FROM actor_runs WHERE actor_id = ?").all("actor-late")).toEqual([]);
  } finally {
    db.close();
  }
}, 20_000);

/** A disposable rusa checkout whose built dist is the launched entry point. */
function syntheticCheckout(options: { sentinel?: string; distName?: string } = {}) {
  const root = realpathSync(tempDir("rusa-start-follower-checkout-"));
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
  git("init", "--quiet");
  const packageDir = join(root, "packages", "rusa");
  const distDir = join(packageDir, options.distName ?? "dist");
  mkdirSync(distDir, { recursive: true });
  writeFileSync(join(packageDir, "package.json"), JSON.stringify({ name: "rusa" }), "utf8");
  writeFileSync(join(distDir, "index.js"), "", "utf8");
  git("add", ".");
  git(
    "-c",
    "user.name=fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "--quiet",
    "--no-gpg-sign",
    "-m",
    "fixture"
  );
  if (options.sentinel) writeBuildSentinel(distDir, options.sentinel);
  process.argv[1] = join(distDir, "index.js");
  return { root, packageDir, head: git("rev-parse", "HEAD") };
}

it("resolves a supported launch's running release and update source from its entry point", async () => {
  const checkout = syntheticCheckout({ sentinel: OLD_SHA });
  process.env[START_FOLLOWER_UPDATE_LAUNCHER_ENV] = START_FOLLOWER_UPDATE_LAUNCHER_VERSION;

  const release = resolveStartFollowerRelease(nullLogger);

  expect(release.runningSha).toBe(OLD_SHA);
  if ("unavailable" in release.update) throw new Error(release.update.unavailable);
  // The updater reads the checkout the running dist was built from...
  expect(await release.update.git.headSha()).toBe(checkout.head);
  // ...and rebuilds that package's dist.
  expect(release.update.build).toBeInstanceOf(BuildRunner);
  expect(release.update.build).toMatchObject({ packageDir: checkout.packageDir });
});

it("reports no running release when the launched dist carries no build sentinel", () => {
  syntheticCheckout();
  process.env[START_FOLLOWER_UPDATE_LAUNCHER_ENV] = START_FOLLOWER_UPDATE_LAUNCHER_VERSION;

  const release = resolveStartFollowerRelease(nullLogger);

  expect(release.runningSha).toBeUndefined();
  expect("unavailable" in release.update).toBe(false);
});

it("refuses self-update for a launch outside a built dist, keeping its proven release", () => {
  syntheticCheckout({ sentinel: OLD_SHA, distName: "src" });
  process.env[START_FOLLOWER_UPDATE_LAUNCHER_ENV] = START_FOLLOWER_UPDATE_LAUNCHER_VERSION;

  expect(resolveStartFollowerRelease(nullLogger)).toEqual({
    runningSha: OLD_SHA,
    update: {
      unavailable:
        "Follower self-update is unsupported for this launch: rusa start is not running from a built dist directory",
    },
  });
});

it("refuses absent and unrecognized launcher contracts before update work", () => {
  syntheticCheckout({ sentinel: OLD_SHA });

  const unsupported = {
    runningSha: OLD_SHA,
    update: {
      unavailable: `Follower self-update is unsupported for this launch: supported launcher contract is absent or unrecognized (expected ${START_FOLLOWER_UPDATE_LAUNCHER_ENV}=${START_FOLLOWER_UPDATE_LAUNCHER_VERSION})`,
    },
  };
  expect(resolveStartFollowerRelease(nullLogger)).toEqual(unsupported);

  process.env[START_FOLLOWER_UPDATE_LAUNCHER_ENV] = "v2";
  expect(resolveStartFollowerRelease(nullLogger)).toEqual(unsupported);
});
