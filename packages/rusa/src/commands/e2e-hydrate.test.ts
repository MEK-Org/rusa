import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { runE2EHydrate } from "./e2e-hydrate.js";

interface TestServer {
  port: number;
  close: () => Promise<void>;
}

async function listen(
  handler: (req: IncomingMessage, res: ServerResponse, body: string) => void
): Promise<TestServer> {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => handler(req, res, body));
  });
  server.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  return {
    port: (server.address() as AddressInfo).port,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve()))
      ),
  };
}

function json(res: ServerResponse, body: unknown, status = 200): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

describe("dashboard E2E hydration", () => {
  const servers: TestServer[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
  });

  it("drives actors, messages, retirement, chat, and tracker through their HTTP fronts", async () => {
    const rootPosts: Array<{ path: string; body: unknown }> = [];
    const chatPosts: unknown[] = [];
    const trackerPosts: unknown[] = [];
    let actors = 0;

    const root = await listen((req, res, raw) => {
      const path = req.url ?? "";
      if (req.method === "GET" && path === "/options") return json(res, { providers: ["fake"] });
      if (req.method === "GET" && path.startsWith("/actors/")) {
        return json(res, { running: false, queued: false });
      }
      const body = raw ? JSON.parse(raw) : undefined;
      rootPosts.push({ path, body });
      if (path === "/actors") return json(res, { id: `actor-${++actors}` }, 201);
      return json(res, { ok: true });
    });
    const chat = await listen((_req, res, raw) => {
      chatPosts.push(JSON.parse(raw));
      json(res, { ok: true });
    });
    const tracker = await listen((_req, res, raw) => {
      trackerPosts.push(JSON.parse(raw));
      json(res, { number: 1 }, 201);
    });
    servers.push(root, chat, tracker);

    await runE2EHydrate({
      scenario: "dashboard-basic",
      rootControlPort: root.port,
      chatControlPort: chat.port,
      trackerPort: tracker.port,
    });

    const spawns = rootPosts.filter((call) => call.path === "/actors");
    const scripts = spawns.map((call) => {
      const charter = (call.body as { charter: string }).charter;
      return JSON.parse(charter.split("FAKE_PROVIDER_OUTPUT: ")[1]);
    });
    expect(spawns).toHaveLength(6);
    expect(rootPosts.some((call) => call.path.endsWith("/messages"))).toBe(true);
    expect(rootPosts.some((call) => call.path.endsWith("/retire"))).toBe(true);
    expect(
      scripts.some((script) =>
        script.toolCalls?.some(
          (call: { arguments?: { status?: string } }) => call.arguments?.status === "blocked"
        )
      )
    ).toBe(true);
    expect(scripts.some((script) => script.success === false)).toBe(true);
    expect(chatPosts).toEqual([{ text: "Can you help me with the dashboard?", dm: true }]);
    expect(trackerPosts).toEqual([
      { title: "Hydration Issue", body: "This is a synthetic issue created during hydration." },
    ]);
  });

  it("leaves a ready mesh untouched for the cold-start scenario", async () => {
    let mutations = 0;
    const root = await listen((req, res) => {
      if (req.method === "GET" && req.url === "/options") return json(res, {});
      mutations += 1;
      json(res, {});
    });
    servers.push(root);

    await runE2EHydrate({ scenario: "dashboard-empty", rootControlPort: root.port });

    expect(mutations).toBe(0);
  });
});
