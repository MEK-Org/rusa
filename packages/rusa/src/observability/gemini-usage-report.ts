import { createHash } from "node:crypto";
import {
  GEMINI_COUNT_FIELDS,
  GEMINI_USAGE_EVENT,
  GEMINI_USAGE_PURPOSES,
  type GeminiCounts,
  type GeminiUsageRecord,
} from "./gemini-usage.js";

export const MAX_USAGE_LINE_BYTES = 64 * 1024;
// Streaming bounds line memory; this cap also bounds exact deduplication memory.
export const MAX_REPORT_ATTEMPTS = 1_000_000;

export interface UsageSource {
  name: string;
  stream: AsyncIterable<Uint8Array>;
}
export interface UsageReportOptions {
  from: string;
  to: string;
  gaps?: string[];
}
interface SourceCoverage {
  name: string;
  logFrom: string | null;
  logTo: string | null;
  usageFrom: string | null;
  usageTo: string | null;
  lines: number;
  malformed: number;
  oversized: number;
  invalidUsage: number;
}
interface Measurement {
  sum: number | null;
  measured: number;
  missing: number;
}
type Totals = { [K in keyof GeminiCounts | "output"]: Measurement };
interface InputPerCall {
  max: number | null;
  p50: number | null;
  p90: number | null;
}
interface UsageActor {
  actorId: string | null;
  /** Distinct attributed run ids; omitted from text output but retained in JSON. */
  runIds: string[];
  calls: number;
  /** Interrupted calls are excluded from completed usage summaries. */
  partialCalls: number;
  input: Measurement;
  output: Measurement;
  inputPerCall: InputPerCall;
}
interface UsageActorAccumulator {
  actorId: string | null;
  runIds: Set<string>;
  calls: number;
  partialCalls: number;
  input: Measurement;
  output: Measurement;
  inputSamples: number[];
}
interface UsageGroup {
  purpose: GeminiUsageRecord["purpose"];
  model: string;
  calls: number;
  outcomes: Record<GeminiUsageRecord["outcome"], number>;
  coverage: Record<GeminiUsageRecord["usage"], number>;
  totals: Totals;
  partialObservations: Totals;
  actors: UsageActor[];
}
export interface GeminiUsageReport {
  version: 1;
  window: { from: string; to: string; endExclusive: true };
  sources: SourceCoverage[];
  knownGaps: string[];
  warnings: string[];
  duplicates: number;
  instances: string[];
  processes: string[];
  groups: UsageGroup[];
  unobservedPurposes: string[];
}

/** Require explicit UTC bounds; normalize them before filtering or displaying. */
export function usageUtc(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value)) {
    return null;
  }
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return null;
  const iso = new Date(time).toISOString();
  // Date.parse normalizes impossible dates such as February 30. Refuse them.
  return iso.slice(0, 19) === value.slice(0, 19) ? iso : null;
}

function parseUsage(value: unknown): GeminiUsageRecord | null {
  if (value === null || typeof value !== "object") return null;
  const r = value as GeminiUsageRecord;
  const occurredAt = usageUtc(r.occurredAt);
  const actorId = nullableUsageIdentifier(r.actorId);
  const runId = nullableUsageIdentifier(r.runId);
  if (
    r.version !== 1 ||
    !occurredAt ||
    actorId === undefined ||
    runId === undefined ||
    (actorId === null && runId !== null) ||
    !GEMINI_USAGE_PURPOSES.includes(r.purpose) ||
    !["response", "error", "cancelled"].includes(r.outcome) ||
    !["complete", "partial", "missing"].includes(r.usage) ||
    typeof r.partial !== "boolean" ||
    !Number.isSafeInteger(r.pid) ||
    r.pid < 0 ||
    [r.instanceId, r.processId, r.attemptId, r.model, r.requestedModel].some(
      (v) => typeof v !== "string" || v.length === 0 || v.length > 200
    ) ||
    !r.counts ||
    typeof r.counts !== "object"
  )
    return null;
  const counts = {} as GeminiCounts;
  for (const key of Object.keys(GEMINI_COUNT_FIELDS) as (keyof GeminiCounts)[]) {
    const v = r.counts[key];
    if (v !== null && !(typeof v === "number" && Number.isSafeInteger(v) && v >= 0)) return null;
    counts[key] = v;
  }
  const hasCounts = Object.values(counts).some((v) => v !== null);
  const usage = !hasCounts
    ? "missing"
    : r.partial || counts.input === null || counts.response === null || counts.total === null
      ? "partial"
      : "complete";
  if (
    usage !== r.usage ||
    (r.partial && r.outcome === "response") ||
    (r.outcome !== "response" && !r.partial && hasCounts)
  )
    return null;
  // Canonicalize and discard every field outside the versioned allowlist.
  return {
    version: 1,
    occurredAt,
    instanceId: r.instanceId,
    processId: r.processId,
    pid: r.pid,
    attemptId: r.attemptId,
    purpose: r.purpose,
    actorId,
    runId,
    requestedModel: r.requestedModel,
    model: r.model,
    outcome: r.outcome,
    usage: r.usage,
    partial: r.partial,
    counts,
  };
}

