import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
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
  const register = async (id: string) => {
    const response = await post("/register", {
      id,
      platform: "darwin",
      pid: 123,
      protocolVersion: INSTANCE_PROTOCOL_VERSION,
    });
    expect(response.status).toBe(200);
    return { id, ...((await response.json()) as { session: string }) };
  };
  return { hub, origin, post, register };
}

describe("leader follower gateway", () => {
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
      events: [{ actorId: "a", message: { type: "ready", pid: 999 } }],
    });
    expect(received).toEqual([]);
    expect(a.pid).toBe(123);
    await h.post("/events", {
      ...identity,
      events: [{ actorId: "a", message: { type: "ready", pid: 123 } }],
    });
    expect(received).toEqual([{ type: "ready", pid: 123 }]);
    const exited = once(a, "exit");
    await h.post("/events", {
      ...identity,
      events: [{ actorId: "a", message: { type: "exit", code: 0, signal: null } }],
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
        events: [{ actorId: "a", message: { type: "exit", code: 0, signal: null } }],
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
});
