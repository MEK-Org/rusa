import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  request as proxyRequest,
  type ServerResponse,
} from "node:http";
import { type Logger, nullLogger } from "../../observability/logger.js";
import type { McpServerSpec } from "../../providers/types.js";
import type { ActorChannel } from "./actor-channel.js";
import type { ActorEvent, LeaderCommand } from "./protocol.js";
import { INSTANCE_PROTOCOL_VERSION } from "./protocol.js";
import { FollowerDedupeTracker, RemoteInstance } from "./remote-instance.js";
import { isSafeFollowerBind } from "./safe-bind.js";

export interface FollowerInfo {
  id: string;
  platform: string;
  pid: number;
  actors: string[];
  lastSeen: string;
}

export interface FollowerCommand {
  actorId: string;
  message: LeaderCommand;
}
export interface FollowerEvent {
  eventId: string;
  actorId: string;
  message: ActorEvent | { type: "exit"; code: number | null; signal: NodeJS.Signals | null };
}

export interface FollowerHubOptions {
  logger?: Logger;
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
  readonly leaderToken = randomBytes(16).toString("hex");
  private static readonly MAX_TRACKED_FOLLOWERS = 128;
  private readonly log: Logger;
  private readonly dedupeTrackers = new Map<string, FollowerDedupeTracker>();
  private followers = new Map<string, RemoteInstance>();
  private routes = new Map<string, { followerId: string; actorId: string; target: string }>();
  private onRegisterCallback?: (follower: RemoteInstance) => void;
  private sweep = setInterval(() => {
    const now = Date.now();
    for (const follower of this.followers.values()) {
      if (now - follower.seen > 45_000) this.drop(follower, "expired");
    }
    for (const [id, tracker] of this.dedupeTrackers) {
      if (!this.followers.has(id) && now - tracker.lastSeen > 3600_000) {
        this.dedupeTrackers.delete(id);
      }
    }
  }, 5000);
  private server = createServer((req, res) => {
    void this.handle(req, res).catch((error) => {
      if (!res.headersSent) reply(res, 400, { error: String(error) });
      else res.destroy();
    });
  });
  private origin = "";
  constructor(
    private readonly token: string,
    opts?: FollowerHubOptions
  ) {
    if (token.length < 32) throw new Error("Follower token must be at least 32 characters");
    this.log = (opts?.logger ?? nullLogger).child({ component: "follower-gateway" });
    this.sweep.unref();
  }

