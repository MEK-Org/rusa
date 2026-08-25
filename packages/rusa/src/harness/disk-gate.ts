import { statfsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { entryPresent, fileSize, listEntries } from "./capture-fs.js";

/**
 * Launch-time free-space gate for the A/B rig, and the sampler that calibrates it
 * (design ISSUE_NUM, G2-v3 rail 4).
 *
 * ## Honest framing, because it shaped the design
 * No A/B arm has ever died on disk. The v2 arms died on **provider quota**; the one
 * EROFS in the logs was a credentials write inside the arm sandbox, on a different
 * plane, fixed weeks earlier. This gate is cheap insurance against a failure mode we
 * have not observed — not a fix for one we have.
 *
 * That matters for how the threshold is chosen. The figure this gate was originally
 * going to be built around (~1.4G peak) turned out to be ~30× high: it was a *worker*
 * clone+install cost, and an A/B arm does neither — `provisionE2EInstance` inits two
 * empty git repos and pushes one commit. The measured post-run instance roots were
 * 34M / 38M / 44M. **A gate calibrated off a 30×-high estimate refuses nothing it
 * should and passes runs it shouldn't: it reads as protection while providing none.**
 *
 * It is also, as built, the fourth thing in this arc to read green while measuring
 * nothing: the first version `statfs`'d the instance root, which does not exist yet at
 * gate time, so with an explicit `--root` it threw ENOENT and skipped every launch. See
 * {@link nearestExistingPath}. Caught by actually running the gate rather than by any of
 * its unit tests — one of which had encoded the bug as expected behaviour.
 *
 * So the gate calibrates itself. {@link DiskUsageSampler} records the run's actual peak
 * instance-root usage, the driver writes it to the report, and the next run can pass a
 * threshold that was *measured* rather than carried. Until then {@link
 * DEFAULT_MIN_FREE_BYTES} is explicitly a placeholder derived from the largest observed
 * residual, and says so at its definition rather than in a comment somewhere else.
 */

/**
 * Placeholder floor: the largest measured post-run instance root (44M) rounded up and
 * given 4× headroom for the un-instrumented mid-run peak. This number is NOT measured
 * and must be replaced by `peakInstanceRootBytes` from the first completed G2-v3 run —
 * that replacement is the whole point of the sampler below.
 */
export const DEFAULT_MIN_FREE_BYTES = 200 * 1024 * 1024;

export interface FreeSpaceCheck {
  ok: boolean;
  availableBytes: number;
  requiredBytes: number;
  /** The path the caller asked about — normally the instance root, which may not exist yet. */
  path: string;
  /**
   * The path actually handed to `statfs` — `path` itself when it exists, otherwise its
   * nearest existing ancestor. Recorded because "which filesystem did you measure" is
   * the question a surprising gate result turns on, and it must not need a re-run to
   * answer. `null` when nothing could be measured.
   */
  measuredPath: string | null;
  /** Human-readable one-liner for the launch log or the refusal. */
  message: string;
}

/** Bytes as a rounded MiB string. Exported so a caller's banner words a figure the way the gate does. */
export const formatMiB = (bytes: number): string => `${(bytes / (1024 * 1024)).toFixed(0)}M`;
const mib = formatMiB;

/**
 * The nearest ancestor of `path` that exists on disk (possibly `path` itself) — or, under
 * the read policy of `capture-fs.ts`, an explicit refusal to guess.
 *
 * Climbing is a claim: "there is no entry here, so the filesystem I want is further up".
 * Only ENOENT supports it. A read that fails any other way leaves the question open, and
 * the gate must say so rather than measure a device it was not asked about.
 *
 * ## Why the gate needs this — the bug that made this function exist
 * The gate deliberately runs BEFORE `provisionE2EInstance`, so a refusal costs nothing
 * and leaves no half-built instance. But with an explicit `--root` (which the runbook
 * MANDATES on a worker plane, since `$HOME` is read-only there) that directory does not
 * exist yet, so `statfsSync` threw ENOENT, the "cannot measure ⇒ do not block" bias
 * turned that into `ok: true`, and the gate passed a launch requiring 930 GiB on a
 * filesystem with 2.0 GiB free. It never fired in the one configuration it ships in.
 *
 * That is this arc's recurring failure — `AGED-OUT ✓`, the kimi `authRe`, the `express`
 * substring — a check that reads green while measuring something other than what it
 * names. Free space is a property of the FILESYSTEM, not of a directory that has yet to
 * be created, so measuring the nearest existing ancestor answers the real question. The
 * ancestor is on the same filesystem unless `path` is itself a fresh mountpoint, and a
 * mountpoint that does not exist yet cannot be measured by anything.
 */
export type NearestPath =
  /** An entry that is really there. Its filesystem is the one to measure. */
  | { outcome: "found"; path: string }
  /** Walked to the filesystem root proving ENOENT the whole way — nothing to measure. */
  | { outcome: "none" }
  /** A read that could not answer. Which filesystem this path lands on is UNKNOWN. */
  | { outcome: "unknown"; path: string; code: string };

export function nearestExistingPath(path: string): NearestPath {
  let current = resolve(path);
  for (;;) {
    const step = entryPresent(current).match<NearestPath | "climb">({
      ok: () => ({ outcome: "found", path: current }),
      // Only ENOENT proves there is no entry here, and only that permits climbing. This
      // used to be `existsSync`, which FOLLOWS the link and answers false when the target
      // resolves EACCES: an instance root symlinked into a locked tree read as "not there",
      // the loop climbed past it, and the gate then enforced against the ANCESTOR's
      // filesystem — passing or refusing a launch on a free-space figure from the wrong
      // device. Same defect as finding four one module over, in the function whose own doc
      // comment calls this arc's failure "a check that reads green while measuring
      // something other than what it names".
      absent: () => "climb",
      unknown: (code) => ({ outcome: "unknown", path: current, code }),
    });
    if (step !== "climb") return step;
    const parent = dirname(current);
    if (parent === current) return { outcome: "none" };
    current = parent;
  }
}

/**
 * How much room the DEVICE has left, as distinct from how much a directory has consumed.
 *
 * Split out of {@link checkFreeSpace} for ISSUE_NUM leg 2, so the launch gate and the mid-run
 * watch below read free space through one implementation rather than two that could drift.
 * It is its own three-state answer because the mid-run watch must be able to tell "the
 * device is low" from "I could not tell", and the gate's `availableBytes: -1` sentinel
 * cannot carry that distinction to a caller that has to decide whether to abort a run.
 */
export type FreeSpaceReading =
  /** A real measurement of the filesystem `measuredPath` sits on. */
  | { outcome: "read"; availableBytes: number; measuredPath: string }
  /** Nothing could be measured. `measuredPath` is the path statfs refused, when we got that far. */
  | { outcome: "unmeasured"; reason: string; measuredPath: string | null };

export function readFreeSpace(path: string): FreeSpaceReading {
  const nearest = nearestExistingPath(path);
  if (nearest.outcome === "none") {
    return {
      outcome: "unmeasured",
      reason: `no existing ancestor of ${path} to measure`,
      measuredPath: null,
    };
  }
  if (nearest.outcome === "unknown") {
    // Not "there is nothing here" — "I could not tell". Enforcing from the ancestor would
    // report some other device's free space under this path's name, which is the shape of
    // every bug in this arc: an answer produced by a failed read.
    return {
      outcome: "unmeasured",
      reason:
        `could not determine whether ${nearest.path} exists (${nearest.code}) — refusing to ` +
        `measure a filesystem that may not be the one ${path} lands on`,
      measuredPath: null,
    };
  }
  const measuredPath = nearest.path;
  try {
    const stats = statfsSync(measuredPath);
    return {
      outcome: "read",
      availableBytes: Number(stats.bavail) * Number(stats.bsize),
      measuredPath,
    };
  } catch (err) {
    return {
      outcome: "unmeasured",
      reason: `could not statfs ${measuredPath}: ${err instanceof Error ? err.message : String(err)}`,
      measuredPath,
    };
  }
}

/**
 * Check that `path`'s filesystem has at least `requiredBytes` available, measuring the
 * nearest existing ancestor when `path` has not been created yet (see
 * {@link nearestExistingPath}).
 *
 * Never throws on an unreadable filesystem: it returns `ok: true` with an explanatory
 * message, because a gate that cannot measure must not be the thing that stops a launch
 * it was only ever meant to protect. That bias is deliberate and stated here so it is
 * not mistaken for an oversight — but note it is exactly what turned the ENOENT above
 * into a silent pass, so the SKIPPED message is worded to be alarming rather than
 * reassuring, and the caller prints it either way.
 *
 * **This runs ONCE, before provisioning.** It is not a watch, and the run it admits can
 * still fill the device afterwards — that gap is what {@link DiskUsageSampler}'s free-space
 * floor closes . The banner the caller prints says which check it is, because a line
 * reading `free space 4971M available ≥ 200M required` with nothing to distinguish it
 * carries an implication of ongoing protection that this function does not provide.
 */
export function checkFreeSpace(path: string, requiredBytes: number): FreeSpaceCheck {
  const reading = readFreeSpace(path);
  if (reading.outcome === "unmeasured") {
    return {
      ok: true,
      availableBytes: -1,
      requiredBytes,
      path,
      measuredPath: reading.measuredPath,
      message: `free-space gate NOT ENFORCED — ${reading.reason}`,
    };
  }
  const { availableBytes, measuredPath } = reading;

  const ok = availableBytes >= requiredBytes;
  const via = measuredPath === resolve(path) ? "" : ` (measured at ${measuredPath})`;
  return {
    ok,
    availableBytes,
    requiredBytes,
    path,
    measuredPath,
    message: ok
      ? `free space ${mib(availableBytes)} available ≥ ${mib(requiredBytes)} required${via}`
      : `INSUFFICIENT free space: ${mib(availableBytes)} available < ${mib(requiredBytes)} required at ${path}${via}`,
  };
}

/** A measured tree size, and whether the walk that produced it saw the whole tree. */
export interface DirSize {
  bytes: number;
  /** False when any read failed for a reason other than "it is not there". */
  complete: boolean;
}

/**
 * Recursive byte size of a directory tree, with the completeness of the walk.
 *
 * Under the read policy of `capture-fs.ts`: only `ENOENT` is a measurement (an absent tree
 * is 0 bytes; a file that vanished mid-walk contributes 0), and every other failure makes
 * the total a FLOOR rather than a size. It used to return a bare `0` on an unreadable
 * directory, which is the same green-by-absence this arc keeps finding — and here it points
 * the wrong way twice: an under-measured peak makes the `--min-free-bytes` recalibration
 * recommend a LOOSER gate, and an under-measured `conversationDbBytes` understates exactly
 * the growth this experiment is about.
 *
 * Symlinks are counted as 0 and are NOT a hole — `du` does not follow them either, and a
 * link's target either lives inside this tree (counted where it lives) or outside it (not
 * this tree's usage).
 */
export function dirSizeBytes(dir: string): DirSize {
  let bytes = 0;
  let complete = true;
  const entries = listEntries(dir).match({
    ok: (list) => list,
    absent: () => null,
    unknown: () => {
      complete = false;
      return null;
    },
  });
  if (!entries) return { bytes, complete };
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      const sub = dirSizeBytes(full);
      bytes += sub.bytes;
      if (!sub.complete) complete = false;
    } else if (entry.isFile()) {
      bytes += fileSize(full).match({
        ok: (size) => size,
        absent: () => 0, // vanished mid-walk (a run's temp file) — genuinely contributes 0
        unknown: () => {
          complete = false;
          return 0;
        },
      });
    }
  }
  return { bytes, complete };
}

