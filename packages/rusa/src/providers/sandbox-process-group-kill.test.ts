import { execSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildActorBwrapArgs } from "./sandbox.js";
import { runSubprocess } from "./subprocess-execution.js";

function probeBwrapCapable(): boolean {
  try {
    execSync("bwrap --unshare-user --uid 1000 --gid 1000 -- true", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
const BWRAP_CAPABLE = probeBwrapCapable();

describe.skipIf(!BWRAP_CAPABLE)(
  "Sandbox — transitive process-group kill inside bwrap (Issue #164 leg 1)",
  () => {
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

      const bwrapArgs = buildActorBwrapArgs(tmp, undefined, undefined, false);
      temps.push(...bwrapArgs.tempPaths);

      const runPromise = runSubprocess({
        command: "bwrap",
        args: [...bwrapArgs.args, script],
        cwd: tmp,
        timeoutMs: 5000,
        buildKilledResult: (sig) => ({
          success: false,
          exitCode: sig.exitCode,
          output: sig.output,
          cancelled: true,
        }),
        buildSignalResult: (sig) => ({
          success: false,
          exitCode: sig.exitCode,
          output: sig.output,
          cancelled: true,
        }),
        buildExitResult: (out, code) => ({ success: code === 0, exitCode: code, output: out }),
        buildSpawnErrorResult: (err) => ({ success: false, exitCode: 1, output: err.message }),
      });

      const result = await runPromise;

      // Without --new-session, the CLI's PGID is 0, so kill -0 kills the CLI itself (exit 137).
      // With --new-session, the CLI's PGID is 1, and kill -1 is a broadcast that excludes the sender, so the CLI survives.
      expect(result.success).toBe(true);
      if (!result.success) {
        expect(result.exitCode).not.toBe(137);
      }
    });

    it("aborting runSubprocess from outside kills grandchild processes inside bwrap", async () => {
      const tmp = mkdtempSync(join(tmpdir(), "mc-sandbox-pgkill-abort-"));
      temps.push(tmp);

      const script = join(tmp, "fake-cli-long.sh");
      const uniqueSleep = "314159";
      writeFileSync(
        script,
        [
          "#!/bin/bash",
          "set -euo pipefail",
          `sleep ${uniqueSleep} &`,
          'echo "STARTED"',
          "wait",
        ].join("\n")
      );
      chmodSync(script, 0o755);

      const bwrapArgs = buildActorBwrapArgs(tmp, undefined, undefined, false);
      temps.push(...bwrapArgs.tempPaths);

      const ac = new AbortController();
      let started = false;

      const runPromise = runSubprocess({
        command: "bwrap",
        args: [...bwrapArgs.args, script],
        cwd: tmp,
        timeoutMs: 5000,
        signal: ac.signal,
        onStdout: (text) => {
          if (text.includes("STARTED")) {
            started = true;
            // Yield to let the shell's sleep spawn
            setTimeout(() => {
              ac.abort("interrupt:test");
            }, 100);
          }
        },
        buildKilledResult: (sig) => ({
          success: false,
          exitCode: sig.exitCode,
          output: sig.output,
          cancelled: true,
        }),
        buildSignalResult: (sig) => ({
          success: false,
          exitCode: sig.exitCode,
          output: sig.output,
          cancelled: true,
        }),
        buildExitResult: (out, code) => ({ success: code === 0, exitCode: code, output: out }),
        buildSpawnErrorResult: (err) => ({ success: false, exitCode: 1, output: err.message }),
      });

      const result = await runPromise;
      expect(started).toBe(true);
      expect(result.cancelled).toBe(true);

      // Give it a tiny moment to die on host
      await new Promise((r) => setTimeout(r, 100));

      let isDead = false;
      try {
        execSync(`ps -ef | grep 'sleep ${uniqueSleep}' | grep -v grep`);
      } catch {
        isDead = true; // grep returns 1 if nothing found
      }
      expect(isDead).toBe(true);
    });
  }
);
