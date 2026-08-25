import { describe, expect, it } from "vitest";
import {
  formatSigtermResult,
  RUN_CEILING_ABORT_REASON,
  STALL_WATCHDOG_ABORT_REASON,
  YIELD_GRACE_ABORT_REASON,
} from "./termination-attribution.js";

describe("formatSigtermResult", () => {
  it("attributes yield grace timeout aborts correctly", () => {
    const controller = new AbortController();
    controller.abort(YIELD_GRACE_ABORT_REASON);
    const result = formatSigtermResult("partial log", controller.signal);
    expect(result.exitCode).toBe(143);
    expect(result.cancelled).toBe(true);
    expect(result.graceKilled).toBe(true);
    expect(result.output).toBe(
      "partial log\n[Task killed by supervisor (yield grace period exceeded)]"
    );
  });

  it("attributes stall watchdog aborts", () => {
    const controller = new AbortController();
    controller.abort(STALL_WATCHDOG_ABORT_REASON);
    const result = formatSigtermResult("partial log", controller.signal);
    expect(result.exitCode).toBe(143);
    expect(result.cancelled).toBe(true);
    expect(result.output).toBe(
      "partial log\n[Task killed by stall watchdog (no output for 15 minutes)]"
    );
  });

  it("attributes run ceiling aborts", () => {
    const controller = new AbortController();
    controller.abort(RUN_CEILING_ABORT_REASON);
    const result = formatSigtermResult("partial log", controller.signal);
    expect(result.exitCode).toBe(143);
    expect(result.cancelled).toBe(true);
    expect(result.output).toBe("partial log\n[Task killed by run ceiling timeout]");
  });
});
