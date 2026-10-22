import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { stringify as toYaml } from "yaml";
import { closeDb } from "../db/index.js";
import { FollowerHub } from "../remote-instances/follower-hub.js";
import type { FollowerInstance } from "../remote-instances/follower-instance.js";
import { FollowerUpdateTriggerStore } from "../remote-instances/follower-update-trigger-store.js";
import type { FollowerBuildSeam, FollowerGitSeam } from "../remote-instances/follower-updater.js";
import { waitUntil } from "../remote-instances/harness.js";
import type { FollowerUpdateStatus, ProviderFactory } from "../remote-instances/protocol.js";
import { StepError } from "../update/orchestrator.js";
import { runStart } from "./start.js";
import type { StartFollowerRelease } from "./start-follower.js";

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
const cleanups: Array<() => Promise<void> | void> = [];
let originalExit: typeof process.exit;

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
  closeDb();
  if (originalHome !== undefined) process.env.RUSA_HOME = originalHome;
  else delete process.env.RUSA_HOME;
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

it("admits no new actor while draining and restarts within the drain bound", async () => {
  const home = tempDir("rusa-start-follower-update-drain-");
  const leader = await startLeader(home);
  const drainStartedAt: number[] = [];
  leader.hub.onUpdateStatus((_id, status) => {
    if (status.status === "draining") drainStartedAt.push(Date.now());
  });
  // Hosted actors stay in place between runs, so the drain runs to its bound.
  const providerFactory: ProviderFactory = (_bridge, _options, selected) => ({
    name: "idle-provider",
    providerName: "idle-provider",
    model: selected?.model,
    run: async () => ({ success: true, output: "", exitCode: 0, model: selected?.model }),
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
  const init = (id: string) => ({
    actorId: id,
    message: {
      type: "init" as const,
      bootstrap: { id, cwd: home, modelConfig: [{ provider: "codex", model: "gpt-5.6-sol" }] },
    },
  });
  instance.dispatch(init("actor-hosted"));
  expect(instance.actorIds).toEqual(["actor-hosted"]);

  leader.hub.updateFollower(FOLLOWER_ID, { targetSha: NEW_SHA, branch: "staging" });
  await waitUntil(() => drainStartedAt.length > 0);
  instance.dispatch(init("actor-late"));
  expect(instance.actorIds).toEqual(["actor-hosted"]);
  expect(process.exit).not.toHaveBeenCalled();

  await waitUntil(() => vi.mocked(process.exit).mock.calls.length > 0);
  // The status is observed after a flush, so the measured wait can only be shorter.
  expect(Date.now() - drainStartedAt[0]).toBeGreaterThanOrEqual(300);
  expect(statusNames(leader.statuses).slice(-2)).toEqual(["draining", "restarting"]);
}, 20_000);
