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
const MAX_TTL_SECONDS = 4 * 3600;
const TTL = `${MAX_TTL_SECONDS}s`;

/** Renew at half the TTL → ~2h of slack before a missed tick would let it lapse. */
const DEFAULT_RENEW_INTERVAL_MS = (MAX_TTL_SECONDS / 2) * 1000;
/** Retry a failed pass at 5s, doubling to a 5m ceiling, until a pass succeeds. */
const RETRY_BACKOFF_MS = 5_000;
const MAX_RETRY_BACKOFF_MS = 5 * 60_000;
/** Repeat the lapse alert at most hourly while recovery keeps failing. */
const ALERT_COOLDOWN_MS = 60 * 60_000;

/**
 * The fields of the API's `Subscription` resource this module reads. `state` is
 * `STATE_UNSPECIFIED | ACTIVE | SUSPENDED | DELETED`; `expireTime` is output-only
 * and always present on a listed subscription.
 */
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
  /** Structured lifecycle records (`chat_subscription_*`). */
  logger?: Logger;
  /** Injectable for tests; defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
  /**
   * Called once a full TTL has passed without a confirmed create or renew, i.e.
   * once delivery has certainly lapsed. Repeats at most hourly until recovery.
   */
  onLapseAlert?: (alert: WorkspaceEventsLapseAlert) => Promise<void> | void;
}

/**
 * Keeps a Google **Workspace Events** subscription alive so chat messages keep
 * flowing into our Pub/Sub topic (consumed by {@link PubsubChatSource}).
 *
 * The subscription has a hard 4h TTL (`includeResource: true`) and silently
 * stops delivering once it lapses, so this owns the renewal loop. Each pass of
 * {@link ensure} re-lists the user's subscriptions and converges on exactly one
 * live subscription: adopting and renewing a live one, reactivating a suspended
 * one, pruning duplicates and expired leftovers, and creating one when none is
 * usable. A failed pass is retried with bounded backoff rather than waiting for
 * the next renewal slot, and a full TTL without a confirmed create/renew raises
 * {@link WorkspaceEventsSubscriberOptions.onLapseAlert}.
 */
export class WorkspaceEventsSubscriber {
  private readonly logger?: Logger;
  private readonly fetchImpl: typeof fetch;
  private readonly renewIntervalMs: number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private nextRetryMs = RETRY_BACKOFF_MS;
  /** The subscription we're currently keeping alive (resource name). */
  private subscriptionName: string | null = null;
  /**
   * When the API last confirmed a subscription with a fresh TTL (a successful
   * create or renew). Merely seeing one listed does not advance it: a listed
   * subscription whose renewals keep failing is exactly the lapse this must
   * detect. A listed `expireTime` may only pull it *earlier*, so a process that
   * restarts onto an ageing subscription alerts when that subscription actually
   * lapses rather than a full TTL after its own boot.
   */
  private lastConfirmedActiveAt: number;
  private lastAlertAt: number | null = null;

  constructor(private readonly opts: WorkspaceEventsSubscriberOptions) {
    this.logger = opts.logger;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.renewIntervalMs = opts.renewIntervalMs ?? DEFAULT_RENEW_INTERVAL_MS;
    this.lastConfirmedActiveAt = Date.now();
  }