export interface SamplerDeps {
  /** Measure the tracked path. Injected so the sampler is testable without a disk. */
  measure: (path: string) => DirSize;
  /**
   * Read free space on the tracked path's DEVICE. Injected for the same reason as
   * `measure`, and required rather than optional: a sampler constructed without it would
   * silently keep the pre-ISSUE_NUM behaviour of watching nothing, which is precisely the
   * "guards nothing while looking like it does" shape this change exists to remove. A
   * caller that forgets it should fail to compile, not to protect.
   */
  readFree: (path: string) => FreeSpaceReading;
  setInterval: (fn: () => void, ms: number) => unknown;
  clearInterval: (handle: unknown) => void;
}

/** The sample at which the device first fell below the floor. */
export interface DiskHeadroomBreach {
  availableBytes: number;
  floorBytes: number;
  measuredPath: string;
  /** 1-based index of the sample that saw it — the sampler has no clock by design. */
  atSample: number;
}

/**
 * Whether the run still has the headroom it was admitted with.
 *
 * `state: "not-enforced"` is the third state and is NOT a pass. `breached: false` with
 * zero usable readings means nothing was ever compared — the same false green as a launch
 * gate that skipped, and the reason this is a discriminated union rather than a boolean
 * with a count beside it that a caller can forget to read.
 */
