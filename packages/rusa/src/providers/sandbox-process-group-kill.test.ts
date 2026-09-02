import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";

import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildMeshActorBwrapArgs } from "./sandbox.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Sandbox — transitive process-group kill inside bwrap (ISSUE_NUM leg 1)", () => {
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

  it("sandbox with --new-session protects CLI from its own tool-timeout group kill, and outside-in reap still works", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "mc-sandbox-pgkill-"));
    temps.push(tmp);

    const grandchildPidFile = join(tmp, "grandchild.pid");
    const cliPidFile = join(tmp, "cli.pid");
    const script = join(tmp, "fake-cli.sh");

    // A fake "provider CLI" running inside bwrap.
    // It spawns a long-lived grandchild, records both PIDs.
    // Then it tries to kill its child's process group, just like the real CLI killing a timed-out tool.
    // If it shares the process group (no --new-session), getpgid() returns 0, and killpg(0) kills the CLI itself.
    writeFileSync(
      script,
      [
        "#!/bin/bash",
        // Record our own PID so the test knows the CLI's host PID (bwrap child)
        // Wait, inside bwrap the PID namespace is unshared, so BASHPID is 2.
        // We can't use the inside PID to check liveness from the outside test.
        // But we can check if bwrap itself exits 137.
        // Let's spawn the child:
        `( echo $BASHPID > ${grandchildPidFile}; exec sleep 300 ) &`,
        "CHILD=$!",
        "sleep 0.15",
        "PGID=$(ps -o pgid= $CHILD | tr -d ' ')",
        "kill -KILL -- -$PGID",
        `echo alive > ${cliPidFile}`,
        "exec sleep 300",
      ].join("\n")
    );
    chmodSync(script, 0o755);

    const bwrapArgs = buildMeshActorBwrapArgs({
      actorDir: tmp,
      isE2eRoot: false,
    });

    // Run the fake CLI inside the sandbox
    const child = spawn("bwrap", [...bwrapArgs.args, script], {
      detached: true, // For outside-in reap
      stdio: "ignore",
    });

    let exitCode: number | null = null;
    child.on("exit", (code, signal) => {
      // signal is null if it exited, code is 137 if it was SIGKILLed
      exitCode = signal ? (signal === "SIGKILL" ? 137 : 143) : code;
    });

    // Wait for the CLI to declare it survived the inner group kill
    const deadline = Date.now() + 5000;
    let survived = false;
    while (Date.now() < deadline) {
      if (existsSync(cliPidFile)) {
        survived = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }

    expect(survived).toBe(true);
    expect(exitCode).toBeNull(); // Still running

    // Now test outside-in reap (abort)
    // Kill the bwrap process group (child.pid)
    if (child.pid) {
      process.kill(-child.pid, "SIGKILL");
    }

    // Wait for exit
    await new Promise((r) => {
      if (exitCode !== null) r(null);
      else child.on("exit", () => r(null));
    });

    expect(exitCode).toBe(137);
  });
});
