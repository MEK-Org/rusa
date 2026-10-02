import { describe, expect, it, vi } from "vitest";
import {
  type BuildSeam,
  type CoordinatorOwnership,
  type CoordinatorRestartSeam,
  type CoordinatorTarget,
  type DrainSeam,
  executeUpdate,
  type GitSeam,
  type NotifySeam,
  StepError,
  type UpdateDeps,
  type UpdatePlan,
} from "./orchestrator.js";

const OLD = "0000000000000000000000000000000000000000";
const NEW = "1111111111111111111111111111111111111111";
/** A sentinel that is neither checkout HEAD (OLD) nor the build (NEW). */
const RETAINED = "2222222222222222222222222222222222222222";

const TARGET: CoordinatorTarget = {
  unit: "rusa-quota-coordinator.service",
  home: "/synthetic/coordinator-home",
  socketPath: "/synthetic/coordinator.sock",
};

/**
 * A coordinator seam that records its calls; `fail` names the call that throws.
 * Its artifact is the fake build's live dist sentinel unless overridden.
 */
function fakeCoordinator(
  over: {
    resolved?: CoordinatorOwnership;
    fail?: "backup" | `restart:${string}`;
    order?: string[];
    /** The live dist sentinel before and after the build-seam rollback swaps dists. */
    artifact?: () => string | null;
    /** What the running coordinator reports loaded, per read. */
    loaded?: string | null | (() => string | null);
    /** What the coordinator this instance dials reports (not-owner/unknown report). */
    dialed?: string | null;
  } = {},
  dist: { live: string | null } = { live: OLD }
) {
  const calls: string[] = over.order ?? [];
  const seam: CoordinatorRestartSeam = {
    async resolve() {
      calls.push("resolve");
      return over.resolved ?? { ownership: "owner", target: TARGET };
    },
    artifactRevision() {
      return over.artifact ? over.artifact() : dist.live;
    },
    async loadedRevision() {
      calls.push("loaded");
      if (typeof over.loaded === "function") return over.loaded();
      return over.loaded === undefined ? OLD : over.loaded;
    },
    async dialedRevision() {
      calls.push("dialed");
      return over.dialed === undefined ? OLD : over.dialed;
    },
    async backup(target) {
      calls.push(`backup:${target.home}`);
      if (over.fail === "backup") throw new Error("quota backup failed");
    },
    async restart(target, revision) {
      calls.push(`restart:${target.socketPath}:${revision}`);
      if (over.fail === `restart:${revision}`) {
        throw new Error(`readyz did not report ${revision.slice(0, 7)}`);
      }
    },
  };
  return { seam, calls };
}

class FakeGit implements GitSeam {
  head = OLD;
  remote = NEW;
  subjectText = "feat: new thing";
  fetchedBranches: string[] = [];
  remoteShaBranches: string[] = [];
  resets: string[] = [];
  submoduleUpdates = 0;
  failFetch?: Error;
  /** When set, resetHard(ref) throws for this ref (simulates a failed rollback). */
  failResetTo?: string;
  async headSha() {
    return this.head;
  }
  async subject() {
    return this.subjectText;
  }
  async fetch(branch: string) {
    this.fetchedBranches.push(branch);
    if (this.failFetch) throw this.failFetch;
  }
  async remoteSha(branch: string) {
    this.remoteShaBranches.push(branch);
    return this.remote;
  }
  async resetHard(ref: string) {
    this.resets.push(ref);
    if (this.failResetTo === ref) throw new Error(`git reset --hard ${ref} failed`);
    this.head = ref;
  }
  async updateSubmodules() {
    this.submoduleUpdates++;
  }
}

class FakeDrain implements DrainSeam {
  engaged = false;
  engageReason = "";
  cancelled = false;
  quiesced = true;
  waitedMs = 3;
  engage(reason: string) {
    this.engaged = true;
    this.engageReason = reason;
  }
  cancel() {
    this.cancelled = true;
  }
  async waitForQuiescence() {
    return { quiesced: this.quiesced, waitedMs: this.waitedMs };
  }
}

