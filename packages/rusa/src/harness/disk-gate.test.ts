import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  calibrationNote,
  checkFreeSpace,
  createRunDiskWatch,
  type DiskUsageReport,
  DiskUsageSampler,
  dirSizeBytes,
  type FreeSpaceReading,
  nearestExistingPath,
  readFreeSpace,
  type SamplerDeps,
} from "./disk-gate.js";

/** More free space than any floor a cell below sets — "the device is fine" as a fixture. */
const ROOMY: FreeSpaceReading = {
  outcome: "read",
  availableBytes: 1024 ** 4,
  measuredPath: "/x",
};
/**
 * A floor that is a real comparison (non-zero, so `<` is actually evaluated) and that
 * {@link ROOMY} clears by six orders of magnitude — for the cells that are about peak
 * accounting rather than about headroom.
 */
const FLOOR_NOT_UNDER_TEST = 1024;

/**
 * Whether `chmod 000` is actually enforced HERE — as root it is not, and the permission
 * cells would then assert on a precondition the environment never established.
 */
const canDenyRead = (() => {
  const probe = mkdtempSync(join(tmpdir(), "disk-perm-"));
  try {
    mkdirSync(join(probe, "d"));
    chmodSync(join(probe, "d"), 0o000);
    readdirSync(join(probe, "d"));
    return false;
  } catch {
    return true;
  } finally {
    chmodSync(join(probe, "d"), 0o755);
    rmSync(probe, { recursive: true, force: true });
  }
})();

/**
 * Drives the sampler's interval by hand so the test has no timers and no disk.
 *
 * `free` is per-sample like `readings`, and short arrays clamp to their last entry, so a
 * cell only has to spell out the samples it cares about. Omitting it entirely means
 * {@link ROOMY} throughout — the device is never the subject of that cell.
 */
function fakeDeps(
  readings: number[],
  incompleteAt: number[] = [],
  free: FreeSpaceReading[] = [ROOMY]
): SamplerDeps & { tick: () => void } {
  let i = 0;
  let f = 0;
  let fn: (() => void) | null = null;
  return {
    measure: () => {
      const n = i++;
      return {
        bytes: readings[Math.min(n, readings.length - 1)],
        complete: !incompleteAt.includes(n),
      };
    },
    readFree: () => free[Math.min(f++, free.length - 1)],
    setInterval: (cb) => {
      fn = cb;
      return "h";
    },
    clearInterval: () => {
      fn = null;
    },
    tick: () => fn?.(),
  };
}