export type DiskHeadroomVerdict =
  | {
      state: "ok";
      floorBytes: number;
      /** Samples that produced a real number and were compared against the floor. */
      enforcedSamples: number;
      /** Samples where free space could not be read at all. */
      unmeasuredSamples: number;
      /** Lowest free-space reading seen. */
      minAvailableBytes: number;
      breach: null;
      message: string;
    }
  | {
      state: "breached";
      floorBytes: number;
      enforcedSamples: number;
      unmeasuredSamples: number;
      minAvailableBytes: number;
      breach: DiskHeadroomBreach;
      message: string;
    }
  | {
      state: "not-enforced";
      floorBytes: number;
      enforcedSamples: 0;
      unmeasuredSamples: number;
      minAvailableBytes: null;
      breach: null;
      /** Why nothing was compared. Always populated on this branch. */
      reason: string;
      message: string;
    };

/**
 * Samples a directory's size on an interval and keeps the maximum — the measurement
 * that turns {@link DEFAULT_MIN_FREE_BYTES} from a carried figure into a real one.
 *
 * Sampling (rather than instrumenting every write) is the right precision here: we need
 * an order of magnitude to size a gate, and the failure we are guarding against is a
 * slow fill across a multi-minute run, not a millisecond spike. What it cannot see is a
 * transient between samples, so {@link DiskUsageReport.sampleCount} is reported alongside
 * the peak — a peak from 3 samples is a weaker claim than one from 300, and the report
 * should not flatten that difference.
 */
