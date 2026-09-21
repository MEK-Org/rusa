import { afterEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "../observability/logger.js";
import {
  type SystemChatSubscriptionLapseEvent,
  WorkspaceEventsSubscriber,
} from "./workspace-events.js";

const TOPIC = "projects/p/topics/chat-events";
const CHAT_TARGET = "//chat.googleapis.com/spaces/-";
const MESSAGE_CREATED = "google.workspace.chat.message.v1.created";

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
/** The subscriber's own constants, restated so a test reads as wall-clock. */
const TTL_MS = 4 * HOUR;
const RENEW_MS = TTL_MS / 2;
const FIRST_RETRY_MS = 5 * SECOND;
const MAX_RETRY_MS = 5 * MINUTE;
const CREATE_VISIBILITY_WINDOW_MS = MINUTE;

interface FakeSub {
  name: string;
  state: string;
  notificationEndpoint: { pubsubTopic: string };
  expireTime?: string;
}

interface Call {
  method: string;
  path: string;
  body?: unknown;
}

function jsonResponse(status: number, body?: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (body === undefined ? "" : JSON.stringify(body)),
  } as unknown as Response;
}

/** Minimal in-memory Workspace Events API for the subscriber under test. */
class FakeWeApi {
  subs: FakeSub[];
  calls: Call[] = [];
  /** When set, PATCH (renew) answers with this status instead of succeeding. */
  renewStatus: number | null = null;
  /** When set, POST /subscriptions (create) answers with this status instead. */
  createStatus: number | null = null;
  /** When set, POST :reactivate answers with this status instead of succeeding. */
  reactivateStatus: number | null = null;
  /** How long the create request takes to answer (virtual time, fake timers only). */
  createLatencyMs = 0;
  /**
   * Whether the create operation completes inline with the Subscription as its
   * response (the API's normal shape) or answers with a bare pending operation.
   */
  createResponseInline = true;
  /** When set, the create operation completes with this error and no subscription. */
  createOperationError: string | null = null;
  /** How many list() calls a newly created subscription stays invisible for. */
  createListLag = 0;
  private pending: Array<{ sub: FakeSub; listsUntilVisible: number }> = [];
  private seq = 0;

  constructor(initial: FakeSub[] = []) {
    this.subs = initial;
  }