function makeDeps(over: Partial<UpdateDeps> = {}) {
  const git = new FakeGit();
  const drain = new FakeDrain();
  // `live`/`retained` model the dist sentinels the production swap moves.
  const build: BuildSeam & {
    builtSha?: string;
    fail?: Error;
    rollbackCalls: number;
    live: string | null;
    retained: string | null;
  } = {
    fail: undefined,
    builtSha: undefined,
    rollbackCalls: 0,
    live: OLD,
    retained: null,
    async build(sha: string) {
      if (this.fail) throw this.fail;
      this.builtSha = sha;
      this.retained = this.live;
      this.live = sha;
    },
    async rollback() {
      this.rollbackCalls++;
      this.live = this.retained;
    },
  };
  const exits: number[] = [];
  const notify: NotifySeam & { messages: string[]; fail?: Error } = {
    messages: [],
    async notify(text: string) {
      if (this.fail) throw this.fail;
      this.messages.push(text);
    },
  };
  const markers: string[] = [];
  const actions: string[] = [];
  const deps: UpdateDeps = {
    git,
    build,
    drain,
    notify,
    alertMarker: (text) => markers.push(text),
    recordAction: (text) => actions.push(text),
    exit: (c) => exits.push(c),
    ...over,
  };
  return { deps, git, drain, build, notify, exits, markers, actions };
}

const plan = (over: Partial<UpdatePlan> = {}): UpdatePlan => ({
  branch: "master",
  drainTimeoutMs: 1000,
  ...over,
});

