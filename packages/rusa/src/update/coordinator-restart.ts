import { spawn } from "node:child_process";
import http from "node:http";
import { POOL_COORDINATOR_UNIT } from "../commands/coordinator-provisioning.js";
import { runTimedStep } from "./runner.js";
import type { CoordinatorRestartSeam } from "./orchestrator.js";

export const COORDINATOR_RESTART_TIMEOUT_MS = 60_000;
const READY_POLL_INTERVAL_MS = 200;

type ReadyEnvelope = { service?: { loadedRevision?: unknown } };

function readReadyRevision(socketPath: string): Promise<string | null> {
  return new Promise((resolve) => {
    const request = http.request({ socketPath, path: "/v1/readyz", method: "GET" }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => (body += chunk));
      response.on("end", () => {
        if (response.statusCode !== 200) {
          resolve(null);
          return;
        }
        try {
          const parsed = JSON.parse(body) as ReadyEnvelope;
          const revision = parsed.service?.loadedRevision;
          resolve(typeof revision === "string" ? revision : null);
        } catch {
          resolve(null);
        }
      });
    });
    request.on("error", () => resolve(null));
    request.setTimeout(2_000, () => request.destroy());
    request.end();
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Wait until readyz identifies the exact revision that this update built. */
export async function waitForCoordinatorRevision(opts: {
  socketPath: string;
  expectedRevision: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
}): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? COORDINATOR_RESTART_TIMEOUT_MS;
  const pollIntervalMs = opts.pollIntervalMs ?? READY_POLL_INTERVAL_MS;
  const deadline = Date.now() + timeoutMs;
  let observed: string | null = null;
  while (Date.now() <= deadline) {
    observed = await readReadyRevision(opts.socketPath);
    if (observed === opts.expectedRevision) return;
    await delay(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
  }
  throw new Error(
    `quota coordinator did not report loaded revision ${opts.expectedRevision.slice(0, 7)} ` +
      `within ${timeoutMs}ms${observed ? ` (last reported ${observed.slice(0, 7)})` : ""}`
  );
}

export interface SystemdCoordinatorRestarterOptions {
  socketPath: string;
  unit?: string;
  timeoutMs?: number;
  /** Injection seam for tests; production runs the one fixed pool unit. */
  restartUnit?: (unit: string) => Promise<void>;
  log?: (message: string) => void;
}

/**
 * Refresh the one fixed pool-owned coordinator, then require its ready
 * envelope to prove it loaded the just-built revision. No client service is
 * touched here; the normal update drain/restart remains responsible for that.
 */
export class SystemdCoordinatorRestarter implements CoordinatorRestartSeam {
  private readonly unit: string;
  private readonly timeoutMs: number;
  private readonly restartUnit: (unit: string) => Promise<void>;

  constructor(private readonly options: SystemdCoordinatorRestarterOptions) {
    this.unit = options.unit ?? POOL_COORDINATOR_UNIT;
    this.timeoutMs = options.timeoutMs ?? COORDINATOR_RESTART_TIMEOUT_MS;
    this.restartUnit =
      options.restartUnit ??
      ((unit) =>
        runTimedStep("coordinator-restart", "systemctl", ["--user", "restart", unit], {
          cwd: process.cwd(),
          timeoutMs: this.timeoutMs,
          log: options.log,
          spawnImpl: spawn,
        }));
  }

  async restart(expectedRevision: string): Promise<void> {
    await this.restartUnit(this.unit);
    await waitForCoordinatorRevision({
      socketPath: this.options.socketPath,
      expectedRevision,
      timeoutMs: this.timeoutMs,
    });
  }
}
