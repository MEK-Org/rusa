import { execFileSync, spawnSync } from "node:child_process";

export interface AtProbe {
  hasAt: () => boolean;
  hasAtrm: () => boolean;
  isAtdRunning: () => boolean;
  /** Confirm that this user can query the live queue through `atq`. */
  canQueryAtq: () => boolean;
}

/** Read-only host preflight for the `at` CLI, daemon, and queue access. */
export function preflightAt(probe: AtProbe = defaultAtProbe()): {
  ok: boolean;
  issues: string[];
} {
  const issues: string[] = [];
  if (!probe.hasAt()) issues.push("`at` CLI not found — install at");
  if (!probe.hasAtrm()) issues.push("`atrm` CLI not found — install at");
  if (probe.hasAt() && !probe.isAtdRunning()) {
    issues.push("atd daemon not detected — one-shot obligations and scheduled messages won't fire");
  }
  if (!probe.canQueryAtq()) {
    issues.push(
      "`atq` cannot be queried — verify at/atd is installed and this user can access the queue"
    );
  }
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
      const result = spawnSync("atq", { encoding: "utf-8" });
      return !result.error && result.status === 0;
    },
  };
}

/** The `at` queue read/write seam. */
export interface AtIo {
  schedule(script: string, date: Date): string;
  list(): { id: string; script: string }[];
  remove(id: string): void;
}

/** Raised when a host without a working `at` facility needs a one-shot job. */
export class AtUnavailableError extends Error {
  constructor(issues: string[]) {
    super(`\`at\` scheduling is unavailable: ${issues.join("; ")}`);
    this.name = "AtUnavailableError";
  }
}

/** An explicit unavailable adapter used when preflight fails during boot. */
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

const AT_JOB_GONE = /cannot find|no such|does not exist|not found/i;

/** Real `at`/`atq`/`atrm` IO. */
export function execAtIo(): AtIo {
  return {
    schedule(script: string, date: Date): string {
      const pad = (value: number, width: number) => value.toString().padStart(width, "0");
      const timeStr =
        `${pad(date.getUTCFullYear(), 4)}${pad(date.getUTCMonth() + 1, 2)}` +
        `${pad(date.getUTCDate(), 2)}${pad(date.getUTCHours(), 2)}` +
        `${pad(date.getUTCMinutes(), 2)}.${pad(date.getUTCSeconds(), 2)}`;

      const result = spawnSync("at", ["-t", timeStr], {
        input: script,
        encoding: "utf-8",
        env: { ...process.env, TZ: "UTC" },
      });
      if (result.error) throw result.error;
      if (result.status !== 0) throw new Error(`at failed: ${result.stderr || result.stdout}`);

      const match = result.stderr.match(/job\s+(\d+)\s+at/);
      if (!match) throw new Error(`could not parse at output: ${result.stderr}`);
      return match[1];
    },
    list(): { id: string; script: string }[] {
      const result = spawnSync("atq", { encoding: "utf-8" });
      if (result.error) throw result.error;
      if (result.status !== 0) {
        throw new Error(`atq failed: ${result.stderr || result.stdout}`);
      }

      const jobs: { id: string; script: string }[] = [];
      for (const line of result.stdout.trim().split("\n")) {
        if (!line) continue;
        const id = line.split(/\s+/)[0];
        if (!id) continue;

        const scriptResult = spawnSync("at", ["-c", id], { encoding: "utf-8" });
        if (scriptResult.status === 0) {
          jobs.push({ id, script: scriptResult.stdout });
        } else if (!AT_JOB_GONE.test(`${scriptResult.stderr}${scriptResult.stdout}`)) {
          throw new Error(`at -c ${id} failed: ${scriptResult.stderr || scriptResult.stdout}`);
        }
      }
      return jobs;
    },
    remove(id: string): void {
      const result = spawnSync("atrm", [id], { encoding: "utf-8" });
      if (result.error) throw result.error;
      if (result.status !== 0 && !AT_JOB_GONE.test(`${result.stderr}${result.stdout}`)) {
        throw new Error(`atrm ${id} failed: ${result.stderr || result.stdout}`);
      }
    },
  };
}
