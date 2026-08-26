import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The cron-backed nightly trigger (ISSUE_NUM, phase 1c — Operator's redirect from a
 * persisted scheduler to system cron). Timing + durability live in the familiar
 * account's OWN crontab; the mesh exposes a loopback wake endpoint that a cron job
 * pings. This module is the crontab side: validate + splice + read the
 * `# mc-wake:<actorId>` tagged blocks, plus the token/port files the job line and
 * the endpoint share.
 *
 * Safety (the crontab is the familiar's own — no shared tenancy — but still
 * surgical): edits are an in-process-serialized read-modify-write that touches
 * ONLY the tagged block for one actor and preserves every other line; the cron
 * expression is validated before any write (a malformed line makes `crontab -`
 * reject the WHOLE file); the reason is shell- and cron-escaped (`%` is a cron
 * newline). The tag is its own comment line ABOVE the job (cron treats a trailing
 * `#` as part of the command, so an inline tag would corrupt the job).
 */

/** Default absolute curl — cron runs with a minimal PATH, so don't rely on lookup. */
const DEFAULT_CURL = "/usr/bin/curl";
const TAG_PREFIX = "# mc-wake:";

export const wakeTokenPath = (mcHome: string): string => join(mcHome, "wake-token");
export const wakePortPath = (mcHome: string): string => join(mcHome, "wake-port");

/**
 * Mint (once) the bearer token the wake endpoint requires and the cron job sends,
 * into a chmod-600 file — same posture as the webhook secret. Idempotent: returns
 * the existing token if present, so boot and install converge on one value.
 */
export function ensureWakeToken(mcHome: string): string {
  const path = wakeTokenPath(mcHome);
  if (existsSync(path)) {
    const existing = readFileSync(path, "utf-8").trim();
    if (existing) return existing;
  }
  const token = randomBytes(32).toString("hex");
  writeFileSync(path, token, { mode: 0o600 });
  chmodSync(path, 0o600); // enforce even if the file pre-existed with looser bits
  return token;
}

/**
 * Publish the endpoint's live port so the cron job can reach it across restarts
 * (the http server binds an ephemeral port; the job line reads this file via
 * `$(cat ...)` rather than hardcoding a port that changes every boot).
 */
export function writeWakePort(mcHome: string, port: number): void {
  // Atomic write (temp + rename) so a cron job that fires mid-restart never reads
  // a half-written port-file and misses a tick — rename is atomic on the same fs.
  const path = wakePortPath(mcHome);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, String(port));
  renameSync(tmp, path);
}

/**
 * A standard 5-field cron expression with numeric/`* / , -` fields only (no named
 * months/days for v1 — keeps the validator strict so a bad expr can't slip a line
 * that makes `crontab -` reject the entire file). Returns true if safe to write.
 */
export function isValidCronExpr(expr: string): boolean {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  return fields.every((f) => /^[0-9*/,-]+$/.test(f));
}

/** Thread ids and suffixed wake slots only — keeps the tag/job lines free of whitespace or shell metachars. */
export function isValidActorId(actorId: string): boolean {
  return /^[A-Za-z0-9._-]+(:[A-Za-z0-9._-]+)*$/.test(actorId);
}

/** Single-quote a value for the cron job line, then escape `%` (a cron newline). */
function quoteForCron(value: string): string {
  const oneLine = value.replace(/[\r\n]+/g, " ");
  const singleQuoted = `'${oneLine.replace(/'/g, "'\\''")}'`;
  return singleQuoted.replace(/%/g, "\\%");
}

export interface WakeEntry {
  actorId: string;
  cronExpr: string;
  reason: string;
  priority?: "normal" | "responsive";
}

