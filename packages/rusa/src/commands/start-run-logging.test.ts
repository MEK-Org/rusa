import { describe, expect, it } from "vitest";
import { createLogger, type Logger } from "../observability/logger.js";
import type { RunResult } from "../providers/types.js";
import { logRunEnd } from "./start.js";

/**
 * A run ending is the record an operator reaches for first, so its level has to
 * mean something: a completed run is not news, a capped run is a nudge, and a
 * failed run is the thing to page on. The fields are the ones a query filters
 * by — never the run's prose, which is the transcript's job.
 */

function recordingLogger(): { logger: Logger; records: () => Record<string, unknown>[] } {
  const lines: string[] = [];
  const logger = createLogger({
    format: "json",
    destination: {
      write: (chunk: string) => {
        lines.push(chunk);
      },
    },
  });
  const records = () =>
    lines
      .join("")
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  return { logger, records };
}

function runResult(overrides: Partial<RunResult> = {}): RunResult {
  return { success: true, output: "", exitCode: 0, ...overrides };
}

describe("logRunEnd", () => {
  it("records a completed run at info", () => {
    const { logger, records } = recordingLogger();

    logRunEnd(logger, runResult({ yieldStatus: "complete", model: "claude-opus-5" }));

    expect(records()[0]).toMatchObject({
      level: "info",
      msg: "run_end",
      success: true,
      exitCode: 0,
      capped: false,
      cancelled: false,
      interrupted: false,
      yieldStatus: "complete",
      model: "claude-opus-5",
    });
  });

  it("records a capped run at warn — degraded, not broken", () => {
    const { logger, records } = recordingLogger();

    logRunEnd(logger, runResult({ success: false, exitCode: 1, capped: true }));

    expect(records()[0]).toMatchObject({ level: "warn", msg: "run_end", capped: true });
  });

  it("records a failed run at error", () => {
    const { logger, records } = recordingLogger();

    logRunEnd(logger, runResult({ success: false, exitCode: 137, interrupted: true }));

    expect(records()[0]).toMatchObject({
      level: "error",
      msg: "run_end",
      success: false,
      exitCode: 137,
      interrupted: true,
    });
  });

  it("keeps the run's own output out of the record", () => {
    const { logger, records } = recordingLogger();

    logRunEnd(logger, runResult({ output: "a very long model transcript", yieldNote: "done" }));

    const written = JSON.stringify(records()[0]);
    expect(written).not.toContain("a very long model transcript");
    expect(written).not.toContain("done");
  });

  it("carries whatever context the caller bound, so the run is identifiable", () => {
    const { logger, records } = recordingLogger();

    logRunEnd(logger.child({ actorId: "worker-7", runId: "run-42" }), runResult());

    expect(records()[0]).toMatchObject({ actorId: "worker-7", runId: "run-42", msg: "run_end" });
  });
});
