import { execFileSync, spawnSync } from "node:child_process";
import { assertCronExprCanFire, type CrontabMutator } from "./wake-cron.js";

/**
 * One internal scheduling service with a deliberately small vocabulary:
 * - register, replace, or cancel an obligation activation;
 * - register, replace, or cancel a scheduled-message delivery.
 */
export interface OsScheduler {
  scheduleObligationActivation(
    id: string,
    time: { kind: "cron"; cronExpr: string } | { kind: "at"; date: Date }
  ): void;
  cancelObligationActivation(id: string): void;
  listObligationActivations(): string[];

  scheduleMessageDelivery(id: string, date: Date): void;
  cancelMessageDelivery(id: string): void;
  listMessageDeliveries(): string[];
}

export interface OsSchedulerOptions {
  tokenFile: string;
  portFile: string;
  host?: string;
  curlPath?: string;
}

export interface AtProbe {
  hasAt: () => boolean;
  hasAtrm: () => boolean;
  isAtdRunning: () => boolean;
  /**
   * Actually invoke `atq` (not just check the binary is on PATH) and confirm
   * it can be queried by this user — the specific call `execAtIo().list()`
   * makes at runtime. `which at` succeeding says nothing about `atq` being
   * installed, executable by this user, or able to reach a live `atd`.
   */
  canQueryAtq: () => boolean;
}

export function preflightAt(probe: AtProbe = defaultAtProbe()): { ok: boolean; issues: string[] } {
  const issues: string[] = [];
  if (!probe.hasAt()) issues.push("`at` CLI not found — install at");
  if (!probe.hasAtrm()) issues.push("`atrm` CLI not found — install at");
  if (probe.hasAt() && !probe.isAtdRunning())
    issues.push("atd daemon not detected — scheduled obligations won't fire");
  if (!probe.canQueryAtq())
    issues.push(
      "`atq` cannot be queried — verify at/atd is installed and this user can access the queue"
    );
  return { ok: issues.length === 0, issues };
}

