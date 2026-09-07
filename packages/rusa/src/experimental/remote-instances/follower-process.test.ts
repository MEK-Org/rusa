import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { beforeAll, expect, it } from "vitest";
import type { Logger } from "../../observability/logger.js";
import { FollowerHub } from "./follower-hub.js";
import { waitUntil } from "./harness.js";
import { INSTANCE_PROTOCOL_VERSION } from "./protocol.js";

beforeAll(() => {
  execFileSync("pnpm", ["run", "build:follower"], {
    cwd: process.cwd(),
    stdio: "pipe",
    timeout: 30_000,
  });
}, 35_000);

it("registers a separate follower process that hosts both actors itself", async () => {
  const home = mkdtempSync(join(tmpdir(), "rusa-follower-process-"));
  const token = randomBytes(32).toString("hex");
  const tokenFile = join(home, "token");
  writeFileSync(tokenFile, token, { mode: 0o600 });
  const hub = new FollowerHub(token);
  const origin = await hub.listen("127.0.0.1", 0);
  const child = spawn(
    process.execPath,
    [
      resolve("build/follower/follower.js"),
      "--leader",
      origin,
      "--id",
      "test",
      "--home",
      home,
      "--token-file",
      tokenFile,
      "--sandbox",
      "none",
    ],
    { stdio: ["ignore", "pipe", "pipe"] }
  );
  const exited = once(child, "exit");
  let logs = "";
  child.stdout.on("data", (chunk) => {
    logs += chunk;
  });
  child.stderr.on("data", (chunk) => {
    logs += chunk;
  });
  try {
    await waitUntil(() => hub.list().length === 1);
    expect(hub.list()[0].pid).toBe(child.pid);
    expect(child.pid).not.toBe(process.pid);
    const a = hub.createHost("test", "a");
    const b = hub.createHost("test", "b");
    for (const [id, channel] of [
      ["a", a],
      ["b", b],
    ] as const) {
      const ready = once(channel, "message");
      channel.send(
        {
          type: "init",
          bootstrap: {
            id,
            cwd: "/ignored-leader-path",
            providerOptions: { name: "fake", providers: { fake: { type: "fake" } } },
          },
        },
        (error) => {
          if (error) throw error;
        }
      );
      expect((await ready)[0]).toEqual({ type: "ready", pid: child.pid });
    }
    const retired = once(a, "exit");
    a.send({ type: "stop" }, (error) => {
      if (error) throw error;
    });
    await retired;
    expect(hub.list()[0].actors).toEqual(["b"]);
    expect(b.connected).toBe(true);
    expect(child.exitCode).toBeNull();
    // Instance loss disconnects every remaining actor channel, never another process.
    const bClosed = once(b, "exit");
    child.kill("SIGTERM");
    await exited;
    await bClosed;
    expect(hub.list()).toEqual([]);
  } catch (error) {
    throw new Error(`${String(error)}\nFollower logs: ${logs}`);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await exited;
    }
    await hub.close();
    rmSync(home, { recursive: true, force: true });
  }
}, 30_000);

it("retries retained /events batches even when /poll remains healthy", async () => {
  const home = mkdtempSync(join(tmpdir(), "rusa-follower-events-retry-"));
  const token = randomBytes(32).toString("hex");
  const tokenFile = join(home, "token");
  writeFileSync(tokenFile, token, { mode: 0o600 });

  let eventsAttempt = 0;
  let eventReceived = false;
  let initDelivered = false;

  const server = createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      const path = req.url ?? "/";
      if (path === "/register") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({ session: "test-session", protocolVersion: INSTANCE_PROTOCOL_VERSION })
        );
        return;
      }
      if (path === "/poll") {
        if (!initDelivered) {
          initDelivered = true;
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify([
              {
                actorId: "actor-retry",
                message: {
                  type: "init",
                  bootstrap: {
                    id: "actor-retry",
                    cwd: "/ignored",
                    providerOptions: { name: "fake", providers: { fake: { type: "fake" } } },
                  },
                },
              },
            ])
          );
        } else {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify([]));
        }
        return;
      }
      if (path === "/events") {
        eventsAttempt++;
        if (eventsAttempt === 1) {
          // First attempt fails with 500 while /poll remains healthy
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "transient events failure" }));
          return;
        }
        eventReceived = true;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({}));
        return;
      }
      res.writeHead(404);
      res.end();
    });
  });

  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  const origin = `http://127.0.0.1:${port}`;

  const child = spawn(
    process.execPath,
    [
      resolve("build/follower/follower.js"),
      "--leader",
      origin,
      "--id",
      "test-retry",
      "--home",
      home,
      "--token-file",
      tokenFile,
      "--sandbox",
      "none",
    ],
    { stdio: ["ignore", "pipe", "pipe"] }
  );
  const exited = once(child, "exit");

  try {
    await waitUntil(() => eventReceived, 10_000);
    expect(eventsAttempt).toBeGreaterThanOrEqual(2);
    expect(eventReceived).toBe(true);
  } finally {
    child.kill("SIGKILL");
    await exited;
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(home, { recursive: true, force: true });
  }
}, 30_000);

