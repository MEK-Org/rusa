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

/**
 * A pid and pgid this run demonstrably is not.
 *
 * The guards short-circuit in order, so which branch catches a target depends
 * on the identity the sandbox handed this run: under `bwrap --new-session` our
 * own pgid is 1 and the broadcast guard fires first, and a shell-led run has
 * its group leader as its parent. Injecting an identity pins the branch under
 * test without that lottery.
 */
const FOREIGN = (() => {
  let candidate = 4242;
  while (candidate === process.pid || candidate === process.ppid) candidate += 1;
  return candidate;
})();

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

  it("refuses the caller's own process group, whichever guard catches it", () => {
    const rec = recorder();
    const own = ownProcessGroupId();

    const outcome = reapProcessGroup(own, { send: rec.send });

    // Nothing sent is the invariant; the wording is not, because an own pgid
    // of 1 is caught by the broadcast guard before the own-group one. The
    // refusal still has to name the number it declined. The own-group branch
    // itself is pinned by injected identity below.
    expect(outcome.signalled).toBe(false);
    expect(outcome.refusedBecause).toContain(String(own));
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

  it("refuses direct kills of init, of this run, of its parent and of its group leader", () => {
    const rec = recorder();

    // These four collapse onto each other under some identities - ppid is 1
    // for a reparented runner, the group leader is 1 under `--new-session` and
    // is the parent for a shell-led run. What holds for every identity is that
    // each is refused, nothing is sent, and the refusal names the number.
    for (const target of [1, process.pid, process.ppid, ownProcessGroupId()]) {
      const outcome = reapProcess(target, { send: rec.send });
      expect(outcome.signalled).toBe(false);
      expect(outcome.refusedBecause).toContain(String(target));
    }
    expect(rec.sent).toEqual([]);
  });

  it("names why each unsafe target was refused", () => {
    expect(unsafeGroupReason(1)).toContain("broadcast");
    expect(unsafeGroupReason(ownProcessGroupId())).toBeDefined();
    expect(unsafeGroupReason(FOREIGN, 99)).toBeUndefined();
    expect(unsafeProcessReason(1)).toContain("init");
    expect(unsafeProcessReason(FOREIGN, 99)).toBeUndefined();

    // The own-group branches, pinned on an id this run cannot be so they are
    // asserted whatever pgid the sandbox gave us.
    expect(unsafeGroupReason(FOREIGN, FOREIGN)).toContain("own group");
    expect(unsafeProcessReason(FOREIGN, FOREIGN)).toContain("own group");
    // The branches that read this run's real identity, where it can tell them
    // apart: a pid of 1 is init before it is anything else.
    if (process.pid > 1) expect(unsafeProcessReason(process.pid)).toContain("caller itself");
    if (process.ppid > 1 && process.ppid !== process.pid) {
      expect(unsafeProcessReason(process.ppid)).toContain("parent");
    }
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

    // The wait for the grandchild's pid is inside the try: a child that never
    // reports must still be reaped, or a timeout here leaks the tree it made.
    let grandchildPid: number | undefined;
    try {
      grandchildPid = await new Promise<number>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("grandchild never reported its pid")),
          5_000
        );
        child.stdout?.on("data", (d: Buffer) => {
          const parsed = Number(d.toString().trim().split("\n")[0]);
          if (Number.isInteger(parsed) && parsed > 1) {
            clearTimeout(timer);
            resolve(parsed);
          }
        });
      });

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
      // The group reap covers the grandchild; the direct one is the backstop
      // for a grandchild that somehow left the group before we got here.
      reapProcessGroup(pid);
      if (grandchildPid !== undefined) reapProcess(grandchildPid);
    }
  });
});
