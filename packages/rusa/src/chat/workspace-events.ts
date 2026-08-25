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

interface WeSubscription {
  name?: string;
  state?: string;
  targetResource?: string;
  eventTypes?: string[];
  notificationEndpoint?: { pubsubTopic?: string };
}

export interface WorkspaceEventsSubscriberOptions {
  /** Full Pub/Sub topic resource the events should be delivered to: `projects/<p>/topics/<t>`. */
  topic: string;
  /** Mints a user-OAuth access token for the gchat user (scope `chat.messages`). */
  getToken: () => Promise<string>;
  /** Override the renewal cadence (default: half the 4h TTL). */
  renewIntervalMs?: number;
  log?: (msg: string) => void;
  /** Injectable for tests; defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
}

/**
 * Keeps a Google **Workspace Events** subscription alive so chat messages keep
 * flowing into our Pub/Sub topic (consumed by {@link PubsubChatSource}).
 *
 * The subscription has a hard 4h TTL (`includeResource: true`) and silently
 * stops delivering once it lapses, so this owns the renewal loop the design
 * called for. {@link ensure} is idempotent and self-healing: each tick re-lists
 * the user's subscriptions, adopts/renews a live one, reactivates a suspended
 * one, creates one if none exist, and prunes duplicates (which would otherwise
 * double-deliver every message). Authenticated as the gchat user via user-OAuth.
 */
export class WorkspaceEventsSubscriber {
  private readonly log: (msg: string) => void;
  private readonly fetchImpl: typeof fetch;
  private readonly renewIntervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** The subscription we're currently keeping alive (resource name). */
  private subscriptionName: string | null = null;

  constructor(private readonly opts: WorkspaceEventsSubscriberOptions) {
    this.log = opts.log ?? (() => {});
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.renewIntervalMs = opts.renewIntervalMs ?? DEFAULT_RENEW_INTERVAL_MS;
  }

  /** Ensure a live subscription exists, then keep renewing it on a timer. */
  async start(): Promise<void> {
    await this.ensure();
    this.timer = setInterval(() => {
      void this.ensure().catch((err) => {
        this.log(`renewal failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    }, this.renewIntervalMs);
    this.timer.unref?.();
  }

  async close(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** The subscription resource name currently being kept alive (for diagnostics). */
  get currentSubscription(): string | null {
    return this.subscriptionName;
  }

  /**
   * Bring the world to "exactly one live subscription for our topic". Idempotent:
   * safe to call on every renewal tick regardless of prior state.
   */
  private async ensure(): Promise<void> {
    const matches = await this.list();

    // Prune duplicates — multiple live subscriptions double-deliver messages.
    const keep = matches[0];
    for (const extra of matches.slice(1)) {
      if (extra.name) {
        await this.delete(extra.name).catch((err) =>
          this.log(`failed to prune duplicate ${extra.name}: ${errMsg(err)}`)
        );
        this.log(`pruned duplicate subscription ${extra.name}`);
      }
    }

    if (!keep?.name) {
      const created = await this.create();
      this.subscriptionName = created;
      this.log(`created subscription ${created}`);
      return;
    }

    this.subscriptionName = keep.name;
    if (keep.state === "SUSPENDED") {
      await this.reactivate(keep.name);
      this.log(`reactivated suspended subscription ${keep.name}`);
    }
    await this.renew(keep.name);
    this.log(`renewed subscription ${keep.name} (ttl ${TTL})`);
  }

  /** List the user's subscriptions for our event type/target and topic. */
  private async list(): Promise<WeSubscription[]> {
    const filter = `event_types:"${MESSAGE_CREATED}" AND target_resource="${CHAT_TARGET}"`;
    const res = (await this.request(
      "GET",
      `/subscriptions?filter=${encodeURIComponent(filter)}`
    )) as { subscriptions?: WeSubscription[] };
    return (res.subscriptions ?? []).filter(
      (s) => s.notificationEndpoint?.pubsubTopic === this.opts.topic
    );
  }

  private async create(): Promise<string> {
    const body = {
      targetResource: CHAT_TARGET,
      eventTypes: [MESSAGE_CREATED],
      notificationEndpoint: { pubsubTopic: this.opts.topic },
      // The message resource (incl. text) must ride in the payload — see normalize.ts.
      payloadOptions: { includeResource: true },
      ttl: TTL,
    };
    // create returns a long-running operation; the subscription appears on the
    // next list(), so we re-list rather than parse the LRO.
    await this.request("POST", "/subscriptions", body);
    const matches = await this.list();
    const name = matches[0]?.name;
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
      throw new Error(
        `workspace-events ${method} ${path} -> HTTP ${resp.status} ${(await resp.text()).slice(0, 300)}`
      );
    }
    const text = await resp.text();
    return text ? JSON.parse(text) : {};
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
