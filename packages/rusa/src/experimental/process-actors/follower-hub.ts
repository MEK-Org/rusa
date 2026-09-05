import { randomBytes, timingSafeEqual } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  createServer,
  type IncomingMessage,
  request as proxyRequest,
  type ServerResponse,
} from "node:http";
import type { McpServerSpec } from "../../providers/types.js";
import type { ActorHost } from "./actor-host.js";
import type { ChildMessage, ParentMessage } from "./protocol.js";

export interface FollowerCommand {
  actorId: string;
  message: ParentMessage | { type: "kill" };
}
export interface FollowerEvent {
  actorId: string;
  message: ChildMessage | { type: "exit"; code: number | null; signal: NodeJS.Signals | null };
}
interface Follower {
  id: string;
  session: string;
  platform: string;
  pid: number;
  seen: number;
  commands: FollowerCommand[];
  poll?: ServerResponse;
  pollTimer?: ReturnType<typeof setTimeout>;
  hosts: Map<string, FollowerActorHost>;
}

class FollowerActorHost extends EventEmitter implements ActorHost {
  get nodeId(): string {
    return this.followerId;
  }
  pid?: number;
  connected = true;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  constructor(
    readonly followerId: string,
    private readonly enqueue: (message: FollowerCommand["message"]) => void
  ) {
    super();
  }
  send(message: ParentMessage, callback: (error: Error | null) => void): boolean {
    if (!this.connected) {
      callback(new Error("Follower actor disconnected"));
      return false;
    }
    this.enqueue(message);
    callback(null);
    return true;
  }
  kill(): boolean {
    if (!this.connected) return false;
    this.enqueue({ type: "kill" });
    return true;
  }
  receive(message: FollowerEvent["message"]): void {
    if (!this.connected) return;
    if (message.type === "ready") this.pid = message.pid;
    if (message.type === "exit") {
      this.connected = false;
      this.exitCode = message.code;
      this.signalCode = message.signal;
      this.emit("exit", message.code, message.signal);
    } else this.emit("message", message);
  }
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 8 * 1024 * 1024) throw new Error("Request too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString());
}
function reply(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
}

/** One authoritative leader, persistent followers, multiple actor hosts per follower.
 * HTTP is restricted to a tailnet/loopback bind. Tailscale supplies link encryption.
 * Control requests use an enrollment secret; MCP URLs are per-actor capabilities.
 */