export interface CrontabWakeCronOptions {
  /** Absolute path to the chmod-600 bearer-token file (cron reads it via `$(cat …)`). */
  tokenFile: string;
  /** Absolute path to the live-port file the endpoint writes each boot. */
  portFile: string;
  /** Loopback host the endpoint binds (default 127.0.0.1). */
  host?: string;
  /** Absolute curl path (default /usr/bin/curl). */
  curlPath?: string;
}

/** The crontab read/write seam — injected so edits are hermetically testable. */
export interface CrontabIo {
  /** `crontab -l` (empty string when the user has no crontab yet). */
  read(): string;
  /** `crontab -` (throws if cron rejects the content). */
  write(content: string): void;
}

/** Real crontab IO over the `crontab` CLI. */
export function execCrontabIo(): CrontabIo {
  return {
    read(): string {
      try {
        return execFileSync("crontab", ["-l"], { encoding: "utf-8" });
      } catch {
        return ""; // "no crontab for user" exits non-zero — treat as empty
      }
    },
    write(content: string): void {
      execFileSync("crontab", ["-"], { input: content, encoding: "utf-8" });
    },
  };
}

/**
 * Read/modify/write the familiar's crontab for `# mc-wake:<actorId>` blocks. All
 * mutations go through an in-process mutex and re-read the crontab immediately
 * before editing, so concurrent schedule/cancel calls can't clobber each other or
 * a human's unrelated lines.
 */
export class CrontabWakeCron {
  private lock: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly io: CrontabIo,
    private readonly opts: CrontabWakeCronOptions
  ) {}

  /** Serialize a read-modify-write so edits never interleave. */
  private serialize<T>(fn: () => T): Promise<T> {
    const run = this.lock.then(() => fn());
    this.lock = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  /** The full job line a cron entry runs to ping the wake endpoint. */
  buildJobLine(
    actorId: string,
    cronExpr: string,
    reason: string,
    priority?: "normal" | "responsive" | boolean
  ): string {
    const curl = this.opts.curlPath ?? DEFAULT_CURL;
    const host = this.opts.host ?? "127.0.0.1";
    // The token + port come from files via command substitution (double-quoted so
    // `$(…)` expands); actorId/reason are single-quoted literals (escaped above).
    // NOTE: the resolved token transits curl's argv (briefly visible in /proc to
    // the same uid). Immaterial on this single-user host — anyone who could read
    // /proc could already read the 0600 token file. If the host ever becomes
    // multi-tenant, switch to `curl -H @<tokenFile>` so the token never hits argv.
    const url = `"http://${host}:$(cat ${this.opts.portFile})/wake"`;
    const auth = `"Authorization: Bearer $(cat ${this.opts.tokenFile})"`;
    const isResponsive = priority === "responsive" || priority === true;
    const priorityArg = isResponsive ? ` -d ${quoteForCron("priority=responsive")}` : "";
    return (
      `${cronExpr.trim()} ${curl} -fsS -H ${auth} ${url} ` +
      `-d ${quoteForCron(`actorId=${actorId}`)} -d ${quoteForCron(`reason=${reason}`)}${priorityArg}`
    );
  }

  /**
   * Drop the tag line + its following job line for `actorId`; keep all else.
   * NOTE: if a human hand-mangles the crontab by inserting a blank/comment line
   * BETWEEN a `# mc-wake:` tag and its job, the now-detached job line is left as an
   * orphan (we only skip an immediately-following real line). Benign: re-firing is
   * harmless (at-least-once + the idempotent cursor-driven distiller), and the
   * `# mc-wake:` namespace is mc-owned so we never touch a human's own lines.
   */
  private stripBlock(lines: string[], actorId: string): string[] {
    const tag = TAG_PREFIX + actorId;
    const out: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim() === tag) {
        // Skip the tag and the immediate job line (if a real, non-comment line).
        const next = lines[i + 1];
        if (next !== undefined && next.trim() !== "" && !next.trimStart().startsWith("#")) {
          i++;
        }
        continue;
      }
      out.push(lines[i]);
    }
    return out;
  }

  async schedule(
    actorId: string,
    cronExpr: string,
    reason: string,
    priority?: "normal" | "responsive" | boolean
  ): Promise<void> {
    if (!isValidActorId(actorId)) throw new Error(`invalid actor id: ${actorId}`);
    if (!isValidCronExpr(cronExpr)) throw new Error(`invalid cron expression: ${cronExpr}`);
    return this.serialize(() => {
      const current = this.io.read();
      const lines = current === "" ? [] : current.replace(/\n$/, "").split("\n");
      const kept = this.stripBlock(lines, actorId);
      kept.push(TAG_PREFIX + actorId, this.buildJobLine(actorId, cronExpr, reason, priority));
      this.io.write(`${kept.join("\n")}\n`);
    });
  }

  async cancel(actorId: string): Promise<void> {
    if (!isValidActorId(actorId)) throw new Error(`invalid actor id: ${actorId}`);
    return this.serialize(() => {
      const current = this.io.read();
      if (current === "") return;
      const lines = current.replace(/\n$/, "").split("\n");
      const kept = this.stripBlock(lines, actorId);
      if (kept.length === lines.length) return; // nothing to remove
      this.io.write(kept.length ? `${kept.join("\n")}\n` : "");
    });
  }

  list(): Promise<WakeEntry[]> {
    return this.serialize(() => {
      const current = this.io.read();
      if (current === "") return [];
      const lines = current.replace(/\n$/, "").split("\n");
      const entries: WakeEntry[] = [];
      for (let i = 0; i < lines.length; i++) {
        const trimmed = lines[i].trim();
        if (!trimmed.startsWith(TAG_PREFIX)) continue;
        const actorId = trimmed.slice(TAG_PREFIX.length);
        const job = lines[i + 1] ?? "";
        const reason = parseReason(job);
        const priority = parsePriority(job);
        entries.push({
          actorId,
          cronExpr: job.trim().split(/\s+/).slice(0, 5).join(" "),
          reason,
          ...(priority ? { priority } : {}),
        });
      }
      return entries;
    });
  }
}

