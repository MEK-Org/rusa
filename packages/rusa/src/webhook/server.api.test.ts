import { createHmac } from "node:crypto";
import { EventEmitter, once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

import { describe, expect, it, vi } from "vitest";
import { writeBuildSentinel } from "../update/build-sentinel.js";
import {
  createDashboardRequestHandler,
  createWebhookRequestHandler,
  parseJsonObjectBody,
  resolveDeployedSha,
} from "./server.js";

/**
 * The v2 dashboard API (tasks / distillation / understanding / models /
 * conversations) was removed with the v2 orchestrator; the handler now only
 * statically serves the placeholder Flutter app. These tests pin the remaining
 * surface: the health endpoint, a 404 for any other API route, and the JSON body
 * parser. Asset serving itself is covered by `dashboard/assets`.
 */

class MockIncomingMessage extends EventEmitter {
  method: string;
  url: string;
  headers: Record<string, string | undefined>;

  constructor(opts: { method: string; url: string; headers?: Record<string, string | undefined> }) {
    super();
    this.method = opts.method;
    this.url = opts.url;
    this.headers = opts.headers ?? {};
  }
}

class MockServerResponse extends EventEmitter {
  statusCode = 200;
  headers: Record<string, string> = {};
  body = "";

  writeHead(statusCode: number, headers?: Record<string, string>): this {
    this.statusCode = statusCode;
    this.headers = headers ?? {};
    return this;
  }

  end(body?: string): this {
    if (body) this.body += body;
    this.emit("finish");
    return this;
  }
}

async function callApiRoute(opts: {
  method: string;
  url: string;
}): Promise<{ statusCode: number; body: string }> {
  const handler = createDashboardRequestHandler({ port: 8787 });
  const req = new MockIncomingMessage({ method: opts.method, url: opts.url });
  const res = new MockServerResponse();
  const done = once(res, "finish");
  void handler(req as unknown as IncomingMessage, res as unknown as ServerResponse);
  req.emit("end");
  await done;
  return { statusCode: res.statusCode, body: res.body };
}

async function callWebhook(deliveryId?: string) {
  const secret = "test-secret";
  const body = JSON.stringify({ repository: { full_name: "dummy-org/dummy-repo" } });
  const onEvent = vi.fn();
  const handler = createWebhookRequestHandler({ port: 0, secret, onEvent });
  const req = new MockIncomingMessage({
    method: "POST",
    url: "/webhook",
    headers: {
      "x-github-event": "push",
      "x-github-delivery": deliveryId,
      "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
    },
  });
  const res = new MockServerResponse();
  const done = once(res, "finish");
  void handler(req as unknown as IncomingMessage, res as unknown as ServerResponse);
  req.emit("data", Buffer.from(body));
  req.emit("end");
  await done;
  return { onEvent, statusCode: res.statusCode, body: res.body };
}

describe("static dashboard request handler", () => {
  it("GET /api/health returns health status details", async () => {
    const res = await callApiRoute({ method: "GET", url: "/api/health" });
    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.body);
    expect(data.status).toBe("ok");
    expect(data.deployedSha).toBeDefined();
    if (data.deployedSha !== "unknown") {
      expect(data.deployedSha).toMatch(/^[0-9a-f]{40}$/);
    } else {
      expect(data.deployedSha).toBe("unknown");
    }
    expect(data.startedAt).toBeDefined();
    expect(Number.isNaN(Date.parse(data.startedAt))).toBe(false);
    expect(data.version).toBeDefined();
    expect(typeof data.version).toBe("string");
  });

  it("unknown /api/* routes 404 — the v2 API surface is gone", async () => {
    for (const url of ["/api/dashboard", "/api/conversations", "/api/models"]) {
      const res = await callApiRoute({ method: "GET", url });
      expect(res.statusCode).toBe(404);
    }
  });

  it("non-API path with no built UI bundle resolves without crashing", async () => {
    // In CI without `build:dashboard-ui` there is no index.html to fall back to,
    // so this is 404; if a bundle happens to exist it would be 200. Either is fine.
    const res = await callApiRoute({ method: "GET", url: "/definitely-not-an-asset.xyz" });
    expect([200, 404]).toContain(res.statusCode);
  });

  it("serves dashboard config for frontend-only quota choices", async () => {
    const handler = createDashboardRequestHandler({
      port: 8787,
      dashboardConfig: { quotaProviders: { claude: { primaryWindow: "session" } } },
    });
    const req = new MockIncomingMessage({ method: "GET", url: "/api/dashboard/config" });
    const res = new MockServerResponse();
    const done = once(res, "finish");
    void handler(req as unknown as IncomingMessage, res as unknown as ServerResponse);
    req.emit("end");
    await done;

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      quotaProviders: { claude: { primaryWindow: "session" } },
    });
  });
});

