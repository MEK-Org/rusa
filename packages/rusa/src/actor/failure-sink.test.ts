import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RunResult } from "../providers/types.js";
import type { MechanicalInboxForensics } from "./actor-mesh.js";
import type { ActorRecord } from "./actor-record.js";
import {
  FailureEscalationBackoff,
  type FailureSinkDeps,
  formatProviderLabel,
  isHumanOperatorCancelled,
  routeRunFailure,
  routeSpawnFailure,
} from "./failure-sink.js";

const FAIL: RunResult = {
  success: false,
  output: "boom\nstack trace",
  exitCode: 1,
};

function makeDeps(
  records: Record<string, Partial<ActorRecord>>,
  over: Partial<FailureSinkDeps> = {}
): {
  deps: FailureSinkDeps;
  toParent: Array<{
    toId: string;
    body: string;
    fromId: string;
    forensics?: MechanicalInboxForensics;
    responsive?: boolean;
  }>;
  toChat: string[];
  logs: string[];
} {
  const toParent: Array<{
    toId: string;
    body: string;
    fromId: string;
    forensics?: MechanicalInboxForensics;
    responsive?: boolean;
  }> = [];
  const toChat: string[] = [];
  const logs: string[] = [];
  const deps: FailureSinkDeps = {
    actors: { get: (id: string) => records[id] as ActorRecord | undefined },
    sendToParent: (toId, body, fromId, forensics, delivery) =>
      toParent.push({ toId, body, fromId, forensics, responsive: delivery?.responsive }),
    postToErrorChat: (text) => toChat.push(text),
    rootId: "root",
    log: (m) => logs.push(m),
    ...over,
  };
  return { deps, toParent, toChat, logs };
}