/** Missing fields are pre-attribution v1 records; malformed values are refused. */
function nullableUsageIdentifier(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return null;
  return typeof value === "string" && value.length > 0 && value.length <= 200 ? value : undefined;
}

async function* boundedLines(stream: AsyncIterable<Uint8Array>): AsyncGenerator<string | null> {
  let fragments: Buffer[] = [];
  let bytes = 0;
  let oversized = false;
  for await (const chunk of stream) {
    const buffer = Buffer.from(chunk);
    let start = 0;
    while (start < buffer.length) {
      const newline = buffer.indexOf(10, start);
      const end = newline < 0 ? buffer.length : newline;
      const part = buffer.subarray(start, end);
      bytes += part.length;
      if (bytes > MAX_USAGE_LINE_BYTES) {
        oversized = true;
        fragments = [];
      }
      if (!oversized && part.length) fragments.push(part);
      if (newline < 0) break;
      yield oversized ? null : Buffer.concat(fragments, bytes).toString("utf8");
      fragments = [];
      bytes = 0;
      oversized = false;
      start = newline + 1;
    }
  }
  if (bytes || oversized) yield oversized ? null : Buffer.concat(fragments, bytes).toString("utf8");
}

function totals(): Totals {
  return Object.fromEntries(
    [...Object.keys(GEMINI_COUNT_FIELDS), "output"].map((key) => [
      key,
      { sum: null, measured: 0, missing: 0 },
    ])
  ) as Totals;
}
function addCounts(target: Totals, counts: GeminiCounts): void {
  const values = {
    ...counts,
    output: outputCount(counts),
  };
  for (const key of Object.keys(values) as (keyof Totals)[])
    addMeasurement(target[key], values[key]);
}
function addMeasurement(target: Measurement, value: number | null): void {
  if (value === null) {
    target.missing++;
    return;
  }
  const sum = (target.sum ?? 0) + value;
  if (!Number.isSafeInteger(sum)) throw new Error("Usage aggregate exceeds safe integer range");
  target.sum = sum;
  target.measured++;
}
function outputCount(counts: GeminiCounts): number | null {
  return counts.response !== null && counts.thinking !== null
    ? counts.response + counts.thinking
    : null;
}
function inputPerCall(samples: number[]): InputPerCall {
  if (samples.length === 0) return { max: null, p50: null, p90: null };
  // The accumulator is private to this actor and is no longer needed after
  // finalization. Sort once without spreading it into a call: one actor can
  // legitimately own every sample in the report's one-million-attempt limit.
  samples.sort((a, b) => a - b);
  const nearestRank = (fraction: number) =>
    samples[Math.ceil(samples.length * fraction) - 1] ?? null;
  return {
    max: samples.at(-1) ?? null,
    p50: nearestRank(0.5),
    p90: nearestRank(0.9),
  };
}
function compareActors(a: UsageActor, b: UsageActor): number {
  const byInput = (b.input.sum ?? -1) - (a.input.sum ?? -1);
  if (byInput) return byInput;
  if (a.actorId === null) return b.actorId === null ? 0 : 1;
  if (b.actorId === null) return -1;
  return a.actorId.localeCompare(b.actorId);
}
function finalizeActor(actor: UsageActorAccumulator): UsageActor {
  return {
    actorId: actor.actorId,
    runIds: [...actor.runIds].sort(),
    calls: actor.calls,
    partialCalls: actor.partialCalls,
    input: actor.input,
    output: actor.output,
    inputPerCall: inputPerCall(actor.inputSamples),
  };
}
function bounds(coverage: SourceCoverage, kind: "log" | "usage", time: string): void {
  const from = `${kind}From` as const;
  const to = `${kind}To` as const;
  if (coverage[from] === null || time < coverage[from]) coverage[from] = time;
  if (coverage[to] === null || time > coverage[to]) coverage[to] = time;
}