  fetch: typeof fetch = async (url, init) => {
    const u = new URL(String(url));
    const path = u.pathname.replace(/^\/v1/, "");
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    this.calls.push({ method, path: path + u.search.replace(/&filter=[^&]*/, ""), body });

    if (method === "GET" && path === "/subscriptions") {
      // The real API filters server-side by event type/target; mirror only what
      // matters here and return everything (the subscriber filters by topic).
      const visible = this.pending.filter((entry) => entry.listsUntilVisible <= 0);
      this.pending = this.pending.filter((entry) => entry.listsUntilVisible > 0);
      for (const entry of this.pending) entry.listsUntilVisible--;
      this.subs.push(...visible.map((entry) => entry.sub));
      return jsonResponse(200, { subscriptions: this.subs });
    }
    if (method === "POST" && path === "/subscriptions") {
      if (this.createLatencyMs > 0) await vi.advanceTimersByTimeAsync(this.createLatencyMs);
      if (this.createStatus !== null) return jsonResponse(this.createStatus, { error: "create" });
      if (this.createOperationError !== null) {
        return jsonResponse(200, {
          name: "operations/op1",
          done: true,
          error: { code: 8, message: this.createOperationError },
        });
      }
      const sub: FakeSub = {
        name: `subscriptions/new-${this.seq++}`,
        state: "ACTIVE",
        notificationEndpoint: { pubsubTopic: body.notificationEndpoint.pubsubTopic },
      };
      if (this.createListLag > 0) {
        this.pending.push({ sub, listsUntilVisible: this.createListLag });
      } else {
        this.subs.push(sub);
      }
      return jsonResponse(
        200,
        this.createResponseInline
          ? { name: "operations/op1", done: true, response: sub }
          : { name: "operations/op1" }
      );
    }
    const name = path.replace(/^\//, "").replace(/:reactivate$/, "");
    const sub = this.subs.find((s) => s.name === name);
    if (method === "PATCH") {
      if (this.renewStatus !== null) return jsonResponse(this.renewStatus, { error: "renew" });
      if (!sub) return jsonResponse(404, { error: "not found" });
      return jsonResponse(200, { name: "operations/patch" });
    }
    if (method === "POST" && path.endsWith(":reactivate")) {
      if (this.reactivateStatus !== null) {
        return jsonResponse(this.reactivateStatus, { error: "reactivate" });
      }
      if (sub) sub.state = "ACTIVE";
      return jsonResponse(200, { name: "operations/reactivate" });
    }
    if (method === "DELETE") {
      this.subs = this.subs.filter((s) => s.name !== name);
      return jsonResponse(200, {});
    }
    return jsonResponse(404, { error: "not found" });
  };

  count(method: string, path?: string): number {
    return this.calls.filter((c) => c.method === method && (!path || c.path === path)).length;
  }
}

function activeSub(name: string): FakeSub {
  return { name, state: "ACTIVE", notificationEndpoint: { pubsubTopic: TOPIC } };
}

interface LogRecord {
  level: string;
  event: string;
  fields?: Record<string, unknown>;
}

function captureLogger(): { logger: Logger; records: LogRecord[] } {
  const records: LogRecord[] = [];
  const at = (level: string) => (event: string, fields?: Record<string, unknown>) => {
    records.push({ level, event, fields });
  };
  const logger = {
    debug: at("debug"),
    info: at("info"),
    warn: at("warn"),
    error: at("error"),
    child: () => logger,
  } as unknown as Logger;
  return { logger, records };
}

function makeSubscriber(
  api: FakeWeApi,
  overrides: Partial<{
    renewIntervalMs: number;
    logger: Logger;
    onLapse: (event: SystemChatSubscriptionLapseEvent) => Promise<void> | void;
  }> = {}
) {
  return new WorkspaceEventsSubscriber({
    topic: TOPIC,
    getToken: async () => "fake-token",
    fetchImpl: api.fetch,
    ...overrides,
  });
}

describe("WorkspaceEventsSubscriber", () => {
  afterEach(() => vi.useRealTimers());

  it("creates a subscription when none exists", async () => {
    const api = new FakeWeApi([]);
    const { logger, records } = captureLogger();
    const sub = makeSubscriber(api, { logger });
    await sub.start();
    await sub.close();

    expect(api.count("POST", "/subscriptions")).toBe(1);
    expect(api.subs).toHaveLength(1);
    expect(api.subs[0]?.notificationEndpoint.pubsubTopic).toBe(TOPIC);
    expect(sub.currentSubscription).toBe(api.subs[0]?.name);
    expect(records.map((r) => r.event)).toEqual(["chat_subscription_created"]);

    // The created subscription carries the fields the pull source depends on.
    const created = api.calls.find((c) => c.method === "POST" && c.path === "/subscriptions");
    expect(created?.body).toMatchObject({
      targetResource: CHAT_TARGET,
      eventTypes: [MESSAGE_CREATED],
      notificationEndpoint: { pubsubTopic: TOPIC },
      payloadOptions: { includeResource: true },
      ttl: "14400s",
    });
  });

  it("renews (does not recreate) an existing active subscription", async () => {
    const api = new FakeWeApi([activeSub("subscriptions/existing")]);
    const sub = makeSubscriber(api);
    await sub.start();
    await sub.close();

    expect(api.count("POST", "/subscriptions")).toBe(0);
    expect(api.count("PATCH")).toBe(1);
    const patch = api.calls.find((c) => c.method === "PATCH");
    expect(patch?.path).toContain("subscriptions/existing");
    expect(patch?.body).toEqual({ ttl: "14400s" });
    expect(sub.currentSubscription).toBe("subscriptions/existing");
  });

  it("reactivates a suspended subscription before renewing", async () => {
    const api = new FakeWeApi([{ ...activeSub("subscriptions/susp"), state: "SUSPENDED" }]);
    const sub = makeSubscriber(api);
    await sub.start();
    await sub.close();

    expect(api.calls.filter((c) => c.path.endsWith(":reactivate"))).toHaveLength(1);
    expect(api.count("PATCH")).toBe(1);
  });

  it("adopts the subscription named by the create operation without re-listing", async () => {
    const api = new FakeWeApi([]);
    const sub = makeSubscriber(api);
    await sub.start();
    await sub.close();

    expect(sub.currentSubscription).toBe("subscriptions/new-0");
    // One list to find nothing, one create; the inline response settles the name.
    expect(api.count("GET")).toBe(1);
  });

  it("waits for a slow-to-appear subscription instead of creating a second one", async () => {
    vi.useFakeTimers();
    // A pending operation with no inline response, and list() lagging one call
    // behind the create: the first pass fails, and the retry must adopt the
    // subscription that has since become visible rather than POST again.
    const api = new FakeWeApi([]);
    api.createResponseInline = false;
    api.createListLag = 1;
    const { logger, records } = captureLogger();
    const sub = makeSubscriber(api, { logger });

    await sub.start();
    expect(sub.currentSubscription).toBeNull();
    expect(records.at(-1)?.event).toBe("chat_subscription_boot_failed");
    expect((records.at(-1)?.fields?.err as Error).message).toMatch(/not yet visible/);

    await vi.advanceTimersByTimeAsync(FIRST_RETRY_MS);
    expect(sub.currentSubscription).toBe("subscriptions/new-0");
    expect(api.count("POST", "/subscriptions")).toBe(1);
    expect(api.subs).toHaveLength(1);
    expect(records.at(-1)?.event).toBe("chat_subscription_renewed");
    await sub.close();
  });

  it("holds an accepted create across retries until it is listed, then creates again past the window", async () => {
    vi.useFakeTimers();
    // Visibility lag spanning two retries: the first retry still lists nothing,
    // and must wait on the accepted create rather than POST a duplicate.
    const api = new FakeWeApi([]);
    api.createResponseInline = false;
    api.createListLag = 2;
    const { logger, records } = captureLogger();
    const sub = makeSubscriber(api, { logger });

    await sub.start();
    await vi.advanceTimersByTimeAsync(FIRST_RETRY_MS);
    expect(sub.currentSubscription).toBeNull();
    expect(api.count("POST", "/subscriptions")).toBe(1);
    expect((records.at(-1)?.fields?.err as Error).message).toMatch(/accepted 5s ago/);

    await vi.advanceTimersByTimeAsync(2 * FIRST_RETRY_MS);
    expect(sub.currentSubscription).toBe("subscriptions/new-0");
    expect(api.count("POST", "/subscriptions")).toBe(1);
    expect(api.subs).toHaveLength(1);
    await sub.close();

    // Bounded: a create that never shows up is repeated once the window has
    // passed (retries at 5, 15, 35 and 75 seconds after the accepted create).
    const stuck = new FakeWeApi([]);
    stuck.createResponseInline = false;
    stuck.createListLag = 99;
    const again = makeSubscriber(stuck);
    await again.start();
    await vi.advanceTimersByTimeAsync(CREATE_VISIBILITY_WINDOW_MS - FIRST_RETRY_MS);
    expect(stuck.count("POST", "/subscriptions")).toBe(1);
    await vi.advanceTimersByTimeAsync(8 * FIRST_RETRY_MS);
    expect(stuck.count("POST", "/subscriptions")).toBe(2);
    await again.close();
  });

  it("holds an accepted create for the window measured from the answer, not the request", async () => {
    vi.useFakeTimers();
    // A create that takes 58s to answer: the visibility window runs from when
    // the acceptance is learned, so the first retry 5s later still waits on it
    // rather than POSTing a second subscription.
    const api = new FakeWeApi([]);
    api.createResponseInline = false;
    api.createLatencyMs = 58 * SECOND;
    api.createListLag = 3;
    const { logger, records } = captureLogger();
    const sub = makeSubscriber(api, { logger });

    await sub.start();
    expect(api.count("POST", "/subscriptions")).toBe(1);

    await vi.advanceTimersByTimeAsync(FIRST_RETRY_MS);
    expect(api.count("POST", "/subscriptions")).toBe(1);
    expect((records.at(-1)?.fields?.err as Error).message).toMatch(/accepted 5s ago/);

    await vi.advanceTimersByTimeAsync(2 * FIRST_RETRY_MS);
    expect(api.count("POST", "/subscriptions")).toBe(1);

    // Adopted on the pass that finally lists it, 35s after the acceptance.
    await vi.advanceTimersByTimeAsync(4 * FIRST_RETRY_MS);
    expect(sub.currentSubscription).toBe("subscriptions/new-0");
    expect(api.count("POST", "/subscriptions")).toBe(1);
    expect(api.subs).toHaveLength(1);
    await sub.close();
  });

  it("treats a failed create operation as a failure, not as an accepted create", async () => {
    vi.useFakeTimers();
    const api = new FakeWeApi([]);
    api.createOperationError = "quota exceeded";
    const { logger, records } = captureLogger();
    const sub = makeSubscriber(api, { logger });

    await sub.start();
    expect((records.at(-1)?.fields?.err as Error).message).toMatch(/quota exceeded/);
    // Nothing was accepted, so the retry creates again right away.
    await vi.advanceTimersByTimeAsync(FIRST_RETRY_MS);
    expect(api.count("POST", "/subscriptions")).toBe(2);
    await sub.close();
  });

  it("keeps the ACTIVE subscription and prunes a SUSPENDED one regardless of list order", async () => {
    const api = new FakeWeApi([
      { ...activeSub("subscriptions/susp"), state: "SUSPENDED" },
      activeSub("subscriptions/live"),
    ]);
    const sub = makeSubscriber(api);
    await sub.start();
    await sub.close();

    expect(sub.currentSubscription).toBe("subscriptions/live");
    expect(api.subs.map((s) => s.name)).toEqual(["subscriptions/live"]);
    expect(api.calls.filter((c) => c.path.endsWith(":reactivate"))).toHaveLength(0);
    expect(api.count("PATCH")).toBe(1);
  });

  it("ignores subscriptions pointed at a different topic", async () => {
    const api = new FakeWeApi([
      {
        name: "subscriptions/other",
        state: "ACTIVE",
        notificationEndpoint: { pubsubTopic: "projects/p/topics/other" },
      },
    ]);
    const sub = makeSubscriber(api);
    await sub.start();
    await sub.close();

    // No match for our topic → it creates one rather than adopting the foreign one.
    expect(api.count("POST", "/subscriptions")).toBe(1);
    expect(api.count("DELETE")).toBe(0);
  });

  it("prunes duplicate subscriptions for our topic", async () => {
    const api = new FakeWeApi([
      activeSub("subscriptions/a"),
      activeSub("subscriptions/b"),
      activeSub("subscriptions/c"),
    ]);
    const { logger, records } = captureLogger();
    const sub = makeSubscriber(api, { logger });
    await sub.start();
    await sub.close();

    expect(api.count("DELETE")).toBe(2);
    expect(api.subs.map((s) => s.name)).toEqual(["subscriptions/a"]);
    expect(sub.currentSubscription).toBe("subscriptions/a");
    expect(records.filter((r) => r.event === "chat_subscription_pruned")).toEqual([
      {
        level: "info",
        event: "chat_subscription_pruned",
        fields: { topic: TOPIC, subscriptionName: "subscriptions/b", reason: "duplicate" },
      },
      {
        level: "info",
        event: "chat_subscription_pruned",
        fields: { topic: TOPIC, subscriptionName: "subscriptions/c", reason: "duplicate" },
      },
    ]);
  });

  it("logs a failed prune as a failure, not as pruned", async () => {
    const api = new FakeWeApi([activeSub("subscriptions/a"), activeSub("subscriptions/b")]);
    const inner = api.fetch;
    api.fetch = async (url, init) =>
      init?.method === "DELETE" ? jsonResponse(500, { error: "boom" }) : inner(url, init);
    const { logger, records } = captureLogger();
    const sub = makeSubscriber(api, { logger });
    await sub.start();
    await sub.close();

    expect(records.map((r) => r.event)).toEqual([
      "chat_subscription_prune_failed",
      "chat_subscription_renewed",
    ]);
    expect(sub.currentSubscription).toBe("subscriptions/a");
  });

  it("renews again when the renewal timer fires", async () => {
    vi.useFakeTimers();
    const api = new FakeWeApi([activeSub("subscriptions/x")]);
    const sub = makeSubscriber(api, { renewIntervalMs: 1000 });
    await sub.start();
    expect(api.count("PATCH")).toBe(1);

    await vi.advanceTimersByTimeAsync(1000);
    expect(api.count("PATCH")).toBe(2);

    await vi.advanceTimersByTimeAsync(1000);
    expect(api.count("PATCH")).toBe(3);

    await sub.close();
    await vi.advanceTimersByTimeAsync(5000);
    expect(api.count("PATCH")).toBe(3); // no more after close
  });

  it("resolves start() after a failed first pass and retries until create succeeds", async () => {
    vi.useFakeTimers();
    const api = new FakeWeApi([]);
    api.createStatus = 503;
    const { logger, records } = captureLogger();
    const sub = makeSubscriber(api, { logger });

    await sub.start();
    expect(sub.currentSubscription).toBeNull();
    expect(records).toEqual([
      {
        level: "warn",
        event: "chat_subscription_boot_failed",
        fields: expect.objectContaining({ topic: TOPIC, retryInMs: FIRST_RETRY_MS }),
      },
    ]);
    expect((records[0]?.fields?.err as Error).message).toMatch(/HTTP 503/);

    // Still failing at the first retry; the second retry waits twice as long.
    await vi.advanceTimersByTimeAsync(FIRST_RETRY_MS);
    expect(api.count("POST", "/subscriptions")).toBe(2);
    expect(records.at(-1)).toMatchObject({
      event: "chat_subscription_retry_failed",
      fields: { retryInMs: 2 * FIRST_RETRY_MS },
    });

    api.createStatus = null;
    await vi.advanceTimersByTimeAsync(2 * FIRST_RETRY_MS);
    expect(sub.currentSubscription).toBe("subscriptions/new-0");
    expect(api.count("POST", "/subscriptions")).toBe(3);
    expect(records.at(-1)?.event).toBe("chat_subscription_created");
    await sub.close();
  });

  it("stops the retry loop on close after a failed first pass", async () => {
    vi.useFakeTimers();
    const api = new FakeWeApi([]);
    api.createStatus = 503;
    const sub = makeSubscriber(api);

    await sub.start();
    // The retry the failed boot armed is the whole point of the loop; disposal
    // has to take it back down, or a stopped service keeps calling the API.
    const callsAtClose = api.calls.length;
    await sub.close();

    await vi.advanceTimersByTimeAsync(4 * MAX_RETRY_MS);
    expect(api.calls).toHaveLength(callsAtClose);
    expect(sub.currentSubscription).toBeNull();
  });

  it("close returns with the request in flight still outstanding, and the pass that resumes is inert", async () => {
    vi.useFakeTimers();
    const alerts: SystemChatSubscriptionLapseEvent[] = [];
    const api = new FakeWeApi([activeSub("subscriptions/stuck")]);
    api.renewStatus = 500;
    // A request that never answers on its own: shutdown must not wait on it.
    let openGate: () => void = () => {};
    let gate: Promise<void> | null = null;
    const answer = api.fetch;
    api.fetch = async (url, init) => {
      if (gate) await gate;
      return answer(url, init);
    };
    const { logger, records } = captureLogger();
    const sub = makeSubscriber(api, {
      logger,
      onLapse: (event) => {
        alerts.push(event);
      },
    });

    await sub.start();
    // A TTL of failing renewals: the next failed pass is the one that would alert.
    await vi.advanceTimersByTimeAsync(TTL_MS);
    expect(alerts).toEqual([]);
    gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    await vi.advanceTimersByTimeAsync(MAX_RETRY_MS);
    const callsWhileStalled = api.calls.length;
    const recordsWhileStalled = records.length;

    // Bounded: close comes back while the request is still outstanding.
    let closed = false;
    const closing = sub.close().then(() => {
      closed = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(closed).toBe(true);
    await closing;

    // Inert: the request it was already holding lands, and then nothing — no
    // follow-up call, no lapse alert, no successor armed. Its failure is a
    // debug record, not a `*_failed` warn or a `lapsed` error.
    openGate();
    await vi.advanceTimersByTimeAsync(4 * MAX_RETRY_MS);
    expect(api.calls).toHaveLength(callsWhileStalled + 1);
    expect(api.calls.at(-1)?.method).toBe("GET");
    expect(alerts).toEqual([]);
    expect(
      records.slice(recordsWhileStalled).map((record) => [record.level, record.event])
    ).toEqual([["debug", "chat_subscription_pass_abandoned"]]);
  });

  it("refuses to start again after close, so an abandoned pass is never un-gated", async () => {
    vi.useFakeTimers();
    const api = new FakeWeApi([activeSub("subscriptions/stuck")]);
    // Hold the list open across close(): the pass is abandoned mid-request.
    let openGate: () => void = () => {};
    let gate: Promise<void> | null = null;
    const answer = api.fetch;
    api.fetch = async (url, init) => {
      if (gate) await gate;
      return answer(url, init);
    };
    const sub = makeSubscriber(api);

    await sub.start();
    gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    await vi.advanceTimersByTimeAsync(RENEW_MS);
    const callsWhileStalled = api.calls.length;
    await sub.close();

    // A restart on a disposed instance is a no-op: it runs no boot pass of its
    // own, and it does not flip the gate the abandoned pass is held behind.
    const restarted = sub.start();
    openGate();
    await restarted;
    await vi.advanceTimersByTimeAsync(4 * RENEW_MS);
    expect(api.calls).toHaveLength(callsWhileStalled + 1);
    expect(api.calls.at(-1)?.method).toBe("GET");
  });

  it("backs off exponentially to a ceiling and starts over after a success", async () => {
    vi.useFakeTimers();
    const api = new FakeWeApi([activeSub("subscriptions/existing")]);
    api.renewStatus = 503;
    const { logger, records } = captureLogger();
    const sub = makeSubscriber(api, { logger });
    const retryDelays = () =>
      records.filter((r) => r.event.endsWith("_failed")).map((r) => r.fields?.retryInMs as number);

    await sub.start();
    for (const delay of [5, 10, 20, 40, 80, 160, 300, 300].map((s) => s * SECOND)) {
      expect(retryDelays().at(-1)).toBe(delay);
      await vi.advanceTimersByTimeAsync(delay);
    }
    expect(retryDelays().at(-1)).toBe(MAX_RETRY_MS);
    expect(sub.currentSubscription).toBe("subscriptions/existing");

    // Recovery: the next retry renews, and the loop returns to the renewal cadence.
    api.renewStatus = null;
    await vi.advanceTimersByTimeAsync(MAX_RETRY_MS);
    expect(records.at(-1)?.event).toBe("chat_subscription_renewed");
    const patchesAfterRecovery = api.count("PATCH");
    await vi.advanceTimersByTimeAsync(TTL_MS / 2 - SECOND);
    expect(api.count("PATCH")).toBe(patchesAfterRecovery);

    // A later failure starts the backoff from the beginning again.
    api.renewStatus = 503;
    await vi.advanceTimersByTimeAsync(SECOND);
    expect(records.at(-1)).toMatchObject({
      event: "chat_subscription_retry_failed",
      fields: { retryInMs: FIRST_RETRY_MS },
    });
    await sub.close();
  });

  it("recreates a missing subscription on a later renewal tick", async () => {
    vi.useFakeTimers();
    const api = new FakeWeApi([activeSub("subscriptions/old")]);
    const sub = makeSubscriber(api);
    await sub.start();
    api.subs = [];

    await vi.advanceTimersByTimeAsync(TTL_MS / 2);

    expect(sub.currentSubscription).toBe("subscriptions/new-0");
    expect(api.count("POST", "/subscriptions")).toBe(1);
    await sub.close();
  });

  it("prunes an expired subscription and creates a fresh one instead of renewing it", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse("2026-09-19T12:00:00.000Z"));
    const api = new FakeWeApi([
      { ...activeSub("subscriptions/expired"), expireTime: "2026-09-19T10:00:00.000Z" },
    ]);
    const { logger, records } = captureLogger();
    const sub = makeSubscriber(api, { logger });

    await sub.start();

    expect(sub.currentSubscription).toBe("subscriptions/new-0");
    expect(api.count("PATCH")).toBe(0);
    expect(api.count("POST", "/subscriptions")).toBe(1);
    expect(api.subs.map((s) => s.name)).toEqual(["subscriptions/new-0"]);
    expect(records[0]).toMatchObject({
      event: "chat_subscription_pruned",
      fields: { subscriptionName: "subscriptions/expired", reason: "lapsed" },
    });
    await sub.close();
  });

  it("recreates when renewal reports that the subscription is missing", async () => {
    const api = new FakeWeApi([activeSub("subscriptions/missing")]);
    api.renewStatus = 404;
    const { logger, records } = captureLogger();
    const sub = makeSubscriber(api, { logger });

    await sub.start();

    expect(sub.currentSubscription).toBe("subscriptions/new-0");
    expect(api.count("POST", "/subscriptions")).toBe(1);
    expect(records.map((r) => r.event)).toEqual([
      "chat_subscription_renew_missing_recreating",
      "chat_subscription_recreated",
    ]);
    await sub.close();
  });

  it("alerts once per hour after a TTL without a confirmed renewal, even while the subscription stays listed", async () => {
    vi.useFakeTimers();
    const alerts: SystemChatSubscriptionLapseEvent[] = [];
    // The subscription keeps appearing in list() but every renewal fails with a
    // shape the subscriber does not recognise as "gone": only a confirmed
    // renewal may count as activity, or this lapse would never be reported.
    const api = new FakeWeApi([activeSub("subscriptions/stuck")]);
    api.renewStatus = 500;
    const { logger, records } = captureLogger();
    const sub = makeSubscriber(api, {
      logger,
      onLapse: (event) => {
        alerts.push(event);
      },
    });
    await sub.start();

    await vi.advanceTimersByTimeAsync(TTL_MS);
    expect(alerts).toEqual([]);
    await vi.advanceTimersByTimeAsync(MAX_RETRY_MS);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      // The payload the host hands to the mesh unchanged, so it asserts the
      // event `type` the root inbox routes on alongside the diagnosis fields.
      type: "system.chat_subscription_lapsed",
      topic: TOPIC,
      subscriptionName: "subscriptions/stuck",
      expectedTtlSeconds: 14400,
    });
    expect(alerts[0]?.elapsedSeconds).toBeGreaterThanOrEqual(14400);
    expect(alerts[0]?.message).toContain("subscriptions/stuck");
    expect(records.filter((r) => r.event === "chat_subscription_lapsed")).toHaveLength(1);

    // Bounded: the retries keep going, the alert does not repeat inside the hour.
    await vi.advanceTimersByTimeAsync(HOUR - MAX_RETRY_MS);
    expect(alerts).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(MAX_RETRY_MS);
    expect(alerts).toHaveLength(2);

    // A confirmed renewal ends the lapse; a later one is reported afresh.
    api.renewStatus = null;
    await vi.advanceTimersByTimeAsync(MAX_RETRY_MS);
    expect(records.at(-1)?.event).toBe("chat_subscription_renewed");
    api.renewStatus = 500;
    await vi.advanceTimersByTimeAsync(TTL_MS + MAX_RETRY_MS);
    expect(alerts).toHaveLength(3);
    await sub.close();
  });

