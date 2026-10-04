import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type ManualReadingRequest,
  type ManualReadingResult,
  QuotaCoordinatorClient,
} from "../quota/coordinator-client.js";
import {
  MANUAL_QUOTA_OBSERVATION_PATH,
  QUOTA_READING_MODE_PATH,
} from "../quota/coordinator-protocol.js";
import { QuotaCoordinatorService } from "../quota/coordinator-service.js";
import { SharedQuotaStore } from "../quota/shared-store.js";
import { FollowerHub } from "../remote-instances/follower-hub.js";
import { INSTANCE_PROTOCOL_VERSION } from "../remote-instances/protocol.js";
import {
  buildGrantableServers,
  type GrantableServerDeps,
  mountGrantedServers,
} from "./grantable-servers.js";
import { McpHttpServer } from "./http-server.js";
import {
  createQuotaManualServer,
  manualReadingIdempotencyKey,
  manualReadingStatus,
  QUOTA_MANUAL_MCP_NAME,
  type QuotaManualMcpDeps,
} from "./quota-manual-mcp.js";

const NOW_MS = Date.parse("2030-01-01T00:10:00.000Z");
// Deliberately not in the canonical `toISOString()` form, so a tool that
// re-encoded the instant would be caught by the exact-string assertions.
const OBSERVED_AT = "2030-01-01T00:05:00Z";
const LIMITS = [
  {
    label: "Weekly",
    kind: "weekly" as const,
    percentLeft: 33,
    resetAtIso: "2030-01-08T00:00:00.000Z",
    scope: { provider: "kimi" },
  },
];

function post(
  socketPath: string,
  path: string,
  body: object,
  headers: http.OutgoingHttpHeaders = {}
): Promise<{ status: number; body: string }> {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        socketPath,
        path,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload),
          ...headers,
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
      }
    );
    req.on("error", reject);
    req.end(payload);
  });
}

function text(result: CallToolResult): string {
  const [first] = result.content;
  if (first?.type !== "text") throw new Error("expected a text result");
  return first.text;
}

async function connect(deps: QuotaManualMcpDeps): Promise<Client> {
  const server = createQuotaManualServer(deps);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientTransport);
  return client;
}

