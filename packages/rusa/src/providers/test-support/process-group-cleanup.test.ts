/**
 * The arbiter for the guarded cleanup helpers (#262).
 *
 * Every unsafe case here is proven with a recording `send`, so the assertions
 * describe a signal that was never delivered - the one shape of this bug that
 * must never be reproduced for real is a runner killing its own group. The
 * safe cases use a disposable `setsid` child of this test, so real signalling
 * is exercised without aiming at anything that outlives it.
 *
 * Delete a guard in process-group-cleanup.ts and the refusal cases go RED:
 * `send` records `-1`, `-0` or the runner's own group instead of nothing.
 */

import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  groupStillHosts,
  ownProcessGroupId,
  processTable,
  reapProcess,
  reapProcessGroup,
  unsafeGroupReason,
  unsafeProcessReason,
} from "./process-group-cleanup.js";

/** Records intended targets instead of delivering them. */
function recorder() {
  const sent: Array<{ target: number; signal: NodeJS.Signals }> = [];
  return {
    sent,
    send: (target: number, signal: NodeJS.Signals) => {
      sent.push({ target, signal });
    },
  };
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForDeath(pid: number, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

describe("guarded process-group cleanup (#262)", () => {
  it("refuses to signal group 1, which broadcasts to every reachable process", () => {
    const rec = recorder();

    const outcome = reapProcessGroup(1, { send: rec.send });

    expect(outcome.signalled).toBe(false);
    expect(outcome.refusedBecause).toMatch(/broadcast/);
    expect(rec.sent).toEqual([]);
  });

  it("refuses group 0, which the kernel reads as the caller's own group", () => {
    const rec = recorder();

    const outcome = reapProcessGroup(0, { send: rec.send });

    expect(outcome.signalled).toBe(false);
    expect(rec.sent).toEqual([]);
  });

  it("refuses the caller's own process group", () => {
    const rec = recorder();
    const own = ownProcessGroupId();

    const outcome = reapProcessGroup(own, { send: rec.send });

    expect(outcome.signalled).toBe(false);
    expect(outcome.refusedBecause).toContain("own group");
    expect(rec.sent).toEqual([]);
  });

  it("refuses a group id that is not a group id", () => {
    const rec = recorder();

    expect(reapProcessGroup(Number.NaN, { send: rec.send }).signalled).toBe(false);
    expect(reapProcessGroup(-7, { send: rec.send }).signalled).toBe(false);
    expect(rec.sent).toEqual([]);
  });

  it("fails closed when the caller's own group cannot be determined", () => {
    const rec = recorder();

    const outcome = reapProcessGroup(4242, { send: rec.send, ownPgid: Number.NaN });

    expect(outcome.signalled).toBe(false);
    expect(rec.sent).toEqual([]);
  });

  it("signals a separate child group as a negative pid", () => {
    const rec = recorder();

    const outcome = reapProcessGroup(4242, { send: rec.send, ownPgid: 99 });

    expect(outcome.signalled).toBe(true);
    expect(rec.sent).toEqual([{ target: -4242, signal: "SIGKILL" }]);
  });

  it("refuses direct kills of init, of this process, and of its parent", () => {
    const rec = recorder();

    expect(reapProcess(1, { send: rec.send }).refusedBecause).toContain("init");
    expect(reapProcess(process.pid, { send: rec.send }).refusedBecause).toContain("caller itself");
    expect(reapProcess(process.ppid, { send: rec.send }).refusedBecause).toContain("parent");
    expect(reapProcess(ownProcessGroupId(), { send: rec.send }).refusedBecause).toContain(
      "own group"
    );
    expect(rec.sent).toEqual([]);
  });

  it("names why each unsafe target was refused", () => {
    expect(unsafeGroupReason(1)).toBeDefined();
    expect(unsafeGroupReason(ownProcessGroupId())).toBeDefined();
    expect(unsafeGroupReason(4242, 99)).toBeUndefined();
    expect(unsafeProcessReason(1)).toBeDefined();
    expect(unsafeProcessReason(4242, 99)).toBeUndefined();
  });

  it("reads pgid and argv out of the process table", () => {
    const rows = processTable(() => "  1 bwrap --unshare-all\n 812 sleep 300\n\n");

    expect(rows).toEqual([
      { pgid: 1, args: "bwrap --unshare-all" },
      { pgid: 812, args: "sleep 300" },
    ]);
  });

  it("treats a recycled group id as no longer hosting the probe", () => {
    const stillOurs = () => " 812 timeout 90 /tmp/probe-cli.sh\n 812 /tmp/probe-cli.sh\n";
    const recycled = () => " 812 postgres: background writer\n";

    expect(groupStillHosts(812, "/tmp/probe-cli.sh", stillOurs)).toBe(true);
    expect(groupStillHosts(812, "/tmp/probe-cli.sh", recycled)).toBe(false);
  });

  it("still reaps a real setsid child group, descendants included", async () => {
    // `detached` is setsid: the child leads a new group, so its pgid is its pid.
    const child = spawn("bash", ["-c", "sleep 300 & echo $!; wait"], {
      detached: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const pid = child.pid;
    expect(pid).toBeDefined();
    if (pid === undefined) return;

    const grandchildPid = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("grandchild never reported its pid")), 5_000);
      child.stdout?.on("data", (d: Buffer) => {
        const parsed = Number(d.toString().trim().split("\n")[0]);
        if (Number.isInteger(parsed) && parsed > 1) {
          clearTimeout(timer);
          resolve(parsed);
        }
      });
    });

    try {
      // The group is demonstrably separate: not ours, not init, not a broadcast.
      expect(pid).toBeGreaterThan(1);
      expect(pid).not.toBe(ownProcessGroupId());
      expect(unsafeGroupReason(pid)).toBeUndefined();
      expect(groupStillHosts(pid, "sleep 300")).toBe(true);
      expect(isAlive(grandchildPid)).toBe(true);

      const outcome = reapProcessGroup(pid);

      expect(outcome.signalled).toBe(true);
      expect(await waitForDeath(pid)).toBe(true);
      // Outside-in reaping is the whole point: the grandchild goes too.
      expect(await waitForDeath(grandchildPid)).toBe(true);
    } finally {
      reapProcessGroup(pid);
      reapProcess(grandchildPid);
    }
  });
});
