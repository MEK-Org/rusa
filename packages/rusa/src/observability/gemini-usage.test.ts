// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { withGeminiRetry } from "../understanding/gemini-utils.js";
import {
  beginGeminiAttempt,
  configureGeminiUsage,
  GEMINI_USAGE_PURPOSES,
  geminiCounts,
  observeGeminiRequest,
} from "./gemini-usage.js";
import {
  buildGeminiUsageReport,
  formatGeminiUsageReport,
  MAX_REPORT_ATTEMPTS,
  MAX_USAGE_LINE_BYTES,
} from "./gemini-usage-report.js";
import { createLogger, nullLogger } from "./logger.js";

const metadata = {
  promptTokenCount: 100,
  candidatesTokenCount: 20,
  thoughtsTokenCount: 5,
  cachedContentTokenCount: 40,
  toolUsePromptTokenCount: 2,
  totalTokenCount: 127,
};
const window = { from: "2026-10-14T12:00:00Z", to: "2026-10-14T13:00:00Z" };
function capture() {
  const lines: string[] = [];
  const logger = createLogger({
    format: "json",
    level: "info",
    secrets: ["synthetic-sensitive-value"],
    destination: {
      write: (line) => {
        lines.push(line);
      },
    },
  });
  configureGeminiUsage(logger, "/synthetic/instance-a");
  vi.useFakeTimers();
  vi.setSystemTime("2026-10-14T12:30:00Z");
  return { lines, logger };
}
function source(name: string, text: string) {
  return {
    name,
    stream: (async function* () {
      // Deliberately split JSON and multibyte source names across byte chunks.
      const buffer = Buffer.from(text);
      for (let i = 0; i < buffer.length; i += 13) yield buffer.subarray(i, i + 13);
    })(),
  };
}
afterEach(() => {
  vi.useRealTimers();
  configureGeminiUsage(nullLogger, "/synthetic/test");
});

