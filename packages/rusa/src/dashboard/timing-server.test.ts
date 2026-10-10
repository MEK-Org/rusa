// @vitest-environment node
import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import type { DashboardTimingRecorder } from "./timing.js";
import { beginDashboardRoutePhase, runDashboardRequestScope } from "./timing-phases.js";
import { beginDashboardRequestTiming } from "./timing-server.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

class TestResponse extends EventEmitter {
  statusCode = 200;
  headersSent = false;
  writableFinished = false;
  readonly headers: Record<string, string> = {};

  setHeader(name: string, value: string): this {
    this.headers[name] = value;
    return this;
  }

  writeHead(status: number): this {
    this.statusCode = status;
    this.headersSent = true;
    return this;
  }

  write(_chunk?: string | Buffer): boolean {
    this.headersSent = true;
    return true;
  }

  // Like a real ServerResponse, a finished response then emits `close`.
  end(_chunk?: string | Buffer): this {
    this.headersSent = true;
    this.writableFinished = true;
    this.emit("finish");
    this.emit("close");
    return this;
  }

  /** The connection goes away before `end`: abort, client timeout or drop. */
  closeEarly(): void {
    this.emit("close");
  }
}

describe("dashboard timing server wrapper", () => {
  it("adds a request id and records content-free post-response metadata", () => {
    const recordServer = vi.fn();
    const response = new TestResponse();
    beginDashboardRequestTiming(
      response as unknown as ServerResponse,
      "/api/dashboard/config",
      "GET",
      {
        recordServer,
      } as unknown as DashboardTimingRecorder
    );
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
    beginDashboardRequestTiming(
      response as unknown as ServerResponse,
      "/api/dashboard/timing",
      "POST",
      {
        recordServer,
      } as unknown as DashboardTimingRecorder
    );
    response.end("accepted");

    expect(response.headers["X-Rusa-Request-Id"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(recordServer).not.toHaveBeenCalled();
  });

  it("excludes health checks and distinguishes list reads from mutations", () => {
    const recordServer = vi.fn();
    const recorder = { recordServer } as unknown as DashboardTimingRecorder;
    const health = new TestResponse();
    beginDashboardRequestTiming(
      health as unknown as ServerResponse,
      "/api/health",
      "GET",
      recorder
    );
    health.end("ok");
    const list = new TestResponse();
    beginDashboardRequestTiming(
      list as unknown as ServerResponse,
      "/api/mesh/actors",
      "GET",
      recorder
    );
    list.end("[]");
    const mutation = new TestResponse();
    beginDashboardRequestTiming(
      mutation as unknown as ServerResponse,
      "/api/mesh/actors",
      "POST",
      recorder
    );
    mutation.end("created");
    const chatSend = new TestResponse();
    beginDashboardRequestTiming(
      chatSend as unknown as ServerResponse,
      "/api/mesh/actors/actor-1/chat",
      "POST",
      recorder
    );
    chatSend.end("sent");

    expect(recordServer).toHaveBeenCalledTimes(3);
    expect(recordServer).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ label: "mesh_actor_list" })
    );
    expect(recordServer).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ label: "mesh_actor_mutation" })
    );
    expect(recordServer).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ label: "mesh_actor_mutation" })
    );
  });

  it("ends the route phase at header write and tags quota operations", async () => {
    const recordServer = vi.fn();
    const response = new TestResponse();
    await runDashboardRequestScope(async () => {
      beginDashboardRequestTiming(
        response as unknown as ServerResponse,
        "/api/quota/history",
        "GET",
        { recordServer } as unknown as DashboardTimingRecorder
      );
      beginDashboardRoutePhase();
      await sleep(30);
      response.writeHead(200);
      await sleep(60);
      response.end("{}");
    });

    const [[record]] = recordServer.mock.calls;
    expect(record).toMatchObject({ label: "mesh_quota", operation: "quota_history" });
    // The body write after the header is outside route.
    expect(Object.keys(record.phases)).toEqual(["route"]);
    expect(record.phases.route).toBeGreaterThanOrEqual(25);
    // Route stops at writeHead; the post-header sleep is outside it.
    expect(record.durationMs - record.phases.route).toBeGreaterThanOrEqual(55);
  });

  it("records a finished response exactly once although close follows finish (#990)", () => {
    const recordServer = vi.fn();
    const response = new TestResponse();
    beginDashboardRequestTiming(response as unknown as ServerResponse, "/api/mesh/threads", "GET", {
      recordServer,
    } as unknown as DashboardTimingRecorder);
    response.writeHead(404);
    response.end("{}");
    response.closeEarly();

    expect(recordServer).toHaveBeenCalledTimes(1);
    expect(recordServer).toHaveBeenCalledWith(
      expect.objectContaining({
        label: "mesh_threads",
        status: 404,
        request: { method: "GET", terminal: "finished" },
      })
    );
  });

  it("records a close before finish once, with a status only after headers were sent (#990)", () => {
    const recordServer = vi.fn();
    const recorder = { recordServer } as unknown as DashboardTimingRecorder;
    const beforeHeaders = new TestResponse();
    beginDashboardRequestTiming(
      beforeHeaders as unknown as ServerResponse,
      "/api/mesh/threads",
      "GET",
      recorder
    );
    beforeHeaders.closeEarly();
    beforeHeaders.closeEarly();
    const midBody = new TestResponse();
    beginDashboardRequestTiming(
      midBody as unknown as ServerResponse,
      "/api/mesh/threads",
      "GET",
      recorder
    );
    midBody.writeHead(200);
    midBody.write("partial");
    midBody.closeEarly();

    expect(recordServer).toHaveBeenCalledTimes(2);
    expect(recordServer).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        status: null,
        bytes: 0,
        request: { method: "GET", terminal: "closed_before_finish" },
      })
    );
    expect(recordServer).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        status: 200,
        bytes: 7,
        request: { method: "GET", terminal: "closed_before_finish" },
      })
    );
  });

  it("records the fixed request method and never a verbatim unknown one (#990)", () => {
    const recordServer = vi.fn();
    const recorder = { recordServer } as unknown as DashboardTimingRecorder;
    for (const method of ["GET", "HEAD", "OPTIONS", "PROPFIND", undefined]) {
      const response = new TestResponse();
      beginDashboardRequestTiming(
        response as unknown as ServerResponse,
        "/api/mesh/obligations",
        method,
        recorder
      );
      response.end("{}");
    }

    expect(
      recordServer.mock.calls.map(([record]) => [record.label, record.request.method])
    ).toEqual([
      ["mesh_obligations", "GET"],
      ["mesh_obligations", "HEAD"],
      ["mesh_obligations", "OPTIONS"],
      ["mesh_obligation_mutation", "other"],
      ["mesh_obligations", "GET"],
    ]);
  });

  it("times the after-paint reference fill-in apart from the pages it fills (#940)", () => {
    const recordServer = vi.fn();
    const recorder = { recordServer } as unknown as DashboardTimingRecorder;
    for (const path of ["/api/mesh/references", "/api/mesh/obligations/ob-1"]) {
      const response = new TestResponse();
      beginDashboardRequestTiming(response as unknown as ServerResponse, path, "GET", recorder);
      response.end("{}");
    }

    expect(recordServer).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ label: "mesh_references" })
    );
    expect(recordServer).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ label: "mesh_obligation_detail" })
    );
  });
});
