import { execSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildActorBwrapArgs } from "./sandbox.js";
import { runSubprocess } from "./subprocess-execution.js";
import { buildExitResult, buildKilledResult, buildSignalResult, buildSpawnErrorResult } from "./termination-attribution.js";

function probeBwrapCapable(): boolean {
  try {
    execSync("bwrap --unshare-user --uid 1000 --gid 1000 -- true", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
const BWRAP_CAPABLE = probeBwrapCapable();

describe.skipIf(!BWRAP_CAPABLE)("Sandbox — transitive process-group kill inside bwrap (Issue #164 leg 1)", () => {
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

  it("sandbox with --new-session protects CLI from its own tool-timeout group kill", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "mc-sandbox-pgkill-"));
    temps.push(tmp);

    const script = join(tmp, "fake-cli.sh");
    // A fake "provider CLI" running inside bwrap.
    writeFileSync(
      script,
      [
        "#!/bin/bash",
        "set -euo pipefail",
        // Spawn a child command (NO set -m, so it shares the CLI's process group)
        "( sleep 300 ) &",
        "CHILD=$!",
        "sleep 0.15",
        "PGID=$(ps -o pgid= $CHILD | tr -d ' ')",
        // Kill the child's process group, as the real CLI does on tool timeout
        "kill -KILL -- -$PGID",
        // CLI should survive and exit 0
      ].join("\n")
    );
    chmodSync(script, 0o755);

    const bwrapArgs = buildActorBwrapArgs(
      tmp,
      undefined,
      undefined,
      false // isE2eRoot: false ensures --new-session is applied
    );
    temps.push(...bwrapArgs.tempPaths);

    const runPromise = runSubprocess({
      command: "bwrap",
      args: [...bwrapArgs.args, script],
      cwd: tmp,
      timeoutMs: 5000,
      buildKilledResult,
      buildSignalResult,
      buildExitResult,
      buildSpawnErrorResult,
    });

    const result = await runPromise;

    // Without --new-session, the CLI's PGID is 0, so kill -0 kills the CLI itself (exit 137).
    // With --new-session, the CLI's PGID is 1, and kill -1 is a broadcast that excludes the sender, so the CLI survives.
    expect(result.success).toBe(true);
    // Make sure we didn't exit 137
    if (!result.success) {
      expect((result as any).exitCode).not.toBe(137);
    }
  });
});
