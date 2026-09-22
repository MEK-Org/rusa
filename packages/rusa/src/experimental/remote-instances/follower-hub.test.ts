import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FollowerHub } from "./follower-hub.js";
import { INSTANCE_PROTOCOL_VERSION } from "./protocol.js";

const hubs: FollowerHub[] = [];
afterEach(async () => {
  await Promise.all(hubs.splice(0).map((hub) => hub.close()));
});
async function setup() {
  const token = randomBytes(32).toString("hex");
  const hub = new FollowerHub(token);
  hubs.push(hub);
  const origin = await hub.listen("127.0.0.1", 0);
  const post = (path: string, body: object) =>
    fetch(`${origin}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const get = (path: string) =>
    fetch(`${origin}${path}`, {
      headers: { authorization: `Bearer ${token}` },
    });
  const register = async (id: string) => {
    const response = await post("/register", {
      id,
      platform: "darwin",
      pid: 123,
      protocolVersion: INSTANCE_PROTOCOL_VERSION,
    });
    expect(response.status).toBe(200);
    return { id, ...((await response.json()) as { session: string; leaderToken: string }) };
  };
  return { hub, origin, token, post, get, register };
}

describe("leader follower gateway", () => {
  it("enforces safe bind and refuses wildcard or public addresses", async () => {
    const token = randomBytes(32).toString("hex");
    const hub = new FollowerHub(token);
    try {
      await expect(hub.listen("0.0.0.0", 0)).rejects.toThrow(
        "Bind the follower gateway to loopback or a Tailscale IPv4 address"
      );
      await expect(hub.listen("8.8.8.8", 0)).rejects.toThrow(
        "Bind the follower gateway to loopback or a Tailscale IPv4 address"
      );
      const origin = await hub.listen("127.0.0.1", 0);
      expect(origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    } finally {
      await hub.close();
    }
  });

  it("authenticates registration and rejects duplicate identities and stale sessions", async () => {
    const h = await setup();
    expect((await fetch(`${h.origin}/followers`)).status).toBe(401);
    const identity = await h.register("mac");
    expect(
      (
        await h.post("/register", {
          id: "mac",
          platform: "darwin",
          pid: 124,
          protocolVersion: INSTANCE_PROTOCOL_VERSION,
        })
      ).status
    ).toBe(409);
    expect((await h.post("/poll", { id: "mac", session: "wrong" })).status).toBe(410);
    expect((await h.post("/register", { id: "old", platform: "darwin", pid: 124 })).status).toBe(
      409
    );
    expect(() => h.hub.createHost("unknown", "actor")).toThrow("not connected");
    await h.post("/unregister", identity);
    expect(h.hub.list()).toEqual([]);
  });

  it("routes multiple actors on one follower and keeps the follower after retirement", async () => {
    const h = await setup();
    const identity = await h.register("mac");
    const other = await h.register("other");
    const a = h.hub.createHost("mac", "a");
    const received: unknown[] = [];
    a.on("message", (event) => received.push(event));
    h.hub.createHost("mac", "b");
    a.send({ type: "wake" }, (error) => expect(error).toBeNull());
    const response = await h.post("/poll", identity);
    expect(await response.json()).toEqual([{ actorId: "a", message: { type: "wake" } }]);
    await h.post("/events", {
      ...other,
      batchId: "other-batch",
      events: [{ eventId: "ev-other", actorId: "a", message: { type: "ready", pid: 999 } }],
    });
    expect(received).toEqual([]);
    expect(a.pid).toBe(123);
    await h.post("/events", {
      ...identity,
      batchId: "mac-batch-1",
      events: [{ eventId: "ev-ready-123", actorId: "a", message: { type: "ready", pid: 123 } }],
    });
    expect(received).toEqual([{ type: "ready", pid: 123 }]);
    const exited = once(a, "exit");
    await h.post("/events", {
      ...identity,
      batchId: "mac-batch-2",
      events: [
        { eventId: "ev-exit-a", actorId: "a", message: { type: "exit", code: 0, signal: null } },
      ],
    });
    await exited;
    expect(h.hub.list().find((f) => f.id === "mac")?.actors).toEqual(["b"]);
  });

  it("proxies only assigned MCP endpoints and revokes them when the actor exits", async () => {
    const h = await setup();
    const identity = await h.register("mac");
    h.hub.createHost("mac", "a");
    const server = createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ path: req.url, session: req.headers["mcp-session-id"] }));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No address");
    try {
      const [tool] = h.hub.toolUrls("mac", "a", [
        { name: "mesh", url: `http://127.0.0.1:${address.port}/mcp/secret` },
      ]);
      const response = await fetch(tool.url, { headers: { "mcp-session-id": "session" } });
      expect(await response.json()).toEqual({ path: "/mcp/secret", session: "session" });
      expect(() =>
        h.hub.toolUrls("mac", "a", [{ name: "bad", url: "https://example.com" }])
      ).toThrow("Only leader-owned");
      await h.post("/events", {
        ...identity,
        batchId: "mcp-exit-batch",
        events: [
          {
            eventId: "ev-mcp-exit",
            actorId: "a",
            message: { type: "exit", code: 0, signal: null },
          },
        ],
      });
      expect((await fetch(tool.url)).status).toBe(404);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
  it("revokes a capability the moment it leaves the actor's snapshot, not at exit", async () => {
    const h = await setup();
    await h.register("mac");
    h.hub.createHost("mac", "a");
    const server = createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ path: req.url }));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No address");
    const leader = `http://127.0.0.1:${address.port}`;
    try {
      const [mesh, revoked] = h.hub.toolUrls("mac", "a", [
        { name: "mesh", url: `${leader}/mcp/mesh` },
        { name: "scratch", url: `${leader}/mcp/scratch` },
      ]);
      expect((await fetch(mesh.url)).status).toBe(200);
      expect((await fetch(revoked.url)).status).toBe(200);

      // The next snapshot drops `scratch`. The actor is still alive and still
      // holds the old bearer URL, so revocation has to happen on this refresh.
      const [meshAgain] = h.hub.toolUrls("mac", "a", [{ name: "mesh", url: `${leader}/mcp/mesh` }]);
      expect(meshAgain.url).toBe(mesh.url);
      expect(h.hub.list().find((f) => f.id === "mac")?.actors).toEqual(["a"]);
      expect((await fetch(revoked.url)).status).toBe(404);
      expect((await fetch(mesh.url)).status).toBe(200);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("reconciles only the refreshed actor's routes", async () => {
    const h = await setup();
    await h.register("mac");
    h.hub.createHost("mac", "a");
    h.hub.createHost("mac", "b");
    const [forB] = h.hub.toolUrls("mac", "b", [{ name: "mesh", url: "http://127.0.0.1:1/mcp/b" }]);
    h.hub.toolUrls("mac", "a", [{ name: "mesh", url: "http://127.0.0.1:1/mcp/a" }]);
    h.hub.toolUrls("mac", "a", []);
    // Sibling capabilities survive another actor's refresh: 502 is the proxy
    // failing to reach the (unbound) leader port, i.e. the route still resolves.
    expect((await fetch(forB.url)).status).toBe(502);
  });

  it("stops actor on follower and dispatches stop command", async () => {
    const h = await setup();
    const identity = await h.register("mac");
    h.hub.createHost("mac", "retired-actor");
    h.hub.stopActor("mac", "retired-actor");
    const response = await h.post("/poll", identity);
    expect(await response.json()).toEqual([
      { actorId: "retired-actor", message: { type: "stop" } },
    ]);
    expect(h.hub.list().find((f) => f.id === "mac")?.actors).toEqual([]);
  });

  it("deduplicates /events by batchId and eventId to prevent duplicate delivery to actor host", async () => {
    const h = await setup();
    const identity = await h.register("mac");
    const host = h.hub.createHost("mac", "actor-1");
    const received: unknown[] = [];
    host.on("message", (msg) => received.push(msg));

    // First delivery of batch-1 with event-1 (runStart)
    const res1 = await h.post("/events", {
      ...identity,
      batchId: "batch-1",
      events: [
        {
          eventId: "ev-1",
          actorId: "actor-1",
          message: {
            type: "runStart",
            responsive: false,
            selected: { provider: "fake", model: "model-a" },
          },
        },
      ],
    });
    expect(res1.status).toBe(200);
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ type: "runStart" });

    // Retry of batch-1 (simulating lost response / replay): must be deduplicated by batchId
    const res2 = await h.post("/events", {
      ...identity,
      batchId: "batch-1",
      events: [
        {
          eventId: "ev-1",
          actorId: "actor-1",
          message: {
            type: "runStart",
            responsive: false,
            selected: { provider: "fake", model: "model-a" },
          },
        },
      ],
    });
    expect(res2.status).toBe(200);
    expect(received).toHaveLength(1); // No duplicate delivery!

    // Delivery of same eventId in a new batch: must be deduplicated by eventId
    const res3 = await h.post("/events", {
      ...identity,
      batchId: "batch-2",
      events: [
        {
          eventId: "ev-1",
          actorId: "actor-1",
          message: {
            type: "runStart",
            responsive: false,
            selected: { provider: "fake", model: "model-a" },
          },
        },
      ],
    });
    expect(res3.status).toBe(200);
    expect(received).toHaveLength(1); // Still no duplicate delivery!

    // Delivery of a new event in batch-3
    const res4 = await h.post("/events", {
      ...identity,
      batchId: "batch-3",
      events: [
        {
          eventId: "ev-2",
          actorId: "actor-1",
          message: { type: "ready", pid: 456 },
        },
      ],
    });
    expect(res4.status).toBe(200);
    expect(received).toHaveLength(2);
    expect(received[1]).toEqual({ type: "ready", pid: 456 });

    // Replay of batch-3: must be deduplicated
    const res5 = await h.post("/events", {
      ...identity,
      batchId: "batch-3",
      events: [
        {
          eventId: "ev-2",
          actorId: "actor-1",
          message: { type: "ready", pid: 456 },
        },
      ],
    });
    expect(res5.status).toBe(200);
    expect(received).toHaveLength(2);
  });

  it("rejects incompatible wire protocol versions on /register and requires validated batchId/eventId on /events", async () => {
    const h = await setup();
    // Prior protocol versions (v2, v1) rejected
    const priorV2 = await h.post("/register", {
      id: "peer-v2",
      platform: "darwin",
      pid: 100,
      protocolVersion: 2,
    });
    expect(priorV2.status).toBe(409);
    expect(await priorV2.json()).toEqual({
      error: "Incompatible instance protocol; rebuild leader and follower",
    });

    const identity = await h.register("valid-peer");
    expect(identity.session).toBeTruthy();
    expect(identity.leaderToken).toBeTruthy();

    // /events missing batchId rejected
    const missingBatch = await h.post("/events", {
      ...identity,
      events: [{ eventId: "ev-1", actorId: "a", message: { type: "ready", pid: 1 } }],
    });
    expect(missingBatch.status).toBe(400);

    // /events missing eventId rejected
    const missingEventId = await h.post("/events", {
      ...identity,
      batchId: "b-1",
      events: [{ actorId: "a", message: { type: "ready", pid: 1 } }],
    });
    expect(missingEventId.status).toBe(400);
  });

  it("preserves deduplication fence across same-leader RemoteInstance replacement (registration replacement after process before ack)", async () => {
    const h = await setup();
    const identity1 = await h.register("mac");
    expect(identity1.leaderToken).toBeTruthy();

    const host1 = h.hub.createHost("mac", "actor-1");
    const received: unknown[] = [];
    host1.on("message", (msg) => received.push(msg));

    // Process batch-1 under generation 1
    const res1 = await h.post("/events", {
      ...identity1,
      batchId: "batch-1",
      events: [
        {
          eventId: "ev-1",
          actorId: "actor-1",
          message: {
            type: "runStart",
            responsive: false,
            selected: { provider: "fake", model: "model-a" },
          },
        },
      ],
    });
    expect(res1.status).toBe(200);
    expect(received).toHaveLength(1);

    // Follower disconnects / re-registers (e.g. response was lost, socket reset, session expired)
    await h.post("/unregister", identity1);
    const identity2 = await h.register("mac");
    expect(identity2.session).not.toBe(identity1.session);
    // Same leader retains the exact same leaderToken
    expect(identity2.leaderToken).toBe(identity1.leaderToken);

    // Rebind actor host on the new RemoteInstance
    const host2 = h.hub.createHost("mac", "actor-1");
    host2.on("message", (msg) => received.push(msg));

    // Follower retries batch-1 under identity2 (new session / generation)
    const res2 = await h.post("/events", {
      ...identity2,
      batchId: "batch-1",
      events: [
        {
          eventId: "ev-1",
          actorId: "actor-1",
          message: {
            type: "runStart",
            responsive: false,
            selected: { provider: "fake", model: "model-a" },
          },
        },
      ],
    });
    expect(res2.status).toBe(200);
    // Deduplication fence held across RemoteInstance replacement: NO duplicate dispatch!
    expect(received).toHaveLength(1);

    // New batch under identity2 is dispatched normally
    const res3 = await h.post("/events", {
      ...identity2,
      batchId: "batch-2",
      events: [
        {
          eventId: "ev-2",
          actorId: "actor-1",
          message: { type: "ready", pid: 789 },
        },
      ],
    });
    expect(res3.status).toBe(200);
    expect(received).toHaveLength(2);
    expect(received[1]).toEqual({ type: "ready", pid: 789 });
  });

  it("keeps a long-lived follower's just-processed replay fence through expiry and replacement", async () => {
    const start = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(start);
    try {
      const h = await setup();
      const identity1 = await h.register("mac");
      const firstHost = h.hub.createHost("mac", "actor-1");
      const received: unknown[] = [];
      firstHost.on("message", (message) => received.push(message));

      // This follower has been connected for over an hour. It now processes a
      // batch whose acknowledgement is assumed lost, so it may replay after
      // the expiry-driven generation replacement below.
      clock.mockReturnValue(start + 3601_000);
      const first = await h.post("/events", {
        ...identity1,
        batchId: "long-lived-batch",
        events: [
          {
            eventId: "long-lived-event",
            actorId: "actor-1",
            message: { type: "ready", pid: 456 },
          },
        ],
      });
      expect(first.status).toBe(200);
      expect(received).toEqual([{ type: "ready", pid: 456 }]);

      // The connection expires 46 seconds after the accepted batch. Running
      // the real sweep is deterministic here; with stale tracker freshness it
      // would delete the fence in this same sweep.
      clock.mockReturnValue(start + 3601_000 + 46_000);
      (h.hub as unknown as { sweepFollowers(): void }).sweepFollowers();
      expect(h.hub.list()).toEqual([]);

      const identity2 = await h.register("mac");
      const replacementHost = h.hub.createHost("mac", "actor-1");
      replacementHost.on("message", (message) => received.push(message));
      const replay = await h.post("/events", {
        ...identity2,
        batchId: "long-lived-batch",
        events: [
          {
            eventId: "long-lived-event",
            actorId: "actor-1",
            message: { type: "ready", pid: 456 },
          },
        ],
      });
      expect(replay.status).toBe(200);
      expect(received).toEqual([{ type: "ready", pid: 456 }]);
    } finally {
      clock.mockRestore();
    }
  });

  describe("follower update mechanism", () => {
    it("registers follower with commitSha and includes update metadata in list()", async () => {
      const h = await setup();
      const response = await h.post("/register", {
        id: "worker-sha",
        platform: "linux",
        pid: 321,
        protocolVersion: INSTANCE_PROTOCOL_VERSION,
        commitSha: "1234567890abcdef1234567890abcdef12345678",
      });
      expect(response.status).toBe(200);

      const followers = h.hub.list();
      expect(followers).toHaveLength(1);
      expect(followers[0].id).toBe("worker-sha");
      expect(followers[0].commitSha).toBe("1234567890abcdef1234567890abcdef12345678");
      expect(followers[0].protocolVersion).toBe(INSTANCE_PROTOCOL_VERSION);
      expect(followers[0].updateStatus).toBeUndefined();
    });

    it("fences update against disconnected follower or mismatched protocol version", async () => {
      const h = await setup();
      await h.register("worker-fence");

      expect(() =>
        h.hub.updateFollower("unknown", { targetSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" })
      ).toThrow("Follower unknown is not connected");

      expect(() =>
        h.hub.updateFollower("worker-fence", {
          protocolVersion: INSTANCE_PROTOCOL_VERSION + 1,
        })
      ).toThrow("Incompatible follower protocol version");

      expect(() => h.hub.updateFollower("worker-fence", { targetSha: "abcdef0" })).toThrow(
        "Invalid target SHA"
      );
      expect(() => h.hub.updateFollower("worker-fence", { branch: "--upload-pack=bad" })).toThrow(
        "Invalid update branch"
      );
    });

    it("triggers authenticated update via HTTP and delivers update command via /poll", async () => {
      const h = await setup();
      const identity = await h.register("worker-update");

      // Unauthenticated request fails
      const unauth = await fetch(`${h.origin}/followers/worker-update/update`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ targetSha: "1111111111111111111111111111111111111111" }),
      });
      expect(unauth.status).toBe(401);

      // Authenticated POST triggers update
      const updateRes = await h.post("/followers/worker-update/update", {
        targetSha: "1111111111111111111111111111111111111111",
        branch: "staging",
      });
      expect(updateRes.status).toBe(200);
      const updateJson = (await updateRes.json()) as {
        ok: boolean;
        update: { updateId: string; status: string };
      };
      expect(updateJson.ok).toBe(true);
      expect(updateJson.update.status).toBe("pending");

      // GET update status
      const getRes = await h.get("/followers/worker-update/update");
      expect(getRes.status).toBe(200);
      const getJson = (await getRes.json()) as {
        followerId: string;
        updateStatus: { updateId: string };
      };
      expect(getJson.followerId).toBe("worker-update");
      expect(getJson.updateStatus.updateId).toBe(updateJson.update.updateId);
      // Poll delivers the update command
      const pollRes = await h.post("/poll", identity);
      expect(pollRes.status).toBe(200);
      const commands = (await pollRes.json()) as Array<{
        type: string;
        updateId: string;
        targetSha?: string;
      }>;
      expect(commands).toHaveLength(1);
      expect(commands[0].type).toBe("update");
      expect(commands[0].updateId).toBe(updateJson.update.updateId);
      expect(commands[0].targetSha).toBe("1111111111111111111111111111111111111111");

      // Follower posts $instance status event back
      await h.post("/events", {
        ...identity,
        batchId: "status-batch",
        events: [
          {
            eventId: "status-event-1",
            actorId: "$instance",
            message: {
              type: "update_status",
              updateId: updateJson.update.updateId,
              status: "building",
              step: "build",
              oldSha: "0000000000000000000000000000000000000000",
              newSha: "1111111111111111111111111111111111111111",
            },
          },
        ],
      });

      const updatedInfo = h.hub.list().find((f) => f.id === "worker-update");
      expect(updatedInfo?.updateStatus?.status).toBe("building");
      expect(updatedInfo?.updateStatus?.step).toBe("build");
    });

    it("waits for follower acceptance and ignores a stale status while an update is active", async () => {
      const h = await setup();
      const identity = await h.register("worker-acceptance");
      const acceptance = h.hub.updateAllFollowersAndWait(
        { targetSha: "1111111111111111111111111111111111111111" },
        1000
      );
      const commands = (await (await h.post("/poll", identity)).json()) as Array<{
        updateId: string;
      }>;
      expect(commands).toHaveLength(1);
      const updateId = commands[0].updateId;

      await h.post("/events", {
        ...identity,
        batchId: "acceptance-status",
        events: [
          {
            eventId: "acceptance-status-event",
            actorId: "$instance",
            message: { type: "update_status", updateId, status: "fetching", step: "pull" },
          },
        ],
      });
      await expect(acceptance).resolves.toBe(true);

      await h.post("/events", {
        ...identity,
        batchId: "stale-status",
        events: [
          {
            eventId: "stale-status-event",
            actorId: "$instance",
            message: {
              type: "update_status",
              updateId: "older-update",
              status: "failed",
              error: "late event",
            },
          },
        ],
      });
      expect(h.hub.getFollowerUpdateStatus("worker-acceptance")).toMatchObject({
        updateId,
        status: "fetching",
      });
    });
  });
});
