import type { Logger } from "../observability/logger.js";

const WE_API = "https://workspaceevents.googleapis.com/v1";

/** Target the authenticated user's whole Chat surface (every space they're in). */
const CHAT_TARGET = "//chat.googleapis.com/spaces/-";
const MESSAGE_CREATED = "google.workspace.chat.message.v1.created";

/**
 * Max subscription lifetime when the payload carries the message resource
 * (`includeResource: true`) — Google caps Chat event subscriptions at 4h in that
 * mode (it's 7 days without the resource, but we need the text in-band, see
 * `normalize.ts`). We renew well inside this window.
 */
export const MAX_TTL_SECONDS = 4 * 3600;
const TTL = `${MAX_TTL_SECONDS}s`;

/** Renew at half the TTL → ~2h of slack before a missed tick would let it lapse. */
const DEFAULT_RENEW_INTERVAL_MS = (MAX_TTL_SECONDS / 2) * 1000;
const DEFAULT_RETRY_BACKOFF_MS = 5_000;
const DEFAULT_MAX_RETRY_BACKOFF_MS = 5 * 60_000;
const DEFAULT_ALERT_COOLDOWN_MS = 60 * 60_000;

interface WeSubscription {
  name?: string;
  state?: string;
  targetResource?: string;
  eventTypes?: string[];
  notificationEndpoint?: { pubsubTopic?: string };
  expireTime?: string;
}

export interface WorkspaceEventsLapseAlert {
  topic: string;
  subscriptionName: string | null;
  expectedTtlSeconds: number;
  elapsedSeconds: number;
  message: string;
}

export interface WorkspaceEventsSubscriberOptions {
  /** Full Pub/Sub topic resource the events should be delivered to: `projects/<p>/topics/<t>`. */
  topic: string;
  /** Mints a user-OAuth access token for the gchat user (scope `chat.messages`). */
  getToken: () => Promise<string>;
  /** Override the renewal cadence (default: half the 4h TTL). */
  renewIntervalMs?: number;
  log?: (msg: string) => void;
  /** Structured lifecycle logs; the legacy log callback remains for CLI output. */
  logger?: Logger;
  /** Injectable for tests; defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Expected subscription TTL in seconds. */
  expectedTtlSeconds?: number;
  /** Minimum time between repeated delivery-gap alerts. */
  alertCooldownMs?: number;
  /** Called for a bounded alert once the subscription has been absent for a TTL. */
  onLapseAlert?: (alert: WorkspaceEventsLapseAlert) => Promise<void> | void;
  /** Injectable clock for deterministic lapse tests. */
  now?: () => number;
  /** Initial and capped exponential retry delays after a failed ensure. */
  retryBackoffMs?: number;
  maxRetryBackoffMs?: number;
}

/**
 * Keeps a Google **Workspace Events** subscription alive so chat messages keep
 * flowing into our Pub/Sub topic (consumed by {@link PubsubChatSource}).
 *
 * The subscription has a hard 4h TTL (`includeResource: true`). Failed setup
 * keeps a single bounded-backoff retry loop alive, and every later pass lists
 * subscriptions afresh so a missing or expired resource is recreated.
 */
export class WorkspaceEventsSubscriber {
  private readonly log: (msg: string) => void;
  private readonly logger?: Logger;
  private readonly fetchImpl: typeof fetch;
  private readonly renewIntervalMs: number;
  private readonly expectedTtlSeconds: number;
  private readonly alertCooldownMs: number;
  private readonly initialBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly now: () => number;
  private readonly startedAt: number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private nextRetryMs: number;
  /** The subscription we're currently keeping alive (resource name). */
  private subscriptionName: string | null = null;
  /** Last point at which the Workspace API confirmed that an active subscription exists. */
  private lastKnownActiveAt: number | null = null;
  private lastAlertAt: number | null = null;

  constructor(private readonly opts: WorkspaceEventsSubscriberOptions) {
    this.log = opts.log ?? (() => {});
    this.logger = opts.logger;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.renewIntervalMs = opts.renewIntervalMs ?? DEFAULT_RENEW_INTERVAL_MS;
    this.expectedTtlSeconds = opts.expectedTtlSeconds ?? MAX_TTL_SECONDS;
    this.alertCooldownMs = opts.alertCooldownMs ?? DEFAULT_ALERT_COOLDOWN_MS;
    this.initialBackoffMs = opts.retryBackoffMs ?? DEFAULT_RETRY_BACKOFF_MS;
    this.maxBackoffMs = opts.maxRetryBackoffMs ?? DEFAULT_MAX_RETRY_BACKOFF_MS;
    this.now = opts.now ?? Date.now;
    this.startedAt = this.now();
    this.nextRetryMs = this.initialBackoffMs;
  }

