import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceEventsSubscriber } from "./workspace-events.js";

const TOPIC = "projects/p/topics/chat-events";
const CHAT_TARGET = "//chat.googleapis.com/spaces/-";
const MESSAGE_CREATED = "google.workspace.chat.message.v1.created";

interface FakeSub {
  name: string;
  state: string;
  notificationEndpoint: { pubsubTopic: string };
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
      return jsonResponse(200, { subscriptions: this.subs });
    }
    if (method === "POST" && path === "/subscriptions") {
      this.subs.push({
        name: `subscriptions/new-${this.seq++}`,
        state: "ACTIVE",
        notificationEndpoint: { pubsubTopic: body.notificationEndpoint.pubsubTopic },
      });
      return jsonResponse(200, { name: "operations/op1" });
    }
    const name = path.replace(/^\//, "").replace(/:reactivate$/, "");
    const sub = this.subs.find((s) => s.name === name);
    if (method === "PATCH") return jsonResponse(200, { name: "operations/patch" });
    if (method === "POST" && path.endsWith(":reactivate")) {
      if (sub) sub.state = "ACTIVE";
      return jsonResponse(200, { name: "operations/reactivate" });
    }
    if (method === "DELETE") {
      this.subs = this.subs.filter((s) => s.name !== name);
      return jsonResponse(200, {});
    }
    return jsonResponse(404, { error: "not found" });
  };

  countWhere(pred: (c: Call) => boolean): number {
    return this.calls.filter(pred).length;
  }
}

function makeSubscriber(api: FakeWeApi, overrides: Partial<{ renewIntervalMs: number }> = {}) {
  return new WorkspaceEventsSubscriber({
    topic: TOPIC,
    getToken: async () => "fake-token",
    fetchImpl: api.fetch,
    renewIntervalMs: overrides.renewIntervalMs,
  });
}

describe("WorkspaceEventsSubscriber", () => {
  afterEach(() => vi.useRealTimers());

  it("creates a subscription when none exists", async () => {
    const api = new FakeWeApi([]);
    const sub = makeSubscriber(api);
    await sub.start();
    await sub.close();

    expect(api.countWhere((c) => c.method === "POST" && c.path === "/subscriptions")).toBe(1);
    expect(api.subs).toHaveLength(1);
    expect(api.subs[0]?.notificationEndpoint.pubsubTopic).toBe(TOPIC);
    expect(sub.currentSubscription).toBe(api.subs[0]?.name);

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
    const api = new FakeWeApi([
      {
        name: "subscriptions/existing",
        state: "ACTIVE",
        notificationEndpoint: { pubsubTopic: TOPIC },
      },
    ]);
    const sub = makeSubscriber(api);
    await sub.start();
    await sub.close();

    expect(api.countWhere((c) => c.method === "POST" && c.path === "/subscriptions")).toBe(0);
    expect(api.countWhere((c) => c.method === "PATCH")).toBe(1);
    const patch = api.calls.find((c) => c.method === "PATCH");
    expect(patch?.path).toContain("subscriptions/existing");
    expect(patch?.body).toEqual({ ttl: "14400s" });
    expect(sub.currentSubscription).toBe("subscriptions/existing");
  });

  it("reactivates a suspended subscription before renewing", async () => {
    const api = new FakeWeApi([
      {
        name: "subscriptions/susp",
        state: "SUSPENDED",
        notificationEndpoint: { pubsubTopic: TOPIC },
      },
    ]);
    const sub = makeSubscriber(api);
    await sub.start();
    await sub.close();

    expect(api.countWhere((c) => c.path.endsWith(":reactivate"))).toBe(1);
    expect(api.countWhere((c) => c.method === "PATCH")).toBe(1);
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
    expect(api.countWhere((c) => c.method === "POST" && c.path === "/subscriptions")).toBe(1);
    expect(api.countWhere((c) => c.method === "DELETE")).toBe(0);
  });

  it("prunes duplicate subscriptions for our topic", async () => {
    const api = new FakeWeApi([
      { name: "subscriptions/a", state: "ACTIVE", notificationEndpoint: { pubsubTopic: TOPIC } },
      { name: "subscriptions/b", state: "ACTIVE", notificationEndpoint: { pubsubTopic: TOPIC } },
      { name: "subscriptions/c", state: "ACTIVE", notificationEndpoint: { pubsubTopic: TOPIC } },
    ]);
    const sub = makeSubscriber(api);
    await sub.start();
    await sub.close();

    expect(api.countWhere((c) => c.method === "DELETE")).toBe(2);
    expect(api.subs.map((s) => s.name)).toEqual(["subscriptions/a"]);
    expect(sub.currentSubscription).toBe("subscriptions/a");
  });

  it("renews again when the renewal timer fires", async () => {
    vi.useFakeTimers();
    const api = new FakeWeApi([
      { name: "subscriptions/x", state: "ACTIVE", notificationEndpoint: { pubsubTopic: TOPIC } },
    ]);
    const sub = makeSubscriber(api, { renewIntervalMs: 1000 });
    await sub.start();
    expect(api.countWhere((c) => c.method === "PATCH")).toBe(1);

    await vi.advanceTimersByTimeAsync(1000);
    expect(api.countWhere((c) => c.method === "PATCH")).toBe(2);

    await vi.advanceTimersByTimeAsync(1000);
    expect(api.countWhere((c) => c.method === "PATCH")).toBe(3);

    await sub.close();
    await vi.advanceTimersByTimeAsync(5000);
    expect(api.countWhere((c) => c.method === "PATCH")).toBe(3); // no more after close
  });

  it("surfaces an HTTP error from start()", async () => {
    const api = new FakeWeApi([]);
    api.fetch = async () => jsonResponse(403, { error: "forbidden" });
    const sub = makeSubscriber(api);
    await expect(sub.start()).rejects.toThrow(/HTTP 403/);
  });
});
