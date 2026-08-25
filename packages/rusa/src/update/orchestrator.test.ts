import { describe, expect, it, vi } from "vitest";
import {
  type BuildSeam,
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
  const build: BuildSeam & { builtSha?: string; fail?: Error } = {
    fail: undefined,
    builtSha: undefined,
    async build(sha: string) {
      if (this.fail) throw this.fail;
      this.builtSha = sha;
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
  const deps: UpdateDeps = {
    git,
    build,
    drain,
    notify,
    alertMarker: (text) => markers.push(text),
    exit: (c) => exits.push(c),
    ...over,
  };
  return { deps, git, drain, build, notify, exits, markers };
}

const plan = (over: Partial<UpdatePlan> = {}): UpdatePlan => ({
  branch: "master",
  drainTimeoutMs: 1000,
  ...over,
});

describe("executeUpdate — happy path (green build → drain → exit)", () => {
  it("pulls, builds the new sha, engages drain, then exit(0)", async () => {
    const { deps, git, drain, build, exits, notify } = makeDeps();
    const res = await executeUpdate(plan(), deps);

    expect(res.ok).toBe(true);
    expect(res.restarting).toBe(true);
    expect(git.resets).toEqual([NEW]); // pulled to new
    expect(git.submoduleUpdates).toBe(1); // submodule path-deps materialized for the build
    expect(build.builtSha).toBe(NEW); // built BEFORE touching run-state
    expect(drain.engaged).toBe(true);
    expect(exits).toEqual([0]); // systemd will restart onto the fresh build
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
    const { deps, git, build, drain, exits } = makeDeps();
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
  });

  it("aborts safely if the audit write (recordAction) throws, leaving git un-reset ", async () => {
    const { deps, git, drain, exits } = makeDeps();
    deps.recordAction = () => {
      throw new Error("ENOSPC / unwritable audit log");
    };
    const res = await executeUpdate(plan(), deps);
    expect(res.ok).toBe(false);
    expect(res.failedStep).toBe("pull");
    expect(res.error).toContain("ENOSPC / unwritable audit log");
    expect(git.resets).toEqual([]); // Did NOT reset to new SHA
    expect(drain.engaged).toBe(false);
    expect(exits).toEqual([]);
  });

  it("REFUSES concurrent calls via concurrency guard ", async () => {
    const { deps, git } = makeDeps();
    let releaseFetch: () => void = () => {};
    git.fetch = () =>
      new Promise((resolve) => {
        releaseFetch = resolve;
      });
    const p1 = executeUpdate(plan(), deps);

    const res2 = await executeUpdate(plan(), deps);
    expect(res2.ok).toBe(false);
    expect(res2.error?.includes("update already in progress")).toBe(true);

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

  it("still exits even if the drain times out (don't wedge on a stuck actor)", async () => {
    const { deps, drain, exits } = makeDeps();
    drain.quiesced = false; // bounded wait expired
    const res = await executeUpdate(plan(), deps);
    expect(res.restarting).toBe(true);
    expect(exits).toEqual([0]);
  });
});

describe("executeUpdate — the GATE (mesh untouched on a bad build)", () => {
  it("a RED build aborts: rolls back, NEVER drains, NEVER exits, reports ❌", async () => {
    const { deps, git, drain, exits, notify } = makeDeps();
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
    expect(notify.messages.some((m) => m.includes("❌ update failed at build"))).toBe(true);
    expect(notify.messages.some((m) => m.includes("staying on 0000000"))).toBe(true);
  });

  it("a FAILED rollback fires the LOUD chat-independent alert (last silent-failure path)", async () => {
    const { deps, git, markers, notify } = makeDeps();
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
    // LOUD: journal ERROR (console.error) + durable marker + best-effort chat — all fired.
    expect(errs.some((e) => e.includes("rollback FAILED"))).toBe(true);
    expect(markers.some((m) => m.includes("restart-fragile"))).toBe(true);
    expect(notify.messages.some((m) => m.includes("rollback FAILED"))).toBe(true);
  });

  it("a HUNG build (timeout) aborts the same way, flagged timedOut (elder #2)", async () => {
    const { deps, drain, exits } = makeDeps();
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
  });

  it("a pull failure aborts before build, drain and exit (no rollback — never moved)", async () => {
    const { deps, git, drain, build, exits } = makeDeps();
    git.failFetch = new Error("network down");
    const res = await executeUpdate(plan(), deps);
    expect(res.ok).toBe(false);
    expect(res.failedStep).toBe("pull");
    expect(build.builtSha).toBeUndefined();
    expect(drain.engaged).toBe(false);
    expect(exits).toEqual([]);
    expect(git.resets).toEqual([]); // pull failed before we moved
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
});
