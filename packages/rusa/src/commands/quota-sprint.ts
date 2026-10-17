import { loadConfig, resolveHome } from "../config/index.js";
import { normalizeProviderThrottleKey, QUOTA_THROTTLE_PROVIDERS } from "../providers/registry.js";
import type { ManualReadingResult } from "../quota/coordinator-client.js";
import { QuotaCoordinatorClient } from "../quota/coordinator-client.js";
import {
  COORDINATOR_PROTOCOL_MAJOR,
  QUOTA_SPRINT_PROTOCOL_MINOR,
  type QuotaSprintArmRequest,
  type QuotaSprintCancelRequest,
} from "../quota/coordinator-protocol.js";
import { resolveQuotaCoordinatorSocketPath } from "./quota-coordinator.js";

/**
 * `rusa quota-sprint status|arm|cancel` (#861): the operator's only control of
 * the weekly sprint. Every call goes over the coordinator's protected socket;
 * nothing here opens the quota database, so policy stays in the coordinator's
 * memory and a restart disarms it.
 *
 * Each command prints the coordinator's own JSON answer, so what the operator
 * reads is exactly what the service decided. The exit code is 0 for a 2xx
 * answer and 1 otherwise, including a coordinator that predates the sprint
 * protocol minor: the command refuses it before sending anything that could
 * change state.
 */
export interface QuotaSprintCommandOptions {
  provider: string;
  home?: string;
  socketPath?: string;
  /** Test seam; the configured socket's client otherwise. */
  client?: Pick<QuotaCoordinatorClient, "getSprintStatus" | "postSprintAction">;
  write?: (text: string) => void;
  writeError?: (text: string) => void;
}

export interface QuotaSprintArmOptions extends QuotaSprintCommandOptions {
  bootId: string;
  revision: string | number;
  bucket: string;
  cycleAnchor: string;
  generation: string | number;
  requestId: string;
  expiresAt: string;
  confirmResetUsable: boolean;
}

export interface QuotaSprintCancelOptions extends QuotaSprintCommandOptions {
  bootId: string;
  revision: string | number;
  armId: string;
}

interface Io {
  provider: string;
  client: NonNullable<QuotaSprintCommandOptions["client"]>;
  write: (text: string) => void;
  writeError: (text: string) => void;
}

function resolveIo(opts: QuotaSprintCommandOptions): Io {
  const raw = opts.provider?.trim() ?? "";
  const provider = normalizeProviderThrottleKey(raw);
  if (!raw || !(QUOTA_THROTTLE_PROVIDERS as readonly string[]).includes(provider)) {
    throw new Error(
      `--provider must name a quota-paced provider: one of ${QUOTA_THROTTLE_PROVIDERS.join(", ")}`
    );
  }
  let client = opts.client;
  if (!client) {
    // An explicit socket needs no config, so the command also works where the
    // operator has no rusa home of their own.
    const config = opts.socketPath?.trim() ? null : loadConfig(opts.home ?? resolveHome());
    const socketPath = resolveQuotaCoordinatorSocketPath(config, opts.socketPath);
    client = new QuotaCoordinatorClient({ socketPath });
  }
  return {
    provider,
    client,
    write: opts.write ?? ((text) => process.stdout.write(text)),
    writeError: opts.writeError ?? ((text) => process.stderr.write(text)),
  };
}

function wholeNumber(name: string, value: string | number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer, not ${JSON.stringify(value)}`);
  }
  return parsed;
}

/**
 * Why `result` cannot be trusted as a sprint-capable coordinator's answer, or
 * null when it can. An older coordinator answers the sprint path with a 404 or
 * 405 envelope that still carries its protocol minor, which is what this reads.
 */
function protocolProblem(result: ManualReadingResult): string | null {
  if (!result.reached) return `Coordinator unreachable: ${result.error}`;
  let service: { protocolMajor?: unknown; protocolMinor?: unknown } | undefined;
  try {
    service = (JSON.parse(result.body) as { service?: typeof service }).service;
  } catch {
    return `Coordinator answered HTTP ${result.statusCode} with a body that is not JSON`;
  }
  if (service?.protocolMajor !== COORDINATOR_PROTOCOL_MAJOR) {
    return `Coordinator protocol major ${String(service?.protocolMajor)} is not ${COORDINATOR_PROTOCOL_MAJOR}`;
  }
  if (
    typeof service.protocolMinor !== "number" ||
    service.protocolMinor < QUOTA_SPRINT_PROTOCOL_MINOR
  ) {
    return (
      `Coordinator protocol minor ${String(service.protocolMinor)} predates the weekly sprint ` +
      `(minor ${QUOTA_SPRINT_PROTOCOL_MINOR}); restart it on a build that serves quota-sprint`
    );
  }
  return null;
}

function report(io: Io, result: ManualReadingResult): number {
  const problem = protocolProblem(result);
  if (problem) {
    io.writeError(`${problem}\n`);
    return 1;
  }
  if (!result.reached) return 1;
  const ok = result.statusCode >= 200 && result.statusCode < 300;
  (ok ? io.write : io.writeError)(`${JSON.stringify(JSON.parse(result.body), null, 2)}\n`);
  return ok ? 0 : 1;
}

/** Print one provider's sprint status. */
export async function runQuotaSprintStatus(opts: QuotaSprintCommandOptions): Promise<number> {
  const io = resolveIo(opts);
  return report(io, await io.client.getSprintStatus(io.provider));
}

/**
 * Check the coordinator speaks the sprint minor before a state-changing POST,
 * so an older peer never receives one.
 */
async function preflight(io: Io): Promise<boolean> {
  const problem = protocolProblem(await io.client.getSprintStatus(io.provider));
  if (problem) io.writeError(`${problem}\n`);
  return problem === null;
}

/** Arm one weekly sprint, exactly as the preconditions name it. */
export async function runQuotaSprintArm(opts: QuotaSprintArmOptions): Promise<number> {
  const io = resolveIo(opts);
  if (opts.confirmResetUsable !== true) {
    throw new Error("--confirm-reset-usable is required: confirm one provider reset is usable");
  }
  const request: QuotaSprintArmRequest = {
    action: "arm",
    provider: io.provider,
    bootId: opts.bootId,
    revision: wholeNumber("--revision", opts.revision),
    bucket: opts.bucket,
    cycleAnchor: opts.cycleAnchor,
    generation: wholeNumber("--generation", opts.generation),
    requestId: opts.requestId,
    expiresAt: opts.expiresAt,
    confirmResetUsable: true,
  };
  if (!(await preflight(io))) return 1;
  return report(io, await io.client.postSprintAction(request));
}

/** Cancel one armed sprint by its arm ID. */
export async function runQuotaSprintCancel(opts: QuotaSprintCancelOptions): Promise<number> {
  const io = resolveIo(opts);
  const request: QuotaSprintCancelRequest = {
    action: "cancel",
    provider: io.provider,
    bootId: opts.bootId,
    revision: wholeNumber("--revision", opts.revision),
    armId: opts.armId,
  };
  if (!(await preflight(io))) return 1;
  return report(io, await io.client.postSprintAction(request));
}