describe("GitHub webhook request handler", () => {
  it("passes X-GitHub-Delivery through as the durable dedupe key", async () => {
    const result = await callWebhook("delivery-123");

    expect(result.statusCode).toBe(200);
    expect(result.onEvent).toHaveBeenCalledWith(
      "push",
      { repository: { full_name: "dummy-org/dummy-repo" } },
      "delivery-123"
    );
  });

  it("rejects non-ping events without X-GitHub-Delivery", async () => {
    const result = await callWebhook();

    expect(result.statusCode).toBe(400);
    expect(result.body).toBe("Missing X-GitHub-Delivery header");
    expect(result.onEvent).not.toHaveBeenCalled();
  });
});

describe("IU ops-getter mount (ISSUE_NUM 2b)", () => {
  async function runHandler(
    handler: (req: IncomingMessage, res: ServerResponse) => unknown,
    url: string
  ): Promise<{ statusCode: number; body: string }> {
    const req = new MockIncomingMessage({ method: "GET", url });
    const res = new MockServerResponse();
    const done = once(res, "finish");
    void handler(req as unknown as IncomingMessage, res as unknown as ServerResponse);
    req.emit("end");
    await done;
    return { statusCode: res.statusCode, body: res.body };
  }

  it("serves /api/understanding/ops when wired; 404s when not", async () => {
    const wired = createDashboardRequestHandler({
      port: 8789,
      understandingOps: { load: async () => ({ ops: [], cursor: null }) },
    });
    const ok = await runHandler(wired, "/api/understanding/ops");
    expect(ok.statusCode).toBe(200);
    expect(JSON.parse(ok.body)).toEqual({ ops: [], nextCursor: null, rootNodeId: null });

    const unwired = await callApiRoute({ method: "GET", url: "/api/understanding/ops" });
    expect(unwired.statusCode).toBe(404);
  });
});

describe("quota snapshot mount ", () => {
  async function runHandler(
    handler: (req: IncomingMessage, res: ServerResponse) => unknown,
    url: string
  ): Promise<{ statusCode: number; body: string }> {
    const req = new MockIncomingMessage({ method: "GET", url });
    const res = new MockServerResponse();
    const done = once(res, "finish");
    void handler(req as unknown as IncomingMessage, res as unknown as ServerResponse);
    req.emit("end");
    await done;
    return { statusCode: res.statusCode, body: res.body };
  }

  it("serves /api/quota when wired; 503s when not (the route is intentionally re-added, unlike the removed v2 surface)", async () => {
    const wired = createDashboardRequestHandler({
      port: 8790,
      quotaApi: {
        getQuota: async (provider) => ({ provider, status: "unknown" }),
      },
    });
    const ok = await runHandler(wired, "/api/quota");
    expect(ok.statusCode).toBe(200);
    const parsed = JSON.parse(ok.body);
    expect(parsed.providers.map((p: { provider: string }) => p.provider)).toEqual([
      "claude",
      "codex",
      "agy",
      "kimi",
    ]);

    const unwired = await callApiRoute({ method: "GET", url: "/api/quota" });
    expect(unwired.statusCode).toBe(503);
  });
});

describe("parseJsonObjectBody", () => {
  it("returns a 400-class error for malformed client JSON", () => {
    expect(parseJsonObjectBody("{not json").ok).toBe(false);
  });

  it("rejects non-object JSON bodies", () => {
    expect(parseJsonObjectBody("[1,2,3]").ok).toBe(false);
    expect(parseJsonObjectBody('"a string"').ok).toBe(false);
  });

  it("accepts a JSON object body", () => {
    const result = parseJsonObjectBody('{"a":1}');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({ a: 1 });
  });
});

describe("resolveDeployedSha", () => {
  it("returns the sentinel SHA when dist/.build-ok is present (wins over git)", () => {
    const tmp = mkdtempSync(join(tmpdir(), "mc-test-"));
    try {
      writeBuildSentinel(tmp, "1111111111111111111111111111111111111111");
      const sha = resolveDeployedSha([tmp], () => "2222222222222222222222222222222222222222");
      expect(sha).toBe("1111111111111111111111111111111111111111");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("falls back to runtime git when the sentinel is absent", () => {
    const tmp = mkdtempSync(join(tmpdir(), "mc-test-"));
    try {
      const sha = resolveDeployedSha([tmp], () => "2222222222222222222222222222222222222222");
      expect(sha).toBe("2222222222222222222222222222222222222222");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("returns 'unknown' when both fail", () => {
    const tmp = mkdtempSync(join(tmpdir(), "mc-test-"));
    try {
      const sha = resolveDeployedSha([tmp], () => null);
      expect(sha).toBe("unknown");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("exported deployedSha resolution", () => {
  it("reads the sentinel from the module's __dirname", async () => {
    const testSha = "3333333333333333333333333333333333333333";
    writeBuildSentinel(__dirname, testSha);
    try {
      vi.resetModules();
      const mod = await import("./server.js");
      expect(mod.deployedSha).toBe(testSha);
    } finally {
      rmSync(join(__dirname, ".build-ok"), { force: true });
    }
  });
});
