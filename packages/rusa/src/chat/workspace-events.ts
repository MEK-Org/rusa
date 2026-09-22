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
 * How long an accepted create is trusted to show up in `list()` before the
 * next failed pass creates again (a duplicate the following pass then prunes).
 */
const CREATE_VISIBILITY_WINDOW_MS = 60_000;

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

/**
 * The subscription keeper's inbox payload, in the shape the host disk sensor
 * already emits (`SystemDiskEvent`): the host wiring hands it to
 * `deliverExternalEvent` unchanged, and scheduling priority is not part of it.
 */
export interface SystemChatSubscriptionLapseEvent {
  [key: string]: unknown;
  type: "system.chat_subscription_lapsed";
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
  onLapse?: (event: SystemChatSubscriptionLapseEvent) => Promise<void> | void;
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
 * {@link WorkspaceEventsSubscriberOptions.onLapse}.
 */
export class WorkspaceEventsSubscriber {
  private readonly logger?: Logger;
  private readonly fetchImpl: typeof fetch;
  private readonly renewIntervalMs: number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  /**
   * Set by `close()` and never cleared: a subscriber is disposed once. Keeping
   * `running` from ever going true again is what keeps a pass abandoned at
   * close gated for good (see {@link request}).
   */
  private closed = false;
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
  /** When the API last accepted a create whose subscription `list()` has not shown yet. */
  private createAcceptedAt: number | null = null;

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
    if (this.running || this.closed) return;
    this.running = true;
    await this.tick(true);
  }

