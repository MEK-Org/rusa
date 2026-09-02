import { execSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";

import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildMeshActorBwrapArgs } from "./sandbox.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getHostPidByCmd(cmdMarker: string): number | null {
  try {
    const output = execSync(`pgrep -f "^${cmdMarker} 300$"`, { encoding: "utf8" }).trim();
    if (output) {
      const pid = parseInt(output.split("\n")[0], 10);
      if (!Number.isNaN(pid)) return pid;
    }
  } catch {
    return null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Sandbox — transitive process-group kill inside bwrap (Issue #164 leg 1)", () => {
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

    const cliPidFile = join(tmp, "cli.pid");
    const script = join(tmp, "fake-cli.sh");
    // Generate a unique marker for the descendant to identify it safely from the host
    const uniqueMarker = `rusa-descendant-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    // A fake "provider CLI" running inside bwrap.
    writeFileSync(
      script,
      [
        "#!/bin/bash",
        "set -euo pipefail",
        "",
        // 1. Spawn a child in a new process group (using monitor mode)
        "set -m",
        "( exec sleep 300 ) &",
        "CHILD=$!",
        "set +m",
        "sleep 0.15",
        "PGID=$(ps -o pgid= $CHILD | tr -d ' ')",
        "",
        // 2. Kill the child's process group, as the real CLI does on tool timeout
        "kill -KILL -- -$PGID",
        "",
        // 3. Prove its target dies (inner kill success is observable/asserted)
        "wait $CHILD 2>/dev/null || true",
        "if kill -0 $CHILD 2>/dev/null; then",
        "  echo 'Target did not die!' >&2",
        "  exit 1",
        "fi",
        "",
        // 4. Fake CLI survives its own group kill (if --new-session wasn't used, the CLI would share the PGID and die here)
        `echo alive > ${cliPidFile}`,
        "",
        // 5. Spawn a later long-lived descendant for outside-in abort
        // Uses exec -a to set argv[0] so the outer test can pgrep it uniquely on the host
        `exec -a ${uniqueMarker} sleep 300`,
      ].join("\n")
    );
    chmodSync(script, 0o755);

    const bwrapArgs = buildMeshActorBwrapArgs({
      actorDir: tmp,
      isE2eRoot: false, // Ensures --new-session is applied
    });

    const child = spawn("bwrap", [...bwrapArgs.args, script], {
      detached: true, // For outside-in reap
      stdio: "ignore",
    });

    let exitCode: number | null = null;
    child.on("exit", (code, signal) => {
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

    // Find the host PID of the long-lived descendant
    let descendantHostPid: number | null = null;
    const findDeadline = Date.now() + 5000;
    while (Date.now() < findDeadline) {
      descendantHostPid = getHostPidByCmd(uniqueMarker);
      if (descendantHostPid) break;
      await new Promise((r) => setTimeout(r, 50));
    }

    expect(descendantHostPid).not.toBeNull();
    const pidToKill = descendantHostPid as number;
    // Sanity check: prove it's alive on the host before abort
    expect(() => process.kill(pidToKill, 0)).not.toThrow();

    // Now test outside-in reap (abort)
    // Kill the bwrap process group (child.pid)
    if (child.pid) {
      process.kill(-child.pid, "SIGKILL");
    }

    // Wait for bwrap to exit
    await new Promise((r) => {
      if (exitCode !== null) r(null);
      else child.on("exit", () => r(null));
    });

    expect(exitCode).toBe(137);

    // Give OS a moment to reap the descendant process tree
    await new Promise((r) => setTimeout(r, 150));

    // THE ARBITER ASSERTION:
    // Prove outside-in abort leaves the later long-lived descendant dead
    expect(() => process.kill(pidToKill, 0)).toThrow(); // Should throw ESRCH
  });
});