  /**
   * Run the first pass and keep the renewal loop alive. Resolves even when the
   * first pass fails: the failure is logged and retried with backoff, so the
   * caller can carry on wiring chat without a fatal/ignore choice. Read
   * {@link currentSubscription} to see whether a subscription is live yet.
   */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    await this.tick(true);
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
    this.timer = setTimeout(() => void this.tick(false), delayMs);
    this.timer.unref?.();
  }

  private async tick(boot: boolean): Promise<void> {
    if (!this.running) return;
    try {
      await this.ensure();
      this.nextRetryMs = RETRY_BACKOFF_MS;
      this.schedule(this.renewIntervalMs);
    } catch (err) {
      const retryInMs = this.nextRetryMs;
      this.nextRetryMs = Math.min(retryInMs * 2, MAX_RETRY_BACKOFF_MS);
      this.logger?.warn(boot ? "chat_subscription_boot_failed" : "chat_subscription_retry_failed", {
        topic: this.opts.topic,
        subscriptionName: this.subscriptionName,
        err,
        retryInMs,
      });
      // Arm the retry before delivering the alert so a slow alert sink cannot
      // hold recovery back.
      this.schedule(retryInMs);
      await this.alertIfLapsed();
    }
  }

  private async alertIfLapsed(): Promise<void> {
    const now = Date.now();
    const elapsedSeconds = Math.floor((now - this.lastConfirmedActiveAt) / 1_000);
    if (elapsedSeconds < MAX_TTL_SECONDS) return;
    if (this.lastAlertAt !== null && now - this.lastAlertAt < ALERT_COOLDOWN_MS) return;

    this.lastAlertAt = now;
    const alert: WorkspaceEventsLapseAlert = {
      topic: this.opts.topic,
      subscriptionName: this.subscriptionName,
      expectedTtlSeconds: MAX_TTL_SECONDS,
      elapsedSeconds,
      message: formatLapseMessage(this.opts.topic, this.subscriptionName, elapsedSeconds),
    };
    this.logger?.error("chat_subscription_lapsed", {
      topic: alert.topic,
      subscriptionName: alert.subscriptionName,
      elapsedSeconds,
      expectedTtlSeconds: alert.expectedTtlSeconds,
    });
    try {
      await this.opts.onLapseAlert?.(alert);
    } catch (err) {
      this.logger?.warn("chat_subscription_lapse_alert_failed", { topic: this.opts.topic, err });
    }
  }

  /**
   * Bring the world to "exactly one live subscription for our topic". Idempotent:
   * safe to call on every renewal tick regardless of prior state.
   */
  private async ensure(): Promise<void> {
    const matches = await this.list();
    const now = Date.now();
    this.seedConfirmationFromListed(matches);
    // The API does not promise list order, so rank rather than take the first:
    // an ACTIVE subscription is already delivering and beats one that would
    // first need reactivating.
    const usable = matches.filter((subscription) => !isLapsed(subscription, now));
    const keep = usable.find((subscription) => subscription.state === "ACTIVE") ?? usable[0];

    // Prune the rest: duplicates double-deliver every message, and an expired
    // subscription can't be renewed (the API refuses a TTL update past expiry).
    for (const extra of matches) {
      if (extra === keep || !extra.name) continue;
      const reason = isLapsed(extra, now) ? "lapsed" : "duplicate";
      try {
        await this.delete(extra.name);
        this.logger?.info("chat_subscription_pruned", {
          topic: this.opts.topic,
          subscriptionName: extra.name,
          reason,
        });
      } catch (err) {
        this.logger?.warn("chat_subscription_prune_failed", {
          topic: this.opts.topic,
          subscriptionName: extra.name,
          reason,
          err,
        });
      }
    }

    if (!keep?.name) {
      this.subscriptionName = null;
      const previousNames = new Set(
        matches.flatMap((subscription) => (subscription.name ? [subscription.name] : []))
      );
      this.confirmActive(await this.create(previousNames), "chat_subscription_created");
      return;
    }

    this.subscriptionName = keep.name;
    if (keep.state === "SUSPENDED") {
      await this.reactivate(keep.name);
      this.logger?.info("chat_subscription_reactivated", {
        topic: this.opts.topic,
        subscriptionName: keep.name,
      });
    }

    try {
      await this.renew(keep.name);
      this.confirmActive(keep.name, "chat_subscription_renewed");
    } catch (err) {
      // A listed subscription the API no longer knows (404) is replaced right
      // away. Any other renew failure is retried with backoff: if the
      // subscription really has lapsed, its `expireTime` moves it onto the
      // prune-and-create path on the next pass.
      if (!(err instanceof WorkspaceEventsRequestError && err.status === 404)) throw err;
      this.logger?.warn("chat_subscription_renew_missing_recreating", {
        topic: this.opts.topic,
        subscriptionName: keep.name,
        err,
      });
      this.subscriptionName = null;
      this.confirmActive(await this.create(new Set([keep.name])), "chat_subscription_recreated");
    }
  }

  /** Record an API-confirmed create/renew: the only thing that resets lapse tracking. */
  private confirmActive(subscriptionName: string, event: string): void {
    this.subscriptionName = subscriptionName;
    this.lastConfirmedActiveAt = Date.now();
    this.lastAlertAt = null;
    this.logger?.info(event, { topic: this.opts.topic, subscriptionName, ttl: TTL });
  }

  /**
   * The latest listed `expireTime` is when delivery stops if nothing is
   * confirmed first, so the confirmation baseline can be no later than one TTL
   * before it. Only ever moves the baseline earlier (see `lastConfirmedActiveAt`).
   */
  private seedConfirmationFromListed(matches: readonly WeSubscription[]): void {
    let latestExpiry = Number.NEGATIVE_INFINITY;
    for (const subscription of matches) {
      const expiresAt = subscription.expireTime ? Date.parse(subscription.expireTime) : NaN;
      if (Number.isFinite(expiresAt)) latestExpiry = Math.max(latestExpiry, expiresAt);
    }
    if (!Number.isFinite(latestExpiry)) return;
    this.lastConfirmedActiveAt = Math.min(
      this.lastConfirmedActiveAt,
      latestExpiry - MAX_TTL_SECONDS * 1_000
    );
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
    // create returns a long-running operation that normally completes inline
    // with the Subscription as its response. Prefer that name; when the
    // operation is still pending, fall back to the newly visible subscription in
    // list(). If it is not visible yet, fail this pass rather than create again:
    // the retry's list() adopts it once it appears.
    const operation = (await this.request("POST", "/subscriptions", body)) as {
      done?: boolean;
      response?: { name?: string };
    };
    if (operation.done && operation.response?.name) return operation.response.name;
    const matches = await this.list();
    const name = matches.find(
      (subscription) => subscription.name && !previousNames.has(subscription.name)
    )?.name;
    if (!name) throw new Error("subscription create accepted but not yet visible in list()");
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

/** A listed subscription that can no longer deliver: deleted, or past its `expireTime`. */
function isLapsed(subscription: WeSubscription, now: number): boolean {
  if (!subscription.name || subscription.state === "DELETED") return true;
  if (!subscription.expireTime) return false;
  const expiresAt = Date.parse(subscription.expireTime);
  return Number.isFinite(expiresAt) && expiresAt <= now;
}

function formatLapseMessage(
  topic: string,
  subscriptionName: string | null,
  elapsedSeconds: number
): string {
  return `Google Workspace Events subscription lapse detected for ${topic} (last subscription: ${subscriptionName ?? "none"}; no confirmed subscription for ${elapsedSeconds}s, TTL ${MAX_TTL_SECONDS}s). Chat delivery to the mesh may be interrupted until recovery succeeds.`;
}
