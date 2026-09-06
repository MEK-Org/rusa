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
import { afterEach, describe, expect, it } from "vitest";
import type { ProviderConfig } from "../config/types.js";
import { CopilotProvider } from "./copilot.js";
import { YIELD_GRACE_ABORT_REASON } from "./termination-attribution.js";

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
   * THE ARBITER TEST.
   *
   * Remove `detached: true` from copilot.ts → this goes RED.
   * Mechanism: without detached, process.kill(-child.pid) throws ESRCH
   * (no process group with PGID = child.pid exists), the catch swallows it,
   * the grandchild is never signalled, and isAlive(grandchildPid) returns true.
   */
  it("killGroup() reaps grandchild: remove detached:true from copilot.ts to see RED", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "mc-pgkill-"));
    temps.push(tmp);

    const grandchildPidFile = join(tmp, "grandchild.pid");
    const script = join(tmp, "fake-copilot.sh");

    // A fake "provider CLI" that spawns a long-lived grandchild, then idles.
    // The grandchild writes its own PID so the test can probe liveness.
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

    // Fire the abort — mirrors actor stall-watchdog or ceiling firing
    controller.abort("stall-watchdog");

    // Adapter settles once the group is killed
    const result = await runPromise;
    expect(result.success).toBe(false);
    expect(result.cancelled).toBe(true);

    // Give OS a moment to reap the group
    await new Promise((r) => setTimeout(r, 150));

    // THE ARBITER ASSERTION:
    // With detached:true + process.kill(-pid, SIGKILL): grandchild is dead → false
    // Without detached:true: ESRCH on kill, grandchild survives → true → RED
    expect(isAlive(grandchildPid)).toBe(false);
  });

  // #257: the supervisor's post-yield grace kill takes this same path, so the
  // descendants of a CLI that outlived its yield are reaped too — and the run
  // comes back attributed as a cleanup termination rather than a bare SIGTERM.
  it("reaps the grandchild and attributes the kill when the yield grace period is exceeded", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "mc-pgkill-yield-"));
    temps.push(tmp);

    const grandchildPidFile = join(tmp, "grandchild.pid");
    const script = join(tmp, "fake-copilot.sh");

    writeFileSync(
      script,
      [
        "#!/bin/bash",
        `( echo $BASHPID > ${grandchildPidFile}; exec sleep 300 ) &`,
        "sleep 0.15",
        // The CLI that has already yielded but will not exit on its own.
        "exec sleep 300",
      ].join("\n")
    );
    chmodSync(script, 0o755);

    const provider = new CopilotProvider("copilot", { cliCommand: script });
    const controller = new AbortController();
    const runPromise = provider.run({ prompt: "test", cwd: tmp, signal: controller.signal });

    const grandchildPid = await waitForPidFile(grandchildPidFile);
    expect(isAlive(grandchildPid)).toBe(true);

    controller.abort(YIELD_GRACE_ABORT_REASON);

    const result = await runPromise;
    expect(result.graceKilled).toBe(true);
    expect(result.exitCode).toBe(143);
    expect(result.output).toContain("[Task killed by supervisor (yield grace period exceeded)]");

    await new Promise((r) => setTimeout(r, 150));
    expect(isAlive(grandchildPid)).toBe(false);
  });
});