describe("submit_manual_reading (#690)", () => {
  let tmpDir: string;
  let socketPath: string;
  let store: SharedQuotaStore;
  let service: QuotaCoordinatorService;
  let sent: ManualReadingRequest[];
  let received: ManualReadingResult[];
  let deps: QuotaManualMcpDeps;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "quota-manual-mcp-"));
    socketPath = join(tmpDir, "coordinator.sock");
    store = new SharedQuotaStore(join(tmpDir, "quota.db"));
    service = new QuotaCoordinatorService({
      socketPath,
      store,
      configuredProviders: ["kimi"],
      now: () => NOW_MS,
      hardStaleAfterMs: 60 * 60_000,
    });
    await service.start();
    const client = new QuotaCoordinatorClient({ socketPath });
    sent = [];
    received = [];
    deps = {
      client: {
        postManualReading: async (request) => {
          sent.push(structuredClone(request));
          const result = await client.postManualReading(request);
          received.push(result);
          return result;
        },
      },
    };
  });

  afterEach(async () => {
    await service.stop();
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  async function switchMode(mode: "manual" | "scrape"): Promise<number> {
    const res = await post(socketPath, QUOTA_READING_MODE_PATH, { provider: "kimi", mode });
    expect(res.status).toBe(200);
    return (JSON.parse(res.body) as { generation: number }).generation;
  }

  /** The same write sent straight to the socket, for a byte-for-byte comparison. */
  function direct(request: ManualReadingRequest): Promise<{ status: number; body: string }> {
    return post(
      socketPath,
      MANUAL_QUOTA_OBSERVATION_PATH,
      {
        provider: request.provider,
        generation: request.generation,
        observation: request.snapshot,
      },
      { "idempotency-key": request.idempotencyKey }
    );
  }

  it("submits the reading with observedAt untouched and returns the accept envelope", async () => {
    const generation = await switchMode("manual");
    const tool = await connect(deps);

    const accepted = (await tool.callTool({
      name: "submit_manual_reading",
      arguments: { provider: "kimi", generation, observedAt: OBSERVED_AT, limits: LIMITS },
    })) as CallToolResult;

    expect(accepted.isError).toBeFalsy();
    expect(sent).toEqual([
      {
        provider: "kimi",
        generation,
        snapshot: {
          provider: "kimi",
          status: "available",
          scrapedAt: OBSERVED_AT,
          limits: LIMITS,
        },
        idempotencyKey: manualReadingIdempotencyKey("kimi", generation, OBSERVED_AT),
      },
    ]);
    // The accept envelope is the coordinator's own bytes, as the client got them.
    const acceptedRaw = received[0];
    if (!acceptedRaw?.reached) throw new Error("coordinator not reached");
    expect(acceptedRaw.statusCode).toBe(200);
    expect(text(accepted)).toBe(acceptedRaw.body);
    expect(JSON.parse(text(accepted))).toMatchObject({
      provider: "kimi",
      generation,
      duplicate: false,
    });
    expect(store.getLatestSnapshot("kimi")).toMatchObject({
      limits: [expect.objectContaining({ percentLeft: 33 })],
    });

    // A retried call is the same reading under the same key: a replay, not a
    // second observation, and the replay envelope is the coordinator's own.
    const replayRequest = sent[0];
    if (!replayRequest) throw new Error("no request recorded");
    const replay = (await tool.callTool({
      name: "submit_manual_reading",
      arguments: { provider: "kimi", generation, observedAt: OBSERVED_AT, limits: LIMITS },
    })) as CallToolResult;
    expect(replay.isError).toBeFalsy();
    expect(text(replay)).toBe((await direct(replayRequest)).body);
    expect(JSON.parse(text(replay))).toMatchObject({ duplicate: true });
  });

  it("records a reading with a provider-wide window at zero as exhausted, gating the lane", async () => {
    const generation = await switchMode("manual");
    const tool = await connect(deps);
    const exhausted = [{ ...LIMITS[0], percentLeft: 0 }];

    const accepted = (await tool.callTool({
      name: "submit_manual_reading",
      arguments: { provider: "kimi", generation, observedAt: OBSERVED_AT, limits: exhausted },
    })) as CallToolResult;

    expect(accepted.isError).toBeFalsy();
    expect(sent[0]?.snapshot.status).toBe("exhausted");
    expect(store.getExhaustedUntil("kimi", NOW_MS)).toBe(LIMITS[0]?.resetAtIso);
  });

  it("derives status the way a scrape does: provider-wide windows only", () => {
    const weekly = LIMITS[0];
    if (!weekly) throw new Error("no fixture limit");
    expect(manualReadingStatus([weekly])).toBe("available");
    expect(manualReadingStatus([{ ...weekly, percentLeft: 0 }])).toBe("exhausted");
    expect(manualReadingStatus([{ ...weekly, scope: undefined, percentLeft: 0 }])).toBe(
      "exhausted"
    );
    expect(
      manualReadingStatus([
        weekly,
        { ...weekly, percentLeft: 0, scope: { provider: "kimi", models: ["kimi-k2"] } },
      ])
    ).toBe("available");
  });

  it.each([
    {
      code: "manual_mode_required",
      observedAt: OBSERVED_AT,
      setup: async () => 1,
    },
    {
      code: "mode_generation_mismatch",
      observedAt: OBSERVED_AT,
      setup: async (switchTo: (mode: "manual" | "scrape") => Promise<number>) => {
        const superseded = await switchTo("manual");
        await switchTo("scrape");
        await switchTo("manual");
        return superseded;
      },
    },
    {
      // Older than the coordinator's manual hard-stale limit: the coordinator
      // refuses it; the tool does not pre-filter or re-date it.
      code: "stale_observation",
      observedAt: "2029-12-31T21:10:00Z",
      setup: async (switchTo: (mode: "manual" | "scrape") => Promise<number>) => switchTo("manual"),
    },
  ])("returns the coordinator's $code envelope unchanged", async ({ code, observedAt, setup }) => {
    const generation = await setup(switchMode);
    const tool = await connect(deps);

    const refused = (await tool.callTool({
      name: "submit_manual_reading",
      arguments: { provider: "kimi", generation, observedAt, limits: LIMITS },
    })) as CallToolResult;

    expect(refused.isError).toBe(true);
    const request = sent[0];
    if (!request) throw new Error("no request recorded");
    expect(request.snapshot.scrapedAt).toBe(observedAt);
    const expected = await direct(request);
    expect(expected.status).toBe(409);
    expect(text(refused)).toBe(expected.body);
    expect(JSON.parse(text(refused))).toMatchObject({ error: { code } });
    expect(store.getLatestSnapshot("kimi")).toBeNull();
  });

  it("reports an unconfigured or unreachable coordinator as a tool error", async () => {
    const unconfigured = await connect({ client: null });
    const none = (await unconfigured.callTool({
      name: "submit_manual_reading",
      arguments: { provider: "kimi", generation: 1, observedAt: OBSERVED_AT, limits: LIMITS },
    })) as CallToolResult;
    expect(none.isError).toBe(true);
    expect(text(none)).toBe("No quota coordinator is configured on this instance");

    const unreachable = await connect({
      client: new QuotaCoordinatorClient({ socketPath: join(tmpDir, "missing.sock") }),
    });
    const down = (await unreachable.callTool({
      name: "submit_manual_reading",
      arguments: { provider: "kimi", generation: 1, observedAt: OBSERVED_AT, limits: LIMITS },
    })) as CallToolResult;
    expect(down.isError).toBe(true);
    expect(text(down)).toMatch(/^Quota coordinator unreachable: /);
  });

  it("reaches a follower-hosted grantee through the follower hub's MCP proxy", async () => {
    const generation = await switchMode("manual");
    // Only the quota-manual factory is exercised; the others are never built.
    const servers = buildGrantableServers({ quotaManual: deps } as GrantableServerDeps);
    const mcpHttp = new McpHttpServer({ servers: {} });
    await mcpHttp.start();
    const token = randomBytes(32).toString("hex");
    const hub = new FollowerHub(token);
    const origin = await hub.listen("127.0.0.1", 0);
    const tool = new Client({ name: "follower-actor", version: "0.0.0" });
    try {
      const registered = await fetch(`${origin}/register`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          id: "mac",
          platform: "darwin",
          pid: 123,
          generation: "mac-process-one",
          protocolVersion: INSTANCE_PROTOCOL_VERSION,
        }),
      });
      expect(registered.status).toBe(200);
      hub.createHost("mac", "reader");
      hub.createHost("mac", "bystander");

      // The leader mounts granted servers on each actor's own spec set, and the
      // hub turns that set into follower-reachable bearer URLs.
      const readerSpecs = hub.toolUrls(
        "mac",
        "reader",
        mountGrantedServers("reader", [QUOTA_MANUAL_MCP_NAME], servers, mcpHttp)
      );
      const bystanderSpecs = hub.toolUrls(
        "mac",
        "bystander",
        mountGrantedServers("bystander", [], servers, mcpHttp)
      );
      expect(bystanderSpecs).toEqual([]);
      const [spec] = readerSpecs;
      expect(readerSpecs.map((s) => s.name)).toEqual([QUOTA_MANUAL_MCP_NAME]);
      if (!spec) throw new Error("no proxied spec");
      expect(spec.url.startsWith(`${origin}/mcp/`)).toBe(true);

      await tool.connect(new StreamableHTTPClientTransport(new URL(spec.url)));
      expect((await tool.listTools()).tools.map((t) => t.name)).toEqual(["submit_manual_reading"]);
      const accepted = (await tool.callTool({
        name: "submit_manual_reading",
        arguments: { provider: "kimi", generation, observedAt: OBSERVED_AT, limits: LIMITS },
      })) as CallToolResult;

      expect(accepted.isError).toBeFalsy();
      expect(JSON.parse(text(accepted))).toMatchObject({
        provider: "kimi",
        generation,
        duplicate: false,
      });
      expect(sent.map((r) => r.snapshot.scrapedAt)).toEqual([OBSERVED_AT]);
      expect(store.getLatestSnapshot("kimi")).toMatchObject({
        limits: [expect.objectContaining({ percentLeft: 33 })],
      });
    } finally {
      await tool.close();
      await hub.close();
      await mcpHttp.close();
    }
  });
});