describe("executeUpdate — happy path (green build → drain → exit)", () => {
  it("pulls, builds the new sha, engages drain, then exit(0)", async () => {
    const { deps, git, drain, build, exits, notify, actions } = makeDeps();
    const res = await executeUpdate(plan(), deps);

    expect(res.ok).toBe(true);
    expect(res.restarting).toBe(true);
    expect(git.resets).toEqual([NEW]); // pulled to new
    expect(git.submoduleUpdates).toBe(1); // submodule path-deps materialized for the build
    expect(build.builtSha).toBe(NEW); // built BEFORE touching run-state
    expect(drain.engaged).toBe(true);
    expect(exits).toEqual([0]); // systemd will restart onto the fresh build
    expect(actions).toEqual([
      "update authorized/attempted by root (trigger: MCP tool, target SHA: 1111111111111111111111111111111111111111)",
      "update committed: 0000000 → 1111111 (feat: new thing) [drain: quiesced] — restarting",
    ]);
    expect(notify.messages).toEqual([
      "🚀 update authorized/attempted by root (trigger: MCP tool, target SHA: 1111111111111111111111111111111111111111)",
      "🔄 Updating → 1111111 (feat: new thing) — draining + restarting",
    ]);
  });

  it("does not block the deploy if the updating ping fails", async () => {
    const { deps, notify, exits } = makeDeps();
    notify.fail = new Error("chat 500");
    const res = await executeUpdate(plan(), deps);
    expect(res.ok).toBe(true);
    expect(res.restarting).toBe(true);
    expect(exits).toEqual([0]);
  });

  it("materializes submodules AFTER resetHard and BEFORE the build (deploy path-deps)", async () => {
    const { deps, git, build } = makeDeps();
    const order: string[] = [];
    const origReset = git.resetHard.bind(git);
    git.resetHard = async (ref) => {
      order.push("reset");
      await origReset(ref);
    };
    git.updateSubmodules = async () => void order.push("submodules");
    build.build = async () => void order.push("build");
    await executeUpdate(plan(), deps);
    expect(order).toEqual(["reset", "submodules", "build"]);
  });

  it("uses the configured deploy branch for fetch and remote sha lookup", async () => {
    const { deps, git } = makeDeps();
    await executeUpdate(plan({ branch: "staging" }), deps);
    expect(git.fetchedBranches).toEqual(["staging"]);
    expect(git.remoteShaBranches).toEqual(["staging"]);
  });

  it("REFUSES (fail-loud no-op) if already at origin tip, leaving mesh completely untouched ", async () => {
    const { deps, git, build, drain, exits, actions } = makeDeps();
    git.remote = git.head; // tip matches deployed
    const order: string[] = [];
    git.resetHard = async () => void order.push("reset");
    git.updateSubmodules = async () => void order.push("submodules");
    build.build = async () => void order.push("build");

    const res = await executeUpdate(plan(), deps);

    expect(res.ok).toBe(false);
    expect(res.alreadyCurrent).toBe(true);
    expect(res.error).toContain("Refused: already deployed");
    expect(order).toEqual([]); // no reset, no submodules, NO BUILD
    expect(drain.engaged).toBe(false);
    expect(exits).toEqual([]);
    expect(actions).toEqual([
      "update refused: already deployed (origin/master tip 0000000 matches deployed SHA 0000000)",
    ]);
  });

  it("proceeds with update even if recordAction on attempt throws", async () => {
    const { deps, exits } = makeDeps();
    deps.recordAction = () => {
      throw new Error("ENOSPC / unwritable audit log");
    };
    const res = await executeUpdate(plan(), deps);
    expect(res.ok).toBe(true);
    expect(res.restarting).toBe(true);
    expect(exits).toEqual([0]);
  });

  it("REFUSES concurrent calls via concurrency guard ", async () => {
    const { deps, git, actions } = makeDeps();
    let releaseFetch: () => void = () => {};
    git.fetch = () =>
      new Promise((resolve) => {
        releaseFetch = resolve;
      });
    const p1 = executeUpdate(plan(), deps);

    const res2 = await executeUpdate(plan(), deps);
    expect(res2.ok).toBe(false);
    expect(res2.error?.includes("update already in progress")).toBe(true);
    expect(actions).toEqual(["update refused: already in progress (current SHA: 0000000)"]);

    releaseFetch?.();
    await p1;
  });

  it("builds BEFORE engaging the drain (mesh stays live through the build)", async () => {
    const { deps, drain, build } = makeDeps();
    const order: string[] = [];
    build.build = async () => void order.push("build");
    const origEngage = drain.engage.bind(drain);
    drain.engage = (r) => {
      order.push("engage");
      origEngage(r);
    };
    await executeUpdate(plan(), deps);
    expect(order).toEqual(["build", "engage"]);
  });

  it("backs up, restarts, and confirms the owned coordinator before draining", async () => {
    const { deps, build, drain, exits } = makeDeps();
    const order: string[] = [];
    const swap = build.build.bind(build);
    build.build = async (sha) => {
      order.push("build");
      await swap(sha);
    };
    deps.coordinator = fakeCoordinator({ order }, build).seam;
    const engage = drain.engage.bind(drain);
    drain.engage = (reason) => {
      order.push("drain");
      engage(reason);
    };

    const res = await executeUpdate(plan(), deps);

    expect(res.coordinator).toEqual({
      outcome: "refreshed",
      previousLoadedRevision: OLD,
      loadedRevision: NEW,
    });
    // Ownership and rollback assurance come before the build can retire the
    // loaded artifact; the loaded revision is re-read just before the restart.
    expect(order).toEqual([
      "resolve",
      "loaded",
      "build",
      "loaded",
      `backup:${TARGET.home}`,
      `restart:${TARGET.socketPath}:${NEW}`,
      "drain",
    ]);
    expect(exits).toEqual([0]);
  });

  it.each([
    ["not-owner", "no unit is installed", "not refreshed, not owned"],
    ["unknown", "daemon-reload pending", "not refreshed, ownership unknown"],
  ] as const)("a %s coordinator is left alone and reported, and the update proceeds", async (ownership, reason, logged) => {
    const { deps, exits, actions } = makeDeps();
    const logs: string[] = [];
    deps.log = (m) => void logs.push(m);
    const coordinator = fakeCoordinator({ resolved: { ownership, reason } });
    deps.coordinator = coordinator.seam;

    const res = await executeUpdate(plan(), deps);

    expect(res.ok).toBe(true);
    expect(res.coordinator).toEqual({ outcome: ownership, reason, loadedRevision: OLD });
    expect(coordinator.calls).toEqual(["resolve", "dialed"]);
    expect(actions.at(-1)).toContain(`[coordinator: ${logged}: ${reason}; loaded 0000000]`);
    expect(
      logs.some((l) => l.includes("drift from this build 1111111; not a rollback trigger"))
    ).toBe(true);
    expect(exits).toEqual([0]);
  });

  it("a dialed coordinator that cannot say is reported as unknown, not as drift", async () => {
    const { deps, actions } = makeDeps();
    const logs: string[] = [];
    deps.log = (m) => void logs.push(m);
    const coordinator = fakeCoordinator({
      resolved: { ownership: "not-owner", reason: "no unit is installed" },
      dialed: null,
    });
    deps.coordinator = coordinator.seam;

    const res = await executeUpdate(plan(), deps);

    expect(res.ok).toBe(true);
    expect(res.coordinator).toMatchObject({ outcome: "not-owner", loadedRevision: null });
    expect(actions.at(-1)).toContain("loaded revision unknown]");
    expect(logs.some((l) => l.includes("drift"))).toBe(false);
  });

  it("still exits even if the drain times out (don't wedge on a stuck actor)", async () => {
    const { deps, drain, exits, actions } = makeDeps();
    drain.quiesced = false; // bounded wait expired
    drain.waitedMs = 1234;
    const res = await executeUpdate(plan(), deps);
    expect(res.restarting).toBe(true);
    expect(exits).toEqual([0]);
    expect(actions).toEqual([
      "update authorized/attempted by root (trigger: MCP tool, target SHA: 1111111111111111111111111111111111111111)",
      "update committed: 0000000 → 1111111 (feat: new thing) [drain: timeout after 1234ms] — restarting",
    ]);
  });
});

