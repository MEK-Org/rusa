import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AbortReason } from "../providers/termination-attribution.js";
import type { RunResult } from "../providers/types.js";
import type { MechanicalInboxForensics } from "./actor-mesh.js";
import type { ActorRecord } from "./actor-record.js";
import {
  clipFailureDiagnostic,
  FAILURE_DIAGNOSTIC_BUDGET,
  FailureEscalationBackoff,
  type FailureSinkDeps,
  formatProviderLabel,
  isUserCancelled,
  routeRunFailure,
  routeSpawnFailure,
  sanitizeFailureText,
} from "./failure-sink.js";

const TEST_USER_ID = "00000000-0000-4000-8000-000000000001";

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
    principals: {
      getUser: (id) =>
        id === TEST_USER_ID
          ? {
              kind: "user",
              id,
              createdAt: "t",
              email: "user@example.test",
            }
          : undefined,
    },
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

    it("renders a provider sign-in diagnostic after the clipped cause, never into the classified output", async () => {
      const classified: RunResult[] = [];
      const { deps, toParent } = makeDeps(
        { w1: { id: "w1", parentId: "root" } },
        {
          classify: async (result) => {
            classified.push(structuredClone(result));
            return { exhausted: false };
          },
        }
      );
      const cause = `${"x".repeat(900)}\nError: --effort is not supported for model`;
      const result: RunResult = {
        success: false,
        output: cause,
        exitCode: 1,
        signInDiagnostic: "[agy run log: silent sign-in failed]",
      };
      await routeRunFailure(deps, "w1", result, "antigravity");

      expect(classified[0]?.output).toBe(cause);
      const body = toParent[0]?.body ?? "";
      // The clipped cause keeps its own budget and the diagnostic follows it.
      expect(body).toBe(
        `[run failed] provider run antigravity failed.\n\n(exit 1)\n\n${clipFailureDiagnostic(cause)}\n` +
          "[agy run log: silent sign-in failed]"
      );
      expect(body).toContain("Error: --effort is not supported for model\n[agy run log:");
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

  describe("failure message and middle-clipped diagnostic (#980)", () => {
    const STACK = `Error: boom\n${Array.from({ length: 40 }, (_, i) => `    at frame${i} (/fixture/f.ts:${i}:1)`).join("\n")}`;
    const codePoints = (s: string) => Array.from(s).length;
    const diagnosticOf = (body: string) => body.replace(/^[\s\S]*?\(exit [^)]*\)\n\n/, "");

    it("shows a nonblank message instead of the stack, with the run id outside the budget", async () => {
      const { deps, toParent, toChat } = makeDeps({
        w1: { id: "w1", parentId: "root" },
        root: { id: "root" },
      });
      const result: RunResult = {
        success: false,
        output: STACK,
        exitCode: 1,
        failure: { message: "boom" },
      };
      await routeRunFailure(deps, "w1", result, "codex/gpt-fixture @ high", "run-1");
      await routeRunFailure(deps, "root", result, "codex/gpt-fixture @ high", "run-2");
      expect(toParent[0]?.body).toBe(
        "[run failed] Run run-1: provider run codex/gpt-fixture @ high failed.\n\n(exit 1)\n\nboom"
      );
      expect(toChat[0]).toBe(
        "⚠️ System Root's root run failed Run run-2: provider run codex/gpt-fixture @ high failed.\n\n(exit 1)\n\nboom"
      );
    });

    it("says a refused selection was never invoked, and skips exhaustion classification", async () => {
      let classified = 0;
      const { deps, toParent } = makeDeps(
        { w1: { id: "w1", parentId: "root" } },
        {
          classify: async () => {
            classified++;
            return { exhausted: true };
          },
        }
      );
      await routeRunFailure(
        deps,
        "w1",
        {
          success: false,
          output: STACK,
          exitCode: 1,
          failure: { stage: "provider-selection", message: 'rejected "x"' },
        },
        "codex/x @ medium",
        "run-1"
      );
      expect(classified).toBe(0);
      expect(toParent[0]?.body).toBe(
        '[run failed] Run run-1: could not prepare codex/x @ medium.\nProvider was not invoked.\n\n(exit 1)\n\nrejected "x"'
      );
    });

    it.each([
      ["missing", undefined],
      ["blank", { message: " \n " }],
    ])("falls back to the actual stack, clipped in the middle, when the message is %s", async (_kind, failure) => {
      const { deps, toParent } = makeDeps({ w1: { id: "w1", parentId: "root" } });
      await routeRunFailure(deps, "w1", { success: false, output: STACK, exitCode: 1, failure });
      const diagnostic = diagnosticOf(toParent[0]?.body ?? "");
      expect(codePoints(diagnostic)).toBe(FAILURE_DIAGNOSTIC_BUDGET);
      expect(diagnostic.startsWith("Error: boom\n    at frame0")).toBe(true);
      expect(diagnostic.endsWith("at frame39 (/fixture/f.ts:39:1)")).toBe(true);
    });

    it("keeps both ends of a long acceptable-values list", async () => {
      const values = Array.from({ length: 120 }, (_, i) => `"gpt-fixture-${i}"`).join(", ");
      const message = `model pin validation failed for provider "codex": rejected "gpt-fixture-missing"; acceptable values: ${values}`;
      const { deps, toParent } = makeDeps({ w1: { id: "w1", parentId: "root" } });
      await routeRunFailure(
        deps,
        "w1",
        {
          success: false,
          output: STACK,
          exitCode: 1,
          failure: { stage: "provider-selection", message },
        },
        "codex/gpt-fixture-missing",
        "run-1"
      );
      const diagnostic = diagnosticOf(toParent[0]?.body ?? "");
      expect(codePoints(diagnostic)).toBe(FAILURE_DIAGNOSTIC_BUDGET);
      expect(diagnostic).toContain(
        'rejected "gpt-fixture-missing"; acceptable values: "gpt-fixture-0"'
      );
      expect(diagnostic.endsWith('"gpt-fixture-119"')).toBe(true);
      expect(diagnostic).not.toContain("at frame");
    });

    it("keeps an ordinary CLI failure's opening and closing output", async () => {
      const output = `usage error: first line\n${"x".repeat(2000)}\nfatal: last line`;
      const { deps, toParent } = makeDeps({ w1: { id: "w1", parentId: "root" } });
      await routeRunFailure(deps, "w1", { success: false, output, exitCode: 2 }, "kimi");
      const diagnostic = diagnosticOf(toParent[0]?.body ?? "");
      expect(diagnostic.startsWith("usage error: first line")).toBe(true);
      expect(diagnostic.endsWith("fatal: last line")).toBe(true);
    });

    it("scrubs before measuring, so the omission count is of sanitized text", async () => {
      const output = `${"a".repeat(500)} "prompt": "${"s".repeat(5000)}" ${"z".repeat(500)}`;
      const { deps, toParent } = makeDeps({ w1: { id: "w1", parentId: "root" } });
      await routeRunFailure(deps, "w1", { success: false, output, exitCode: 1 });
      const diagnostic = diagnosticOf(toParent[0]?.body ?? "");
      const sanitized = sanitizeFailureText(output);
      expect(diagnostic).not.toContain("sss");
      expect(diagnostic).toBe(clipFailureDiagnostic(sanitized));
      const omitted = Number(/\[(\d+) characters omitted\]/.exec(diagnostic)?.[1]);
      const marker = `… [${omitted} characters omitted] …`;
      expect(omitted).toBe(codePoints(sanitized) - (FAILURE_DIAGNOSTIC_BUDGET - marker.length));
    });
  });

  describe("clipFailureDiagnostic (#980)", () => {
    it("returns text at or below the budget unchanged", () => {
      expect(clipFailureDiagnostic("short")).toBe("short");
      const exact = "é".repeat(FAILURE_DIAGNOSTIC_BUDGET);
      expect(clipFailureDiagnostic(exact)).toBe(exact);
    });

    it("counts the marker inside the budget and gives the spare character to the beginning", () => {
      const text = `${"h".repeat(500)}${"t".repeat(500)}`;
      // 25-point marker frame + 3 digits = 28; 50 - 28 = 22 kept → 11 / 11.
      expect(clipFailureDiagnostic(text, 50)).toBe(
        `${"h".repeat(11)}… [978 characters omitted] …${"t".repeat(11)}`
      );
      // 23 kept → 12 at the beginning, 11 at the end.
      expect(clipFailureDiagnostic(text, 51)).toBe(
        `${"h".repeat(12)}… [977 characters omitted] …${"t".repeat(11)}`
      );
    });

    it("stays exact where the omission count gains a digit", () => {
      for (const length of [122, 123]) {
        const clipped = clipFailureDiagnostic("x".repeat(length), 50);
        expect(Array.from(clipped)).toHaveLength(50);
        const omitted = Number(/\[(\d+) characters omitted\]/.exec(clipped)?.[1]);
        expect(Array.from(clipped.replace(/… \[\d+ characters omitted\] …/, ""))).toHaveLength(
          length - omitted
        );
      }
    });

    it("never splits a code point", () => {
      const clipped = clipFailureDiagnostic("😀".repeat(1000), 51);
      expect(Array.from(clipped)).toHaveLength(51);
      expect(clipped).not.toMatch(
        /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/
      );
      expect(clipped).toBe(`${"😀".repeat(12)}… [977 characters omitted] …${"😀".repeat(11)}`);
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

  describe("user cancellation / error chat suppression", () => {
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

    it("suppresses error chat when root is interrupted by a durable user", async () => {
      const { deps, toParent, toChat, logs } = makeDeps({
        root: { id: "root", parentId: null },
      });
      const interruptedRun: RunResult = {
        success: false,
        exitCode: 143,
        cancelled: true,
        interrupted: true,
        interruptSource: "00000000-0000-4000-8000-000000000001",
        output: "some work\n[Task interrupted by 00000000-0000-4000-8000-000000000001]",
      };
      await routeRunFailure(deps, "root", interruptedRun);
      expect(toChat).toHaveLength(0);
      expect(toParent).toHaveLength(0);
      expect(
        logs.some((m) => m.includes("suppressing error chat") && m.includes("human operator"))
      ).toBe(true);
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
        interruptSource: "00000000-0000-4000-8000-000000000001",
        output: "[Task interrupted by 00000000-0000-4000-8000-000000000001]",
      };
      await routeRunFailure(deps, "w1", interruptedRun);
      expect(toParent).toHaveLength(1);
      expect(toParent[0]?.toId).toBe("root");
      expect(toParent[0]?.body).toContain("interrupted by 00000000-0000-4000-8000-000000000001");
      expect(toChat).toHaveLength(0);
    });

    it.each<[AbortReason, string]>([
      ["stall-watchdog", "[Task killed by stall watchdog (no output for 15 minutes)]"],
      ["run-ceiling", "[Task killed by run ceiling timeout]"],
    ])("distinguishes %s abort in parent notice", async (abortReason, output) => {
      const { deps, toParent } = makeDeps({
        w1: { id: "w1", parentId: "root" },
      });
      const failResult: RunResult = {
        success: false,
        exitCode: 143,
        cancelled: true,
        abortReason,
        output,
      };
      await routeRunFailure(
        deps,
        "w1",
        failResult,
        "antigravity/gemini-3.8-flash @ high",
        `run-${abortReason}`
      );
      expect(toParent).toHaveLength(1);
      expect(toParent[0]?.toId).toBe("root");
      expect(toParent[0]?.body).toContain(`(exit 143, ${abortReason})`);
      expect(toParent[0]?.forensics?.abortReason).toBe(abortReason);
    });
  });

  describe("isUserCancelled", () => {
    it("recognizes a durable user principal id as a human cancellation only via principal storage", () => {
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
      expect(isUserCancelled(interrupted, principals)).toBe(true);
      expect(isUserCancelled(interrupted)).toBe(false);
      expect(isUserCancelled({ ...interrupted, interruptSource: "worker-abc" }, principals)).toBe(
        false
      );
    });
  });
});