describe("Gemini usage logger and on-demand report", () => {
  it("round-trips all ten active purposes through the real redacting JSON logger and deduplicates exports", async () => {
    const { lines, logger } = capture();
    for (const purpose of GEMINI_USAGE_PURPOSES)
      await observeGeminiRequest(purpose, "requested-model", async () => ({
        modelVersion: "returned-model",
        usageMetadata: metadata,
        text: "synthetic-sensitive-value",
        prompt: "PRIVATE PROMPT",
        media: "PRIVATE MEDIA",
      }));
    logger.info("credential_probe", {
      apiKey: "synthetic-sensitive-value",
      promptTokenCount: 123,
      counts: { input: 9 },
    });
    const rows = lines.map((line) => JSON.parse(line));
    expect(rows.at(-1)).toMatchObject({
      apiKey: "[redacted]",
      promptTokenCount: "[redacted]",
      counts: { input: 9 },
    });
    expect(lines.join("")).not.toMatch(
      /PRIVATE PROMPT|PRIVATE MEDIA|synthetic-sensitive-value|usageMetadata/
    );
    expect(rows[0].usage).toMatchObject({
      version: 1,
      model: "returned-model",
      requestedModel: "requested-model",
      usage: "complete",
      counts: { input: 100, response: 20, thinking: 5, cachedInput: 40, toolInput: 2, total: 127 },
    });
    expect(new Set(rows.slice(0, 10).map((r) => r.usage.attemptId)).size).toBe(10);
    const report = await buildGeminiUsageReport(
      [source("first-α", lines.join("")), source("overlap", lines.slice(0, 3).join(""))],
      { ...window, gaps: ["Coordinator export begins after restart"] }
    );
    expect(report.groups).toHaveLength(10);
    expect(report.duplicates).toBe(3);
    expect(report.unobservedPurposes).toEqual([]);
    expect(report.knownGaps).toEqual(["Coordinator export begins after restart"]);
    expect(report.sources[0]).toMatchObject({
      logFrom: "2026-10-14T12:30:00.000Z",
      usageFrom: "2026-10-14T12:30:00.000Z",
      invalidUsage: 0,
    });
    for (const group of report.groups)
      expect(group.totals).toMatchObject({
        input: { sum: 100, measured: 1, missing: 0 },
        output: { sum: 25 },
        total: { sum: 127 },
        cachedInput: { sum: 40 },
        toolInput: { sum: 2 },
      });
    expect(formatGeminiUsageReport(report)).toContain(
      "Known gap: Coordinator export begins after restart"
    );
  });

  it("retains actor/run attribution, accepts legacy rows, and keeps actor sums equal to group totals", async () => {
    const { lines } = capture();
    for (const [runId, input] of [
      ["run-1", 50],
      ["run-2", 100],
    ] as const)
      await observeGeminiRequest(
        "portable_compaction",
        "model",
        async () => ({
          usageMetadata: { ...metadata, promptTokenCount: input, totalTokenCount: input + 27 },
        }),
        { actorId: "actor-a", runId }
      );
    await observeGeminiRequest("portable_compaction", "model", async () => ({
      usageMetadata: metadata,
    }));

    const rows = lines.map((line) => JSON.parse(line));
    expect(rows[0].usage).toMatchObject({ actorId: "actor-a", runId: "run-1" });
    expect(rows[2].usage).toMatchObject({ actorId: null, runId: null });

    // Pre-attribution v1 exports have neither field. They remain valid v1
    // records and belong in the explicit unattributed bucket.
    delete rows[2].usage.actorId;
    delete rows[2].usage.runId;
    const report = await buildGeminiUsageReport(
      [source("attribution", `${lines[0]}${lines[1]}${JSON.stringify(rows[2])}\n`)],
      window
    );
    const group = report.groups[0];
    const actor = group.actors.find((entry) => entry.actorId === "actor-a");
    const unattributed = group.actors.find((entry) => entry.actorId === null);
    if (!actor || !unattributed) throw new Error("expected attributed and unattributed buckets");
    expect(actor).toMatchObject({
      calls: 2,
      runIds: ["run-1", "run-2"],
      input: { sum: 150, measured: 2, missing: 0 },
      output: { sum: 50, measured: 2, missing: 0 },
      inputPerCall: { max: 100, p50: 50, p90: 100 },
    });
    expect(unattributed).toMatchObject({
      calls: 1,
      runIds: [],
      input: { sum: 100, measured: 1, missing: 0 },
      output: { sum: 25, measured: 1, missing: 0 },
    });
    expect((actor.input.sum ?? 0) + (unattributed.input.sum ?? 0)).toBe(group.totals.input.sum);
    expect((actor.output.sum ?? 0) + (unattributed.output.sum ?? 0)).toBe(group.totals.output.sum);
    expect(formatGeminiUsageReport(report)).toContain("unattributed: 1 calls");
  });

  it("summarizes a large single-actor bucket below the report attempt limit", async () => {
    // This exceeds V8's practical function-argument cap, while remaining far
    // below the documented report limit. Keep it streamed so the test also
    // exercises the report's normal bounded line reader.
    const samples = 131_072;
    expect(samples).toBeLessThan(MAX_REPORT_ATTEMPTS);
    const stream = (async function* () {
      for (let index = 0; index < samples; index++)
        yield Buffer.from(
          `${JSON.stringify({
            time: "2026-10-14T12:30:00.000Z",
            msg: "gemini_usage",
            usage: {
              version: 1,
              occurredAt: "2026-10-14T12:30:00.000Z",
              instanceId: "instance",
              processId: "process",
              pid: 1,
              attemptId: `attempt-${index}`,
              purpose: "portable_compaction",
              actorId: "actor-large",
              runId: "run-large",
              requestedModel: "model",
              model: "model",
              outcome: "response",
              usage: "complete",
              partial: false,
              counts: {
                input: index,
                response: 1,
                thinking: 0,
                cachedInput: 0,
                toolInput: 0,
                total: index + 1,
              },
            },
          })}\n`
        );
    })();
    const report = await buildGeminiUsageReport([{ name: "large-actor", stream }], window);
    expect(report.groups[0]?.actors).toEqual([
      expect.objectContaining({
        actorId: "actor-large",
        calls: samples,
        inputPerCall: { max: samples - 1, p50: 65_535, p90: 117_964 },
      }),
    ]);
  });

  it("counts outer retries, stronger-model fallback and a response rejected by application validation", async () => {
    const { lines } = capture();
    const call = vi
      .fn()
      .mockRejectedValueOnce(new Error("503 overloaded"))
      .mockResolvedValue({ usageMetadata: metadata, text: "bad json" });
    const promise = withGeminiRetry(() => observeGeminiRequest("quota_parse", "small-model", call));
    const resolved = expect(promise).resolves.toMatchObject({ text: "bad json" });
    await vi.runAllTimersAsync();
    await resolved;
    await expect(
      (async () => {
        const response = await observeGeminiRequest("quota_parse", "stronger-model", async () => ({
          usageMetadata: metadata,
          text: "bad json",
        }));
        JSON.parse(response.text);
      })()
    ).rejects.toThrow();
    const report = await buildGeminiUsageReport([source("attempts", lines.join(""))], window);
    expect(report.groups.find((g) => g.model === "small-model")).toMatchObject({
      calls: 2,
      outcomes: { response: 1, error: 1 },
      coverage: { complete: 1, missing: 1 },
      totals: { input: { sum: 100, measured: 1, missing: 1 } },
    });
    expect(report.groups.find((g) => g.model === "stronger-model")).toMatchObject({
      calls: 1,
      outcomes: { response: 1 },
      totals: { input: { sum: 100 } },
    });
  });

  it("preserves missing fields and legitimate zero, separating interrupted snapshots from completed totals", async () => {
    const { lines } = capture();
    await observeGeminiRequest("speech_synthesis", "model", async () => ({}));
    await observeGeminiRequest("speech_synthesis", "model", async () => ({
      usageMetadata: { promptTokenCount: 0, totalTokenCount: 50 },
    }));
    const attempt = beginGeminiAttempt("speech_synthesis", "model");
    attempt.observe({ usageMetadata: metadata });
    attempt.finish("cancelled", true);
    attempt.finish("response");
    const report = await buildGeminiUsageReport([source("counts", lines.join(""))], window);
    expect(report.groups[0]).toMatchObject({
      calls: 3,
      coverage: { complete: 0, partial: 2, missing: 1 },
      totals: {
        input: { sum: 0, measured: 1, missing: 1 },
        response: { sum: null, measured: 0, missing: 2 },
        output: { sum: null },
        total: { sum: 50 },
      },
      partialObservations: { input: { sum: 100 }, output: { sum: 25 } },
    });
  });

  it("does not change API results or errors when logging or metadata inspection fails", async () => {
    const logger = {
      ...nullLogger,
      child() {
        return this;
      },
      info() {
        throw new Error("sink failed");
      },
    };
    configureGeminiUsage(logger, "/synthetic/broken-sink");
    const response = {
      get usageMetadata() {
        throw new Error("getter failed");
      },
      text: "usable",
    };
    expect(await observeGeminiRequest("portable_compaction", "model", async () => response)).toBe(
      response
    );
    const error = new Error("API failure");
    await expect(
      observeGeminiRequest("quota_parse", "model", async () => {
        throw error;
      })
    ).rejects.toBe(error);
    expect(
      geminiCounts({
        promptTokenCount: -1,
        candidatesTokenCount: Number.NaN,
        thoughtsTokenCount: 1.5,
        totalTokenCount: "20",
      })
    ).toEqual({
      input: null,
      response: null,
      thinking: null,
      cachedInput: null,
      toolInput: null,
      total: null,
    });
  });

  it("filters [from,to), reports log bounds outside the selection and never infers seven-day retention", async () => {
    const { lines } = capture();
    for (const time of ["2026-10-14T11:59:59Z", window.from, window.to]) {
      vi.setSystemTime(time);
      await observeGeminiRequest("quota_parse", "model", async () => ({ usageMetadata: metadata }));
    }
    const report = await buildGeminiUsageReport([source("bounded", lines.join(""))], window);
    expect(report.groups[0].calls).toBe(1);
    expect(report.sources[0]).toMatchObject({
      logFrom: "2026-10-14T11:59:59.000Z",
      logTo: "2026-10-14T13:00:00.000Z",
    });
    expect(report.warnings[0]).toContain("do not prove continuous retention");
    await expect(
      buildGeminiUsageReport([], { from: "2026-02-30T12:00:00Z", to: window.to })
    ).rejects.toThrow("UTC");
    await expect(buildGeminiUsageReport([], { from: window.to, to: window.from })).rejects.toThrow(
      "UTC"
    );
  });

  it("reports damaged, oversized and unsupported usage rows without echoing their contents; refuses conflicting copies", async () => {
    const { lines } = capture();
    await observeGeminiRequest("quota_parse", "model", async () => ({ usageMetadata: metadata }));
    const changed = JSON.parse(lines[0]);
    changed.usage.counts.input = 999;
    await expect(
      buildGeminiUsageReport([source("conflict", lines[0] + JSON.stringify(changed))], window)
    ).rejects.toThrow("Conflicting copies");
    changed.usage.version = 2;
    const report = await buildGeminiUsageReport(
      [
        source(
          "damaged",
          `PRIVATE BROKEN JSON\n${"x".repeat(MAX_USAGE_LINE_BYTES + 1)}\n${JSON.stringify(changed)}\n${lines[0]}`
        ),
      ],
      window
    );
    expect(report.sources[0]).toMatchObject({ malformed: 1, oversized: 1, invalidUsage: 1 });
    expect(report.groups[0].calls).toBe(1);
    expect(JSON.stringify(report)).not.toContain("PRIVATE BROKEN JSON");
  });
});
