import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  request as proxyRequest,
  type ServerResponse,
} from "node:http";
import { type Logger, nullLogger } from "../observability/logger.js";
import type { McpServerSpec } from "../providers/types.js";
import type { ActorChannel } from "./actor-channel.js";
import { EventTransferReceiver, type EventTransferStep } from "./follower-event-transfer.js";
import {
  FollowerUpdateReconciler,
  type ReconciliationStatus,
} from "./follower-update-reconciler.js";
import type { FollowerUpdateTriggerStore } from "./follower-update-trigger-store.js";
import { isFullCommitSha, isSafeFollowerBranch } from "./follower-update-validation.js";
import type {
  ActorEvent,
  FollowerUpdateCommand,
  FollowerUpdateStatus,
  FollowerUpdateStatusEvent,
  LeaderCommand,
} from "./protocol.js";
import {
  FOLLOWER_HTTP_BODY_LIMIT_BYTES,
  INSTANCE_PROTOCOL_VERSION,
  OLDEST_FOLLOWER_PROTOCOL_VERSION,
} from "./protocol.js";
import { FollowerDedupeTracker, RemoteInstance } from "./remote-instance.js";
import { isSafeFollowerBind } from "./safe-bind.js";

export interface FollowerInfo {
  id: string;
  platform: string;
  pid: number;
  actors: string[];
  lastSeen: string;
  commitSha?: string;
  protocolVersion?: number;
  updateStatus?: FollowerUpdateStatus;
}

export interface FollowerActorCommand {
  actorId: string;
  message: LeaderCommand;
}

export type FollowerCommand = FollowerActorCommand | FollowerUpdateCommand;

export interface FollowerEvent {
  eventId: string;
  actorId: string;
  message:
    | ActorEvent
    | { type: "exit"; code: number | null; signal: NodeJS.Signals | null }
    | FollowerUpdateStatusEvent;
}

export interface FollowerHubOptions {
  logger?: Logger;
  triggerStore?: FollowerUpdateTriggerStore;
  /** Replaces the default event-transfer receiver and its limits; for tests. */
  eventTransfers?: EventTransferReceiver;
}

