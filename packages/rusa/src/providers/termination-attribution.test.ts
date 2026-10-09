import { describe, expect, it } from "vitest";
import {
  extractAbortReason,
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
    controller.abort("interrupt:00000000-0000-4000-8000-000000000001");
    const result = formatSigtermResult("partial log", controller.signal);
    expect(result.exitCode).toBe(143);
    expect(result.cancelled).toBe(true);
    expect(result.interrupted).toBe(true);
    expect(result.interruptSource).toBe("00000000-0000-4000-8000-000000000001");
    expect(result.abortReason).toBe("interrupt:00000000-0000-4000-8000-000000000001");
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

describe("extractAbortReason", () => {
  it("extracts stall-watchdog abort reason", () => {
    const controller = new AbortController();
    controller.abort(STALL_WATCHDOG_ABORT_REASON);
    expect(extractAbortReason(controller.signal)).toBe("stall-watchdog");
  });

  it("extracts run-ceiling abort reason", () => {
    const controller = new AbortController();
    controller.abort(RUN_CEILING_ABORT_REASON);
    expect(extractAbortReason(controller.signal)).toBe("run-ceiling");
  });

  it("extracts interrupt abort reason with prefix", () => {
    const controller = new AbortController();
    controller.abort("interrupt:00000000-0000-4000-8000-000000000001");
    expect(extractAbortReason(controller.signal)).toBe(
      "interrupt:00000000-0000-4000-8000-000000000001"
    );
  });

  it("extracts unknown for unattributed abort", () => {
    const controller = new AbortController();
    controller.abort();
    expect(extractAbortReason(controller.signal)).toBe("unknown");
  });

  it("returns unknown when signal is undefined or not aborted", () => {
    expect(extractAbortReason(undefined)).toBe("unknown");
    const controller = new AbortController();
    expect(extractAbortReason(controller.signal)).toBe("unknown");
  });
});