/** Read retained JSONL exports on demand; no database, API calls or persistent totals. */
export async function buildGeminiUsageReport(
  sources: UsageSource[],
  options: UsageReportOptions
): Promise<GeminiUsageReport> {
  const from = usageUtc(options.from);
  const to = usageUtc(options.to);
  if (!from || !to || from >= to) throw new Error("Require UTC --from < --to, with a Z suffix");
  const report: GeminiUsageReport = {
    version: 1,
    window: { from, to, endExclusive: true },
    sources: [],
    knownGaps: options.gaps ?? [],
    warnings: [
      "Observed log bounds do not prove continuous retention or complete source coverage.",
      "Only supplied instrumented API logs are measured; actor CLI runs, external scripts and SDK-internal retries are separate coverage.",
      "Missing fields stay unknown; cached/tool counts are breakdowns, not extra totals. Output requires both response and thinking counts.",
    ],
    duplicates: 0,
    instances: [],
    processes: [],
    groups: [],
    unobservedPurposes: [],
  };
  const seen = new Map<string, string>();
  const groups = new Map<string, UsageGroup>();
  const actors = new Map<string, Map<string | null, UsageActorAccumulator>>();
  const instances = new Set<string>();
  const processes = new Set<string>();
  for (const source of sources) {
    const coverage: SourceCoverage = {
      name: source.name,
      logFrom: null,
      logTo: null,
      usageFrom: null,
      usageTo: null,
      lines: 0,
      malformed: 0,
      oversized: 0,
      invalidUsage: 0,
    };
    report.sources.push(coverage);
    for await (const line of boundedLines(source.stream)) {
      coverage.lines++;
      if (line === null) {
        coverage.oversized++;
        continue;
      }
      if (!line.trim()) continue;
      let row: Record<string, unknown>;
      try {
        const parsed = JSON.parse(line);
        if (!parsed || typeof parsed !== "object") {
          coverage.malformed++;
          continue;
        }
        row = parsed;
      } catch {
        coverage.malformed++;
        continue;
      }
      const logTime = usageUtc(row.time);
      if (logTime) bounds(coverage, "log", logTime);
      if (row.msg !== GEMINI_USAGE_EVENT) continue;
      const record = parseUsage(row.usage);
      if (!record) {
        coverage.invalidUsage++;
        continue;
      }
      bounds(coverage, "usage", record.occurredAt);
      if (record.occurredAt < from || record.occurredAt >= to) continue;
      const digest = createHash("sha256").update(JSON.stringify(record)).digest("hex");
      const prior = seen.get(record.attemptId);
      if (prior) {
        if (prior !== digest) throw new Error("Conflicting copies of a Gemini usage attempt");
        report.duplicates++;
        continue;
      }
      if (seen.size >= MAX_REPORT_ATTEMPTS)
        throw new Error("Usage deduplication limit reached; narrow the time window");
      seen.set(record.attemptId, digest);
      instances.add(record.instanceId);
      processes.add(record.processId);
      const key = JSON.stringify([record.purpose, record.model]);
      let group = groups.get(key);
      if (!group) {
        group = {
          purpose: record.purpose,
          model: record.model,
          calls: 0,
          outcomes: { response: 0, error: 0, cancelled: 0 },
          coverage: { complete: 0, partial: 0, missing: 0 },
          totals: totals(),
          partialObservations: totals(),
          actors: [],
        };
        groups.set(key, group);
      }
      group.calls++;
      group.outcomes[record.outcome]++;
      group.coverage[record.usage]++;
      addCounts(record.partial ? group.partialObservations : group.totals, record.counts);
      let actorGroups = actors.get(key);
      if (!actorGroups) {
        actorGroups = new Map();
        actors.set(key, actorGroups);
      }
      let actor = actorGroups.get(record.actorId);
      if (!actor) {
        actor = {
          actorId: record.actorId,
          runIds: new Set(),
          calls: 0,
          partialCalls: 0,
          input: { sum: null, measured: 0, missing: 0 },
          output: { sum: null, measured: 0, missing: 0 },
          inputSamples: [],
        };
        actorGroups.set(record.actorId, actor);
      }
      actor.calls++;
      if (record.partial) actor.partialCalls++;
      if (record.runId !== null) actor.runIds.add(record.runId);
      // Keep per-actor measured sums and percentiles on the same completed-only
      // basis as the group totals. Interrupted snapshots remain separate above.
      if (!record.partial) {
        addMeasurement(actor.input, record.counts.input);
        addMeasurement(actor.output, outputCount(record.counts));
        if (record.counts.input !== null) actor.inputSamples.push(record.counts.input);
      }
    }
    if (coverage.malformed || coverage.oversized || coverage.invalidUsage) {
      report.warnings.push(
        `Source ${source.name} contains skipped lines; inspect its coverage counters for truncation or format gaps.`
      );
    }
  }
  report.instances = [...instances].sort();
  report.processes = [...processes].sort();
  report.groups = [...groups.entries()]
    .map(([key, group]) => ({
      ...group,
      actors: [...(actors.get(key)?.values() ?? [])].map(finalizeActor).sort(compareActors),
    }))
    .sort(
      (a, b) =>
        (b.totals.total.sum ?? b.totals.input.sum ?? 0) -
          (a.totals.total.sum ?? a.totals.input.sum ?? 0) ||
        a.purpose.localeCompare(b.purpose) ||
        a.model.localeCompare(b.model)
    );
  report.unobservedPurposes = GEMINI_USAGE_PURPOSES.filter(
    (purpose) => !report.groups.some((group) => group.purpose === purpose)
  );
  return report;
}