describe("executeUpdate — the GATE (mesh untouched on a bad build)", () => {
  it("a RED build aborts: rolls back, NEVER drains, NEVER exits, reports ❌", async () => {
    const { deps, git, drain, exits, notify, actions } = makeDeps();
    deps.build = {
      async build() {
        throw new StepError("build", "tsc: type error", false);
      },
    };
    const res = await executeUpdate(plan(), deps);

    expect(res.ok).toBe(false);
    expect(res.failedStep).toBe("build");
    expect(res.timedOut).toBe(false);
    expect(drain.engaged).toBe(false); // run-state untouched
    expect(exits).toEqual([]); // NEVER restart onto a broken build
    expect(git.resets).toEqual([NEW, OLD]); // rolled back to old code
    expect(actions).toEqual([
      "update authorized/attempted by root (trigger: MCP tool, target SHA: 1111111111111111111111111111111111111111)",
      "update failed at build: tsc: type error [rolled back, staying on 0000000]",
    ]);
    expect(notify.messages).toEqual([
      "🚀 update authorized/attempted by root (trigger: MCP tool, target SHA: 1111111111111111111111111111111111111111)",
      "❌ update failed at build: tsc: type error [rolled back, staying on 0000000]",
    ]);
  });

  it("a FAILED rollback fires the LOUD chat-independent alert (last silent-failure path)", async () => {
    const { deps, git, markers, notify, actions } = makeDeps();
    deps.build = {
      async build() {
        throw new StepError("build", "tsc broke", false);
      },
    };
    git.failResetTo = OLD; // the rollback (reset --hard old) ALSO fails
    const errs: string[] = [];
    const errSpy = vi.spyOn(console, "error").mockImplementation((...a) => {
      errs.push(a.join(" "));
    });
    const res = await executeUpdate(plan(), deps);
    errSpy.mockRestore();

    expect(res.ok).toBe(false);
    expect(res.rollbackFailed).toBe(true); // surfaced in the result
    expect(git.resets).toEqual([NEW, OLD]); // tried to roll back; it threw
    expect(actions).toEqual([
      "update authorized/attempted by root (trigger: MCP tool, target SHA: 1111111111111111111111111111111111111111)",
      "update failed at build: tsc broke [rollback FAILED, checkout state UNKNOWN/UNSAFE (update target 1111111; attempted rollback to 0000000)]",
    ]);
    expect(actions[1]).not.toContain("staying on 0000000");
    expect(actions[1]).not.toContain("at 1111111");
    // LOUD: journal ERROR (console.error) + durable marker + best-effort chat — all fired.
    expect(errs.some((e) => e.includes("rollback FAILED"))).toBe(true);
    expect(markers.some((m) => m.includes("restart-fragile"))).toBe(true);
    expect(notify.messages.some((m) => m.includes("rollback FAILED"))).toBe(true);
    expect(
      notify.messages.some((m) =>
        m.includes(
          "❌ update failed at build: tsc broke [rollback FAILED, checkout state UNKNOWN/UNSAFE (update target 1111111; attempted rollback to 0000000)]"
        )
      )
    ).toBe(true);
  });

  it("a HUNG build (timeout) aborts the same way, flagged timedOut (elder #2)", async () => {
    const { deps, drain, exits, actions, notify } = makeDeps();
    deps.build = {
      async build() {
        throw new StepError("install", "install timed out after 600000ms", true);
      },
    };
    const res = await executeUpdate(plan(), deps);
    expect(res.ok).toBe(false);
    expect(res.failedStep).toBe("install");
    expect(res.timedOut).toBe(true);
    expect(drain.engaged).toBe(false);
    expect(exits).toEqual([]); // a hung build never wedges into a restart
    expect(actions).toEqual([
      "update authorized/attempted by root (trigger: MCP tool, target SHA: 1111111111111111111111111111111111111111)",
      "update failed at install (timeout): install timed out after 600000ms [rolled back, staying on 0000000]",
    ]);
    expect(notify.messages).toEqual([
      "🚀 update authorized/attempted by root (trigger: MCP tool, target SHA: 1111111111111111111111111111111111111111)",
      "❌ update failed at install (timeout): install timed out after 600000ms [rolled back, staying on 0000000]",
    ]);
  });

  it("never backs up or restarts the coordinator when the build is red", async () => {
    const { deps } = makeDeps();
    deps.build = {
      async build() {
        throw new StepError("build", "tsc: type error", false);
      },
    };
    const coordinator = fakeCoordinator();
    deps.coordinator = coordinator.seam;

    const res = await executeUpdate(plan(), deps);

    expect(res.failedStep).toBe("build");
    expect(coordinator.calls).toEqual(["resolve", "loaded"]); // the preflight only
  });

  it.each([
    [
      "the live dist is not the loaded artifact",
      { live: RETAINED, loaded: OLD },
      "the live dist is not the artifact the coordinator has loaded",
    ],
    [
      "the coordinator cannot say what it loaded",
      { live: OLD, loaded: null },
      "the running coordinator does not report its loaded revision",
    ],
    [
      "the live dist has no identity",
      { live: null, loaded: OLD },
      "the live dist records no valid revision",
    ],
  ] as const)("stops before moving, building, or restarting when %s", async (_label, state, reason) => {
    const { deps, git, build, drain, exits, actions } = makeDeps();
    build.live = state.live;
    const coordinator = fakeCoordinator({ loaded: state.loaded }, build);
    deps.coordinator = coordinator.seam;

    const res = await executeUpdate(plan(), deps);

    expect(res.ok).toBe(false);
    expect(res.failedStep).toBe("coordinator");
    expect(res.error).toBe(`rollback protection unavailable: ${reason}`);
    expect(res.rollbackFailed).toBe(false);
    expect(res.coordinator).toEqual({
      outcome: "rollback-unavailable",
      reason,
      loadedRevision: state.loaded,
      artifactRevision: state.live,
    });
    expect(coordinator.calls).toEqual(["resolve", "loaded"]); // zero backups, zero restarts
    expect(git.resets).toEqual([]);
    expect(build.builtSha).toBeUndefined();
    expect(build.live).toBe(state.live); // the loaded artifact's dist is untouched
    expect(build.rollbackCalls).toBe(0);
    expect(drain.engaged).toBe(false);
    expect(exits).toEqual([]);
    expect(actions.at(-1)).toContain("no rollback needed");
    expect(actions.at(-1)).toContain(
      "[coordinator: not refreshed, rollback protection unavailable"
    );
  });

  it.each([
    ["an artifact/build mismatch", { artifact: (): string | null => OLD }, ["resolve", "loaded"]],
    [
      "a coordinator that changed what it loaded during the build",
      {
        loaded: (() => {
          let reads = 0;
          return () => (reads++ ? RETAINED : OLD);
        })(),
      },
      ["resolve", "loaded", "loaded"],
    ],
    [
      "a backup failure",
      { fail: "backup" },
      ["resolve", "loaded", "loaded", `backup:${TARGET.home}`],
    ],
  ] as const)("%s refuses the restart and rolls back cleanly", async (_label, over, calls) => {
    const { deps, git, build, drain, exits } = makeDeps();
    const coordinator = fakeCoordinator(over, build);
    deps.coordinator = coordinator.seam;

    const res = await executeUpdate(plan(), deps);

    expect(res.ok).toBe(false);
    expect(res.failedStep).toBe("coordinator");
    expect(res.rollbackFailed).toBe(false);
    expect(coordinator.calls).toEqual(calls); // the running coordinator is never restarted
    expect(build.rollbackCalls).toBe(1);
    expect(git.resets).toEqual([NEW, OLD]);
    expect(drain.engaged).toBe(false);
    expect(exits).toEqual([]);
  });

  it("restores dist, checkout, and coordinator when readiness never confirms the new revision", async () => {
    const { deps, git, build, drain, exits } = makeDeps();
    const coordinator = fakeCoordinator({ fail: `restart:${NEW}` }, build);
    deps.coordinator = coordinator.seam;

    const res = await executeUpdate(plan(), deps);

    expect(res.ok).toBe(false);
    expect(res.failedStep).toBe("coordinator");
    expect(res.rollbackFailed).toBe(false);
    expect(build.rollbackCalls).toBe(1);
    expect(git.resets).toEqual([NEW, OLD]);
    expect(coordinator.calls.filter((c) => c.startsWith("restart"))).toEqual([
      `restart:${TARGET.socketPath}:${NEW}`,
      `restart:${TARGET.socketPath}:${OLD}`,
    ]);
    expect(res.coordinator).toEqual({
      outcome: "restored",
      previousLoadedRevision: OLD,
      loadedRevision: OLD,
    });
    expect(drain.engaged).toBe(false);
    expect(exits).toEqual([]);
  });

  it("reports a recovery onto a retained artifact other than the loaded one as degraded and unsafe", async () => {
    const { deps, build, markers } = makeDeps();
    // Passes the preflight, then the retained dist changes before the rollback.
    const coordinator = fakeCoordinator(
      { fail: `restart:${NEW}`, artifact: () => (build.rollbackCalls ? RETAINED : build.live) },
      build
    );
    deps.coordinator = coordinator.seam;
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await executeUpdate(plan(), deps);
    errorSpy.mockRestore();

    expect(res.rollbackFailed).toBe(true);
    expect(res.coordinator).toEqual({
      outcome: "degraded",
      previousLoadedRevision: OLD,
      loadedRevision: RETAINED,
    });
    expect(markers.some((message) => message.includes("not the previously loaded 0000000"))).toBe(
      true
    );
  });

  it("returns a confirmed-new coordinator to the old build when the drain then fails", async () => {
    const { deps, git, build, drain, exits } = makeDeps();
    const coordinator = fakeCoordinator({}, build);
    deps.coordinator = coordinator.seam;
    drain.waitForQuiescence = async () => {
      throw new StepError("drain", "drain exploded", false);
    };

    const res = await executeUpdate(plan(), deps);

    expect(res.ok).toBe(false);
    expect(res.failedStep).toBe("drain");
    expect(res.rollbackFailed).toBe(false);
    expect(build.rollbackCalls).toBe(1);
    expect(git.resets).toEqual([NEW, OLD]);
    expect(coordinator.calls.filter((c) => c.startsWith("restart"))).toEqual([
      `restart:${TARGET.socketPath}:${NEW}`,
      `restart:${TARGET.socketPath}:${OLD}`,
    ]);
    expect(exits).toEqual([]);
  });

  it("raises the durable rollback alert when the old coordinator cannot be restored", async () => {
    const { deps, build, markers, git, notify } = makeDeps();
    deps.coordinator = fakeCoordinator({ fail: `restart:${OLD}` }, build).seam;
    deps.drain.waitForQuiescence = async () => {
      throw new StepError("drain", "drain exploded", false);
    };
    const errors: string[] = [];
    const errorSpy = vi.spyOn(console, "error").mockImplementation((...args) => {
      errors.push(args.join(" "));
    });

    const res = await executeUpdate(plan(), deps);
    errorSpy.mockRestore();

    expect(res.rollbackFailed).toBe(true);
    expect(build.rollbackCalls).toBe(1);
    expect(git.resets).toEqual([NEW, OLD]);
    expect(errors.some((message) => message.includes("rollback FAILED"))).toBe(true);
    expect(markers.some((message) => message.includes("restart-fragile"))).toBe(true);
    expect(notify.messages.some((message) => message.includes("rollback FAILED"))).toBe(true);
  });

  it("a pull failure aborts before build, drain and exit (no rollback — never moved)", async () => {
    const { deps, git, drain, build, exits, actions, notify } = makeDeps();
    git.failFetch = new Error("network down");
    const res = await executeUpdate(plan(), deps);
    expect(res.ok).toBe(false);
    expect(res.failedStep).toBe("pull");
    expect(build.builtSha).toBeUndefined();
    expect(drain.engaged).toBe(false);
    expect(exits).toEqual([]);
    expect(git.resets).toEqual([]); // pull failed before we moved
    expect(actions).toEqual([
      "update failed at pull: network down [no rollback needed, staying on 0000000]",
    ]);
    expect(notify.messages).toEqual([
      "❌ update failed at pull: network down [no rollback needed, staying on 0000000]",
    ]);
  });

  it("a failed notify never sinks the result", async () => {
    const { deps, notify } = makeDeps();
    notify.fail = new Error("chat 500");
    deps.build = {
      async build() {
        throw new StepError("build", "boom", false);
      },
    };
    const res = await executeUpdate(plan(), deps);
    expect(res.ok).toBe(false); // still returns cleanly
  });

  it("does not abort or throw if recordAction on terminal outcome throws", async () => {
    const { deps, exits } = makeDeps();
    let callCount = 0;
    deps.recordAction = (_msg) => {
      callCount++;
      if (callCount > 1) {
        throw new Error("disk error on second recordAction");
      }
    };
    const res = await executeUpdate(plan(), deps);
    expect(res.ok).toBe(true);
    expect(res.restarting).toBe(true);
    expect(exits).toEqual([0]);
  });

  it("invokes onCommitted with newSha and branch once the update is committed", async () => {
    const { deps } = makeDeps();
    const committed: { sha: string; branch: string }[] = [];
    deps.onCommitted = (sha, branch) => {
      committed.push({ sha, branch });
    };
    const res = await executeUpdate(plan({ branch: "staging" }), deps);
    expect(res.ok).toBe(true);
    expect(committed).toEqual([{ sha: "1".repeat(40), branch: "staging" }]);
  });

  it("does not invoke onCommitted when build fails", async () => {
    const { deps } = makeDeps();
    const committed: { sha: string; branch: string }[] = [];
    deps.onCommitted = (sha, branch) => {
      committed.push({ sha, branch });
    };
    deps.build = {
      async build() {
        throw new StepError("build", "compile failed", false);
      },
    };
    const res = await executeUpdate(plan(), deps);
    expect(res.ok).toBe(false);
    expect(committed).toHaveLength(0);
  });

  it("does not invoke onCommitted when a post-build step fails and the checkout rolls back", async () => {
    // The reason the hook moved off build-green: a drain failure resets the checkout to
    // oldSha, so anything persisted at build time would name a revision this leader
    // reverted — and would later deploy followers onto it.
    const { deps, git, drain, build } = makeDeps();
    const committed: { sha: string; branch: string }[] = [];
    deps.onCommitted = (sha, branch) => {
      committed.push({ sha, branch });
    };
    drain.waitForQuiescence = async () => {
      throw new StepError("drain", "drain exploded", false);
    };

    const res = await executeUpdate(plan(), deps);

    expect(res.ok).toBe(false);
    expect(committed).toHaveLength(0);
    expect(git.resets).toEqual([NEW, OLD]); // rolled back off the revision no trigger names
    expect(build.rollbackCalls).toBe(1); // returned to the last bootable dist as well
  });

  it("still restarts when onCommitted throws", async () => {
    // The restart is already irreversible here; a failed follower-trigger write costs one
    // skipped reconciliation, not a failed update.
    const { deps, exits } = makeDeps();
    deps.onCommitted = () => {
      throw new Error("disk full writing follower trigger");
    };
    const res = await executeUpdate(plan(), deps);
    expect(res.ok).toBe(true);
    expect(res.restarting).toBe(true);
    expect(exits).toEqual([0]);
  });
});