it("processes /events, drops response, retries, and proves retry causes no duplicate effects", async () => {
  const home = mkdtempSync(join(tmpdir(), "rusa-follower-ambiguous-ack-"));
  const token = randomBytes(32).toString("hex");
  const tokenFile = join(home, "token");
  writeFileSync(tokenFile, token, { mode: 0o600 });

  let eventsAttempt = 0;
  let initDelivered = false;
  const processedBatches = new Set<string>();
  const receivedBatchIds: string[] = [];
  let modelSideEffects = 0;
  let finalAck = false;

  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const rawBody = Buffer.concat(chunks).toString();
    const body = rawBody ? (JSON.parse(rawBody) as Record<string, unknown>) : {};
    const path = req.url ?? "/";

    if (path === "/register") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          session: `test-session-${eventsAttempt + 1}`,
          protocolVersion: INSTANCE_PROTOCOL_VERSION,
          leaderToken: "leader-token-shared",
        })
      );
      return;
    }
    if (path === "/poll") {
      if (!initDelivered) {
        initDelivered = true;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify([
            {
              actorId: "actor-retry-safe",
              message: {
                type: "init",
                bootstrap: {
                  id: "actor-retry-safe",
                  cwd: "/ignored",
                  providerOptions: { name: "fake", providers: { fake: { type: "fake" } } },
                },
              },
            },
          ])
        );
      } else {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify([]));
      }
      return;
    }
    if (path === "/events") {
      eventsAttempt++;
      const batchId = body.batchId as string;
      expect(typeof batchId).toBe("string");
      receivedBatchIds.push(batchId);

      // Leader-side deduplication:
      if (!processedBatches.has(batchId)) {
        processedBatches.add(batchId);
        // Simulate leader applying side effects (e.g. runStart, request processing)
        const events = body.events as Array<{
          eventId?: string;
          actorId: string;
          message: { type: string };
        }>;
        for (const event of events) {
          expect(typeof event.eventId).toBe("string");
          modelSideEffects++;
        }
      }

      if (eventsAttempt === 1) {
        // Ambiguous-ack: leader processed the batch, but connection drops / response is lost
        req.socket.destroy();
        return;
      }

      // Retry attempt: response successfully delivered
      finalAck = true;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({}));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  const origin = `http://127.0.0.1:${port}`;

  const child = spawn(
    process.execPath,
    [
      resolve("build/follower/follower.js"),
      "--leader",
      origin,
      "--id",
      "test-retry-safe",
      "--home",
      home,
      "--token-file",
      tokenFile,
      "--sandbox",
      "none",
    ],
    { stdio: ["ignore", "pipe", "pipe"] }
  );
  const exited = once(child, "exit");

  try {
    await waitUntil(() => finalAck, 10_000);
    // At least 2 attempts (initial + retry)
    expect(eventsAttempt).toBeGreaterThanOrEqual(2);
    // The retry used the EXACT SAME batchId
    expect(receivedBatchIds[1]).toBe(receivedBatchIds[0]);
    // The side effects occurred exactly once despite replay
    expect(modelSideEffects).toBe(1);
  } finally {
    child.kill("SIGKILL");
    await exited;
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(home, { recursive: true, force: true });
  }
}, 30_000);

