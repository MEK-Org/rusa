// @vitest-environment node

/**
 * process-group-kill.test.ts — ISSUE_NUM leg 2
 *
 * Drives CopilotProvider.run() with a real shell script as the fake CLI —
 * no spawn mock.  The script spawns a long-lived grandchild, then sleeps.
 * We fire opts.signal's abort and assert the grandchild is dead.
 *
 * THE ARBITER:
 *   Delete `detached: true` from CopilotProvider's spawn options
 *   (packages/rusa/src/providers/copilot.ts, the `const child = spawn(…)`
 *   call) and this test goes RED, because `process.kill(-child.pid, "SIGKILL")`
 *   targets a PGID that only exists when the child is a process-group leader.
 *   Without `detached: true`, the group kill throws ESRCH (caught silently),
 *   the grandchild is never signalled, and the assertion fails.
 *
 * This file does NOT vi.mock("node:child_process").
 * It exercises the adapter's real spawn/kill code path.
 */

import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { ProviderConfig } from "../config/types.js";
import { CopilotProvider } from "./copilot.js";
import { runSubprocess, type SubprocessDuplex } from "./subprocess-execution.js";
import {
  RUN_CEILING_ABORT_REASON,
  STALL_WATCHDOG_ABORT_REASON,
} from "./termination-attribution.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function waitForPidFile(path: string, timeoutMs = 5000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) {
      const content = await readFile(path, "utf8");
      const pid = parseInt(content.trim(), 10);
      if (!Number.isNaN(pid) && pid > 0) return pid;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Timed out waiting for PID file: ${path}`);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CopilotProvider — transitive process-group kill (ISSUE_NUM leg 2)", () => {
  const temps: string[] = [];

  afterEach(() => {
    for (const d of temps) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
    temps.length = 0;
  });

  /**
   * A fake "provider CLI" that spawns a long-lived grandchild, then idles.
   * The grandchild writes its own PID so the test can probe liveness.
   */
  function writeFakeCli(tmp: string): { script: string; grandchildPidFile: string } {
    const grandchildPidFile = join(tmp, "grandchild.pid");
    const script = join(tmp, "fake-copilot.sh");
    writeFileSync(
      script,
      [
        "#!/bin/bash",
        // Grandchild: record its PID and sleep
        `( echo $BASHPID > ${grandchildPidFile}; exec sleep 300 ) &`,
        // Give the grandchild time to write its PID before the parent sleeps
        "sleep 0.15",
        // "CLI" idles — the adapter will kill the group when abort fires
        "exec sleep 300",
      ].join("\n")
    );
    chmodSync(script, 0o755);
    return { script, grandchildPidFile };
  }

  /**
   * THE ARBITER TEST.
   *
   * Remove `detached: true` from copilot.ts → this goes RED.
   * Mechanism: without detached, process.kill(-child.pid) throws ESRCH
   * (no process group with PGID = child.pid exists), the catch swallows it,
   * the grandchild is never signalled, and isAlive(grandchildPid) returns true.
   *
   * Parameterized over the abort reason because the group kill is reason-blind
   * while the attribution is not: every supervisor abort takes this same path,
   * so the descendants are reaped whichever limit fired, and the run comes back
   * attributed to that limit rather than as a bare SIGTERM.
   */
  it.each([
    {
      label: "the stall watchdog fires",
      reason: STALL_WATCHDOG_ABORT_REASON,
      marker: "[Task killed by stall watchdog (no output for 15 minutes)]",
    },
    {
      label: "the run ceiling is reached",
      reason: RUN_CEILING_ABORT_REASON,
      marker: "[Task killed by run ceiling timeout]",
    },
  ])("reaps the grandchild and attributes the kill when $label — remove detached:true from copilot.ts to see RED", async ({
    reason,
    marker,
  }) => {
    const tmp = mkdtempSync(join(tmpdir(), "mc-pgkill-"));
    temps.push(tmp);
    const { script, grandchildPidFile } = writeFakeCli(tmp);

    const config: ProviderConfig = { cliCommand: script };
    const provider = new CopilotProvider("copilot", config);
    const controller = new AbortController();

    const runPromise = provider.run({
      prompt: "test",
      cwd: tmp,
      signal: controller.signal,
    });

    // Wait for the grandchild to start and record its PID
    const grandchildPid = await waitForPidFile(grandchildPidFile);
    expect(isAlive(grandchildPid)).toBe(true); // sanity: grandchild alive pre-kill

    controller.abort(reason);

    // Adapter settles once the group is killed
    const result = await runPromise;
    expect(result.success).toBe(false);
    expect(result.cancelled).toBe(true);
    expect(result.exitCode).toBe(143);
    // The raw termination diagnostic reaches the caller from the real adapter,
    // not just from formatSigtermResult in isolation.
    expect(result.output).toContain(marker);

    // Give OS a moment to reap the group
    await new Promise((r) => setTimeout(r, 150));

    // THE ARBITER ASSERTION:
    // With detached:true + process.kill(-pid, SIGKILL): grandchild is dead → false
    // Without detached:true: ESRCH on kill, grandchild survives → true → RED
    expect(isAlive(grandchildPid)).toBe(false);
  });
});

const fixture = fileURLToPath(new URL("./fixtures/process-tree.mjs", import.meta.url));

// Linux may retain an orphan zombie until PID 1 reaps it. A zombie cannot execute;
// this checks termination, not reaping, and never treats kill(pid, 0) as proof of life.
async function isRunning(pid: number): Promise<boolean> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0] !== "Z";
  } catch (error) {
    if (["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
    throw error;
  }
}

async function cleanupProcess(pid: number): Promise<void> {
  if (!(await isRunning(pid))) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

describe.skipIf(process.platform !== "linux")("supervised process-group termination", () => {
  it("terminates a ready same-group descendant on duplex close", async () => {
    const controller = new AbortController();
    let transport: SubprocessDuplex | undefined;
    let pids: { parent: number; descendant: number } | undefined;
    let buffer = "";
    let ready: Promise<void> | undefined;
    let closure: Promise<void> | undefined;
    let readinessError: unknown;
    const result = { success: false, output: "terminated", exitCode: 1 };
    try {
      const run = runSubprocess({
        command: process.execPath,
        args: [fixture],
        cwd: process.cwd(),
        env: {},
        signal: controller.signal,
        timeoutMs: 5000,
        onDuplex: (value) => {
          transport = value;
        },
        handleStdoutData: (chunk) => {
          buffer += chunk.toString();
          if (!buffer.includes("\n") || ready) return;
          const tree: { parent: number; descendant: number } = JSON.parse(buffer.trim());
          pids = tree;
          const activeTransport = transport;
          ready = (async () => {
            expect(await isRunning(tree.parent)).toBe(true);
            expect(await isRunning(tree.descendant)).toBe(true);
            if (!activeTransport) throw new Error("Missing duplex transport");
            closure = activeTransport.close();
          })().catch((error) => {
            readinessError = error;
            controller.abort();
          });
        },
        buildKilledResult: () => ({
          ...result,
          output: "unexpected abort or deadline",
        }),
        buildSignalResult: (_attribution, signal) => ({ ...result, output: signal }),
        buildExitResult: () => ({ ...result, output: "unexpected natural exit" }),
        buildSpawnErrorResult: () => ({ ...result, output: "spawn failed" }),
      });
      expect(await run).toMatchObject({ ...result, output: "SIGKILL" });
      expect(ready, "both processes must report readiness before termination").toBeDefined();
      await ready;
      if (readinessError) throw readinessError;
      await closure;
      if (!pids) throw new Error("Missing process readiness");
      for (const pid of [pids.parent, pids.descendant]) {
        await expect.poll(() => isRunning(pid), { timeout: 2000, interval: 20 }).toBe(false);
      }
    } finally {
      await transport?.close();
      // A failed assertion or mutation must not leave synthetic processes alive.
      if (pids) {
        for (const pid of [pids.descendant, pids.parent]) {
          await cleanupProcess(pid);
        }
      }
    }
  }, 15000);
});