  /** Ensure a live subscription exists, then keep renewing it on a timer. */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.ensure();
      this.nextRetryMs = this.initialBackoffMs;
      this.schedule(this.renewIntervalMs);
    } catch (err) {
      await this.handleFailure(err, true);
      throw err;
    }
  }

  async close(): Promise<void> {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** The subscription resource name currently being kept alive (for diagnostics). */
  get currentSubscription(): string | null {
    return this.subscriptionName;
  }

  private schedule(delayMs: number): void {
    if (!this.running) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.tick(), delayMs);
    this.timer.unref?.();
  }

  private async tick(): Promise<void> {
    if (!this.running) return;
    try {
      await this.ensure();
      this.nextRetryMs = this.initialBackoffMs;
      this.schedule(this.renewIntervalMs);
    } catch (err) {
      await this.handleFailure(err, false);
    }
  }

  private async handleFailure(err: unknown, boot: boolean): Promise<void> {
    const retryInMs = this.nextRetryMs;
    this.emitLog(
      "warn",
      boot ? "chat_subscription_boot_failed" : "chat_subscription_retry_failed",
      { topic: this.opts.topic, subscriptionName: this.subscriptionName, err, retryInMs },
      `${boot ? "events subscription setup" : "subscription renewal"} failed: ${errMsg(err)}; retrying in ${Math.round(retryInMs / 1000)}s`
    );
    await this.alertIfLapsed();
    this.nextRetryMs = Math.min(retryInMs * 2, this.maxBackoffMs);
    this.schedule(retryInMs);
  }

  private async alertIfLapsed(): Promise<void> {
    const now = this.now();
    const activeSince = this.lastKnownActiveAt ?? this.startedAt;
    const elapsedSeconds = Math.floor((now - activeSince) / 1_000);
    if (elapsedSeconds < this.expectedTtlSeconds) return;
    if (this.lastAlertAt !== null && now - this.lastAlertAt < this.alertCooldownMs) return;

    this.lastAlertAt = now;
    const message = formatLapseMessage({
      topic: this.opts.topic,
      subscriptionName: this.subscriptionName,
      expectedTtlSeconds: this.expectedTtlSeconds,
      elapsedSeconds,
    });
    const alert: WorkspaceEventsLapseAlert = {
      topic: this.opts.topic,
      subscriptionName: this.subscriptionName,
      expectedTtlSeconds: this.expectedTtlSeconds,
      elapsedSeconds,
      message,
    };
    this.emitLog(
      "error",
      "chat_subscription_lapsed",
      {
        topic: alert.topic,
        subscriptionName: alert.subscriptionName,
        elapsedSeconds,
        expectedTtlSeconds: alert.expectedTtlSeconds,
      },
      message
    );
    try {
      await this.opts.onLapseAlert?.(alert);
    } catch (err) {
      this.emitLog(
        "warn",
        "chat_subscription_lapse_alert_failed",
        { topic: this.opts.topic, err },
        `failed to emit subscription lapse alert: ${errMsg(err)}`
      );
    }
  }

  /**
   * Bring the world to "exactly one live subscription for our topic". Idempotent:
   * safe to call on every renewal tick regardless of prior state.
   */
  private async ensure(): Promise<void> {
    const matches = await this.list();
    const keep = matches.find((subscription) => !isLapsed(subscription, this.now()));

    // Prune duplicates — multiple live subscriptions double-deliver messages.
    for (const extra of matches) {
      if (extra !== keep && extra.name) {
        await this.delete(extra.name).catch((err) =>
          this.emitLog(
            "warn",
            "chat_subscription_prune_duplicate_failed",
            { topic: this.opts.topic, subscriptionName: extra.name, err },
            `failed to prune duplicate ${extra.name}: ${errMsg(err)}`
          )
        );
        this.emitLog(
          "info",
          "chat_subscription_pruned_duplicate",
          { topic: this.opts.topic, subscriptionName: extra.name },
          `pruned duplicate subscription ${extra.name}`
        );
      }
    }

    if (!keep?.name) {
      this.subscriptionName = null;
      const previousNames = new Set(
        matches.flatMap((subscription) => (subscription.name ? [subscription.name] : []))
      );
      const created = await this.create(previousNames);
      this.subscriptionName = created;
      this.noteActive(created, "chat_subscription_created", `created subscription ${created}`);
      return;
    }

    this.subscriptionName = keep.name;
    this.lastKnownActiveAt = this.now();
    if (keep.state === "SUSPENDED") {
      await this.reactivate(keep.name);
      this.emitLog(
        "info",
        "chat_subscription_reactivated",
        { topic: this.opts.topic, subscriptionName: keep.name },
        `reactivated suspended subscription ${keep.name}`
      );
    }

    try {
      await this.renew(keep.name);
      this.noteActive(
        keep.name,
        "chat_subscription_renewed",
        `renewed subscription ${keep.name} (ttl ${TTL})`
      );
    } catch (err) {
      if (!shouldRecreateAfterRenewFailure(err)) throw err;
      this.emitLog(
        "warn",
        "chat_subscription_renew_missing_recreating",
        { topic: this.opts.topic, subscriptionName: keep.name, err },
        `renewal found ${keep.name} missing or expired; recreating`
      );
      this.subscriptionName = null;
      await this.delete(keep.name).catch(() => {});
      const created = await this.create(new Set([keep.name]));
      this.subscriptionName = created;
      this.noteActive(created, "chat_subscription_recreated", `recreated subscription ${created}`);
    }
  }

  private noteActive(subscriptionName: string, event: string, message: string): void {
    this.lastKnownActiveAt = this.now();
    this.lastAlertAt = null;
    this.emitLog("info", event, { topic: this.opts.topic, subscriptionName, ttl: TTL }, message);
  }

  private emitLog(
    level: "debug" | "info" | "warn" | "error",
    event: string,
    fields: Record<string, unknown>,
    message: string
  ): void {
    this.logger?.[level](event, fields);
    this.log(message);
  }

  /** List the user's subscriptions for our event type/target and topic. */
  private async list(): Promise<WeSubscription[]> {
    const filter = `event_types:"${MESSAGE_CREATED}" AND target_resource="${CHAT_TARGET}"`;
    const res = (await this.request(
      "GET",
      `/subscriptions?filter=${encodeURIComponent(filter)}`
    )) as { subscriptions?: WeSubscription[] };
    return (res.subscriptions ?? []).filter(
      (subscription) => subscription.notificationEndpoint?.pubsubTopic === this.opts.topic
    );
  }

  private async create(previousNames: Set<string>): Promise<string> {
    const body = {
      targetResource: CHAT_TARGET,
      eventTypes: [MESSAGE_CREATED],
      notificationEndpoint: { pubsubTopic: this.opts.topic },
      // The message resource (incl. text) must ride in the payload — see normalize.ts.
      payloadOptions: { includeResource: true },
      ttl: TTL,
    };
    // create returns a long-running operation; the subscription appears on the
    // next list(), so choose the newly visible subscription rather than parse the LRO.
    await this.request("POST", "/subscriptions", body);
    const matches = await this.list();
    const name = matches.find(
      (subscription) => subscription.name && !previousNames.has(subscription.name)
    )?.name;
    if (!name) throw new Error("subscription created but did not appear in list()");
    return name;
  }

  private async renew(name: string): Promise<void> {
    await this.request("PATCH", `/${name}?updateMask=ttl`, { ttl: TTL });
  }

  private async reactivate(name: string): Promise<void> {
    await this.request("POST", `/${name}:reactivate`, {});
  }

  private async delete(name: string): Promise<void> {
    await this.request("DELETE", `/${name}`);
  }

  private async request(method: string, path: string, body?: unknown): Promise<unknown> {
    const token = await this.opts.getToken();
    const resp = await this.fetchImpl(`${WE_API}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!resp.ok) {
      throw new WorkspaceEventsRequestError(
        resp.status,
        `workspace-events ${method} ${path} -> HTTP ${resp.status} ${(await resp.text()).slice(0, 300)}`
      );
    }
    const text = await resp.text();
    return text ? JSON.parse(text) : {};
  }
}

class WorkspaceEventsRequestError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

function isLapsed(subscription: WeSubscription, now: number): boolean {
  if (!subscription.name || subscription.state === "EXPIRED" || subscription.state === "DELETED")
    return true;
  if (!subscription.expireTime) return false;
  const expiresAt = Date.parse(subscription.expireTime);
  return Number.isFinite(expiresAt) && expiresAt <= now;
}

function shouldRecreateAfterRenewFailure(err: unknown): boolean {
  if (!(err instanceof WorkspaceEventsRequestError)) return false;
  return (
    err.status === 404 || (err.status === 400 && /(expired|lapsed|not found)/i.test(err.message))
  );
}

function formatLapseMessage(opts: Omit<WorkspaceEventsLapseAlert, "message">): string {
  const subscription = opts.subscriptionName ?? "none";
  return `Google Workspace Events subscription lapse detected for ${opts.topic} (last subscription: ${subscription}; no active subscription for ${opts.elapsedSeconds}s, expected TTL ${opts.expectedTtlSeconds}s). Chat delivery to the mesh may be interrupted until recovery succeeds.`;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