it("fences and discards pending events from an old leader incarnation when leader restarts", async () => {
  const home = mkdtempSync(join(tmpdir(), "rusa-follower-leader-restart-fence-"));
  const token = randomBytes(32).toString("hex");
  const tokenFile = join(home, "token");
  writeFileSync(tokenFile, token, { mode: 0o600 });

  let incarnation = "leader-incarnation-1";
  let gen2Registered = false;
  const receivedBatchesGen2: string[] = [];

  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const rawBody = Buffer.concat(chunks).toString();
    const body = rawBody ? (JSON.parse(rawBody) as Record<string, unknown>) : {};
    const path = req.url ?? "/";

    if (path === "/register") {
      if (incarnation === "leader-incarnation-2") {
        gen2Registered = true;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          session: `session-${incarnation}`,
          protocolVersion: INSTANCE_PROTOCOL_VERSION,
          leaderToken: incarnation,
        })
      );
      return;
    }

    // Requests with a stale session receive 410 (Session expired), exactly matching FollowerHub
    if (body.session !== `session-${incarnation}`) {
      res.writeHead(410, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Session expired" }));
      return;
    }

    if (path === "/poll") {
      if (incarnation === "leader-incarnation-1") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify([
            {
              actorId: "actor-fence",
              message: {
                type: "init",
                bootstrap: {
                  id: "actor-fence",
                  cwd: "/ignored",
                  providerOptions: { name: "fake", providers: { fake: { type: "fake" } } },
                },
              },
            },
          ])
        );
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify([]));
      return;
    }
    if (path === "/events") {
      if (incarnation === "leader-incarnation-1") {
        // Leader 1 receives events, but leader restarts with new incarnation before ack
        incarnation = "leader-incarnation-2";
        req.socket.destroy();
        return;
      }
      // Under Leader 2: record any received batches
      receivedBatchesGen2.push(body.batchId as string);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({}));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  const origin = `http://127.0.0.1:${port}`;

  const child = spawn(
    process.execPath,
    [
      resolve("build/follower/follower.js"),
      "--leader",
      origin,
      "--id",
      "test-fence",
      "--home",
      home,
      "--token-file",
      tokenFile,
      "--sandbox",
      "none",
    ],
    { stdio: ["ignore", "pipe", "pipe"] }
  );
  const exited = once(child, "exit");

  try {
    // Wait for follower to detect restart and re-register under generation 2
    await waitUntil(() => gen2Registered, 10_000);
    // Give a brief window to ensure no replayed batches are sent to generation 2
    await new Promise((r) => setTimeout(r, 500));
    // The old batch from leader incarnation 1 was discarded and NOT sent to incarnation 2!
    expect(receivedBatchesGen2).toHaveLength(0);
  } finally {
    child.kill("SIGKILL");
    await exited;
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(home, { recursive: true, force: true });
  }
}, 30_000);

