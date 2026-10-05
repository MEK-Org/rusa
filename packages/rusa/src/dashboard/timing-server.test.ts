// @vitest-environment node
import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import type { DashboardTimingRecorder } from "./timing.js";
import { beginDashboardRequestTiming } from "./timing-server.js";

class TestResponse extends EventEmitter {
  statusCode = 200;
  readonly headers: Record<string, string> = {};

  setHeader(name: string, value: string): this {
    this.headers[name] = value;
    return this;
  }

  write(_chunk?: string | Buffer): boolean {
    return true;
  }

  end(_chunk?: string | Buffer): this {
    this.emit("finish");
    return this;
  }
}

describe("dashboard timing server wrapper", () => {
  it("adds a request id and records content-free post-response metadata", () => {
    const recordServer = vi.fn();
    const response = new TestResponse();
    beginDashboardRequestTiming(response as unknown as ServerResponse, "/api/dashboard/config", {
      recordServer,
    } as unknown as DashboardTimingRecorder);
    response.end("ok");

    expect(response.headers["X-Rusa-Request-Id"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(recordServer).toHaveBeenCalledWith(
      expect.objectContaining({
        label: "dashboard_config",
        status: 200,
        bytes: 2,
        requestId: response.headers["X-Rusa-Request-Id"],
      })
    );
  });

  it("does not measure the telemetry receiver itself", () => {
    const recordServer = vi.fn();
    const response = new TestResponse();
    beginDashboardRequestTiming(response as unknown as ServerResponse, "/api/dashboard/timing", {
      recordServer,
    } as unknown as DashboardTimingRecorder);
    response.end("accepted");

    expect(response.headers["X-Rusa-Request-Id"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(recordServer).not.toHaveBeenCalled();
  });
});