  it("alerts when an adopted subscription's own expireTime passes, not a TTL after boot", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse("2026-09-19T12:00:00.000Z"));
    const alerts: SystemChatSubscriptionLapseEvent[] = [];
    // Restart onto a subscription that was last renewed elsewhere and has 30
    // minutes left; every renewal, and every replacement create once it has
    // expired, fails. Delivery stops at 12:30, so the alert must follow that
    // expiry rather than wait until 16:00.
    const api = new FakeWeApi([
      { ...activeSub("subscriptions/ageing"), expireTime: "2026-09-19T12:30:00.000Z" },
    ]);
    api.renewStatus = 500;
    api.createStatus = 500;
    const sub = makeSubscriber(api, {
      onLapse: (event) => {
        alerts.push(event);
      },
    });
    await sub.start();

    await vi.advanceTimersByTimeAsync(30 * MINUTE - SECOND);
    expect(alerts).toEqual([]);
    await vi.advanceTimersByTimeAsync(MAX_RETRY_MS + SECOND);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.elapsedSeconds).toBeGreaterThanOrEqual(14400);
    await sub.close();
  });

  it("times the lapse from the kept subscription, not from a suspended leftover that expires later", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse("2026-09-19T12:00:00.000Z"));
    const alerts: SystemChatSubscriptionLapseEvent[] = [];
    // Restart onto a SUSPENDED leftover that stays listed until 15:00 (its
    // prune keeps failing, and so does its reactivation) beside the ACTIVE
    // subscription delivery actually rests on, expiring 12:30. The leftover
    // delivers nothing, so its later expiry must not delay the alert.
    const api = new FakeWeApi([
      {
        ...activeSub("subscriptions/susp"),
        state: "SUSPENDED",
        expireTime: "2026-09-19T15:00:00.000Z",
      },
      { ...activeSub("subscriptions/live"), expireTime: "2026-09-19T12:30:00.000Z" },
    ]);
    const inner = api.fetch;
    api.fetch = async (url, init) =>
      init?.method === "DELETE" ? jsonResponse(500, { error: "boom" }) : inner(url, init);
    api.renewStatus = 500;
    api.createStatus = 500;
    api.reactivateStatus = 500;
    const sub = makeSubscriber(api, {
      onLapse: (event) => {
        alerts.push(event);
      },
    });
    await sub.start();
    expect(sub.currentSubscription).toBe("subscriptions/live");

    await vi.advanceTimersByTimeAsync(30 * MINUTE - SECOND);
    expect(alerts).toEqual([]);
    await vi.advanceTimersByTimeAsync(MAX_RETRY_MS + SECOND);
    expect(alerts).toHaveLength(1);
    await sub.close();
  });

  it("times the lapse from the expired subscription when reactivating the leftover fails", async () => {
    vi.useFakeTimers();
    // Restart at 12:40 onto nothing that delivers: the ACTIVE subscription
    // expired at 12:30 and the SUSPENDED leftover listed to 15:00 delivers
    // only if reactivation succeeds — here it fails, so the alert is due now.
    vi.setSystemTime(Date.parse("2026-09-19T12:40:00.000Z"));
    const alerts: SystemChatSubscriptionLapseEvent[] = [];
    const api = new FakeWeApi([
      {
        ...activeSub("subscriptions/susp"),
        state: "SUSPENDED",
        expireTime: "2026-09-19T15:00:00.000Z",
      },
      { ...activeSub("subscriptions/live"), expireTime: "2026-09-19T12:30:00.000Z" },
    ]);
    api.reactivateStatus = 500;
    const sub = makeSubscriber(api, {
      onLapse: (event) => {
        alerts.push(event);
      },
    });
    await sub.start();

    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.subscriptionName).toBe("subscriptions/susp");
    // One TTL before the 12:30 expiry is 08:30, so 4h10m without delivery.
    expect(alerts[0]?.elapsedSeconds).toBe(15_000);
    await sub.close();
  });

  it("restarts the lapse clock when reactivation succeeds, up to the unchanged expiry", async () => {
    vi.useFakeTimers();
    // Same restart, but reactivation succeeds: the leftover delivers again from
    // 12:40, so no alert is due until its own 15:00 expiry passes with every
    // renew still failing.
    vi.setSystemTime(Date.parse("2026-09-19T12:40:00.000Z"));
    const alerts: SystemChatSubscriptionLapseEvent[] = [];
    const api = new FakeWeApi([
      {
        ...activeSub("subscriptions/susp"),
        state: "SUSPENDED",
        expireTime: "2026-09-19T15:00:00.000Z",
      },
      { ...activeSub("subscriptions/live"), expireTime: "2026-09-19T12:30:00.000Z" },
    ]);
    api.renewStatus = 500;
    api.createStatus = 500;
    const sub = makeSubscriber(api, {
      onLapse: (event) => {
        alerts.push(event);
      },
    });
    await sub.start();
    expect(sub.currentSubscription).toBe("subscriptions/susp");
    expect(alerts).toEqual([]);

    await vi.advanceTimersByTimeAsync(2 * HOUR + 20 * MINUTE - SECOND);
    expect(alerts).toEqual([]);
    await vi.advanceTimersByTimeAsync(MAX_RETRY_MS + SECOND);
    expect(alerts).toHaveLength(1);
    await sub.close();
  });

  it("extends the lapse horizon by an ACTIVE duplicate that could not be pruned", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse("2026-09-19T12:00:00.000Z"));
    const alerts: SystemChatSubscriptionLapseEvent[] = [];
    // Both subscriptions deliver; the duplicate's prune fails, so it keeps
    // delivering until 13:00 after the kept one expires at 12:30.
    const api = new FakeWeApi([
      { ...activeSub("subscriptions/a"), expireTime: "2026-09-19T12:30:00.000Z" },
      { ...activeSub("subscriptions/b"), expireTime: "2026-09-19T13:00:00.000Z" },
    ]);
    const inner = api.fetch;
    api.fetch = async (url, init) =>
      init?.method === "DELETE" || init?.method === "PATCH"
        ? jsonResponse(500, { error: "boom" })
        : inner(url, init);
    api.createStatus = 500;
    const sub = makeSubscriber(api, {
      onLapse: (event) => {
        alerts.push(event);
      },
    });
    await sub.start();

    await vi.advanceTimersByTimeAsync(HOUR - SECOND);
    expect(alerts).toEqual([]);
    await vi.advanceTimersByTimeAsync(MAX_RETRY_MS + SECOND);
    expect(alerts).toHaveLength(1);
    await sub.close();
  });

  it("alerts with no subscription name when nothing was ever created", async () => {
    vi.useFakeTimers();
    const alerts: SystemChatSubscriptionLapseEvent[] = [];
    const api = new FakeWeApi([]);
    api.fetch = async () => jsonResponse(503, { error: "unavailable" });
    const sub = makeSubscriber(api, {
      onLapse: (event) => {
        alerts.push(event);
      },
    });
    await sub.start();

    await vi.advanceTimersByTimeAsync(TTL_MS + MAX_RETRY_MS);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ subscriptionName: null });
    expect(alerts[0]?.message).toContain("last subscription: none");
    await sub.close();
  });

  it("keeps retrying when the alert sink itself fails", async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const api = new FakeWeApi([]);
    api.fetch = async () => {
      attempts++;
      return jsonResponse(503, { error: "unavailable" });
    };
    const { logger, records } = captureLogger();
    const sub = makeSubscriber(api, {
      logger,
      onLapse: async () => {
        throw new Error("mesh unavailable");
      },
    });
    await sub.start();

    await vi.advanceTimersByTimeAsync(TTL_MS + MAX_RETRY_MS);
    expect(records.filter((r) => r.event === "chat_subscription_lapse_alert_failed")).toHaveLength(
      1
    );
    const attemptsSoFar = attempts;
    await vi.advanceTimersByTimeAsync(MAX_RETRY_MS);
    expect(attempts).toBe(attemptsSoFar + 1);
    await sub.close();
  });

  it("only renews and never alerts while the subscription is healthy", async () => {
    vi.useFakeTimers();
    const alerts: SystemChatSubscriptionLapseEvent[] = [];
    const api = new FakeWeApi([activeSub("subscriptions/stable")]);
    const { logger, records } = captureLogger();
    const sub = makeSubscriber(api, {
      logger,
      onLapse: (event) => {
        alerts.push(event);
      },
    });

    await sub.start();
    await vi.advanceTimersByTimeAsync(12 * HOUR);

    expect(api.count("POST", "/subscriptions")).toBe(0);
    expect(api.count("DELETE")).toBe(0);
    expect(api.count("PATCH")).toBe(7); // boot + one renewal every 2h
    expect(alerts).toEqual([]);
    expect(new Set(records.map((r) => r.event))).toEqual(new Set(["chat_subscription_renewed"]));
    await sub.close();
  });
});