it("survives synthetic leader restart with follower auto-reconnect, actor re-attachment, and capability re-issuance", async () => {
  const home = mkdtempSync(join(tmpdir(), "rusa-follower-restart-"));
  const token = randomBytes(32).toString("hex");
  const tokenFile = join(home, "token");
  writeFileSync(tokenFile, token, { mode: 0o600 });

  const logEvents: Array<{ level: string; msg: string; fields?: Record<string, unknown> }> = [];
  const testLogger: Logger = {
    debug: () => {},
    info: (msg, fields) => {
      logEvents.push({ level: "info", msg, fields: fields as Record<string, unknown> });
    },
    warn: (msg, fields) => {
      logEvents.push({ level: "warn", msg, fields: fields as Record<string, unknown> });
    },
    error: (msg, fields) => {
      logEvents.push({ level: "error", msg, fields: fields as Record<string, unknown> });
    },
    child: () => testLogger,
  };

  // Spin up mock leader MCP server on 127.0.0.1
  let leaderMcpHits = 0;
  const mockMcpServer = createServer((_req, res) => {
    leaderMcpHits++;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", result: { tools: [] }, id: 1 }));
  });
  await new Promise<void>((r) => mockMcpServer.listen(0, "127.0.0.1", () => r()));
  const mockMcpPort = (mockMcpServer.address() as { port: number }).port;
  const mockMcpUrl = `http://127.0.0.1:${mockMcpPort}/mcp/tools`;

  // 1. Start generation 1 leader hub
  let hub = new FollowerHub(token, { logger: testLogger });
  const origin = await hub.listen("127.0.0.1", 0);
  const leaderUrl = new URL(origin);
  const leaderPort = Number(leaderUrl.port);

  // 2. Start follower process pointing to generation 1 leader
  const child = spawn(
    process.execPath,
    [
      resolve("build/follower/follower.js"),
      "--leader",
      origin,
      "--id",
      "worker-node",
      "--home",
      home,
      "--token-file",
      tokenFile,
      "--sandbox",
      "none",
    ],
    { stdio: ["ignore", "pipe", "pipe"] }
  );
  const exited = once(child, "exit");
  let logs = "";
  child.stdout.on("data", (chunk) => {
    logs += chunk;
  });
  child.stderr.on("data", (chunk) => {
    logs += chunk;
  });

  try {
    // 3. Wait for follower to register
    await waitUntil(() => hub.list().length === 1);
    expect(hub.list()[0].id).toBe("worker-node");
    expect(hub.list()[0].pid).toBe(child.pid);

    // Verify follower_connected log was emitted
    expect(
      logEvents.some(
        (e) => e.msg === "follower_connected" && e.fields?.followerId === "worker-node"
      )
    ).toBe(true);

    // 4. Place actor "actor-1" on follower
    const host1 = hub.createHost("worker-node", "actor-1");
    const readyPromise1 = once(host1, "message");
    const toolUrls1 = hub.toolUrls("worker-node", "actor-1", [
      { name: "mock-tools", url: mockMcpUrl },
    ]);
    expect(toolUrls1[0].url).toContain("/mcp/");

    host1.send(
      {
        type: "init",
        bootstrap: {
          id: "actor-1",
          cwd: "/ignored-leader-path",
          mcpServers: toolUrls1,
          providerOptions: { name: "fake", providers: { fake: { type: "fake" } } },
        },
      },
      (error) => {
        if (error) throw error;
      }
    );
    const [readyMsg1] = (await readyPromise1) as [{ type: string; pid: number }];
    expect(readyMsg1.type).toBe("ready");
    expect(readyMsg1.pid).toBe(child.pid);

    // Verify MCP request proxying through hub works and leader server receives it
    const mcpResp = await fetch(toolUrls1[0].url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 1 }),
    });
    expect(mcpResp.status).toBe(200);
    expect(leaderMcpHits).toBe(1);

    // 5. SYNTHETIC LEADER RESTART:
    // Shut down generation 1 hub
    await hub.close();

    // Verify follower child process did NOT exit
    expect(child.exitCode).toBeNull();

    // 6. Start generation 2 leader hub on the SAME port and bind address
    const reconnectedFollowerPromise = new Promise<{ id: string; pid: number }>(
      (resolveRegistered) => {
        const nextHub = new FollowerHub(token, { logger: testLogger });
        nextHub.onRegister((follower) => {
          resolveRegistered({ id: follower.id, pid: follower.pid });
        });
        hub = nextHub;
      }
    );
    await hub.listen("127.0.0.1", leaderPort);

    // 7. Follower auto-reconnects with backoff
    const reconnected = await reconnectedFollowerPromise;
    expect(reconnected.id).toBe("worker-node");
    expect(reconnected.pid).toBe(child.pid);

    // 8. Leader re-attaches actor-1 by ID with re-issued capability URLs
    const toolUrls2 = hub.toolUrls("worker-node", "actor-1", [
      { name: "mock-tools", url: mockMcpUrl },
    ]);
    const host2 = hub.createHost("worker-node", "actor-1");
    const readyPromise2 = once(host2, "message");

    host2.send(
      {
        type: "init",
        bootstrap: {
          id: "actor-1",
          cwd: "/ignored-leader-path",
          mcpServers: toolUrls2,
          providerOptions: { name: "fake", providers: { fake: { type: "fake" } } },
          reconnect: true,
        },
      },
      (error) => {
        if (error) throw error;
      }
    );

    const [readyMsg2] = (await readyPromise2) as [{ type: string; pid: number }];
    expect(readyMsg2.type).toBe("ready");
    expect(readyMsg2.pid).toBe(child.pid);

    // 9. Verify re-issued MCP capability URL works with new leader generation
    const mcpResp2 = await fetch(toolUrls2[0].url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 2 }),
    });
    expect(mcpResp2.status).toBe(200);
    expect(leaderMcpHits).toBe(2);

    // 10. Verify logging: no capability bearer token paths (/mcp/...) appear in log messages or fields
    for (const entry of logEvents) {
      expect(entry.msg).not.toMatch(/\/mcp\/[a-f0-9]{32,}/i);
      const serializedFields = JSON.stringify(entry.fields ?? {});
      expect(serializedFields).not.toMatch(/\/mcp\/[a-f0-9]{32,}/i);
    }

    // 11. Clean shutdown of follower
    child.kill("SIGTERM");
    await exited;
    expect(child.exitCode).toBe(0);
  } catch (error) {
    throw new Error(`${String(error)}\nFollower logs:\n${logs}`);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await exited;
    }
    await hub.close();
    await new Promise<void>((r) => mockMcpServer.close(() => r()));
    rmSync(home, { recursive: true, force: true });
  }
}, 30_000);
