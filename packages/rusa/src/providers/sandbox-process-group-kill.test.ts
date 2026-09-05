import { execFileSync, execSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildActorBwrapArgs } from "./sandbox.js";
import { runSubprocess } from "./subprocess-execution.js";

function probeBwrapCapable(): boolean {
  try {
    execFileSync("bwrap", ["--ro-bind", "/", "/", "--", "/bin/true"], { stdio: "ignore" });
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

    it("refuses a group kill that resolves to its own group, reaps a setsid one", async () => {
      const tmp = mkdtempSync(join(tmpdir(), "mc-sandbox-pgkill-"));
      temps.push(tmp);

      const script = join(tmp, "fake-cli.sh");
      // A fake "provider CLI" running inside bwrap, exercising both shapes of
      // the group kill a real CLI issues when a tool times out.
      //
      // The first shape is the one that made this test itself dangerous: a
      // child started without a session of its own shares the CLI's group, so
      // the group kill resolves to the CLI - and under --new-session that group
      // is 1, where a negative-pid kill is a namespace-wide broadcast sparing
      // only the sender. Proving that by firing it and checking the CLI
      // survived only holds while the PID namespace does; anywhere it does not,
      // the same line takes out the runner and everything beside it. So the
      // hazard is now observed and reported, never sent.
      //
      // The second shape is the cleanup a CLI should do: setsid gives the child
      // tree a group of its own, the guard proves that group is neither init,
      // nor a broadcast, nor the caller's, and only then is it signalled.
      writeFileSync(
        script,
        [
          "#!/bin/bash",
          "set -uo pipefail",
          'SELF_PGID=$(ps -o pgid= $$ | tr -d " ")',
          'echo "SELF_PGID=$SELF_PGID"',
          "( sleep 300 ) &",
          "SHARED=$!",
          "sleep 0.15",
          'SHARED_PGID=$(ps -o pgid= $SHARED | tr -d " ")',
          'if [ -z "$SHARED_PGID" ] || [ "$SHARED_PGID" -le 1 ] || [ "$SHARED_PGID" = "$SELF_PGID" ]; then',
          '  echo "REFUSED_SELF_GROUP shared_pgid=$SHARED_PGID self_pgid=$SELF_PGID"',
          "else",
          '  echo "SEPARATE_WITHOUT_SETSID shared_pgid=$SHARED_PGID self_pgid=$SELF_PGID"',
          "fi",
          "kill -KILL $SHARED 2>/dev/null",
          "export PIDS=/tmp/rusa-owned-group.$$.pids",
          "setsid bash -c 'echo $$ > $PIDS; sleep 300 & echo $! >> $PIDS; wait' &",
          "for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do",
          '  [ -f $PIDS ] && [ "$(wc -l < $PIDS)" -ge 2 ] && break',
          "  sleep 0.1",
          "done",
          "LEADER=$(sed -n 1p $PIDS)",
          "GRANDCHILD=$(sed -n 2p $PIDS)",
          'OWNED_PGID=$(ps -o pgid= $LEADER | tr -d " ")',
          'echo "OWNED leader=$LEADER grandchild=$GRANDCHILD pgid=$OWNED_PGID"',
          'if [ -z "$OWNED_PGID" ] || [ "$OWNED_PGID" -le 1 ] || [ "$OWNED_PGID" = "$SELF_PGID" ]; then',
          '  echo "UNSAFE_OWNED_GROUP pgid=$OWNED_PGID self_pgid=$SELF_PGID"',
          "  exit 3",
          "fi",
          "kill -KILL -- -$OWNED_PGID",
          "sleep 0.2",
          'if kill -0 $GRANDCHILD 2>/dev/null; then echo "GRANDCHILD_SURVIVED"; exit 4; fi',
          'echo "REAPED_OWNED_GROUP pgid=$OWNED_PGID"',
          "exit 0",
        ].join("\n")
      );
      chmodSync(script, 0o755);

      const bwrapArgs = buildActorBwrapArgs(tmp, undefined, undefined, false);
      temps.push(...bwrapArgs.tempPaths);

      const runPromise = runSubprocess({
        command: "bwrap",
        args: [...bwrapArgs.args, script],
        cwd: tmp,
        timeoutMs: 15000,
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

      // The CLI is still standing because the unsafe kill was never sent - not
      // because a broadcast happened to spare it.
      expect(result.output).toContain("REFUSED_SELF_GROUP");
      expect(result.output).toContain("REAPED_OWNED_GROUP");
      expect(result.output).not.toContain("GRANDCHILD_SURVIVED");
      expect(result.success).toBe(true);
      expect(result.exitCode).toBe(0);
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

describe("Sandbox provider args generation (always executed)", () => {
  it("includes exactly one --new-session for actor isolation (issue #164)", () => {
    const result = buildActorBwrapArgs("/tmp/fake", undefined, undefined, false);
    expect(result.args.filter((a) => a === "--new-session")).toHaveLength(1);
  });

  it("omits --new-session for e2e-root", () => {
    const result = buildActorBwrapArgs("/tmp/fake", undefined, undefined, true);
    expect(result.args.filter((a) => a === "--new-session")).toHaveLength(0);
  });
});