export function formatGeminiUsageReport(report: GeminiUsageReport): string {
  const measured = (value: Measurement) =>
    `${value.sum ?? "unknown"} (${value.measured} measured/${value.missing} unknown)`;
  const lines = [
    `Gemini API usage: ${report.window.from} <= completed-at < ${report.window.to}`,
    `Sources: ${report.sources.length}; instances: ${report.instances.length}; processes: ${report.processes.length}; duplicates: ${report.duplicates}`,
  ];
  for (const source of report.sources)
    lines.push(
      `Source ${source.name}: logs ${source.logFrom ?? "unknown"} .. ${source.logTo ?? "unknown"}; usage ${source.usageFrom ?? "unknown"} .. ${source.usageTo ?? "unknown"}; skipped malformed=${source.malformed}, oversized=${source.oversized}, invalidUsage=${source.invalidUsage}`
    );
  for (const group of report.groups) {
    lines.push(
      `\n${group.purpose} / ${group.model}: ${group.calls} calls; response=${group.outcomes.response}, error=${group.outcomes.error}, cancelled=${group.outcomes.cancelled}; usage complete=${group.coverage.complete}, partial=${group.coverage.partial}, missing=${group.coverage.missing}`
    );
    for (const key of Object.keys(group.totals) as (keyof Totals)[])
      lines.push(
        `  ${key}: ${measured(group.totals[key])}; interrupted observations: ${measured(group.partialObservations[key])}`
      );
    for (const actor of group.actors)
      lines.push(
        `  actor ${actor.actorId ?? "unattributed"}: ${actor.calls} calls; interrupted=${actor.partialCalls}; input: ${measured(actor.input)}; output: ${measured(actor.output)}; input/call max=${actor.inputPerCall.max ?? "unknown"}, p50=${actor.inputPerCall.p50 ?? "unknown"}, p90=${actor.inputPerCall.p90 ?? "unknown"}`
      );
  }
  lines.push(
    `\nUnobserved purposes (not measured zero): ${report.unobservedPurposes.join(", ") || "none"}`
  );
  for (const gap of report.knownGaps) lines.push(`Known gap: ${gap}`);
  for (const warning of report.warnings) lines.push(`Coverage: ${warning}`);
  return `${lines.join("\n")}\n`;
}