/** Recover the reason from a job line's `-d 'reason=…'` (reverse of quoteForCron). */
function parseReason(job: string): string {
  const m = job.match(/-d '(?:reason=)((?:[^']|'\\'')*)'/);
  if (!m) return "";
  return m[1].replace(/'\\''/g, "'").replace(/\\%/g, "%");
}

/** Recover the priority from a job line's `-d 'priority=…'`. */
function parsePriority(job: string): "responsive" | undefined {
  const m = job.match(/-d '(?:priority=)((?:[^']|'\\'')*)'/);
  if (!m) return undefined;
  const val = m[1].replace(/'\\''/g, "'");
  return val === "responsive" ? "responsive" : undefined;
}

/**
 * Preflight that the host can actually run cron, so `schedule_wake` doesn't
 * silently no-op. Best-effort + non-fatal: returns the issues for the caller to
 * warn about (IU is the only consumer and isn't scheduled until phase 2).
 */
export function preflightCron(
  probe: { hasCrontab: () => boolean; isCrondRunning: () => boolean } = defaultCronProbe()
): { ok: boolean; issues: string[] } {
  const issues: string[] = [];
  if (!probe.hasCrontab()) issues.push("`crontab` CLI not found — install cron");
  else if (!probe.isCrondRunning())
    issues.push("cron daemon not detected — scheduled wakes won't fire");
  return { ok: issues.length === 0, issues };
}

function defaultCronProbe(): { hasCrontab: () => boolean; isCrondRunning: () => boolean } {
  const can = (cmd: string, args: string[]): boolean => {
    try {
      execFileSync(cmd, args, { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  };
  return {
    hasCrontab: () => can("which", ["crontab"]),
    isCrondRunning: () => can("pgrep", ["-x", "cron"]) || can("pgrep", ["-x", "crond"]),
  };
}