export interface DiskUsageReport {
  path: string;
  peakBytes: number;
  finalBytes: number;
  sampleCount: number;
  intervalMs: number;
  /**
   * False when ANY sample's walk hit a read it could not complete. The peak is then a
   * floor, not a peak — which matters because this figure is what recalibrates
   * {@link DEFAULT_MIN_FREE_BYTES}, and an under-measured peak argues for a looser gate.
   */
  complete: boolean;
  /** The device-side half (ISSUE_NUM leg 2): whether the run kept the headroom it started with. */
  headroom: DiskHeadroomVerdict;
}

export class DiskUsageSampler {
  private handle: unknown = null;
  private peak = 0;
  private last = 0;
  private samples = 0;
  private complete = true;
  private freeEnforced = 0;
  private freeUnmeasured = 0;
  private minAvailable: number | null = null;
  private lastUnmeasuredReason: string | null = null;
  private breach: DiskHeadroomBreach | null = null;

  constructor(
    private readonly path: string,
    private readonly intervalMs: number,
    /**
     * Free bytes the device must keep for this run to continue. Deliberately the SAME
     * number the launch gate refused below (`--min-free-bytes`) rather than a second
     * knob: the headroom a run needed to start is the headroom it needs to carry on, and
     * splitting them would ask an operator to justify two figures when we have evidence
     * for neither. If a run is ever shown to want a looser mid-run floor than its launch
     * floor, that is the moment to add the second flag — not before.
     */
    private readonly floorBytes: number,
    private readonly deps: SamplerDeps
  ) {}

