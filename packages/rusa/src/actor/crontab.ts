import { execFileSync } from "node:child_process";

/** The crontab read/write seam. */
export interface CrontabIo {
  read(): string;
  write(content: string): void;
}

/** Real crontab IO over the `crontab` CLI. */
export function execCrontabIo(run: typeof execFileSync = execFileSync): CrontabIo {
  return {
    read(): string {
      try {
        return run("crontab", ["-l"], { encoding: "utf-8" }) as string;
      } catch (error) {
        const stderr = (error as { stderr?: string | Buffer }).stderr;
        const detail = typeof stderr === "string" ? stderr : (stderr?.toString("utf-8") ?? "");
        if (/no crontab for(?:\s+user)?\b/i.test(detail)) return "";
        throw error;
      }
    },
    write(content: string): void {
      execFileSync("crontab", ["-"], { input: content, encoding: "utf-8" });
    },
  };
}

/** The single read-modify-write path for all managed crontab entries. */
export class CrontabMutator {
  constructor(private readonly io: CrontabIo) {}

  read(): string {
    return this.io.read();
  }

  mutate<T>(fn: (lines: string[]) => { lines: string[]; result: T }): T {
    const current = this.io.read();
    const lines = current === "" ? [] : current.replace(/\n$/, "").split("\n");
    const { lines: nextLines, result } = fn(lines);
    if (nextLines !== lines) {
      this.io.write(nextLines.length ? `${nextLines.join("\n")}\n` : "");
    }
    return result;
  }
}

export interface CronProbe {
  hasCrontab: () => boolean;
  isCrondRunning: () => boolean;
  checkPermission: () => { ok: boolean; detail?: string };
}

/** Read-only host preflight for the crontab CLI, daemon, and user access. */
export function preflightCron(probe: CronProbe = defaultCronProbe()): {
  ok: boolean;
  issues: string[];
} {
  const issues: string[] = [];
  if (!probe.hasCrontab()) {
    issues.push("`crontab` CLI not found — install cron");
    return { ok: false, issues };
  }
  if (!probe.isCrondRunning()) issues.push("cron daemon not detected — scheduled wakes won't fire");
  const permission = probe.checkPermission();
  if (!permission.ok) {
    issues.push(
      permission.detail ??
        "this user is not permitted to use crontab — check /etc/cron.allow and /etc/cron.deny"
    );
  }
  return { ok: issues.length === 0, issues };
}

function defaultCronProbe(): CronProbe {
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
    checkPermission: () => {
      try {
        execFileSync("crontab", ["-l"], {
          stdio: ["ignore", "ignore", "pipe"],
          encoding: "utf-8",
        });
        return { ok: true };
      } catch (error) {
        const stderr =
          error && typeof error === "object" && "stderr" in error
            ? String((error as { stderr: unknown }).stderr)
            : "";
        if (/not allowed/i.test(stderr)) {
          return { ok: false, detail: `crontab denied for this user: ${stderr.trim()}` };
        }
        return { ok: true };
      }
    },
  };
}