  /**
   * Stop maintenance. Returns at once, whatever the pass in flight is doing:
   * shutdown never waits on a Workspace Events request, stalled or not. Letting
   * the pass go is safe because from here on it is inert — its next `request()`
   * is refused, its failure arms no retry and raises no lapse, and `start()`
   * will not run this instance again, so the pass can never be un-gated. What it
   * may still do in-process is finish bookkeeping for a request that had
   * already answered before close; nothing more leaves the process.
   */
  async close(): Promise<void> {
    this.closed = true;
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

  /**
   * One maintenance pass. Passes never overlap: the next timer is armed only
   * once a pass has ended (either branch below), and `start()` runs at most one
   * boot pass per instance.
   */
  private async tick(boot: boolean): Promise<void> {
    if (!this.running) return;
    try {
      await this.ensure();
      this.nextRetryMs = RETRY_BACKOFF_MS;
      this.schedule(this.renewIntervalMs);
    } catch (err) {
      // A pass that outlived its subscriber stops here. `schedule()` would
      // already refuse the retry; what this adds is silence where it belongs:
      // after close nothing is expected to keep delivering, so a lapse this
      // pass would report is shutdown, not news, and pages nobody. A debug
      // record keeps the abandoned pass visible to anyone reading a shutdown.
      if (!this.running) {
        this.logger?.debug("chat_subscription_pass_abandoned", {
          topic: this.opts.topic,
          subscriptionName: this.subscriptionName,
          err,
        });
        return;
      }
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
    const event: SystemChatSubscriptionLapseEvent = {
      type: "system.chat_subscription_lapsed",
      topic: this.opts.topic,
      subscriptionName: this.subscriptionName,
      expectedTtlSeconds: MAX_TTL_SECONDS,
      elapsedSeconds,
      message: formatLapseMessage(this.opts.topic, this.subscriptionName, elapsedSeconds),
    };
    this.logger?.error("chat_subscription_lapsed", {
      topic: event.topic,
      subscriptionName: event.subscriptionName,
      elapsedSeconds,
      expectedTtlSeconds: event.expectedTtlSeconds,
    });
    try {
      await this.opts.onLapse?.(event);
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
    if (!this.running) throw new Error("workspace-events subscriber is closed");
    const now = Date.now();
    // The API does not promise list order, so rank rather than take the first:
    // an ACTIVE subscription is already delivering and beats one that would
    // first need reactivating.
    const usable = matches.filter((subscription) => !isLapsed(subscription, now));
    const keep = usable.find((subscription) => subscription.state === "ACTIVE") ?? usable[0];

    // Prune the rest: duplicates double-deliver every message, and an expired
    // subscription can't be renewed (the API refuses a TTL update past expiry).
    // Whatever survives the prune is what delivery rests on — a SUSPENDED keep
    // only once its reactivation below succeeds.
    const delivering = keep?.state === "ACTIVE" ? [keep] : [];
    for (const extra of matches) {
      if (!this.running) throw new Error("workspace-events subscriber is closed");
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
        if (!this.running) throw err;
        if (reason === "duplicate" && extra.state === "ACTIVE") delivering.push(extra);
        this.logger?.warn("chat_subscription_prune_failed", {
          topic: this.opts.topic,
          subscriptionName: extra.name,
          reason,
          err,
        });
      }
    }
    // With nothing delivering, the lapsed leftovers say when delivery stopped.
    this.seedConfirmationFromListed(
      delivering.length > 0 ? delivering : matches.filter((match) => isLapsed(match, now))
    );

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
      // Delivering again as of now — but reactivation does not move `expireTime`,
      // so the seed still holds the alert to the expiry the renew below (or a
      // retry of it) has yet to push out.
      this.confirmActive(keep.name, "chat_subscription_reactivated", {});
      this.seedConfirmationFromListed([keep]);
    }

    try {
      await this.renew(keep.name);
      this.confirmActive(keep.name, "chat_subscription_renewed");
    } catch (err) {
      if (!this.running) throw err;
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

  /** Record an API-confirmed create/renew/reactivate: the only thing that resets lapse tracking. */
  private confirmActive(
    subscriptionName: string,
    event: string,
    fields: Record<string, unknown> = { ttl: TTL }
  ): void {
    this.subscriptionName = subscriptionName;
    this.lastConfirmedActiveAt = Date.now();
    this.lastAlertAt = null;
    this.createAcceptedAt = null;
    this.logger?.info(event, { topic: this.opts.topic, subscriptionName, ...fields });
  }

  /**
   * The latest `expireTime` among the subscriptions delivery rests on is when it
   * stops if nothing is confirmed first, so the confirmation baseline can be no
   * later than one TTL before it. Only ever moves the baseline earlier (see
   * `lastConfirmedActiveAt`).
   */
  private seedConfirmationFromListed(delivering: readonly WeSubscription[]): void {
    let latestExpiry = Number.NEGATIVE_INFINITY;
    for (const subscription of delivering) {
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
    // An accepted create that list() has not shown yet is waited for, not
    // repeated: each retry's list() adopts it once it appears. Past the window
    // the pass creates again and a later pass prunes any duplicate.
    const now = Date.now();
    if (
      this.createAcceptedAt !== null &&
      now - this.createAcceptedAt < CREATE_VISIBILITY_WINDOW_MS
    ) {
      throw new Error(
        `subscription create accepted ${Math.floor((now - this.createAcceptedAt) / 1_000)}s ago but not yet visible in list()`
      );
    }
    this.createAcceptedAt = null;
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
    // operation is still pending, fall back to the newly visible subscription
    // in list(), and otherwise fail this pass with the create held as accepted.
    const operation = (await this.request("POST", "/subscriptions", body)) as {
      done?: boolean;
      response?: { name?: string };
      error?: { code?: number; message?: string };
    };
    if (operation.error) {
      throw new Error(
        `subscription create operation failed: ${operation.error.message ?? "unknown"}`
      );
    }
    if (operation.done && operation.response?.name) return operation.response.name;
    // Stamped when the acceptance is *learned*: a slow POST must not spend the
    // window before the first retry has had a chance to list the new one.
    this.createAcceptedAt = Date.now();
    const matches = await this.list();
    const name = matches.find(
      (subscription) => subscription.name && !previousNames.has(subscription.name)
    )?.name;
    if (!name) throw new Error("subscription create accepted but not yet visible in list()");
    this.createAcceptedAt = null;
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
    // Every outward call a pass makes goes through here, so this is where
    // disposal stops one: a pass that resumes after `close()` — mid-`ensure`,
    // between a list and the prune it implies, or while awaiting a token — gets
    // no further than its next request step, and the world outside the process
    // sees nothing more from it.
    // Whatever the pass had already done out there stays done — a subscription
    // it created, a duplicate it had not yet pruned — and the next pass to run
    // against this topic, in this process or the one that replaces it, lists
    // and converges on it like any other leftover.
    if (!this.running) throw new Error("workspace-events subscriber is closed");
    const token = await this.opts.getToken();
    if (!this.running) throw new Error("workspace-events subscriber is closed");
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