  onRegister(callback: (follower: RemoteInstance) => void): void {
    this.onRegisterCallback = callback;
  }
  async listen(host: string, port: number): Promise<string> {
    // Never accidentally expose the prototype on every public interface.
    if (!isSafeFollowerBind(host)) {
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
  list(): FollowerInfo[] {
    return [...this.followers.values()].map((f) => ({
      id: f.id,
      platform: f.platform,
      pid: f.pid,
      actors: [...f.hosts.keys()],
      lastSeen: new Date(f.seen).toISOString(),
    }));
  }
  createHost(followerId: string, actorId: string): ActorChannel {
    const follower = this.followers.get(followerId);
    if (!follower) throw new Error(`Follower ${followerId} is not connected`);
    const host = follower.createHost(actorId);
    host.once("exit", () => {
      for (const [key, route] of this.routes)
        if (route.actorId === actorId) this.routes.delete(key);
    });
    return host;
  }
  stopActor(followerId: string, actorId: string): void {
    const follower = this.followers.get(followerId);
    if (!follower) return;
    follower.stopActor(actorId);
    for (const [key, route] of this.routes) {
      if (route.actorId === actorId) this.routes.delete(key);
    }
  }
  /**
   * The actor's whole capability set, as a set of bearer URLs.
   *
   * This is a reconciliation, not an accumulation: a spec still present keeps
   * its URL, and a spec that has left the snapshot loses its route here — while
   * the actor is still running. Revoking only at `exit` would leave a follower
   * that cached the old URL able to reach a capability the leader has already
   * taken away.
   */
  toolUrls(followerId: string, actorId: string, specs: McpServerSpec[]): McpServerSpec[] {
    const live = new Set<string>();
    const urls = specs.map((spec) => {
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
      live.add(key);
      return { name: spec.name, url: `${this.origin}/mcp/${key}` };
    });
    // Only this actor's routes; a sibling's capabilities are not this snapshot's
    // business. A rejected spec threw above, so no partial set is reconciled.
    for (const [key, route] of this.routes)
      if (route.actorId === actorId && !live.has(key)) this.routes.delete(key);
    return urls;
  }
  async close(): Promise<void> {
    clearInterval(this.sweep);
    for (const follower of this.followers.values()) this.drop(follower);
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
  private drop(
    follower: RemoteInstance,
    reason: "disconnected" | "expired" = "disconnected"
  ): void {
    this.followers.delete(follower.id);
    follower.close();
    if (reason === "expired") {
      this.log.warn("follower_expired", {
        followerId: follower.id,
        lastSeen: new Date(follower.seen).toISOString(),
      });
    } else {
      this.log.info("follower_disconnected", {
        followerId: follower.id,
        platform: follower.platform,
        pid: follower.pid,
      });
    }
  }

  private getDedupeTracker(followerId: string): FollowerDedupeTracker {
    let tracker = this.dedupeTrackers.get(followerId);
    if (tracker) {
      this.dedupeTrackers.delete(followerId);
      this.dedupeTrackers.set(followerId, tracker);
      tracker.touch();
      return tracker;
    }
    if (this.dedupeTrackers.size >= FollowerHub.MAX_TRACKED_FOLLOWERS) {
      const oldestKey = this.dedupeTrackers.keys().next().value;
      if (oldestKey) this.dedupeTrackers.delete(oldestKey);
    }
    tracker = new FollowerDedupeTracker();
    this.dedupeTrackers.set(followerId, tracker);
    return tracker;
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
      if (body.protocolVersion !== INSTANCE_PROTOCOL_VERSION) {
        reply(res, 409, { error: "Incompatible instance protocol; rebuild leader and follower" });
        return;
      }
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
      const tracker = this.getDedupeTracker(body.id);
      const follower = new RemoteInstance(body.id, body.platform, body.pid, tracker);
      this.followers.set(follower.id, follower);
      this.log.info("follower_connected", {
        followerId: follower.id,
        platform: follower.platform,
        pid: follower.pid,
      });
      this.onRegisterCallback?.(follower);
      reply(res, 200, {
        session: follower.session,
        protocolVersion: INSTANCE_PROTOCOL_VERSION,
        leaderToken: this.leaderToken,
      });
      return;
    }
    const follower = typeof body.id === "string" ? this.followers.get(body.id) : undefined;
    if (!follower || body.session !== follower.session) {
      reply(res, 410, { error: "Session expired" });
      return;
    }
    follower.seen = Date.now();
    if (path === "/unregister") {
      this.drop(follower, "disconnected");
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
      follower.flush();
      return;
    }
    if (path === "/events") {
      if (typeof body.batchId !== "string" || !body.batchId.trim()) {
        reply(res, 400, { error: "Missing or invalid batchId" });
        return;
      }
      const batchId = body.batchId.trim();
      if (follower.hasBatch(batchId)) {
        this.log.debug?.("follower_events_duplicate_batch_ignored", {
          followerId: follower.id,
          batchId,
        });
        reply(res, 200, {});
        return;
      }
      const events = body.events as FollowerEvent[];
      if (!Array.isArray(events) || events.length > 1000) {
        reply(res, 400, { error: "Invalid events" });
        return;
      }
      for (const event of events) {
        if (
          !event ||
          typeof event.eventId !== "string" ||
          !event.eventId.trim() ||
          typeof event.actorId !== "string" ||
          !event.message ||
          typeof event.message.type !== "string"
        ) {
          reply(res, 400, { error: "Invalid event shape or missing eventId" });
          return;
        }
        if (follower.hasEvent(event.eventId)) continue;
        follower.recordEvent(event.eventId);
        follower.receive(event);
      }
      follower.recordBatch(batchId);
      reply(res, 200, {});
      return;
    }
    reply(res, 404, {});
  }
}