  /** Take one sample immediately, then every `intervalMs` until {@link stop}. */
  start(): void {
    if (this.handle !== null) return;
    this.sample();
    this.handle = this.deps.setInterval(() => this.sample(), this.intervalMs);
  }

  private sample(): void {
    const { bytes, complete } = this.deps.measure(this.path);
    this.samples += 1;
    this.last = bytes;
    if (bytes > this.peak) this.peak = bytes;
    // Sticky: one incomplete walk anywhere in the run means the reported peak is a floor,
    // and a later clean sample does not restore the claim.
    if (!complete) this.complete = false;

    // ...and the device side, which is a different number from the one above: `bytes` is
    // what THIS RUN has consumed, and on a shared box the thing that runs us out of disk
    // is usually somebody else. The 2026-08-05 near-miss was two worker spawns.
    const free = this.deps.readFree(this.path);
    if (free.outcome === "unmeasured") {
      this.freeUnmeasured += 1;
      this.lastUnmeasuredReason = free.reason;
      // NOT a breach. A read that could not answer is not evidence the device is full,
      // and aborting an expensive run on a probe fault is the mirror of the false pass
      // this whole check exists to avoid. It is counted, and it surfaces in the verdict.
      return;
    }
    this.freeEnforced += 1;
    if (this.minAvailable === null || free.availableBytes < this.minAvailable) {
      this.minAvailable = free.availableBytes;
    }
    // Sticky, like `complete` above: the first sample below the floor is the answer, and a
    // later recovery does not withdraw it. A dip we watched happen is a dip the run should
    // not have been in the middle of, and un-sticking it would make a transient — which is
    // exactly what a 300–800M worker-spawn burst is — invisible to the report.
    if (this.breach === null && free.availableBytes < this.floorBytes) {
      this.breach = {
        availableBytes: free.availableBytes,
        floorBytes: this.floorBytes,
        measuredPath: free.measuredPath,
        atSample: this.samples,
      };
    }
  }

  /**
   * The headroom verdict as of the last sample. Polled by the driver at points where
   * stopping is cheap, rather than pushed from the timer: an abort that fires in the
   * middle of an arm's dispatch would leave the run in a state the report cannot describe,
   * and the thing worth preventing is the NEXT provider run, not the current one.
   */
  headroom(): DiskHeadroomVerdict {
    const floorBytes = this.floorBytes;
    const unmeasuredSamples = this.freeUnmeasured;
    if (this.breach !== null && this.minAvailable !== null) {
      return {
        state: "breached",
        floorBytes,
        enforcedSamples: this.freeEnforced,
        unmeasuredSamples,
        minAvailableBytes: this.minAvailable,
        breach: this.breach,
        message:
          `INSUFFICIENT free space mid-run: ${mib(this.breach.availableBytes)} available < ` +
          `${mib(floorBytes)} floor at ${this.breach.measuredPath} (sample ${this.breach.atSample} ` +
          `of ${this.samples})`,
      };
    }
    if (this.freeEnforced === 0 || this.minAvailable === null) {
      const reason =
        this.lastUnmeasuredReason ?? "no free-space sample has been taken for this run yet";
      return {
        state: "not-enforced",
        floorBytes,
        enforcedSamples: 0,
        unmeasuredSamples,
        minAvailableBytes: null,
        breach: null,
        reason,
        message:
          `mid-run free-space watch NOT ENFORCED — ${reason}. ${this.samples} sample(s) taken, ` +
          "none of them usable; this is not a pass, and the run is proceeding unwatched",
      };
    }
    const caveat =
      unmeasuredSamples > 0
        ? ` (${unmeasuredSamples} of ${this.samples} sample(s) could not be read)`
        : "";
    return {
      state: "ok",
      floorBytes,
      enforcedSamples: this.freeEnforced,
      unmeasuredSamples,
      minAvailableBytes: this.minAvailable,
      breach: null,
      message:
        `mid-run free space held: low-water ${mib(this.minAvailable)} ≥ ${mib(floorBytes)} floor ` +
        `over ${this.freeEnforced} sample(s)${caveat}`,
    };
  }