export class FollowerHub {
  private followers = new Map<string, Follower>();
  private routes = new Map<string, { followerId: string; actorId: string; target: string }>();
  private sweep = setInterval(() => {
    for (const follower of this.followers.values()) {
      if (Date.now() - follower.seen > 45_000) this.drop(follower);
    }
  }, 5000);
  private server = createServer((req, res) => {
    void this.handle(req, res).catch((error) => {
      if (!res.headersSent) reply(res, 400, { error: String(error) });
      else res.destroy();
    });
  });
  private origin = "";
  constructor(private readonly token: string) {
    if (token.length < 32) throw new Error("Follower token must be at least 32 characters");
    this.sweep.unref();
  }
  async listen(host: string, port: number): Promise<string> {
    // Never accidentally expose the prototype on every public interface.
    if (host !== "127.0.0.1" && !/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d+\.\d+$/.test(host)) {
      throw new Error("Bind the follower gateway to loopback or a Tailscale IPv4 address");
    }
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(port, host, () => {
        this.server.off("error", reject);
        resolve();
      });
    });
    const address = this.server.address();
    if (!address || typeof address === "string") throw new Error("No gateway address");
    this.origin = `http://${host}:${address.port}`;
    return this.origin;
  }
  list() {
    return [...this.followers.values()].map((f) => ({
      id: f.id,
      platform: f.platform,
      pid: f.pid,
      actors: [...f.hosts.keys()],
      lastSeen: new Date(f.seen).toISOString(),
    }));
  }
  createHost(followerId: string, actorId: string): ActorHost {
    const follower = this.followers.get(followerId);
    if (!follower) throw new Error(`Follower ${followerId} is not connected`);
    if (follower.hosts.has(actorId)) throw new Error("Actor already assigned");
    const host = new FollowerActorHost(followerId, (message) => {
      follower.commands.push({ actorId, message });
      this.flush(follower);
    });
    follower.hosts.set(actorId, host);
    host.once("exit", () => {
      follower.hosts.delete(actorId);
      for (const [key, route] of this.routes)
        if (route.actorId === actorId) this.routes.delete(key);
    });
    return host;
  }
  toolUrls(followerId: string, actorId: string, specs: McpServerSpec[]): McpServerSpec[] {
    return specs.map((spec) => {
      const url = new URL(spec.url);
      if (url.hostname !== "127.0.0.1" || !url.pathname.startsWith("/mcp/")) {
        throw new Error("Only leader-owned loopback MCP endpoints may be forwarded");
      }
      let key = [...this.routes].find(
        ([, route]) => route.actorId === actorId && route.target === spec.url
      )?.[0];
      if (!key) {
        key = randomBytes(32).toString("hex");
        this.routes.set(key, { followerId, actorId, target: spec.url });
      }
      return { name: spec.name, url: `${this.origin}/mcp/${key}` };
    });
  }
  async close(): Promise<void> {
    clearInterval(this.sweep);
    for (const follower of this.followers.values()) this.drop(follower);
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
  private drop(follower: Follower): void {
    clearTimeout(follower.pollTimer);
    if (follower.poll) reply(follower.poll, 410, { error: "Follower disconnected" });
    this.followers.delete(follower.id);
    for (const host of [...follower.hosts.values()])
      host.receive({ type: "exit", code: -1, signal: null });
  }
  private flush(follower: Follower): void {
    if (!follower.poll || !follower.commands.length) return;
    clearTimeout(follower.pollTimer);
    reply(follower.poll, 200, follower.commands.splice(0));
    follower.poll = undefined;
  }
  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    if (path.startsWith("/mcp/")) {
      const route = this.routes.get(path.slice(5));
      if (!route || !this.followers.get(route.followerId)?.hosts.has(route.actorId)) {
        reply(res, 404, { error: "Unknown actor tool" });
        return;
      }
      const target = new URL(route.target);
      const headers = { ...req.headers, host: target.host };
      delete headers.authorization;
      delete headers.origin;
      const upstream = proxyRequest(target, { method: req.method, headers }, (incoming) => {
        res.writeHead(incoming.statusCode ?? 502, incoming.headers);
        incoming.pipe(res);
      });
      upstream.on("error", () => {
        if (!res.headersSent) reply(res, 502, { error: "Leader MCP unavailable" });
        else res.destroy();
      });
      res.on("close", () => upstream.destroy());
      req.pipe(upstream);
      return;
    }
    const auth = Buffer.from(req.headers.authorization ?? "");
    const expected = Buffer.from(`Bearer ${this.token}`);
    if (auth.length !== expected.length || !timingSafeEqual(auth, expected)) {
      reply(res, 401, { error: "Unauthorized" });
      return;
    }
    if (req.method === "GET" && path === "/followers") {
      reply(res, 200, this.list());
      return;
    }
    if (req.method !== "POST") {
      reply(res, 404, {});
      return;
    }
    const body = (await readJson(req)) as Record<string, unknown>;
    if (path === "/register") {
      if (
        typeof body.id !== "string" ||
        !/^[a-zA-Z0-9_-]{1,64}$/.test(body.id) ||
        typeof body.platform !== "string" ||
        typeof body.pid !== "number"
      ) {
        throw new Error("Invalid follower identity");
      }
      if (this.followers.has(body.id)) {
        reply(res, 409, { error: "Follower already connected" });
        return;
      }
      const follower: Follower = {
        id: body.id,
        session: randomBytes(32).toString("hex"),
        platform: body.platform,
        pid: body.pid,
        seen: Date.now(),
        commands: [],
        hosts: new Map(),
      };
      this.followers.set(follower.id, follower);
      reply(res, 200, { session: follower.session });
      return;
    }
    const follower = typeof body.id === "string" ? this.followers.get(body.id) : undefined;
    if (!follower || body.session !== follower.session) {
      reply(res, 410, { error: "Session expired" });
      return;
    }
    follower.seen = Date.now();
    if (path === "/unregister") {
      this.drop(follower);
      reply(res, 200, {});
      return;
    }
    if (path === "/poll") {
      if (follower.poll) {
        reply(res, 409, { error: "Poll already pending" });
        return;
      }
      follower.poll = res;
      res.on("close", () => {
        if (follower.poll === res) follower.poll = undefined;
      });
      follower.pollTimer = setTimeout(() => {
        if (follower.poll === res) {
          reply(res, 200, []);
          follower.poll = undefined;
        }
      }, 20_000);
      this.flush(follower);
      return;
    }
    if (path === "/events") {
      const events = body.events as FollowerEvent[];
      if (!Array.isArray(events) || events.length > 1000) throw new Error("Invalid events");
      for (const event of events) {
        if (
          !event ||
          typeof event.actorId !== "string" ||
          !event.message ||
          typeof event.message.type !== "string"
        )
          throw new Error("Invalid event");
        follower.hosts.get(event.actorId)?.receive(event.message);
      }
      reply(res, 200, {});
      return;
    }
    reply(res, 404, {});
  }
}