function isFollowerEvent(event: unknown): event is FollowerEvent {
  const candidate = event as FollowerEvent | null;
  return (
    !!candidate &&
    typeof candidate.eventId === "string" &&
    !!candidate.eventId.trim() &&
    typeof candidate.actorId === "string" &&
    !!candidate.message &&
    typeof candidate.message.type === "string"
  );
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > FOLLOWER_HTTP_BODY_LIMIT_BYTES) throw new Error("Request too large");
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
  private static readonly STALE_AFTER_MS = 45_000;
  private readonly log: Logger;
  private readonly dedupeTrackers = new Map<string, FollowerDedupeTracker>();
  private readonly eventTransfers: EventTransferReceiver;
  private transferReads = 0;
  /** Followers for which the current lapsed-contact interval has been reported. */
  private readonly staleFollowerIds = new Set<string>();
  /** Generations that a confirmed replacement made permanently stale. */
  private readonly supersededGenerations = new Map<string, Set<string>>();
  private followers = new Map<string, RemoteInstance>();
  private routes = new Map<string, { followerId: string; actorId: string; target: string }>();
  private onRegisterListeners: ((follower: RemoteInstance) => void)[] = [];
  private onUpdateStatusListeners: ((followerId: string, status: FollowerUpdateStatus) => void)[] =
    [];
  readonly triggerStore?: FollowerUpdateTriggerStore;
  readonly reconciler?: FollowerUpdateReconciler;
  private sweep = setInterval(() => this.sweepFollowers(), 5000);
  private sweepFollowers(): void {
    const now = Date.now();
    // Contact age is advisory. It gates new dispatch but does not prove that a
    // follower process or any in-flight provider run has ended.
    for (const follower of this.followers.values()) {
      if (
        now - follower.seen > FollowerHub.STALE_AFTER_MS &&
        !this.staleFollowerIds.has(follower.id)
      ) {
        this.staleFollowerIds.add(follower.id);
        this.log.warn("follower_contact_stale", {
          followerId: follower.id,
          lastSeen: new Date(follower.seen).toISOString(),
        });
      }
    }
    for (const followerId of this.eventTransfers.sweep()) {
      this.log.warn("follower_event_transfer_expired", { followerId });
    }
    for (const [id, tracker] of this.dedupeTrackers) {
      if (!this.followers.has(id) && now - tracker.lastSeen > 3600_000) {
        this.dedupeTrackers.delete(id);
      }
    }
  }
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
    this.eventTransfers = opts?.eventTransfers ?? new EventTransferReceiver();
    this.triggerStore = opts?.triggerStore;
    if (this.triggerStore) {
      this.reconciler = new FollowerUpdateReconciler(this.triggerStore, this, {
        logger: this.log,
      });
    }
  }

  onRegister(callback: (follower: RemoteInstance) => void): () => void {
    this.onRegisterListeners.push(callback);
    return () => {
      const idx = this.onRegisterListeners.indexOf(callback);
      if (idx >= 0) this.onRegisterListeners.splice(idx, 1);
    };
  }

  onUpdateStatus(callback: (followerId: string, status: FollowerUpdateStatus) => void): () => void {
    this.onUpdateStatusListeners.push(callback);
    return () => {
      const idx = this.onUpdateStatusListeners.indexOf(callback);
      if (idx >= 0) this.onUpdateStatusListeners.splice(idx, 1);
    };
  }

  /** Single source for reconciliation state; the reconciler owns the shape. */
  getReconciliationStatus(): ReconciliationStatus {
    return (
      this.reconciler?.getStatus() ?? {
        state: "none",
        activeTrigger: null,
        allConnectedCurrent: false,
        armed: false,
      }
    );
  }

  /** Permit automatic reconciliation; the leader calls this once boot has completed. */
  armReconciliation(): void {
    this.reconciler?.arm();
  }
  async listen(host: string, port: number): Promise<string> {
    // Never accidentally expose the follower gateway on every public interface.
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
      commitSha: f.commitSha,
      protocolVersion: f.protocolVersion,
      updateStatus: f.updateStatus,
    }));
  }
  updateFollower(
    followerId: string,
    options?: { targetSha?: string; branch?: string }
  ): FollowerUpdateStatus {
    const follower = this.followers.get(followerId);
    if (!follower) throw new Error(`Follower ${followerId} is not connected`);
    follower.assertDispatchable();
    if (follower.isUpdateInProgress()) {
      throw new Error(`Follower ${followerId} already has an update in progress`);
    }
    if (options?.targetSha !== undefined && !isFullCommitSha(options.targetSha)) {
      throw new Error("Invalid target SHA");
    }
    if (options?.branch !== undefined && !isSafeFollowerBranch(options.branch)) {
      throw new Error("Invalid update branch");
    }
    const updateId = randomBytes(16).toString("hex");
    const status: FollowerUpdateStatus = {
      updateId,
      status: "pending",
      newSha: options?.targetSha,
      timestamp: new Date().toISOString(),
    };
    follower.setUpdateStatus(status);
    follower.enqueueUpdate({
      type: "update",
      updateId,
      targetSha: options?.targetSha,
      branch: options?.branch,
    });
    this.log.info("follower_update_triggered", {
      followerId,
      updateId,
      targetSha: options?.targetSha,
      branch: options?.branch,
    });
    for (const listener of this.onUpdateStatusListeners) {
      try {
        listener(followerId, status);
      } catch (err) {
        this.log.warn("follower_update_status_listener_error", { followerId, err });
      }
    }
    return status;
  }
  updateAllFollowers(options?: { targetSha?: string; branch?: string }): FollowerUpdateStatus[] {
    const statuses: FollowerUpdateStatus[] = [];
    for (const followerId of this.followers.keys()) {
      try {
        statuses.push(this.updateFollower(followerId, options));
      } catch (err) {
        this.log.warn("follower_update_all_partial_failure", { followerId, err });
      }
    }
    return statuses;
  }
  getFollowerUpdateStatus(followerId: string): FollowerUpdateStatus | undefined {
    return this.followers.get(followerId)?.updateStatus;
  }
  createHost(followerId: string, actorId: string): ActorChannel {
    const follower = this.followers.get(followerId);
    if (!follower) throw new Error(`Follower ${followerId} is not connected`);
    follower.assertDispatchable();
    const host = follower.createHost(actorId);
    host.once("exit", () => {
      for (const [key, route] of this.routes)
        if (route.actorId === actorId) this.routes.delete(key);
    });
    return host;
  }
  /** Reattach a persisted leader actor to the same follower process generation. */
  rebindHost(followerId: string, actorId: string): ActorChannel {
    const follower = this.followers.get(followerId);
    if (!follower) throw new Error(`Follower ${followerId} is not connected`);
    const host = follower.rebindHost(actorId);
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
    this.reconciler?.close();
    for (const follower of this.followers.values()) this.drop(follower);
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
  private drop(follower: RemoteInstance): void {
    this.followers.delete(follower.id);
    this.staleFollowerIds.delete(follower.id);
    this.eventTransfers.discard(follower.id);
    follower.close();
    this.log.info("follower_disconnected", {
      followerId: follower.id,
      platform: follower.platform,
      pid: follower.pid,
    });
  }

  private supersedeGeneration(follower: RemoteInstance): void {
    let generations = this.supersededGenerations.get(follower.id);
    if (!generations) {
      generations = new Set();
      this.supersededGenerations.set(follower.id, generations);
    }
    generations.add(follower.generation);
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
    if (req.method === "GET" && path === "/followers/reconciliation") {
      reply(res, 200, { ok: true, reconciliation: this.getReconciliationStatus() });
      return;
    }
    if (req.method === "GET" && path.startsWith("/followers/") && path.endsWith("/update")) {
      const followerId = path.slice("/followers/".length, -"/update".length);
      const status = this.getFollowerUpdateStatus(followerId);
      if (!status && !this.followers.has(followerId)) {
        reply(res, 404, { error: `Follower ${followerId} not found` });
        return;
      }
      reply(res, 200, { followerId, updateStatus: status ?? null });
      return;
    }
    if (req.method !== "POST") {
      reply(res, 404, {});
      return;
    }
    // Each transfer request buffers up to a whole body before the receiver
    // can apply its own limits, so bound how many are read at once.
    const transferRead = path === "/events/transfer";
    if (transferRead && this.transferReads >= this.eventTransfers.maxTransfers) {
      reply(res, 429, { status: "busy", reason: "capacity" });
      return;
    }
    if (transferRead) this.transferReads++;
    let body: Record<string, unknown>;
    try {
      body = (await readJson(req)) as Record<string, unknown>;
    } finally {
      if (transferRead) this.transferReads--;
    }
    if (path.startsWith("/followers/") && path.endsWith("/update")) {
      const followerId = path.slice("/followers/".length, -"/update".length);
      try {
        const status = this.updateFollower(followerId, {
          targetSha: typeof body.targetSha === "string" ? body.targetSha : undefined,
          branch: typeof body.branch === "string" ? body.branch : undefined,
        });
        reply(res, 200, { ok: true, followerId, update: status });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const statusCode = message.includes("not connected") ? 404 : 400;
        reply(res, statusCode, { error: message });
      }
      return;
    }
    if (path === "/followers/update-all") {
      const statuses = this.updateAllFollowers({
        targetSha: typeof body.targetSha === "string" ? body.targetSha : undefined,
        branch: typeof body.branch === "string" ? body.branch : undefined,
      });
      reply(res, 200, { ok: true, updates: statuses });
      return;
    }
    if (path === "/register") {
      // Every refusal past authentication and JSON parsing is logged: a follower
      // the hub never registers is otherwise invisible, and a stuck rollout looks
      // like silence. A 401 or unparseable body is not: it carries no identity the
      // hub can trust, and logging it would let any caller write to this log. The
      // follower's own registration-failure log covers those.
      const rejectRegistration = (reason: string, extra: Record<string, unknown> = {}): void => {
        this.log.warn("follower_register_rejected", {
          reason,
          followerId: body.id,
          protocolVersion: body.protocolVersion,
          commitSha: body.commitSha,
          ...extra,
        });
      };
      // The session speaks the follower's protocol, which the reply echoes: a
      // follower accepts only its own version back.
      const protocolVersion = body.protocolVersion;
      if (
        protocolVersion !== INSTANCE_PROTOCOL_VERSION &&
        protocolVersion !== OLDEST_FOLLOWER_PROTOCOL_VERSION
      ) {
        rejectRegistration("incompatible_protocol", {
          supportedProtocolVersions: [OLDEST_FOLLOWER_PROTOCOL_VERSION, INSTANCE_PROTOCOL_VERSION],
        });
        reply(res, 409, { error: "Incompatible instance protocol; rebuild leader and follower" });
        return;
      }
      if (
        typeof body.id !== "string" ||
        !/^[a-zA-Z0-9_-]{1,64}$/.test(body.id) ||
        typeof body.platform !== "string" ||
        typeof body.pid !== "number" ||
        typeof body.generation !== "string" ||
        !/^[a-zA-Z0-9_-]{1,128}$/.test(body.generation)
      ) {
        rejectRegistration("invalid_identity");
        throw new Error("Invalid follower identity");
      }
      const existing = this.followers.get(body.id);
      const superseded = this.supersededGenerations.get(body.id);
      if (superseded?.has(body.generation)) {
        // An older process must never reclaim this ID, even after its newer
        // replacement has stopped; its session and any queued work are stale.
        rejectRegistration("superseded_generation");
        reply(res, 409, { error: "Follower generation was superseded" });
        return;
      }
      if (existing) {
        if (existing.generation === body.generation) {
          existing.renewSession();
          this.staleFollowerIds.delete(existing.id);
          this.log.info("follower_reconnected", {
            followerId: existing.id,
            generation: existing.generation,
          });
          for (const listener of this.onRegisterListeners) {
            try {
              listener(existing);
            } catch (err) {
              this.log.warn("follower_register_listener_error", { followerId: existing.id, err });
            }
          }
          reply(res, 200, {
            session: existing.session,
            protocolVersion: existing.protocolVersion,
            leaderToken: this.leaderToken,
            eventTransfer: this.eventTransfers.capability,
          });
          return;
        }
        // The enrollment secret authenticates both requests; generation proves
        // this is a new process and is the only transport event that ends old work.
        this.supersedeGeneration(existing);
        this.drop(existing);
      }
      const commitSha =
        typeof body.commitSha === "string" && isFullCommitSha(body.commitSha)
          ? body.commitSha
          : undefined;
      const tracker = this.getDedupeTracker(body.id);
      const follower = new RemoteInstance(
        body.id,
        body.platform,
        body.pid,
        tracker,
        commitSha,
        protocolVersion,
        body.generation,
        FollowerHub.STALE_AFTER_MS
      );
      this.followers.set(follower.id, follower);
      this.staleFollowerIds.delete(follower.id);
      this.log.info("follower_connected", {
        followerId: follower.id,
        platform: follower.platform,
        pid: follower.pid,
        commitSha: follower.commitSha,
        protocolVersion: follower.protocolVersion,
      });
      for (const listener of this.onRegisterListeners) {
        try {
          listener(follower);
        } catch (err) {
          this.log.warn("follower_register_listener_error", { followerId: follower.id, err });
        }
      }
      reply(res, 200, {
        session: follower.session,
        protocolVersion,
        leaderToken: this.leaderToken,
        eventTransfer: this.eventTransfers.capability,
      });
      return;
    }
    const follower = typeof body.id === "string" ? this.followers.get(body.id) : undefined;
    if (!follower || body.session !== follower.session) {
      reply(res, 410, { error: "Session expired" });
      return;
    }
    follower.seen = Date.now();
    this.staleFollowerIds.delete(follower.id);
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
        if (!isFollowerEvent(event)) {
          reply(res, 400, { error: "Invalid event shape or missing eventId" });
          return;
        }
        if (!this.acceptEvent(follower, event)) {
          reply(res, 409, {
            status: "refused",
            reason: "acceptance_failed",
            eventId: event.eventId,
          });
          return;
        }
      }
      follower.recordBatch(batchId);
      reply(res, 200, {});
      return;
    }
    if (path === "/events/transfer") {
      const step = this.eventTransfers.accept(follower.id, follower.generation, body, (eventId) =>
        follower.eventOutcome(eventId)
      );
      if (!("bytes" in step)) {
        this.logTransferStep(follower.id, body, step);
        reply(res, step.httpStatus, step.reply);
        return;
      }
      let event: unknown;
      try {
        event = JSON.parse(step.bytes.toString("utf8"));
      } catch {}
      if (!isFollowerEvent(event) || event.eventId !== step.eventId) {
        const refusal: EventTransferStep = {
          httpStatus: 422,
          reply: { status: "refused", reason: "invalid_event" },
        };
        this.logTransferStep(follower.id, body, refusal);
        reply(res, refusal.httpStatus, refusal.reply);
        return;
      }
      // The reassembled event takes the same acceptance path as an ordinary batch.
      if (!this.acceptEvent(follower, event)) {
        reply(res, 409, { status: "refused", reason: "acceptance_failed" });
        return;
      }
      this.log.info("follower_event_transfer_completed", {
        followerId: follower.id,
        eventId: event.eventId,
        eventType: event.message.type,
        totalBytes: step.bytes.length,
      });
      reply(res, 200, { status: "complete" });
      return;
    }
    reply(res, 404, {});
  }

  private acceptEvent(follower: RemoteInstance, event: FollowerEvent): boolean {
    const outcome = follower.eventOutcome(event.eventId);
    if (outcome) return outcome === "accepted";
    // Fence before invoking synchronous listeners: an earlier listener may
    // have performed a side effect before a later listener throws.
    follower.recordEvent(event.eventId, "failed");
    try {
      follower.receive(event);
    } catch {
      this.log.warn("follower_event_acceptance_failed", {
        followerId: follower.id,
        eventId: event.eventId,
        eventType: event.message.type,
      });
      return false;
    }
    follower.recordEvent(event.eventId, "accepted");
    if (event.actorId === "$instance" && event.message?.type === "update_status") {
      const status = follower.updateStatus;
      if (status) {
        for (const listener of this.onUpdateStatusListeners) {
          try {
            listener(follower.id, status);
          } catch (err) {
            this.log.warn("follower_update_status_listener_error", {
              followerId: follower.id,
              err,
            });
          }
        }
      }
    }
    return true;
  }

  /** Content-free: identities, sizes and limits only, never fragment data. */
  private logTransferStep(
    followerId: string,
    body: Record<string, unknown>,
    step: Extract<EventTransferStep, { reply: unknown }>
  ): void {
    if (step.reply.status === "fragment" || step.reply.status === "complete") return;
    this.log.warn("follower_event_transfer_not_accepted", {
      followerId,
      transferId: typeof body.transferId === "string" ? body.transferId.slice(0, 128) : undefined,
      eventId: typeof body.eventId === "string" ? body.eventId.slice(0, 256) : undefined,
      totalBytes: typeof body.totalBytes === "number" ? body.totalBytes : undefined,
      index: typeof body.index === "number" ? body.index : undefined,
      ...step.reply,
      ...this.eventTransfers.usage,
    });
  }
}