  /** Take a final sample, stop sampling, and return the report. */
  stop(): DiskUsageReport {
    if (this.handle !== null) {
      this.deps.clearInterval(this.handle);
      this.handle = null;
    }
    this.sample();
    return {
      path: this.path,
      peakBytes: this.peak,
      finalBytes: this.last,
      sampleCount: this.samples,
      intervalMs: this.intervalMs,
      complete: this.complete,
      headroom: this.headroom(),
    };
  }
}

/**
 * The sampler as the driver actually builds it: real disk walk, real statfs, real timers.
 *
 * This exists so the production wiring can be exercised. Every cell above drives the
 * sampler through injected deps, which proves the logic and proves nothing about whether
 * the driver hands it a live reader — a check that can only be satisfied by a fake is the
 * `boundModel` mistake (a comparison of two nulls, passing on the absence of evidence).
 * Constructing it here means one call site, one test, and no way for the rig to keep a
 * watch that measures nothing while looking like it does.
 *
 * The handle is unref'd: a watch must never be the reason the process stays alive.
 */
export function createRunDiskWatch(
  path: string,
  intervalMs: number,
  floorBytes: number
): DiskUsageSampler {
  return new DiskUsageSampler(path, intervalMs, floorBytes, {
    measure: dirSizeBytes,
    readFree: readFreeSpace,
    setInterval: (fn, ms) => {
      const h = setInterval(fn, ms);
      h.unref?.();
      return h;
    },
    clearInterval: (h) => clearInterval(h as NodeJS.Timeout),
  });
}

/**
 * The calibration line the driver prints and writes: what the gate required, what the
 * run actually used, and therefore what the threshold should be next time. Deliberately
 * states the ratio — "required 200M, peaked at 44M (4.5× over)" is the sentence that
 * makes a mis-calibrated gate visible instead of quietly green.
 */
export function calibrationNote(check: FreeSpaceCheck, usage: DiskUsageReport): string {
  if (usage.peakBytes <= 0) {
    return `gate required ${mib(check.requiredBytes)}; peak usage unmeasured (${usage.sampleCount} samples)`;
  }
  const ratio = check.requiredBytes / usage.peakBytes;
  // An incomplete walk makes the peak a FLOOR, and the recommendation it supports points the
  // wrong way — a too-small peak argues for a LOOSER gate. Say so instead of recommending.
  if (!usage.complete) {
    return (
      `gate required ${mib(check.requiredBytes)}; measured peak instance-root usage ` +
      `AT LEAST ${mib(usage.peakBytes)} over ${usage.sampleCount} samples — the walk could ` +
      `not read part of the tree, so this is a floor; do NOT retune --min-free-bytes from it`
    );
  }
  return (
    `gate required ${mib(check.requiredBytes)}; measured peak instance-root usage ` +
    `${mib(usage.peakBytes)} over ${usage.sampleCount} samples (${ratio.toFixed(1)}× over) — ` +
    `use the measured peak to set --min-free-bytes on the next run`
  );
}
