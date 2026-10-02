import { describe, expect, it } from "vitest";
import {
  formatSigtermResult,
  RUN_CEILING_ABORT_REASON,
  STALL_WATCHDOG_ABORT_REASON,
} from "./termination-attribution.js";

describe("formatSigtermResult", () => {
  it("attributes stall watchdog aborts", () => {
    const controller = new AbortController();
    controller.abort(STALL_WATCHDOG_ABORT_REASON);
    const result = formatSigtermResult("partial log", controller.signal);
    expect(result.exitCode).toBe(143);
    expect(result.cancelled).toBe(true);
    expect(result.output).toBe(
      "partial log\n[Task killed by stall watchdog (no output for 15 minutes)]"
    );
    expect(result.abortReason).toBe("stall-watchdog");
  });

  it("attributes run ceiling aborts", () => {
    const controller = new AbortController();
    controller.abort(RUN_CEILING_ABORT_REASON);
    const result = formatSigtermResult("partial log", controller.signal);
    expect(result.exitCode).toBe(143);
    expect(result.cancelled).toBe(true);
    expect(result.output).toBe("partial log\n[Task killed by run ceiling timeout]");
    expect(result.abortReason).toBe("run-ceiling");
  });

  it("attributes interrupt aborts with the source prefix", () => {
    const controller = new AbortController();
    controller.abort("interrupt:human:operator");
    const result = formatSigtermResult("partial log", controller.signal);
    expect(result.exitCode).toBe(143);
    expect(result.cancelled).toBe(true);
    expect(result.interrupted).toBe(true);
    expect(result.interruptSource).toBe("human:operator");
    expect(result.abortReason).toBe("interrupt:human:operator");
  });

  it("attributes unattributed SIGTERM as unknown", () => {
    const controller = new AbortController();
    controller.abort();
    const result = formatSigtermResult("partial log", controller.signal);
    expect(result.exitCode).toBe(143);
    expect(result.cancelled).toBe(true);
    expect(result.abortReason).toBe("unknown");
  });
});