describe("nearestExistingPath", () => {
  it("returns the path itself when it exists", () => {
    expect(nearestExistingPath(process.cwd())).toEqual({
      outcome: "found",
      path: resolve(process.cwd()),
    });
  });

  it("walks up to the nearest existing ancestor", () => {
    const missing = join(process.cwd(), "no-such-dir", "nor-this-one");
    expect(nearestExistingPath(missing)).toEqual({
      outcome: "found",
      path: resolve(process.cwd()),
    });
  });

  it("bottoms out at the filesystem root rather than looping", () => {
    expect(nearestExistingPath("/definitely/not/a/path/anywhere")).toEqual({
      outcome: "found",
      path: "/",
    });
  });

  it.runIf(canDenyRead)("REFUSES to climb past an entry it could not read", () => {
    // The fifth-round finding, and the same defect one module over: `existsSync` FOLLOWS the
    // link, so an instance root symlinked into a locked tree answered `false` — identical to
    // "no such entry" — and the loop climbed to the parent. The gate then measured the
    // ancestor's filesystem and reported its free bytes under this path's name. Only ENOENT
    // is permission to climb.
    const root = mkdtempSync(join(tmpdir(), "disk-gate-"));
    try {
      mkdirSync(join(root, "locked", "store"), { recursive: true });
      symlinkSync("./locked/store", join(root, "instance"));
      chmodSync(join(root, "locked"), 0o000);
      const nearest = nearestExistingPath(join(root, "instance"));
      // The ENTRY is right there — lstat sees it — so this is not an absence at all.
      expect(nearest).toEqual({ outcome: "found", path: join(root, "instance") });

      // ...and one level up, where the entry genuinely cannot be read, the answer is
      // "unknown", never the grandparent.
      const buried = nearestExistingPath(join(root, "locked", "store", "run"));
      expect(buried.outcome).toBe("unknown");
      if (buried.outcome === "unknown") expect(buried.code).toBe("EACCES");
    } finally {
      chmodSync(join(root, "locked"), 0o755);
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("checkFreeSpace", () => {
  it("passes when the filesystem has room", () => {
    const check = checkFreeSpace(process.cwd(), 1);
    expect(check.ok).toBe(true);
    expect(check.availableBytes).toBeGreaterThan(0);
  });

  it("fails loudly when it does not", () => {
    const check = checkFreeSpace(process.cwd(), Number.MAX_SAFE_INTEGER);
    expect(check.ok).toBe(false);
    expect(check.message).toContain("INSUFFICIENT");
  });

  it("STILL ENFORCES on an instance root that does not exist yet (the gate's real config)", () => {
    // The regression. The gate runs before provisioning, so with an explicit --root —
    // which the G2-v3 runbook MANDATES, because $HOME is read-only on a worker plane —
    // the directory is not there yet. statfs threw ENOENT, the "cannot measure ⇒ do not
    // block" bias turned that into ok:true, and a launch demanding 930 GiB sailed
    // through on a filesystem with 2.0 GiB free. Measuring the nearest existing
    // ancestor asks the question the gate always meant to ask: is there room on THIS
    // FILESYSTEM. Same failure class as AGED-OUT ✓ — green while measuring nothing.
    const notYetCreated = join(process.cwd(), "g2v3-run-that-does-not-exist");
    const check = checkFreeSpace(notYetCreated, Number.MAX_SAFE_INTEGER);
    expect(check.ok).toBe(false);
    expect(check.message).toContain("INSUFFICIENT");
    expect(check.measuredPath).toBe(resolve(process.cwd()));
    // ...and the message must say WHERE it measured, since that is the first question
    // a surprising verdict raises.
    expect(check.message).toContain("measured at");
  });

  it.runIf(canDenyRead)("says NOT ENFORCED rather than measuring the wrong filesystem", () => {
    // Both halves of the fifth-round finding, at the gate: an instance root it cannot
    // resolve must produce a refusal to measure, never a verdict from some other device.
    const root = mkdtempSync(join(tmpdir(), "disk-gate-"));
    try {
      mkdirSync(join(root, "locked", "store"), { recursive: true });
      symlinkSync("./locked/store", join(root, "instance"));
      chmodSync(join(root, "locked"), 0o000);

      // The link resolves nowhere readable: statfs cannot answer, so the gate does not.
      const viaLink = checkFreeSpace(join(root, "instance"), 1);
      expect(viaLink.message).toContain("NOT ENFORCED");
      expect(viaLink.measuredPath).toBe(join(root, "instance"));

      // A path whose own existence is unreadable: the climb is refused outright, and
      // `measuredPath` is null because nothing was measured.
      const buried = checkFreeSpace(join(root, "locked", "store", "run"), 1);
      expect(buried.message).toContain("NOT ENFORCED");
      expect(buried.message).toContain("EACCES");
      expect(buried.measuredPath).toBeNull();
      expect(buried.availableBytes).toBe(-1);
    } finally {
      chmodSync(join(root, "locked"), 0o755);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports the measured path plainly when it is the requested path", () => {
    const check = checkFreeSpace(process.cwd(), 1);
    expect(check.measuredPath).toBe(resolve(process.cwd()));
    expect(check.message).not.toContain("measured at");
  });
});

describe("DiskUsageSampler", () => {
  it("keeps the PEAK, not the final reading", () => {
    const deps = fakeDeps([10, 90, 20]);
    const sampler = new DiskUsageSampler("/x", 1000, FLOOR_NOT_UNDER_TEST, deps);
    sampler.start(); // 10
    deps.tick(); // 90
    const report = sampler.stop(); // 20
    expect(report.peakBytes).toBe(90);
    expect(report.finalBytes).toBe(20);
    expect(report.sampleCount).toBe(3);
  });

  it("is idempotent on start and always reports its sample count", () => {
    const deps = fakeDeps([5]);
    const sampler = new DiskUsageSampler("/x", 1000, FLOOR_NOT_UNDER_TEST, deps);
    sampler.start();
    sampler.start();
    const report = sampler.stop();
    expect(report.sampleCount).toBe(2); // start + stop, not three
    expect(report.intervalMs).toBe(1000);
  });

  it("reports a clean run as complete, so the flag is not always-false", () => {
    const deps = fakeDeps([10, 20]);
    const sampler = new DiskUsageSampler("/x", 1000, FLOOR_NOT_UNDER_TEST, deps);
    sampler.start();
    expect(sampler.stop().complete).toBe(true);
  });

  it("stays incomplete after ONE bad sample, even if later ones are clean", () => {
    // Sticky on purpose: a peak is a claim about the whole run, so a walk that missed part
    // of the tree at any point makes the reported peak a floor. A later clean sample cannot
    // recover the bytes it never saw.
    const deps = fakeDeps([10, 90, 20], [1]);
    const sampler = new DiskUsageSampler("/x", 1000, FLOOR_NOT_UNDER_TEST, deps);
    sampler.start(); // sample 0, clean
    deps.tick(); // sample 1, incomplete
    const report = sampler.stop(); // sample 2, clean
    expect(report.complete).toBe(false);
    expect(report.peakBytes).toBe(90);
  });
});

describe("DiskUsageSampler free-space watch (ISSUE_NUM leg 2)", () => {
  const MB = 1024 * 1024;
  const avail = (bytes: number): FreeSpaceReading => ({
    outcome: "read",
    availableBytes: bytes,
    measuredPath: "/x",
  });
  const cannotTell = (reason: string): FreeSpaceReading => ({
    outcome: "unmeasured",
    reason,
    measuredPath: null,
  });

  it("breaches when the DEVICE drops below the floor, whatever the run itself consumed", () => {
    // The point of the whole change: `measure` reports a run that is costing next to
    // nothing (10 bytes, flat), and the device still fills up — because on a shared box
    // the thing that fills it is somebody else's spawn. A watch keyed on consumed-bytes
    // sees a perfectly healthy run right through the near-miss.
    const deps = fakeDeps([10], [], [avail(500 * MB), avail(50 * MB)]);
    const sampler = new DiskUsageSampler("/x", 1000, 200 * MB, deps);
    sampler.start(); // sample 1: 500M free, fine
    expect(sampler.headroom().state).toBe("ok");
    deps.tick(); // sample 2: 50M free, under the 200M floor
    const verdict = sampler.headroom();
    expect(verdict.state).toBe("breached");
    if (verdict.state !== "breached") throw new Error("unreachable");
    expect(verdict.breach.availableBytes).toBe(50 * MB);
    expect(verdict.breach.floorBytes).toBe(200 * MB);
    expect(verdict.breach.atSample).toBe(2);
    expect(verdict.breach.measuredPath).toBe("/x");
    expect(verdict.message).toContain("INSUFFICIENT");
    // The consumed-bytes number is untouched by any of this — it is a different question,
    // and the report carries both.
    expect(sampler.stop().peakBytes).toBe(10);
  });

  it("keeps a breach after the device recovers, because the dip IS the evidence", () => {
    // A worker-spawn burst is transient by nature: it takes 300–800M for a few minutes and
    // gives it back. If a later sample withdrew the breach, the only run that could ever be
    // stopped is one that was already doomed — and the near-miss this exists for would be
    // invisible in the report afterwards.
    const deps = fakeDeps([10], [], [avail(500 * MB), avail(50 * MB), avail(900 * MB)]);
    const sampler = new DiskUsageSampler("/x", 1000, 200 * MB, deps);
    sampler.start();
    deps.tick(); // dip
    deps.tick(); // recovered
    const report = sampler.stop(); // recovered again (clamps to the last reading)
    expect(report.headroom.state).toBe("breached");
    if (report.headroom.state !== "breached") throw new Error("unreachable");
    expect(report.headroom.breach.atSample).toBe(2); // the FIRST one under, not the last
    expect(report.headroom.minAvailableBytes).toBe(50 * MB);
  });

  it("does NOT treat a failed read as a breach — a probe fault is not a full disk", () => {
    // The mirror of the false pass this change exists to remove. Aborting an expensive
    // provider run because statfs threw would be the same mistake pointed the other way:
    // a verdict produced by a read that never answered.
    const deps = fakeDeps([10], [], [cannotTell("could not statfs /x: EACCES"), avail(900 * MB)]);
    const sampler = new DiskUsageSampler("/x", 1000, 200 * MB, deps);
    sampler.start(); // unreadable
    expect(sampler.headroom().state).not.toBe("breached");
    deps.tick(); // readable, roomy
    const verdict = sampler.headroom();
    expect(verdict.state).toBe("ok");
    // Both samples are accounted for and they land in different buckets: the failed read
    // is COUNTED as unmeasured rather than quietly folded into the enforced ones, which is
    // what makes "1 of 2 samples could not be read" sayable in the report.
    expect(verdict.unmeasuredSamples).toBe(1);
    expect(verdict.enforcedSamples).toBe(1);
  });

  it("says NOT ENFORCED, not ok, when no sample could be read at all", () => {
    // `breached: false` off zero usable readings is a false green — the exact shape of
    // `AGED-OUT ✓`. The third state has to reach the report, and it has to say out loud
    // that the run proceeded unwatched.
    const deps = fakeDeps([10], [], [cannotTell("no existing ancestor of /x to measure")]);
    const sampler = new DiskUsageSampler("/x", 1000, 200 * MB, deps);
    sampler.start();
    deps.tick();
    const report = sampler.stop();
    expect(report.headroom.state).toBe("not-enforced");
    if (report.headroom.state !== "not-enforced") throw new Error("unreachable");
    expect(report.headroom.enforcedSamples).toBe(0);
    expect(report.headroom.unmeasuredSamples).toBe(3);
    expect(report.headroom.minAvailableBytes).toBeNull();
    expect(report.headroom.reason).toContain("no existing ancestor");
    expect(report.headroom.message).toContain("NOT ENFORCED");
    expect(report.headroom.message).toContain("not a pass");
  });

  it("reports the low-water mark on a clean run, so a near-miss is visible after the fact", () => {
    // Counter-assertion to the cells above: `ok` must be reachable and must carry a real
    // number, or "never breached" could just mean "never looked".
    const deps = fakeDeps([10], [], [avail(900 * MB), avail(260 * MB), avail(700 * MB)]);
    const sampler = new DiskUsageSampler("/x", 1000, 200 * MB, deps);
    sampler.start();
    deps.tick();
    const report = sampler.stop();
    expect(report.headroom.state).toBe("ok");
    expect(report.headroom.minAvailableBytes).toBe(260 * MB);
    expect(report.headroom.enforcedSamples).toBe(3);
    expect(report.headroom.breach).toBeNull();
  });
});

describe("createRunDiskWatch — the wiring the driver actually uses", () => {
  // Everything above drives the sampler through `fakeDeps`. That proves the logic and says
  // nothing about whether the rig hands it a live reader; a watch wired to nothing would
  // pass every cell above unchanged. These two go through the real statfs and the real
  // walk, against a real directory, so the production path has to work for them to pass.
  it("takes REAL readings and holds when the device has room", () => {
    const root = mkdtempSync(join(tmpdir(), "disk-watch-"));
    try {
      writeFileSync(join(root, "f"), "x".repeat(4096));
      const watch = createRunDiskWatch(root, 60_000, 1); // a 1-byte floor any device clears
      watch.start();
      const report = watch.stop();
      expect(report.headroom.state).toBe("ok");
      expect(report.headroom.enforcedSamples).toBeGreaterThan(0);
      expect(report.headroom.minAvailableBytes).toBeGreaterThan(0);
      // ...and the consumed-bytes side is live too, not a leftover zero.
      expect(report.peakBytes).toBeGreaterThanOrEqual(4096);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("BREACHES on a real device against an unsatisfiable floor — the check can fire", () => {
    // The counter-assertion to the cell above. Without it, "ok" could mean the floor is
    // never actually compared against anything.
    const root = mkdtempSync(join(tmpdir(), "disk-watch-"));
    try {
      const watch = createRunDiskWatch(root, 60_000, Number.MAX_SAFE_INTEGER);
      watch.start();
      const report = watch.stop();
      expect(report.headroom.state).toBe("breached");
      if (report.headroom.state !== "breached") throw new Error("unreachable");
      expect(report.headroom.breach.atSample).toBe(1); // the FIRST sample saw it
      expect(report.headroom.breach.measuredPath).toBe(resolve(root));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("readFreeSpace", () => {
  // The sampler above is driven by injected readings, so these cells exist to show the
  // injected shape is one the REAL reader can produce — a fixture no production path can
  // emit would certify nothing (the ISSUE_NUM lesson).
  it("reads the device under an existing path", () => {
    const reading = readFreeSpace(process.cwd());
    expect(reading.outcome).toBe("read");
    if (reading.outcome !== "read") throw new Error("unreachable");
    expect(reading.availableBytes).toBeGreaterThan(0);
    expect(reading.measuredPath).toBe(resolve(process.cwd()));
  });

  it("measures the nearest existing ancestor of a path not created yet", () => {
    // The sampler starts before the instance root is populated on some runs; the answer
    // must still be about the right filesystem.
    const reading = readFreeSpace(join(process.cwd(), "no-such-dir-here"));
    expect(reading.outcome).toBe("read");
    if (reading.outcome !== "read") throw new Error("unreachable");
    expect(reading.measuredPath).toBe(resolve(process.cwd()));
  });

  it.runIf(canDenyRead)("refuses to answer rather than measure some other device", () => {
    const root = mkdtempSync(join(tmpdir(), "disk-gate-"));
    try {
      mkdirSync(join(root, "locked", "store"), { recursive: true });
      chmodSync(join(root, "locked"), 0o000);
      const reading = readFreeSpace(join(root, "locked", "store", "run"));
      expect(reading.outcome).toBe("unmeasured");
      if (reading.outcome !== "unmeasured") throw new Error("unreachable");
      expect(reading.reason).toContain("EACCES");
      expect(reading.measuredPath).toBeNull();
    } finally {
      chmodSync(join(root, "locked"), 0o755);
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("calibrationNote", () => {
  /**
   * The note is about bytes CONSUMED and says nothing about headroom, so these cells fill
   * the new field once here rather than restating a verdict they do not exercise. If the
   * note ever starts reading `headroom`, this is the single place that has to vary.
   */
  const consumed = (report: Omit<DiskUsageReport, "headroom">): DiskUsageReport => ({
    ...report,
    headroom: {
      state: "not-enforced",
      floorBytes: 0,
      enforcedSamples: 0,
      unmeasuredSamples: 0,
      minAvailableBytes: null,
      breach: null,
      reason: "not exercised by this cell",
      message: "mid-run free-space watch NOT ENFORCED",
    },
  });

  it("states the over-provisioning ratio, which is what makes a stale gate visible", () => {
    const check = checkFreeSpace("/definitely/not/a/path/anywhere", 200 * 1024 * 1024);
    const note = calibrationNote(
      check,
      consumed({
        path: "/x",
        peakBytes: 44 * 1024 * 1024,
        finalBytes: 40 * 1024 * 1024,
        sampleCount: 12,
        intervalMs: 30_000,
        complete: true,
      })
    );
    expect(note).toContain("200M");
    expect(note).toContain("44M");
    expect(note).toContain("4.5× over");
  });

  it("says so rather than dividing by zero when nothing was measured", () => {
    const check = checkFreeSpace("/definitely/not/a/path/anywhere", 1024);
    const note = calibrationNote(
      check,
      consumed({
        path: "/x",
        peakBytes: 0,
        finalBytes: 0,
        sampleCount: 0,
        intervalMs: 30_000,
        complete: true,
      })
    );
    expect(note).toContain("unmeasured");
  });

  it("refuses to recommend a threshold from a peak that is only a floor", () => {
    // The dangerous direction: an under-measured peak makes the gate look over-provisioned
    // and argues for LOWERING it. The note has to say the number is a floor, not print the
    // same confident ratio.
    const check = checkFreeSpace("/definitely/not/a/path/anywhere", 200 * 1024 * 1024);
    const note = calibrationNote(
      check,
      consumed({
        path: "/x",
        peakBytes: 44 * 1024 * 1024,
        finalBytes: 40 * 1024 * 1024,
        sampleCount: 12,
        intervalMs: 30_000,
        complete: false,
      })
    );
    expect(note).toContain("AT LEAST");
    expect(note).toContain("do NOT retune");
    expect(note).not.toContain("× over");
  });
});

/**
 * Real filesystem, same reason as `workdir-capture.test.ts`: the bug is a failed read
 * answering with a number, and only a real EACCES produces one.
 */
describe("dirSizeBytes reports the completeness of its own walk (ISSUE_NUM policy)", () => {
  it("sums a readable tree and calls the walk complete", () => {
    const dir = mkdtempSync(join(tmpdir(), "disk-size-"));
    try {
      writeFileSync(join(dir, "a.bin"), "x".repeat(100));
      mkdirSync(join(dir, "sub"));
      writeFileSync(join(dir, "sub", "b.bin"), "y".repeat(23));
      expect(dirSizeBytes(dir)).toEqual({ bytes: 123, complete: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("calls an absent tree a complete zero — nothing there really is nothing", () => {
    expect(dirSizeBytes(join(tmpdir(), "disk-size-no-such-dir-ever"))).toEqual({
      bytes: 0,
      complete: true,
    });
  });

  it.runIf(canDenyRead)("calls a tree with an unreadable subdirectory INCOMPLETE", () => {
    // It used to return the partial total as if it were the size. That points the wrong way
    // twice: an understated peak recommends a looser `--min-free-bytes`, and an understated
    // `conversationDbBytes` understates the growth the whole experiment is about.
    const dir = mkdtempSync(join(tmpdir(), "disk-size-"));
    try {
      writeFileSync(join(dir, "a.bin"), "x".repeat(100));
      mkdirSync(join(dir, "locked"));
      writeFileSync(join(dir, "locked", "big.bin"), "z".repeat(9000));
      chmodSync(join(dir, "locked"), 0o000);
      expect(dirSizeBytes(dir)).toEqual({ bytes: 100, complete: false });
    } finally {
      chmodSync(join(dir, "locked"), 0o755);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("counts a symlink as zero WITHOUT calling the walk incomplete", () => {
    // The one place a silent skip is honest: `du` does not follow links either, and the
    // target's bytes are either inside this tree (counted where they live) or outside it
    // (not this tree's usage). Asserted rather than assumed, because every other silent skip
    // in this arc turned out to be a hole.
    const dir = mkdtempSync(join(tmpdir(), "disk-size-"));
    try {
      writeFileSync(join(dir, "a.bin"), "x".repeat(100));
      symlinkSync("./a.bin", join(dir, "link.bin"));
      symlinkSync("./nowhere", join(dir, "dangling"));
      expect(dirSizeBytes(dir)).toEqual({ bytes: 100, complete: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