function defaultAtProbe(): AtProbe {
  const can = (cmd: string, args: string[]): boolean => {
    try {
      execFileSync(cmd, args, { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  };
  return {
    hasAt: () => can("which", ["at"]),
    hasAtrm: () => can("which", ["atrm"]),
    isAtdRunning: () => can("pgrep", ["-x", "atd"]),
    canQueryAtq: () => {
      const res = spawnSync("atq", { encoding: "utf-8" });
      return !res.error && res.status === 0;
    },
  };
}

export interface AtIo {
  schedule(script: string, date: Date): string;
  list(): { id: string; script: string }[];
  remove(id: string): void;
}

/**
 * Thrown by {@link unavailableAtIo} for the one operation that actually needs
 * a one-off job — scheduling a completion-interval activation or a scheduled
 * message delivery — when `at`/`atd` was confirmed absent at boot (not when a
 * live `atq` call merely fails, which stays a plain IO error).
 */
export class AtUnavailableError extends Error {
  constructor(issues: string[]) {
    super(`\`at\` scheduling is unavailable: ${issues.join("; ")}`);
    this.name = "AtUnavailableError";
  }
}

/**
 * Stand-in `AtIo` for a host where {@link preflightAt} found `at`/`atd`
 * missing. Boot must survive that (cron-only recurrences keep working) and
 * reconciliation must not mistake "we chose not to call a missing binary"
 * for "the binary said the queue is empty" — so `list()` reports no jobs
 * (nothing could have been armed without `at` ever being available) and
 * `schedule()`/`remove()` raise the named prerequisite error the first time
 * something actually needs a one-off job, instead of letting `spawnSync`
 * reject with a raw ENOENT.
 */
export function unavailableAtIo(issues: string[]): AtIo {
  return {
    schedule(): string {
      throw new AtUnavailableError(issues);
    },
    list(): { id: string; script: string }[] {
      return [];
    },
    remove(): void {
      throw new AtUnavailableError(issues);
    },
  };
}

/** `atrm`/`atq`/`at -c` on a job id that no longer exists — already fired, or already removed. */
const AT_JOB_GONE = /cannot find|no such|does not exist|not found/i;

export function execAtIo(): AtIo {
  return {
    schedule(script: string, date: Date): string {
      // `at -t` takes seconds precision (`[[CC]YY]MMDDhhmm[.ss]`); the interval
      // contract is seconds-based, so truncating to the minute could fire a
      // completion_interval activation up to 59s early.
      const pad = (n: number, w: number) => n.toString().padStart(w, "0");
      const yyyy = pad(date.getUTCFullYear(), 4);
      const mm = pad(date.getUTCMonth() + 1, 2);
      const dd = pad(date.getUTCDate(), 2);
      const hh = pad(date.getUTCHours(), 2);
      const min = pad(date.getUTCMinutes(), 2);
      const ss = pad(date.getUTCSeconds(), 2);
      const timeStr = `${yyyy}${mm}${dd}${hh}${min}.${ss}`;

      const res = spawnSync("at", ["-t", timeStr], {
        input: script,
        encoding: "utf-8",
        env: { ...process.env, TZ: "UTC" },
      });
      if (res.error) throw res.error;
      if (res.status !== 0) throw new Error(`at failed: ${res.stderr || res.stdout}`);

      const m = res.stderr.match(/job\s+(\d+)\s+at/);
      if (!m) throw new Error(`could not parse at output: ${res.stderr}`);
      return m[1];
    },
    list(): { id: string; script: string }[] {
      const res = spawnSync("atq", { encoding: "utf-8" });
      // A missing `atq` binary is a deployment/preflight problem, not an
      // empty authoritative queue — reading it as "nothing scheduled" would
      // let the reconciler treat every OS-scheduled job as an orphan and
      // cancel it out from under still-pending obligations/messages.
      if (res.error) throw res.error;
      // An empty queue exits 0 with empty stdout; a nonzero exit means atq
      // itself failed (atd down, permission denied, ...), which must surface
      // rather than read as "nothing scheduled" — that would make the
      // reconciler quietly cancel every OS-scheduled job it thinks is an orphan.
      if (res.status !== 0) {
        throw new Error(`atq failed: ${res.stderr || res.stdout}`);
      }

      const out: { id: string; script: string }[] = [];
      for (const line of res.stdout.trim().split("\n")) {
        if (!line) continue;
        const id = line.split(/\s+/)[0];
        if (!id) continue;

        const scriptRes = spawnSync("at", ["-c", id], { encoding: "utf-8" });
        if (scriptRes.status === 0) {
          out.push({ id, script: scriptRes.stdout });
        } else if (!AT_JOB_GONE.test(`${scriptRes.stderr}${scriptRes.stdout}`)) {
          // A job atq just listed but `at -c` can't read is a real IO failure
          // (not the race of it firing between the two calls, which reads as
          // "gone" and is fine to drop silently).
          throw new Error(`at -c ${id} failed: ${scriptRes.stderr || scriptRes.stdout}`);
        }
      }
      return out;
    },
    remove(id: string): void {
      const res = spawnSync("atrm", [id], { encoding: "utf-8" });
      if (res.error) throw res.error;
      // Cancellation must be idempotent for a job that already fired or was
      // already removed — atrm exits nonzero either way, and only the message
      // tells them apart from a genuine IO failure.
      if (res.status !== 0 && !AT_JOB_GONE.test(`${res.stderr}${res.stdout}`)) {
        throw new Error(`atrm ${id} failed: ${res.stderr || res.stdout}`);
      }
    },
  };
}

/**
 * Thrown when an owned recurrence/message cron block is found truncated or
 * unterminated — a start tag with no matching end marker before EOF or
 * another start tag. This can only mean the block was hand-edited or
 * corrupted after this class wrote it: its exact boundary can no longer be
 * verified, so the mutation fails closed with no write rather than guessing
 * that an adjacent line belongs to (or doesn't belong to) the block.
 */
export class TruncatedCronBlockError extends Error {
  constructor(tag: string) {
    super(
      `crontab block "${tag}" has no matching end marker — truncated or hand-edited; refusing to mutate without a verified boundary`
    );
    this.name = "TruncatedCronBlockError";
  }
}

export class DefaultOsScheduler implements OsScheduler {
  constructor(
    private readonly mutator: CrontabMutator,
    private readonly atIo: AtIo,
    private readonly opts: OsSchedulerOptions
  ) {}

  private buildCurlLine(endpoint: string, data: Record<string, string>): string {
    const curl = this.opts.curlPath ?? "/usr/bin/curl";
    const host = this.opts.host ?? "127.0.0.1";
    const url = `"http://${host}:$(cat ${this.opts.portFile})/${endpoint}"`;
    const auth = `"Authorization: Bearer $(cat ${this.opts.tokenFile})"`;
    const args = Object.entries(data)
      .map(([k, v]) => `-d '${k}=${v.replace(/'/g, "'\\''")}'`)
      .join(" ");
    return `${curl} -fsS -H ${auth} ${url} ${args}`;
  }

  /**
   * Drop exactly the block this class writes for `tag`: from the tag line
   * through the matching `endTag` line, inclusive — an exact, verifiable
   * boundary rather than a fixed line count or content heuristic. A prior
   * position-counting version assumed the block was always intact and
   * consumed whatever followed the tag by position, which deletes an
   * adjacent user entry the moment the block is truncated or hand-edited
   * (e.g. `# mc-obligation-activation:<id>` immediately followed by an
   * unrelated job, with no job/restore lines of its own left before it).
   * When `endTag` isn't found before either EOF or another start tag, the
   * block is malformed/partial — its boundary can no longer be verified, so
   * this throws {@link TruncatedCronBlockError} instead of guessing which
   * adjacent line belongs to it. The caller must perform no write in that
   * case (never fall back to dropping just the orphaned tag): a block that
   * looks truncated might just as easily be one where a foreign line was
   * inserted BEFORE the real end marker, and only a human can tell those
   * apart safely.
   */
  private stripCronBlock(lines: string[], tag: string, endTag: string): string[] {
    const out: string[] = [];
    let i = 0;
    while (i < lines.length) {
      if (lines[i].trim() !== tag) {
        out.push(lines[i]);
        i++;
        continue;
      }
      let j = i + 1;
      while (j < lines.length && lines[j].trim() !== endTag && lines[j].trim() !== tag) {
        j++;
      }
      if (j < lines.length && lines[j].trim() === endTag) {
        i = j + 1; // drop tag..endTag inclusive
      } else {
        throw new TruncatedCronBlockError(tag);
      }
    }
    return out;
  }

  /**
   * Routed through the shared {@link CrontabMutator}: if `stripCronBlock`
   * throws (truncated block), that throw propagates out of `mutate()` before
   * it ever calls `write`, so a truncated block leaves the crontab
   * byte-for-byte untouched.
   */
  private updateCron(tag: string, endTag: string, jobLine: string | null): void {
    this.mutator.mutate((lines) => {
      const kept = this.stripCronBlock(lines, tag, endTag);
      if (jobLine) {
        kept.push(tag, jobLine, endTag);
      }
      const changed = kept.length !== lines.length || !!jobLine;
      return { lines: changed ? kept : lines, result: undefined };
    });
  }

  /** Verify an existing managed block before touching a replacement scheduler. */
  private verifyCronBlock(tag: string, endTag: string): void {
    this.mutator.mutate((lines) => {
      this.stripCronBlock(lines, tag, endTag);
      return { lines, result: undefined };
    });
  }

  /** The last `CRON_TZ=...` assignment still in effect at the end of `lines`, if any. */
  private lastCronTzLine(lines: string[]): string | null {
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i].trim().startsWith("CRON_TZ=")) return lines[i];
    }
    return null;
  }

  private staleAtIds(tag: string): string[] {
    return this.atIo
      .list()
      .filter((job) => job.script.includes(tag))
      .map((job) => job.id);
  }

  private removeAtIds(ids: Iterable<string>): void {
    for (const id of ids) this.atIo.remove(id);
  }

  /** The tag/end-tag pair bounding one obligation's managed cron block, exactly. */
  private activationTags(id: string): { tag: string; endTag: string } {
    return {
      tag: `# mc-obligation-activation:${id}`,
      endTag: `# mc-obligation-activation-end:${id}`,
    };
  }

  scheduleObligationActivation(
    id: string,
    time: { kind: "cron"; cronExpr: string } | { kind: "at"; date: Date }
  ): void {
    const { tag, endTag } = this.activationTags(id);
    const curlLine = this.buildCurlLine("wake-obligation", { id });

    if (time.kind === "cron") {
      assertCronExprCanFire(time.cronExpr);
      const staleAtIds = this.staleAtIds(tag);
      // CRON_TZ persists for every later line in the crontab, not just ours,
      // so the block must put back whatever was in effect before it rather
      // than clearing it — otherwise a job appended after this one silently
      // loses a timezone some other entry depends on.
      this.mutator.mutate((lines) => {
        const kept = this.stripCronBlock(lines, tag, endTag);
        const priorTz = this.lastCronTzLine(kept);
        kept.push(
          tag,
          "CRON_TZ=UTC",
          `${time.cronExpr} ${curlLine}`,
          priorTz ?? "CRON_TZ=",
          endTag
        );
        return { lines: kept, result: undefined };
      });
      // The replacement cron block is now durable.  If removing an old at job
      // fails, retain it for reconciliation rather than creating a scheduling
      // gap by removing it before the replacement was installed.
      this.removeAtIds(staleAtIds);
    } else {
      const script = `${tag}\n${curlLine}\n`;
      // Validate the existing block before submitting `at`: corruption must
      // still fail closed with no new job, while a normal replacement is
      // installed before its old cron/at entries are removed.
      this.verifyCronBlock(tag, endTag);
      // Install first: a failed `at` submission leaves an existing cron block
      // and prior at jobs armed.  Once it succeeds, remove only the stale jobs
      // captured before installation (never the just-created replacement).
      const staleAtIds = this.staleAtIds(tag);
      const replacementId = this.atIo.schedule(script, time.date);
      this.updateCron(tag, endTag, null);
      this.removeAtIds(staleAtIds.filter((staleId) => staleId !== replacementId));
    }
  }

  cancelObligationActivation(id: string): void {
    const { tag, endTag } = this.activationTags(id);
    this.updateCron(tag, endTag, null);
    this.removeAtIds(this.staleAtIds(tag));
  }

  listObligationActivations(): string[] {
    const ids = new Set<string>();
    const current = this.mutator.read();
    for (const line of current.split("\n")) {
      const m = line.match(/^# mc-obligation-activation:(.+)$/);
      if (m) ids.add(m[1].trim());
    }
    for (const job of this.atIo.list()) {
      const m = job.script.match(/# mc-obligation-activation:(.+)/);
      if (m) ids.add(m[1].trim());
    }
    return Array.from(ids);
  }

  scheduleMessageDelivery(id: string, date: Date): void {
    const tag = `# mc-message-delivery:${id}`;
    const curlLine = this.buildCurlLine("wake-message", { id });
    const script = `${tag}\n${curlLine}\n`;
    const staleAtIds = this.staleAtIds(tag);
    const replacementId = this.atIo.schedule(script, date);
    this.removeAtIds(staleAtIds.filter((staleId) => staleId !== replacementId));
  }

  cancelMessageDelivery(id: string): void {
    const tag = `# mc-message-delivery:${id}`;
    this.removeAtIds(this.staleAtIds(tag));
  }

  listMessageDeliveries(): string[] {
    const ids = new Set<string>();
    for (const job of this.atIo.list()) {
      const m = job.script.match(/# mc-message-delivery:(.+)/);
      if (m) ids.add(m[1].trim());
    }
    return Array.from(ids);
  }
}