describe("routeRunFailure", () => {
  it("labels the exact provider/model/effort selection", () => {
    expect(
      formatProviderLabel({
        name: "configured alias",
        providerName: "codex",
        model: "gpt-5.6-sol",
        effort: "xhigh",
      })
    ).toBe("codex/gpt-5.6-sol @ xhigh");
  });

  it("appends a sub-actor's failure to its parent's inbox", () => {
    const { deps, toParent, toChat } = makeDeps({ w1: { id: "w1", parentId: "root" } });
    routeRunFailure(deps, "w1", FAIL);
    expect(toParent).toHaveLength(1);
    expect(toParent[0]?.toId).toBe("root");
    expect(toParent[0]?.fromId).toBe("w1");
    expect(toParent[0]?.body).toContain("run failed");
    expect(toParent[0]?.forensics).toEqual({ runId: "w1", actorId: "w1", exitCode: 1 });
    expect(toChat).toHaveLength(0);
  });

  it("identifies a failed launched provider run without mislabeling selection", async () => {
    const { deps, toParent } = makeDeps({ w1: { id: "w1", parentId: "root" } });

    await routeRunFailure(deps, "w1", FAIL, "kimi/kimi-for-coding @ high", "run-04d139ba");

    expect(toParent[0]?.body).toContain("provider run kimi/kimi-for-coding @ high failed.");
    expect(toParent[0]?.body).not.toContain("provider selection");
    expect(toParent[0]?.forensics).toEqual({
      runId: "run-04d139ba",
      actorId: "w1",
      exitCode: 1,
    });
  });

  it("does not send failure notice when result.success is true", async () => {
    const { deps, toParent, toChat } = makeDeps({ w1: { id: "w1", parentId: "root" } });
    await routeRunFailure(deps, "w1", {
      success: true,
      exitCode: 0,
      output: "done",
    });
    expect(toParent).toHaveLength(0);
    expect(toChat).toHaveLength(0);
  });

  it("forwards sub-actor failures without requiring run trigger provenance", () => {
    const { deps, toParent } = makeDeps({ w1: { id: "w1", parentId: "root" } });
    routeRunFailure(deps, "w1", FAIL);
    expect(toParent).toEqual([
      expect.objectContaining({
        toId: "root",
        fromId: "w1",
      }),
    ]);
  });

  it("posts the root's failure to the configured error chat", () => {
    const { deps, toParent, toChat } = makeDeps({ root: { id: "root", parentId: null } });
    routeRunFailure(deps, "root", FAIL);
    expect(toChat).toHaveLength(1);
    expect(toChat[0]).toContain("root run failed");
    expect(toParent).toHaveLength(0);
  });

  it("journals (does not throw) when the root fails with no error chat configured", () => {
    const { deps, toChat, logs } = makeDeps(
      { root: { id: "root", parentId: null } },
      { postToErrorChat: null }
    );
    routeRunFailure(deps, "root", FAIL);
    expect(toChat).toHaveLength(0);
    expect(logs.some((m) => m.includes("no error chat"))).toBe(true);
  });

  it("journals and drops a failure for an unknown / parentless non-root actor", () => {
    const { deps, toParent, toChat, logs } = makeDeps({});
    routeRunFailure(deps, "ghost", FAIL);
    expect(toParent).toHaveLength(0);
    expect(toChat).toHaveLength(0);
    expect(logs.some((m) => m.includes("dropped"))).toBe(true);
  });

  it("includes the exit code and an output tail in the notice", () => {
    const { deps, toParent } = makeDeps({ w1: { id: "w1", parentId: "root" } });
    routeRunFailure(deps, "w1", FAIL);
    expect(toParent[0]?.body).toContain("exit 1");
    expect(toParent[0]?.body).toContain("boom");
  });

  it("scrubs tool-call arguments and request-body content from failure notices", () => {
    const leaked: RunResult = {
      success: false,
      exitCode: 1,
      output: JSON.stringify({
        error: "tool failed",
        tool_call: {
          name: "send_message",
          arguments: { body: "secret payload", thread_id: "root" },
        },
        request: { messages: [{ content: "private prompt" }] },
      }),
    };
    const { deps, toParent } = makeDeps({ w1: { id: "w1", parentId: "root" } });
    routeRunFailure(deps, "w1", leaked);
    expect(toParent[0]?.body).toContain("[scrubbed]");
    expect(toParent[0]?.body).not.toContain("secret payload");
    expect(toParent[0]?.body).not.toContain("private prompt");
    expect(toParent[0]?.body).not.toContain("thread_id");
  });

  describe("responsive escalation to the parent (#189)", () => {
    function escalating(now: { t: number }) {
      return makeDeps(
        {
          w1: { id: "w1", parentId: "root" },
          w2: { id: "w2", parentId: "root" },
          root: { id: "root", parentId: null },
        },
        {
          escalation: new FailureEscalationBackoff({
            baseMs: 60_000,
            maxMs: 240_000,
            now: () => now.t,
          }),
        }
      );
    }

    it("delivers a repeat failure inside the backoff window at normal priority", async () => {
      const now = { t: 0 };
      const { deps, toParent } = escalating(now);
      await routeRunFailure(deps, "w1", FAIL);
      now.t = 30_000;
      await routeRunFailure(deps, "w1", FAIL);
      expect(toParent.map((n) => n.responsive)).toEqual([true, false]);
      // The notice itself is still delivered; only the bypass is withheld.
      expect(toParent[1]?.body).toContain("[run failed]");
    });

    it("doubles the window while a child keeps failing, up to the cap", async () => {
      const now = { t: 0 };
      const { deps, toParent } = escalating(now);
      // Windows: 60s from 0, 120s from 60s, 240s from 180s, capped at 240s from 420s.
      for (const t of [0, 59_999, 60_000, 179_999, 180_000, 419_999, 420_000, 659_999, 660_000]) {
        now.t = t;
        await routeRunFailure(deps, "w1", FAIL);
      }
      expect(toParent.map((n) => n.responsive)).toEqual([
        true,
        false,
        true,
        false,
        true,
        false,
        true,
        false,
        true,
      ]);
    });

    it("resets to the base window after a quiet period", async () => {
      const now = { t: 0 };
      const { deps, toParent } = escalating(now);
      await routeRunFailure(deps, "w1", FAIL); // window 60s
      now.t = 60_000;
      await routeRunFailure(deps, "w1", FAIL); // window 120s, until 180s
      now.t = 180_000 + 120_000; // a full window with no failure past the last one
      await routeRunFailure(deps, "w1", FAIL); // back to the 60s base
      now.t += 60_000;
      await routeRunFailure(deps, "w1", FAIL);
      expect(toParent.map((n) => n.responsive)).toEqual([true, true, true, true]);
    });

    it("backs off each child independently", async () => {
      const { deps, toParent } = escalating({ t: 0 });
      await routeRunFailure(deps, "w1", FAIL);
      await routeRunFailure(deps, "w2", FAIL);
      await routeRunFailure(deps, "w1", FAIL);
      expect(toParent.map((n) => [n.fromId, n.responsive])).toEqual([
        ["w1", true],
        ["w2", true],
        ["w1", false],
      ]);
    });

    it("does not spend a child's escalation on a suppressed preemption", async () => {
      const { deps, toParent } = escalating({ t: 0 });
      await routeRunFailure(deps, "w1", {
        success: false,
        exitCode: 143,
        cancelled: true,
        interrupted: true,
        interruptSource: "responsive-notification",
        output: "[Task interrupted by responsive-notification]",
      });
      await routeRunFailure(deps, "w1", FAIL);
      expect(toParent.map((n) => n.responsive)).toEqual([true]);
    });

    it.each([
      ["run", (deps: FailureSinkDeps) => routeRunFailure(deps, "w1", FAIL)],
      ["spawn", (deps: FailureSinkDeps) => routeSpawnFailure(deps, "w1", "root", "bad pool")],
    ] as const)("keeps a child's escalation when its %s-failure notice fails to deliver", async (_, route) => {
      const now = { t: 0 };
      const { deps, toParent } = escalating(now);
      const deliver = deps.sendToParent;
      let failNext = true;
      deps.sendToParent = (...args) => {
        if (failNext) {
          failNext = false;
          throw new Error("inbox append failed");
        }
        deliver(...args);
      };
      await expect(async () => route(deps)).rejects.toThrow("inbox append failed");
      now.t = 30_000;
      await route(deps);
      expect(toParent.map((n) => n.responsive)).toEqual([true]);
    });

    it("leaves the root's error-chat path unchanged", async () => {
      const { deps, toParent, toChat } = escalating({ t: 0 });
      await routeRunFailure(deps, "root", FAIL);
      expect(toParent).toHaveLength(0);
      expect(toChat).toHaveLength(1);
    });

    it("keeps normal priority when no escalation policy is configured", async () => {
      const { deps, toParent } = makeDeps({ w1: { id: "w1", parentId: "root" } });
      await routeRunFailure(deps, "w1", FAIL);
      expect(toParent.map((n) => n.responsive)).toEqual([false]);
    });

    it("wakes the parent responsively for a child's spawn failure", () => {
      const { deps, toParent, toChat } = escalating({ t: 0 });
      routeSpawnFailure(deps, "w1", "root", "worker w1 spawn failed: bad pool");
      expect(toParent).toEqual([
        {
          toId: "root",
          body: "[spawn failed] worker w1 spawn failed: bad pool",
          fromId: "w1",
          forensics: undefined,
          responsive: true,
        },
      ]);
      expect(toChat).toHaveLength(0);
    });

    it("shares one per-child budget between spawn and run failures", async () => {
      const { deps, toParent } = escalating({ t: 0 });
      // A spawn failure spends the budget a run failure then finds spent, and
      // also honors it: a revived child can spawn-fail again inside the window.
      routeSpawnFailure(deps, "w1", "root", "worker w1 spawn failed: bad pool");
      await routeRunFailure(deps, "w1", FAIL);
      routeSpawnFailure(deps, "w1", "root", "worker w1 spawn failed: bad pool");
      expect(toParent.map((n) => n.responsive)).toEqual([true, false, false]);
    });

    it("posts a parentless spawn failure to the error chat", () => {
      const { deps, toParent, toChat } = escalating({ t: 0 });
      routeSpawnFailure(deps, "w1", null, "worker w1 spawn failed: bad pool");
      expect(toParent).toHaveLength(0);
      expect(toChat).toEqual(["⚠️ worker w1 spawn failed: bad pool"]);
    });
  });

  describe("exhaustion classification leads the notice ", () => {
    it("names the exhaustion on the FIRST line when classify reports exhausted", async () => {
      const { deps, toParent } = makeDeps(
        { w1: { id: "w1", parentId: "root" } },
        { classify: async () => ({ exhausted: true }) }
      );
      await routeRunFailure(deps, "w1", FAIL, "claude/claude-sonnet-5");
      const body = toParent[0]?.body ?? "";
      const firstLine = body.split("\n")[0];
      expect(firstLine).toContain("quota exhausted");
      expect(firstLine).toContain("claude/claude-sonnet-5");
      expect(firstLine).toContain("Parent judgment needed");
      // The usual exit-code/tail summary still follows, unmodified.
      expect(body).toContain("exit 1");
      expect(body).toContain("boom");
    });

    it("labels a non-exhausted provider run failure", async () => {
      const { deps, toParent } = makeDeps(
        { w1: { id: "w1", parentId: "root" } },
        { classify: async () => ({ exhausted: false }) }
      );
      await routeRunFailure(deps, "w1", FAIL, "claude/claude-sonnet-5");
      const body = toParent[0]?.body ?? "";
      expect(body).not.toContain("quota exhausted");
      expect(body).toBe(
        "[run failed] provider run claude/claude-sonnet-5 failed.\n\n(exit 1)\n\nboom\nstack trace"
      );
    });

    it("does not label network transient failures as quota exhausted ", async () => {
      const { createExhaustionClassifier } = await import("../providers/exhaustion-classifier.js");
      const classifier = createExhaustionClassifier(); // no api key -> deterministic fallback
      const { deps, toParent } = makeDeps(
        { w1: { id: "w1", parentId: "root" } },
        { classify: classifier }
      );
      const networkFail: RunResult = {
        success: false,
        output: "Error: connect ETIMEDOUT 142.250.180.14:443\nnetwork changed",
        exitCode: 1,
      };
      await routeRunFailure(deps, "w1", networkFail, "antigravity");
      const body = toParent[0]?.body ?? "";
      expect(body).not.toContain("quota exhausted");
      expect(body).toContain("[run failed] provider run antigravity failed.");
      expect(body).toContain("(exit 1)");
      expect(body).toContain("connect ETIMEDOUT");
    });

    it("labels a provider run failure when no classifier is configured", async () => {
      const { deps, toParent } = makeDeps({ w1: { id: "w1", parentId: "root" } });
      await routeRunFailure(deps, "w1", FAIL, "claude/claude-sonnet-5");
      const body = toParent[0]?.body ?? "";
      expect(body).not.toContain("quota exhausted");
      expect(body).toBe(
        "[run failed] provider run claude/claude-sonnet-5 failed.\n\n(exit 1)\n\nboom\nstack trace"
      );
    });
  });

  describe("watchdog unpushed work detection (Rung 2)", () => {
    const WATCHDOG_FAIL: RunResult = {
      success: false,
      output: "stalled",
      exitCode: 143,
    };
    let tempWorkersDir: string | null = null;

    const cleanupTemp = () => {
      if (tempWorkersDir) {
        rmSync(tempWorkersDir, { recursive: true, force: true });
        tempWorkersDir = null;
      }
    };

    afterEach(() => {
      cleanupTemp();
    });

    it("appends in-progress work path if the worktree is dirty", () => {
      tempWorkersDir = mkdtempSync(join(tmpdir(), "mc-test-workers-"));
      const actorId = "w-dirty";
      const actorDir = join(tempWorkersDir, actorId);
      const repoDir = join(actorDir, "my-repo");
      mkdirSync(repoDir, { recursive: true });

      // Initialize real git repo
      execSync("git init", { cwd: repoDir, stdio: "ignore" });
      // Write untracked file to make it dirty
      writeFileSync(join(repoDir, "dirty.txt"), "dirty content");

      const { deps, toParent } = makeDeps(
        { [actorId]: { id: actorId, parentId: "root" } },
        { workersDir: tempWorkersDir }
      );

      routeRunFailure(deps, actorId, WATCHDOG_FAIL);

      expect(toParent).toHaveLength(1);
      expect(toParent[0]?.body).toContain("in-progress work present at");
      expect(toParent[0]?.body).toContain(repoDir);
    });

    it("appends in-progress work path if the repo has unpushed commits", () => {
      tempWorkersDir = mkdtempSync(join(tmpdir(), "mc-test-workers-"));
      const actorId = "w-unpushed";
      const actorDir = join(tempWorkersDir, actorId);
      const repoDir = join(actorDir, "my-repo");
      mkdirSync(repoDir, { recursive: true });

      // Initialize real git repo
      execSync("git init", { cwd: repoDir, stdio: "ignore" });
      execSync("git config user.name 'Test User'", { cwd: repoDir, stdio: "ignore" });
      execSync("git config user.email 'test@example.com'", { cwd: repoDir, stdio: "ignore" });
      // Commit one file so we have commits
      writeFileSync(join(repoDir, "committed.txt"), "committed content");
      execSync("git add committed.txt && git commit -m 'initial commit'", {
        cwd: repoDir,
        stdio: "ignore",
      });

      const { deps, toParent } = makeDeps(
        { [actorId]: { id: actorId, parentId: "root" } },
        { workersDir: tempWorkersDir }
      );

      routeRunFailure(deps, actorId, WATCHDOG_FAIL);

      expect(toParent).toHaveLength(1);
      expect(toParent[0]?.body).toContain("in-progress work present at");
      expect(toParent[0]?.body).toContain(repoDir);
    });

    it("does not append path if the worktree is completely clean", () => {
      tempWorkersDir = mkdtempSync(join(tmpdir(), "mc-test-workers-"));
      const actorId = "w-clean";
      const actorDir = join(tempWorkersDir, actorId);
      const repoDir = join(actorDir, "my-repo");
      const remoteDir = join(actorDir, "my-remote.git");
      mkdirSync(repoDir, { recursive: true });
      mkdirSync(remoteDir, { recursive: true });

      // Initialize remote bare repo
      execSync("git init --bare", { cwd: remoteDir, stdio: "ignore" });

      // Initialize local git repo
      execSync("git init", { cwd: repoDir, stdio: "ignore" });
      execSync("git config user.name 'Test User'", { cwd: repoDir, stdio: "ignore" });
      execSync("git config user.email 'test@example.com'", { cwd: repoDir, stdio: "ignore" });

      // Add remote and commit/push first commit
      execSync(`git remote add origin "${remoteDir}"`, { cwd: repoDir, stdio: "ignore" });
      writeFileSync(join(repoDir, "committed.txt"), "committed content");
      execSync("git add committed.txt && git commit -m 'initial commit'", {
        cwd: repoDir,
        stdio: "ignore",
      });
      execSync("git push -u origin HEAD", { cwd: repoDir, stdio: "ignore" });

      const { deps, toParent } = makeDeps(
        { [actorId]: { id: actorId, parentId: "root" } },
        { workersDir: tempWorkersDir }
      );

      routeRunFailure(deps, actorId, WATCHDOG_FAIL);

      expect(toParent).toHaveLength(1);
      expect(toParent[0]?.body).not.toContain("in-progress work present at");
    });

    it("gracefully falls back to normal notification if workersDir does not exist or errors out", () => {
      const { deps, toParent } = makeDeps(
        { w1: { id: "w1", parentId: "root" } },
        { workersDir: "/nonexistent/directory/path" }
      );

      routeRunFailure(deps, "w1", WATCHDOG_FAIL);

      expect(toParent).toHaveLength(1);
      expect(toParent[0]?.body).toContain("run failed");
      expect(toParent[0]?.body).not.toContain("in-progress work present at");
    });
  });

  describe("human operator cancellation / error chat suppression ", () => {
    it("suppresses expected responsive preemption notices for roots and workers", async () => {
      const { deps, toParent, toChat, logs } = makeDeps({
        root: { id: "root", parentId: null },
        w1: { id: "w1", parentId: "root" },
      });
      const preempted: RunResult = {
        success: false,
        exitCode: 143,
        cancelled: true,
        interrupted: true,
        interruptSource: "responsive-notification",
        output: "[Task interrupted by responsive-notification]",
      };

      await routeRunFailure(deps, "root", preempted);
      await routeRunFailure(deps, "w1", preempted);

      expect(toChat).toHaveLength(0);
      expect(toParent).toHaveLength(0);
      expect(logs.filter((line) => line.includes("responsive preemption"))).toHaveLength(2);
    });

    it("does not suppress marker-like output without the typed responsive source", async () => {
      const { deps, toParent, toChat } = makeDeps({
        w1: { id: "w1", parentId: "root" },
      });
      const spoofed: RunResult = {
        success: false,
        exitCode: 143,
        cancelled: true,
        interrupted: true,
        // No interruptSource set
        output: "[Task interrupted by responsive-notification]",
      };

      await routeRunFailure(deps, "w1", spoofed);

      // It should NOT be suppressed (so it goes to parent)
      expect(toParent).toHaveLength(1);
      expect(toParent[0]?.toId).toBe("root");
      expect(toChat).toHaveLength(0);
    });

    it("suppresses error chat when root is interrupted by human:operator", async () => {
      const { deps, toParent, toChat, logs } = makeDeps({
        root: { id: "root", parentId: null },
      });
      const interruptedRun: RunResult = {
        success: false,
        exitCode: 143,
        cancelled: true,
        interrupted: true,
        interruptSource: "human:operator",
        output: "some work\n[Task interrupted by human:operator]",
      };
      await routeRunFailure(deps, "root", interruptedRun);
      expect(toChat).toHaveLength(0);
      expect(toParent).toHaveLength(0);
      expect(
        logs.some((m) => m.includes("suppressing error chat") && m.includes("human operator"))
      ).toBe(true);
    });

    it("suppresses error chat when root is interrupted by operator", async () => {
      const { deps, toChat } = makeDeps({
        root: { id: "root", parentId: null },
      });
      const interruptedRun: RunResult = {
        success: false,
        exitCode: 143,
        cancelled: true,
        interrupted: true,
        interruptSource: "operator",
        output: "[Task interrupted by operator]",
      };
      await routeRunFailure(deps, "root", interruptedRun);
      expect(toChat).toHaveLength(0);
    });

    it("suppresses error chat when root is interrupted by human:<username>", async () => {
      const { deps, toChat } = makeDeps({
        root: { id: "root", parentId: null },
      });
      const interruptedRun: RunResult = {
        success: false,
        exitCode: 143,
        cancelled: true,
        interrupted: true,
        interruptSource: "human:alice",
        output: "[Task interrupted by human:alice]",
      };
      await routeRunFailure(deps, "root", interruptedRun);
      expect(toChat).toHaveLength(0);
    });

    it("suppresses error chat when root has interrupted: true without output attribution", async () => {
      const { deps, toChat } = makeDeps({
        root: { id: "root", parentId: null },
      });
      const interruptedRun: RunResult = {
        success: false,
        exitCode: 143,
        cancelled: true,
        interrupted: true,
        output: "",
      };
      await routeRunFailure(deps, "root", interruptedRun);
      expect(toChat).toHaveLength(0);
    });

    it("suppresses error chat when interruptSource indicates human interrupt even if interrupted flag is omitted", async () => {
      const { deps, toChat } = makeDeps({
        root: { id: "root", parentId: null },
      });
      const interruptedRun: RunResult = {
        success: false,
        exitCode: 143,
        cancelled: true,
        interruptSource: "human:operator",
        output: "partial logs\n[Task interrupted by human:operator]",
      };
      await routeRunFailure(deps, "root", interruptedRun);
      expect(toChat).toHaveLength(0);
    });

    it("still posts to error chat when root fails with genuine runtime error", async () => {
      const { deps, toChat } = makeDeps({
        root: { id: "root", parentId: null },
      });
      const runtimeFail: RunResult = {
        success: false,
        exitCode: 1,
        output: "ReferenceError: foo is not defined\n    at bar.js:10:5",
      };
      await routeRunFailure(deps, "root", runtimeFail);
      expect(toChat).toHaveLength(1);
      expect(toChat[0]).toContain("root run failed");
      expect(toChat[0]).toContain("ReferenceError");
    });

    it("still posts to error chat when root is killed by stall watchdog (non-human)", async () => {
      const { deps, toChat } = makeDeps({
        root: { id: "root", parentId: null },
      });
      const watchdogFail: RunResult = {
        success: false,
        exitCode: 143,
        cancelled: true,
        output: "[Task killed by stall watchdog (no output for 15 minutes)]",
      };
      await routeRunFailure(deps, "root", watchdogFail);
      expect(toChat).toHaveLength(1);
      expect(toChat[0]).toContain("stall watchdog");
    });

    it("still posts to error chat when root is killed by run ceiling timeout (non-human)", async () => {
      const { deps, toChat } = makeDeps({
        root: { id: "root", parentId: null },
      });
      const ceilingFail: RunResult = {
        success: false,
        exitCode: 143,
        cancelled: true,
        output: "[Task killed by run ceiling timeout]",
      };
      await routeRunFailure(deps, "root", ceilingFail);
      expect(toChat).toHaveLength(1);
      expect(toChat[0]).toContain("run ceiling");
    });

    it("still posts to error chat when root is terminated by unattributed SIGTERM (non-human)", async () => {
      const { deps, toChat } = makeDeps({
        root: { id: "root", parentId: null },
      });
      const unattributedFail: RunResult = {
        success: false,
        exitCode: 143,
        cancelled: true,
        output: "[Task terminated by SIGTERM (source unattributed)]",
      };
      await routeRunFailure(deps, "root", unattributedFail);
      expect(toChat).toHaveLength(1);
      expect(toChat[0]).toContain("source unattributed");
    });

    it("still posts to error chat when root is interrupted by a non-human actor", async () => {
      const { deps, toChat } = makeDeps({
        root: { id: "root", parentId: null },
      });
      const peerInterrupt: RunResult = {
        success: false,
        exitCode: 143,
        cancelled: true,
        interrupted: true,
        interruptSource: "peer-worker-123",
        output: "[Task interrupted by peer-worker-123]",
      };
      await routeRunFailure(deps, "root", peerInterrupt);
      expect(toChat).toHaveLength(1);
      expect(toChat[0]).toContain("peer-worker-123");
    });

    it("still forwards sub-actor human interrupt failure to parent inbox", async () => {
      const { deps, toParent, toChat } = makeDeps({
        w1: { id: "w1", parentId: "root" },
      });
      const interruptedRun: RunResult = {
        success: false,
        exitCode: 143,
        cancelled: true,
        interrupted: true,
        interruptSource: "human:operator",
        output: "[Task interrupted by human:operator]",
      };
      await routeRunFailure(deps, "w1", interruptedRun);
      expect(toParent).toHaveLength(1);
      expect(toParent[0]?.toId).toBe("root");
      expect(toParent[0]?.body).toContain("interrupted by human:operator");
      expect(toChat).toHaveLength(0);
    });

    it("distinguishes stall watchdog abort from other cancellations in parent notice", async () => {
      const { deps, toParent } = makeDeps({
        w1: { id: "w1", parentId: "root" },
      });
      const watchdogFail: RunResult = {
        success: false,
        exitCode: 143,
        cancelled: true,
        abortReason: "stall-watchdog",
        output: "[Task killed by stall watchdog (no output for 15 minutes)]",
      };
      await routeRunFailure(deps, "w1", watchdogFail, "antigravity/gemini-3.8-flash @ high", "run-1");
      expect(toParent).toHaveLength(1);
      expect(toParent[0]?.toId).toBe("root");
      expect(toParent[0]?.body).toContain("(exit 143, stall-watchdog)");
      expect(toParent[0]?.forensics?.abortReason).toBe("stall-watchdog");
    });

    it("distinguishes run ceiling abort in parent notice", async () => {
      const { deps, toParent } = makeDeps({
        w1: { id: "w1", parentId: "root" },
      });
      const ceilingFail: RunResult = {
        success: false,
        exitCode: 143,
        cancelled: true,
        abortReason: "run-ceiling",
        output: "[Task killed by run ceiling timeout]",
      };
      await routeRunFailure(deps, "w1", ceilingFail, "antigravity/gemini-3.8-flash @ high", "run-2");
      expect(toParent).toHaveLength(1);
      expect(toParent[0]?.body).toContain("(exit 143, run-ceiling)");
      expect(toParent[0]?.forensics?.abortReason).toBe("run-ceiling");
    });
  });

  describe("isHumanOperatorCancelled helper ", () => {
    it("recognizes a durable user principal id as a human cancellation only via principal storage", () => {
      // After the #460 cutover the dashboard interrupts with the migrated user
      // id, which carries no `human:` prefix; storage is what says it is a person.
      const USER = "11111111-0000-4000-8000-000000000001";
      const interrupted: RunResult = {
        success: false,
        exitCode: 143,
        interrupted: true,
        interruptSource: USER,
        output: `[Task interrupted by ${USER}]`,
      };
      const principals = {
        getUser: (id: string) => (id === USER ? { kind: "user", id } : undefined),
      } as unknown as NonNullable<FailureSinkDeps["principals"]>;
      expect(isHumanOperatorCancelled(interrupted, principals)).toBe(true);
      expect(isHumanOperatorCancelled(interrupted)).toBe(false);
      expect(
        isHumanOperatorCancelled({ ...interrupted, interruptSource: "worker-abc" }, principals)
      ).toBe(false);
    });

    it("suppresses the root error-chat notice for a durable-principal interrupt", async () => {
      const USER = "11111111-0000-4000-8000-000000000001";
      const { deps, toChat, logs } = makeDeps(
        { root: { id: "root", parentId: null } },
        {
          principals: {
            getUser: (id: string) => (id === USER ? { kind: "user", id } : undefined),
          } as unknown as NonNullable<FailureSinkDeps["principals"]>,
        }
      );
      await routeRunFailure(deps, "root", {
        success: false,
        exitCode: 143,
        interrupted: true,
        interruptSource: USER,
        output: `[Task interrupted by ${USER}]`,
      });
      expect(toChat).toEqual([]);
      expect(logs.some((l) => l.includes("interrupted by human operator"))).toBe(true);
    });

    it("identifies various human operator interrupt patterns", () => {
      expect(
        isHumanOperatorCancelled({
          success: false,
          exitCode: 143,
          interrupted: true,
          interruptSource: "human:operator",
          output: "[Task interrupted by human:operator]",
        })
      ).toBe(true);
      expect(
        isHumanOperatorCancelled({
          success: false,
          exitCode: 143,
          interrupted: true,
          interruptSource: "operator",
          output: "[Task interrupted by operator]",
        })
      ).toBe(true);
      expect(
        isHumanOperatorCancelled({
          success: false,
          exitCode: 143,
          interrupted: true,
          interruptSource: "human:bob",
          output: "[Task interrupted by human:bob]",
        })
      ).toBe(true);
      expect(
        isHumanOperatorCancelled({
          success: false,
          exitCode: 143,
          interrupted: true,
          interruptSource: "human:operator",
          output: "[Task cancelled by human:operator]",
        })
      ).toBe(true);
      expect(
        isHumanOperatorCancelled({
          success: false,
          exitCode: 143,
          interrupted: true,
          output: "",
        })
      ).toBe(true);
      expect(
        isHumanOperatorCancelled({
          success: false,
          exitCode: 143,
          interruptSource: "human:operator",
          output: "[Task interrupted by human:operator]",
        })
      ).toBe(true);

      expect(
        isHumanOperatorCancelled({
          success: false,
          exitCode: 143,
          interrupted: true,
          interruptSource: "root",
          output: "[Task interrupted by root]",
        })
      ).toBe(false);
      expect(
        isHumanOperatorCancelled({
          success: false,
          exitCode: 143,
          interrupted: true,
          interruptSource: "root-llm",
          output: "[Task interrupted by root-llm]",
        })
      ).toBe(false);
      expect(
        isHumanOperatorCancelled({
          success: false,
          exitCode: 143,
          interrupted: true,
          interruptSource: "worker-abc",
          output: "[Task interrupted by worker-abc]",
        })
      ).toBe(false);
      expect(
        isHumanOperatorCancelled({
          success: false,
          exitCode: 1,
          output: "runtime error",
        })
      ).toBe(false);
      expect(
        isHumanOperatorCancelled({
          success: false,
          exitCode: 143,
          output: "[Task killed by stall watchdog (no output for 15 minutes)]",
        })
      ).toBe(false);
    });
  });
});
