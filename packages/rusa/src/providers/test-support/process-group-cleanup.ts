/**
 * Guards for the negative-PID signalling that test cleanup uses to reap the
 * descendants a probe left behind.
 *
 * `kill -9 -<pgid>` is one bad number away from taking out the run that sent
 * it. A group id of 0 means "my own group"; 1 is a namespace-wide broadcast
 * that spares only the sender and init; and a group id derived from `ps` can
 * land on the runner's own group, or on a recycled id that now belongs to
 * something else entirely. Inside a sandbox whose init is PID 1 that blast
 * radius is the whole world - the agent CLI supervising the run included.
 *
 * So cleanup never signals a group it has not shown to be a separate child
 * group. Everything here fails closed: when a target cannot be proven safe,
 * nothing is signalled and the caller is told why.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

/** What a reap attempt did, so callers and tests can assert on the decision. */
export interface ReapOutcome {
  signalled: boolean;
  /** Why the target was refused; set only when `signalled` is false. */
  refusedBecause?: string;
  /** A signal that was sent but failed - an already-dead group is normal. */
  error?: string;
}

/** Injection seam: tests observe the intended target without signalling it. */
export type SendSignal = (target: number, signal: NodeJS.Signals) => void;

/** Injection seam for the process table, so lookups are testable from rows. */
export type RunPs = () => string;

export interface ReapOptions {
  signal?: NodeJS.Signals;
  send?: SendSignal;
  /** Overrides the caller's own group; resolved from the OS when omitted. */
  ownPgid?: number;
}

const sendWithProcessKill: SendSignal = (target, signal) => {
  process.kill(target, signal);
};

const readProcessTable: RunPs = () =>
  execFileSync("ps", ["-eo", "pgid=,args="], { encoding: "utf8" });

/**
 * The caller's own process group.
 *
 * `/proc/self/stat` field 5 holds it; `comm` may contain spaces and brackets,
 * so fields are read after the final ')'. Falls back to `ps` where /proc is
 * not a Linux procfs.
 */
export function ownProcessGroupId(): number {
  try {
    const stat = readFileSync("/proc/self/stat", "utf8");
    const fields = stat
      .slice(stat.lastIndexOf(")") + 1)
      .trim()
      .split(/\s+/);
    // state, ppid, pgrp
    const pgid = Number(fields[2]);
    if (Number.isInteger(pgid) && pgid > 0) return pgid;
  } catch {
    /* fall through to ps */
  }
  const pgid = Number(
    execFileSync("ps", ["-o", "pgid=", "-p", String(process.pid)], { encoding: "utf8" }).trim()
  );
  if (Number.isInteger(pgid) && pgid > 0) return pgid;
  throw new Error("could not determine the caller's own process group");
}

/** One `ps -eo pgid=,args=` row. */
export interface ProcessRow {
  pgid: number;
  args: string;
}

/** The visible process table, as rows cleanup can match against. */
export function processTable(runPs: RunPs = readProcessTable): ProcessRow[] {
  return runPs()
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const split = line.indexOf(" ");
      if (split === -1) return { pgid: Number(line), args: "" };
      return { pgid: Number(line.slice(0, split)), args: line.slice(split + 1).trim() };
    })
    .filter((row) => Number.isInteger(row.pgid));
}

/** Why signalling this whole group would be unsafe, or undefined when it is not. */
export function unsafeGroupReason(pgid: number, ownPgid?: number): string | undefined {
  if (!Number.isInteger(pgid)) return `process group ${pgid} is not a group id`;
  if (pgid <= 1) {
    return `process group ${pgid} would signal init or broadcast to every reachable process`;
  }
  let own: number;
  try {
    own = ownPgid ?? ownProcessGroupId();
  } catch (err) {
    return `own process group is unknown, refusing to signal ${pgid}: ${(err as Error).message}`;
  }
  if (!Number.isInteger(own) || own <= 0) {
    return `own process group is unreadable (${own}), refusing to signal group ${pgid}`;
  }
  if (pgid === own) return `process group ${pgid} is the caller's own group`;
  return undefined;
}

/** Why signalling this single process would be unsafe, or undefined when it is not. */
export function unsafeProcessReason(pid: number, ownPgid?: number): string | undefined {
  if (!Number.isInteger(pid)) return `process ${pid} is not a pid`;
  if (pid <= 1) return `process ${pid} is init or invalid`;
  if (pid === process.pid) return `process ${pid} is the caller itself`;
  if (pid === process.ppid) return `process ${pid} is the caller's parent`;
  let own: number;
  try {
    own = ownPgid ?? ownProcessGroupId();
  } catch (err) {
    return `own process group is unknown, refusing to signal ${pid}: ${(err as Error).message}`;
  }
  if (!Number.isInteger(own) || own <= 0) {
    return `own process group is unreadable (${own}), refusing to signal process ${pid}`;
  }
  // The leader of our own group is an ancestor of this run, not a probe leftover.
  if (pid === own) return `process ${pid} leads the caller's own group`;
  return undefined;
}

/** Signal a whole process group, but only once it is shown to be someone else's. */
export function reapProcessGroup(pgid: number, opts: ReapOptions = {}): ReapOutcome {
  const refusedBecause = unsafeGroupReason(pgid, opts.ownPgid);
  if (refusedBecause) return { signalled: false, refusedBecause };
  const signal = opts.signal ?? "SIGKILL";
  try {
    (opts.send ?? sendWithProcessKill)(-pgid, signal);
    return { signalled: true };
  } catch (err) {
    return { signalled: true, error: (err as Error).message };
  }
}

/** Signal a single process, but only once it is shown not to be this run. */
export function reapProcess(pid: number, opts: ReapOptions = {}): ReapOutcome {
  const refusedBecause = unsafeProcessReason(pid, opts.ownPgid);
  if (refusedBecause) return { signalled: false, refusedBecause };
  const signal = opts.signal ?? "SIGKILL";
  try {
    (opts.send ?? sendWithProcessKill)(pid, signal);
    return { signalled: true };
  } catch (err) {
    return { signalled: true, error: (err as Error).message };
  }
}

/**
 * Whether a group captured earlier still holds a process this probe started.
 *
 * Group ids are recycled, and a cleanup path that remembers a number for tens
 * of seconds can end up signalling whatever inherited it. Re-deriving the
 * membership from a live `ps` keeps the reap aimed at the original tree while
 * still draining members whose own argv no longer names the marker.
 */
export function groupStillHosts(
  pgid: number,
  marker: string,
  runPs: RunPs = readProcessTable
): boolean {
  return processTable(runPs).some((row) => row.pgid === pgid && row.args.includes(marker));
}
