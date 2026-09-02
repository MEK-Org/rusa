import { execFileSync, spawnSync } from "node:child_process";
import { type CrontabIo, isValidCronExpr } from "./wake-cron.js";

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

export function preflightAt(
  probe: { hasAt: () => boolean; isAtdRunning: () => boolean } = defaultAtProbe()
): { ok: boolean; issues: string[] } {
  const issues: string[] = [];
  if (!probe.hasAt()) issues.push("`at` CLI not found — install at");
  else if (!probe.isAtdRunning())
    issues.push("atd daemon not detected — scheduled obligations won't fire");
  return { ok: issues.length === 0, issues };
}

function defaultAtProbe(): { hasAt: () => boolean; isAtdRunning: () => boolean } {
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
    isAtdRunning: () => can("pgrep", ["-x", "atd"]),
  };
}

export interface AtIo {
  schedule(script: string, date: Date): string;
  list(): { id: string; script: string }[];
  remove(id: string): void;
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
      if (res.error) {
        if ((res.error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw res.error;
      }
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

export class DefaultOsScheduler implements OsScheduler {
  constructor(
    private readonly crontabIo: CrontabIo,
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

  private stripCronBlock(lines: string[], tag: string): string[] {
    const out: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim() === tag) {
        while (i + 1 < lines.length) {
          const next = lines[i + 1];
          if (next === undefined) break;
          const trimmed = next.trim();
          if (
            trimmed.startsWith("CRON_TZ=") ||
            trimmed.includes("wake-obligation") ||
            trimmed.includes("wake-message")
          ) {
            i++;
          } else {
            break;
          }
        }
        continue;
      }
      out.push(lines[i]);
    }
    return out;
  }

  private updateCron(tag: string, jobLine: string | null): void {
    const current = this.crontabIo.read();
    const lines = current === "" ? [] : current.replace(/\n$/, "").split("\n");
    const kept = this.stripCronBlock(lines, tag);
    if (jobLine) {
      kept.push(tag, jobLine);
    }
    if (kept.length !== lines.length || jobLine) {
      this.crontabIo.write(kept.length ? `${kept.join("\n")}\n` : "");
    }
  }

  /** The last `CRON_TZ=...` assignment still in effect at the end of `lines`, if any. */
  private lastCronTzLine(lines: string[]): string | null {
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i].trim().startsWith("CRON_TZ=")) return lines[i];
    }
    return null;
  }

  private removeAtByTag(tag: string): void {
    const jobs = this.atIo.list();
    for (const job of jobs) {
      if (job.script.includes(tag)) {
        this.atIo.remove(job.id);
      }
    }
  }

  scheduleObligationActivation(
    id: string,
    time: { kind: "cron"; cronExpr: string } | { kind: "at"; date: Date }
  ): void {
    const tag = `# mc-obligation-activation:${id}`;
    const curlLine = this.buildCurlLine("wake-obligation", { id });

    if (time.kind === "cron") {
      if (!isValidCronExpr(time.cronExpr))
        throw new Error(`invalid cron expression: ${time.cronExpr}`);
      this.removeAtByTag(tag);
      // CRON_TZ persists for every later line in the crontab, not just ours,
      // so the block must put back whatever was in effect before it rather
      // than clearing it — otherwise a job appended after this one silently
      // loses a timezone some other entry depends on.
      const current = this.crontabIo.read();
      const lines = current === "" ? [] : current.replace(/\n$/, "").split("\n");
      const kept = this.stripCronBlock(lines, tag);
      const priorTz = this.lastCronTzLine(kept);
      kept.push(tag, "CRON_TZ=UTC", `${time.cronExpr} ${curlLine}`, priorTz ?? "CRON_TZ=");
      this.crontabIo.write(`${kept.join("\n")}\n`);
    } else {
      this.updateCron(tag, null);
      this.removeAtByTag(tag);
      const script = `${tag}\n${curlLine}\n`;
      this.atIo.schedule(script, time.date);
    }
  }

  cancelObligationActivation(id: string): void {
    const tag = `# mc-obligation-activation:${id}`;
    this.updateCron(tag, null);
    this.removeAtByTag(tag);
  }

  listObligationActivations(): string[] {
    const ids = new Set<string>();
    const current = this.crontabIo.read();
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
    this.removeAtByTag(tag);
    const curlLine = this.buildCurlLine("wake-message", { id });
    const script = `${tag}\n${curlLine}\n`;
    this.atIo.schedule(script, date);
  }

  cancelMessageDelivery(id: string): void {
    const tag = `# mc-message-delivery:${id}`;
    this.removeAtByTag(tag);
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
