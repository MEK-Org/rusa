import { createHash } from "node:crypto";
import { ACTOR_RUN_OUTPUT_MAX_CHARS, captureRunOutput } from "./actor-run-repository.js";

/** The capture bound plus room for its truncation marker. */
export const RUN_RECEIPT_OUTPUT_MAX_CHARS = ACTOR_RUN_OUTPUT_MAX_CHARS + 128;

/**
 * A remote run's terminal as its executing host committed it (#1020). It is
 * stored as JSON on both sides, so its readers validate it here rather than
 * with SQLite JSON functions, and `version` is the one explicit evolution
 * path. It carries the bounded terminal fields of `actor_runs`: `output` is
 * capped at the same capture bound, never the provider's full stream.
 */
export type RunReceipt = RunReceiptCompleted | RunReceiptAbandoned;

interface RunReceiptBase {
  version: 1;
  instanceId: string;
  runId: string;
  actorId: string;
  endedAt: string;
}

export interface RunReceiptCompleted extends RunReceiptBase {
  outcome: "completed";
  success: boolean;
  exitCode: number;
  output: string | null;
}

/**
 * A run the host's own runtime ended without a result, after the provider
 * call it made had settled. Nothing else writes one: a run the host did not
 * see end gets no receipt at all and stays unresolved (#1020).
 */
export interface RunReceiptAbandoned extends RunReceiptBase {
  outcome: "abandoned";
  reason: string;
}

/**
 * A receipt as it travels, keyed by the run ID it closes (#1119 ruling), plus
 * the exact stored document. The host mints that ID and registers it with the
 * leader through `runStart`; the leader treats it as untrusted and validates
 * each receipt against the instance that registered the run.
 */
export interface RunReceiptEnvelope {
  runId: string;
  /** SHA-256 hex of `receipt`. */
  digest: string;
  /** The serialized {@link RunReceipt}, byte-identical on every retry. */
  receipt: string;
}

export function createRunReceipt(
  input:
    | (Omit<RunReceiptCompleted, "version" | "output"> & { output: string | null | undefined })
    | Omit<RunReceiptAbandoned, "version">
): RunReceipt {
  if (input.outcome === "completed") {
    return validateRunReceipt({
      version: 1,
      instanceId: input.instanceId,
      runId: input.runId,
      actorId: input.actorId,
      endedAt: input.endedAt,
      outcome: "completed",
      success: input.success,
      exitCode: input.exitCode,
      output: captureRunOutput(input.output),
    });
  }
  return validateRunReceipt({
    version: 1,
    instanceId: input.instanceId,
    runId: input.runId,
    actorId: input.actorId,
    endedAt: input.endedAt,
    outcome: "abandoned",
    reason: input.reason,
  });
}

/** Serialize in a fixed key order, so equal receipts have equal digests. */
export function serializeRunReceipt(receipt: RunReceipt): string {
  return JSON.stringify(validateRunReceipt(receipt));
}

export function runReceiptDigest(serialized: string): string {
  return createHash("sha256").update(serialized, "utf8").digest("hex");
}

export function parseRunReceipt(serialized: string): RunReceipt {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw new Error("invalid run receipt: invalid JSON");
  }
  return validateRunReceipt(parsed);
}

const BASE_KEYS = ["version", "instanceId", "runId", "actorId", "endedAt", "outcome"];
const COMPLETED_KEYS = new Set([...BASE_KEYS, "success", "exitCode", "output"]);
const ABANDONED_KEYS = new Set([...BASE_KEYS, "reason"]);

function nonblank(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`invalid run receipt: ${key} must be a nonblank string`);
  }
  return value;
}

function validateRunReceipt(value: unknown): RunReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid run receipt: expected an object");
  }
  const record = value as Record<string, unknown>;
  if (record.version !== 1) throw new Error("invalid run receipt: unsupported version");
  const outcome = record.outcome;
  if (outcome !== "completed" && outcome !== "abandoned") {
    throw new Error("invalid run receipt: outcome must be completed or abandoned");
  }
  const allowed = outcome === "completed" ? COMPLETED_KEYS : ABANDONED_KEYS;
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) throw new Error(`invalid run receipt: unexpected property '${key}'`);
  }
  const endedAt = nonblank(record, "endedAt");
  if (Number.isNaN(Date.parse(endedAt))) {
    throw new Error("invalid run receipt: endedAt must be an ISO timestamp");
  }
  const base = {
    version: 1 as const,
    instanceId: nonblank(record, "instanceId"),
    runId: nonblank(record, "runId"),
    actorId: nonblank(record, "actorId"),
    endedAt,
  };
  if (outcome === "abandoned") {
    return { ...base, outcome, reason: nonblank(record, "reason") };
  }
  if (typeof record.success !== "boolean") {
    throw new Error("invalid run receipt: success must be a boolean");
  }
  if (typeof record.exitCode !== "number" || !Number.isInteger(record.exitCode)) {
    throw new Error("invalid run receipt: exitCode must be an integer");
  }
  if (record.output !== null && typeof record.output !== "string") {
    throw new Error("invalid run receipt: output must be a string or null");
  }
  if (typeof record.output === "string" && record.output.length > RUN_RECEIPT_OUTPUT_MAX_CHARS) {
    throw new Error("invalid run receipt: output exceeds the capture bound");
  }
  return {
    ...base,
    outcome,
    success: record.success,
    exitCode: record.exitCode,
    output: record.output,
  };
}
