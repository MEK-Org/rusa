import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RunResult } from "../providers/types.js";
import type { MechanicalInboxForensics } from "./actor-mesh.js";
import {
  type FailureSinkDeps,
  isHumanOperatorCancelled,
  routeContinuationCapped,
  routeRunFailure,
} from "./failure-sink.js";
import type { ThreadRecord } from "./thread-registry.js";

const FAIL: RunResult = {
  success: false,
  output: "boom\nstack trace",
  exitCode: 1,
};

function makeDeps(
  records: Record<string, Partial<ThreadRecord>>,
  over: Partial<FailureSinkDeps> = {}
): {
  deps: FailureSinkDeps;
  toParent: Array<{
    toId: string;
    body: string;
    fromId: string;
    forensics?: MechanicalInboxForensics;
  }>;
  toChat: string[];
  logs: string[];
} {
  const toParent: Array<{
    toId: string;
    body: string;
    fromId: string;
    forensics?: MechanicalInboxForensics;
  }> = [];
  const toChat: string[] = [];
  const logs: string[] = [];
  const deps: FailureSinkDeps = {
    registry: { get: (id: string) => records[id] as ThreadRecord | undefined },
    sendToParent: (toId, body, fromId, forensics) =>
      toParent.push({ toId, body, fromId, forensics }),
    postToErrorChat: (text) => toChat.push(text),
    rootId: "root",
    log: (m) => logs.push(m),
    ...over,
  };
  return { deps, toParent, toChat, logs };
}

describe("routeRunFailure", () => {
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

  it("does not send failure notice when result.success is true", async () => {
    const { deps, toParent, toChat } = makeDeps({ w1: { id: "w1", parentId: "root" } });
    await routeRunFailure(deps, "w1", {
      success: true,
      exitCode: 143,
      graceKilled: true,
      yieldStatus: "complete",
      output: "[Task killed by supervisor (yield grace period exceeded)]",
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

    it("keeps today's format when classify reports not exhausted", async () => {
      const { deps, toParent } = makeDeps(
        { w1: { id: "w1", parentId: "root" } },
        { classify: async () => ({ exhausted: false }) }
      );
      await routeRunFailure(deps, "w1", FAIL, "claude/claude-sonnet-5");
      const body = toParent[0]?.body ?? "";
      expect(body).not.toContain("quota exhausted");
      expect(body).toBe("[run failed] (exit 1)\n\nboom\nstack trace");
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
      expect(body).toContain("[run failed] (exit 1)");
      expect(body).toContain("connect ETIMEDOUT");
    });

    it("keeps today's format when no classifier is configured", async () => {
      const { deps, toParent } = makeDeps({ w1: { id: "w1", parentId: "root" } });
      await routeRunFailure(deps, "w1", FAIL, "claude/claude-sonnet-5");
      const body = toParent[0]?.body ?? "";
      expect(body).not.toContain("quota exhausted");
      expect(body).toBe("[run failed] (exit 1)\n\nboom\nstack trace");
    });
  });

  it("sends continuation caps to the parent as a mechanical capped notice", () => {
    const { deps, toParent, toChat, logs } = makeDeps({ w1: { id: "w1", parentId: "root" } });
    routeContinuationCapped(deps, "w1", 20);
    expect(toParent).toHaveLength(1);
    expect(toParent[0]?.toId).toBe("root");
    expect(toParent[0]?.fromId).toBe("w1");
    expect(toParent[0]?.body).toBe(
      "[capped] yield-elicitation exhausted after 20 corrective run(s)"
    );
    expect(toParent[0]?.forensics).toEqual({ runId: "w1", actorId: "w1", exitCode: undefined });
    expect(toChat).toHaveLength(0);
    expect(logs[0]).toContain("yield-elicitation exhausted for w1");
  });

  it("sends root continuation caps to the error chat", () => {
    const { deps, toChat, logs } = makeDeps({ root: { id: "root", parentId: null } });
    routeContinuationCapped(deps, "root", 20);
    expect(toChat).toHaveLength(1);
    expect(toChat[0]).toContain("System Root's root capped");
    expect(toChat[0]).toContain("yield-elicitation exhausted after 20 corrective run(s)");
    expect(logs[0]).toContain("yield-elicitation exhausted for root");
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
    it("suppresses error chat when root is interrupted by human:operator", async () => {
      const { deps, toParent, toChat, logs } = makeDeps({
        root: { id: "root", parentId: null },
      });
      const interruptedRun: RunResult = {
        success: false,
        exitCode: 143,
        cancelled: true,
        interrupted: true,
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

    it("suppresses error chat when output indicates human interrupt even if interrupted flag is omitted", async () => {
      const { deps, toChat } = makeDeps({
        root: { id: "root", parentId: null },
      });
      const interruptedRun: RunResult = {
        success: false,
        exitCode: 143,
        cancelled: true,
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
        output: "[Task interrupted by human:operator]",
      };
      await routeRunFailure(deps, "w1", interruptedRun);
      expect(toParent).toHaveLength(1);
      expect(toParent[0]?.toId).toBe("root");
      expect(toParent[0]?.body).toContain("interrupted by human:operator");
      expect(toChat).toHaveLength(0);
    });
  });

  describe("isHumanOperatorCancelled helper ", () => {
    it("identifies various human operator interrupt patterns", () => {
      expect(
        isHumanOperatorCancelled({
          success: false,
          exitCode: 143,
          interrupted: true,
          output: "[Task interrupted by human:operator]",
        })
      ).toBe(true);
      expect(
        isHumanOperatorCancelled({
          success: false,
          exitCode: 143,
          interrupted: true,
          output: "[Task interrupted by operator]",
        })
      ).toBe(true);
      expect(
        isHumanOperatorCancelled({
          success: false,
          exitCode: 143,
          interrupted: true,
          output: "[Task interrupted by human:bob]",
        })
      ).toBe(true);
      expect(
        isHumanOperatorCancelled({
          success: false,
          exitCode: 143,
          interrupted: true,
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
          output: "[Task interrupted by human:operator]",
        })
      ).toBe(true);

      expect(
        isHumanOperatorCancelled({
          success: false,
          exitCode: 143,
          interrupted: true,
          output: "[Task interrupted by root]",
        })
      ).toBe(false);
      expect(
        isHumanOperatorCancelled({
          success: false,
          exitCode: 143,
          interrupted: true,
          output: "[Task interrupted by root-llm]",
        })
      ).toBe(false);
      expect(
        isHumanOperatorCancelled({
          success: false,
          exitCode: 143,
          interrupted: true,
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
