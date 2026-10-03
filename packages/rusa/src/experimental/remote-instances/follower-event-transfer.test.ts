import { createHash, randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  FollowerEventAcceptanceFailedError,
  FollowerEventParkedError,
  FollowerEventQueue,
  FollowerEventTransferRetryError,
  type FollowerEventTransferSender,
} from "./follower-event-queue.js";
import {
  EVENT_TRANSFER_LIMITS,
  type EventTransferLimits,
  EventTransferReceiver,
} from "./follower-event-transfer.js";
import { type FollowerEvent, FollowerHub } from "./follower-hub.js";
import {
  EVENT_TRANSFER_CAPABILITY,
  type EventTransferCapability,
  type EventTransferFragment,
  type EventTransferReply,
  FOLLOWER_HTTP_BODY_LIMIT_BYTES,
  INSTANCE_PROTOCOL_VERSION,
  OLDEST_FOLLOWER_PROTOCOL_VERSION,
} from "./protocol.js";

const MiB = 1024 * 1024;
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

function fragmentsOf(event: FollowerEvent, transferId: string, fragmentBytes: number) {
  const bytes = Buffer.from(JSON.stringify(event), "utf8");
  const fragments: EventTransferFragment[] = [];
  for (let offset = 0, index = 0; offset < bytes.length; offset += fragmentBytes, index++) {
    const chunk = bytes.subarray(offset, offset + fragmentBytes);
    fragments.push({
      transferId,
      eventId: event.eventId,
      totalBytes: bytes.length,
      digest: sha256(bytes),
      index,
      offset,
      data: chunk.toString("base64"),
      fragmentDigest: sha256(chunk),
    });
  }
  return fragments;
}

const log = (eventId: string, chunk: string): FollowerEvent => ({
  eventId,
  actorId: "actor-1",
  message: { type: "log", chunk },
});
const ready = (eventId = "ready"): FollowerEvent => ({
  eventId,
  actorId: "actor-1",
  message: { type: "ready", pid: 123 },
});

describe("event transfer receiver", () => {
  const small: EventTransferLimits = {
    maxEventBytes: 4096,
    maxFragmentBytes: 64,
    maxTransfers: 2,
    maxReservedBytes: 1000,
    idleMs: 5 * 60_000,
    lifetimeMs: 30 * 60_000,
  };
  const never = () => undefined;

  it("reserves declared bytes, applies backpressure at either global bound, and releases on completion", () => {
    const receiver = new EventTransferReceiver(small);
    const a = fragmentsOf(log("a", "x".repeat(500)), "ta", 64);
    const b = fragmentsOf(log("b", "y".repeat(400)), "tb", 64);
    const c = fragmentsOf(log("c", "z".repeat(10)), "tc", 64);
    expect(receiver.accept("f1", "g1", a[0], never)).toMatchObject({ httpStatus: 200 });
    // Reserved bytes: 500+ already; a second 400+ byte declaration exceeds 1000.
    expect(receiver.accept("f2", "g2", b[0], never)).toEqual({
      httpStatus: 429,
      reply: { status: "busy", reason: "capacity" },
    });
    expect(receiver.accept("f3", "g3", c[0], never)).toMatchObject({ httpStatus: 200 });
    expect(receiver.usage.transfers).toBe(2);
    // Two incomplete transfers is the global count bound in this configuration.
    const d = fragmentsOf(log("d", "w"), "td", 64);
    expect(receiver.accept("f4", "g4", d[0], never)).toMatchObject({
      reply: { status: "busy", reason: "capacity" },
    });
    // One incomplete transfer per follower.
    const a2 = fragmentsOf(log("a2", "v"), "ta2", 64);
    expect(receiver.accept("f1", "g1", a2[0], never)).toMatchObject({
      httpStatus: 429,
      reply: { status: "busy", reason: "transfer_in_progress" },
    });
    let last: ReturnType<EventTransferReceiver["accept"]> | undefined;
    for (const fragment of a.slice(1)) last = receiver.accept("f1", "g1", fragment, never);
    expect(last && "bytes" in last && JSON.parse(last.bytes.toString())).toEqual(
      log("a", "x".repeat(500))
    );
    expect(receiver.usage.transfers).toBe(1);
    expect(receiver.accept("f2", "g2", b[0], never)).toMatchObject({ httpStatus: 200 });
  });

  it("acknowledges duplicate fragments without extending deadlines and expires idle or overlong staging", () => {
    let now = 0;
    const receiver = new EventTransferReceiver(small, () => now);
    const frags = fragmentsOf(log("a", "x".repeat(300)), "ta", 64);
    receiver.accept("f1", "g1", frags[0], never);
    now += 4 * 60_000;
    expect(receiver.accept("f1", "g1", frags[0], never)).toEqual({
      httpStatus: 200,
      reply: { status: "fragment", receivedBytes: 64 },
    });
    now += 2 * 60_000; // 6 minutes since the only accepted progress.
    expect(receiver.sweep()).toEqual(["f1"]);
    expect(receiver.usage).toEqual({ transfers: 0, reservedBytes: 0 });
    expect(receiver.accept("f1", "g1", frags[1], never)).toEqual({
      httpStatus: 409,
      reply: { status: "restart", reason: "unknown_transfer" },
    });

    // Progress every four minutes still ends at the thirty-minute lifetime.
    now = 0;
    const slow = fragmentsOf(log("s", "y".repeat(800)), "ts", 64);
    let index = 0;
    while (now <= 30 * 60_000) {
      expect(receiver.accept("f1", "g1", slow[index++], never)).toMatchObject({ httpStatus: 200 });
      now += 4 * 60_000;
    }
    expect(receiver.accept("f1", "g1", slow[index], never)).toMatchObject({
      reply: { status: "restart" },
    });
  });

  it("refuses conflicting fragments and declarations, and restarts on a gap", () => {
    const receiver = new EventTransferReceiver(small);
    const frags = fragmentsOf(log("a", "x".repeat(300)), "ta", 64);
    receiver.accept("f1", "g1", frags[0], never);
    const tampered = Buffer.from("y".repeat(64));
    expect(
      receiver.accept(
        "f1",
        "g1",
        { ...frags[0], data: tampered.toString("base64"), fragmentDigest: sha256(tampered) },
        never
      )
    ).toEqual({ httpStatus: 409, reply: { status: "refused", reason: "conflicting_fragment" } });
    expect(receiver.usage.transfers).toBe(0);

    receiver.accept("f1", "g1", frags[0], never);
    expect(receiver.accept("f1", "g1", { ...frags[1], totalBytes: 999 }, never)).toMatchObject({
      reply: { status: "refused", reason: "conflicting_declaration" },
    });

    receiver.accept("f1", "g1", frags[0], never);
    expect(receiver.accept("f1", "g1", frags[2], never)).toEqual({
      httpStatus: 409,
      reply: { status: "restart", reason: "non_contiguous" },
    });

    expect(
      receiver.accept("f1", "g1", { ...frags[0], fragmentDigest: "0".repeat(64) }, never)
    ).toMatchObject({ reply: { status: "refused", reason: "invalid_fragment" } });
    expect(receiver.accept("f1", "g1", { ...frags[0], data: "!!" }, never)).toMatchObject({
      reply: { status: "refused", reason: "invalid_fragment" },
    });
    expect(receiver.usage).toEqual({ transfers: 0, reservedBytes: 0 });
  });

  it("refuses declarations above the event maximum before staging anything", () => {
    const receiver = new EventTransferReceiver();
    const [first] = fragmentsOf(log("a", "x"), "ta", 64);
    expect(
      receiver.accept(
        "f1",
        "g1",
        { ...first, totalBytes: EVENT_TRANSFER_LIMITS.maxEventBytes + 1 },
        never
      )
    ).toEqual({
      httpStatus: 413,
      reply: { status: "refused", reason: "event_too_large", maxEventBytes: 64 * MiB },
    });
    expect(receiver.usage.transfers).toBe(0);
  });

  it("answers complete for a committed event at any fragment and discards a replaced generation", () => {
    const receiver = new EventTransferReceiver(small);
    const frags = fragmentsOf(log("a", "x".repeat(300)), "ta", 64);
    receiver.accept("f1", "g1", frags[0], never);
    expect(
      receiver.accept("f1", "g1", frags[3], (id) => (id === "a" ? "accepted" : undefined))
    ).toEqual({
      httpStatus: 200,
      reply: { status: "complete" },
    });
    expect(receiver.usage.transfers).toBe(0);
    receiver.accept("f1", "g1", frags[0], never);
    expect(receiver.accept("f1", "g2", frags[1], never)).toMatchObject({
      reply: { status: "restart", reason: "unknown_transfer" },
    });
  });
});

const hubs: FollowerHub[] = [];
afterEach(async () => {
  await Promise.all(hubs.splice(0).map((hub) => hub.close()));
});

async function setup(options?: { receiver?: EventTransferReceiver; protocolVersion?: number }) {
  const token = randomBytes(32).toString("hex");
  const hub = new FollowerHub(token, { eventTransfers: options?.receiver });
  hubs.push(hub);
  const origin = await hub.listen("127.0.0.1", 0);
  const post = (path: string, body: object) =>
    fetch(`${origin}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const identity = { id: "mac", session: "" };
  const register = async (generation = "process-one") => {
    const response = await post("/register", {
      id: "mac",
      platform: "darwin",
      pid: 123,
      generation,
      protocolVersion: options?.protocolVersion ?? INSTANCE_PROTOCOL_VERSION,
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      session: string;
      eventTransfer?: EventTransferCapability;
    };
    identity.session = body.session;
    return body;
  };
  const registration = await register();
  const received: unknown[] = [];
  const host = hub.createHost("mac", "actor-1");
  host.on("message", (message) => received.push(message));
  const requests: { path: string; bytes: number; status?: number }[] = [];
  const deliver = async (batch: { batchId: string; events: FollowerEvent[] }) => {
    const body = { ...identity, ...batch };
    requests.push({ path: "/events", bytes: Buffer.byteLength(JSON.stringify(body)) });
    const response = await post("/events", body);
    requests[requests.length - 1].status = response.status;
    const reply = (await response.json()) as { reason?: string; eventId?: string };
    if (response.status === 409 && reply.reason === "acceptance_failed" && reply.eventId) {
      throw new FollowerEventAcceptanceFailedError(reply.eventId);
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
  };
  const sender = (capability: EventTransferCapability): FollowerEventTransferSender => ({
    capability,
    send: async (fragment) => {
      const body = { ...identity, ...fragment };
      requests.push({ path: "/events/transfer", bytes: Buffer.byteLength(JSON.stringify(body)) });
      const response = await post("/events/transfer", body);
      requests[requests.length - 1].status = response.status;
      return (await response.json()) as EventTransferReply;
    },
  });
  return { hub, host, post, identity, register, registration, received, requests, deliver, sender };
}

/** Flush until drained, retrying transport and transfer retries like the follower does. */
async function drain(
  queue: FollowerEventQueue,
  flush: () => Promise<void>,
  attempts = 10
): Promise<unknown[]> {
  const errors: unknown[] = [];
  for (let n = 0; n < attempts && queue.hasPending; n++) {
    await flush().catch((error) => errors.push(error));
  }
  return errors;
}

describe("negotiated event transfer over the follower gateway", () => {
  it("keeps failed ordinary acceptance terminal across batches, renewal and transfer expiry", async () => {
    let now = 0;
    const h = await setup({
      receiver: new EventTransferReceiver(EVENT_TRANSFER_LIMITS, () => now),
    });
    const prefix = log("prefix", "accepted");
    const failed = log("failed", "private synthetic content");
    let sideEffects = 0;
    h.host.on("message", (message) => {
      if (message.type === "log" && message.chunk === "private synthetic content") sideEffects++;
    });
    h.host.on("message", (message) => {
      if (message.type === "log" && message.chunk === "private synthetic content") {
        throw new Error("private listener error must not escape");
      }
    });
    for (const batchId of ["first", "first", "changed"]) {
      const response = await h.post("/events", {
        ...h.identity,
        batchId,
        events: [prefix, failed, ready()],
      });
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({
        status: "refused",
        reason: "acceptance_failed",
        eventId: "failed",
      });
    }
    await h.register();
    now += 31 * 60_000;
    for (const transferId of ["retry-one", "retry-two"]) {
      const [fragment] = fragmentsOf(failed, transferId, MiB);
      const response = await h.post("/events/transfer", { ...h.identity, ...fragment });
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        status: "refused",
        reason: "acceptance_failed",
      });
    }
    expect(sideEffects).toBe(1);
    expect(h.received).toEqual([prefix.message, failed.message]);
    const accepted = await h.post("/events", {
      ...h.identity,
      batchId: "accepted-retry",
      events: [prefix],
    });
    expect(accepted.status).toBe(200);
    expect(h.received).toHaveLength(2);
  });

  it("parks a failed ordinary batch member behind its accepted prefix without resending", async () => {
    const h = await setup();
    const prefix = log("prefix", "accepted");
    const failed = log("failed", "synthetic failing content");
    const original = JSON.stringify(failed);
    let sideEffects = 0;
    h.host.on("message", (message) => {
      if (message.type === "log" && message.chunk === "synthetic failing content") sideEffects++;
    });
    h.host.on("message", (message) => {
      if (message.type === "log" && message.chunk === "synthetic failing content") {
        throw new Error("synthetic listener failure");
      }
    });
    const queue = new FollowerEventQueue();
    for (const event of [prefix, failed, ready()]) queue.enqueue(event);
    const first = await queue.flush(h.deliver, h.identity).catch((error) => error);
    expect(first).toBeInstanceOf(FollowerEventParkedError);
    expect(first).toMatchObject({
      reason: "acceptance_failed",
      eventId: "failed",
      repeated: false,
    });
    expect(h.requests.map((request) => request.status)).toEqual([409]);
    // Deterministic retries, including after session renewal, stay off the network.
    await h.register();
    await expect(queue.flush(h.deliver, h.identity)).rejects.toMatchObject({
      reason: "acceptance_failed",
      repeated: true,
    });
    expect(h.requests).toHaveLength(1);
    expect(queue.hasPending).toBe(true);
    expect(sideEffects).toBe(1);
    expect(h.received).toEqual([prefix.message, failed.message]);
    expect(JSON.stringify(failed)).toBe(original);
    // A new leader incarnation fences the old queue, as before.
    queue.clear();
    expect(queue.hasPending).toBe(false);
  });

  it("parks failed transfer acceptance with original bytes and never replays listeners", async () => {
    const h = await setup();
    const event = log("failed-large", "x".repeat(9 * MiB));
    const original = JSON.stringify(event);
    let sideEffects = 0;
    h.host.on("message", () => {
      sideEffects++;
    });
    h.host.on("message", () => {
      throw new Error("private failure");
    });
    const queue = new FollowerEventQueue();
    queue.enqueue(event);
    queue.enqueue(ready());
    const transfer = h.sender(h.registration.eventTransfer as EventTransferCapability);
    await expect(queue.flush(h.deliver, h.identity, transfer)).rejects.toMatchObject({
      reason: "acceptance_failed",
    });
    expect(queue.hasPending).toBe(true);
    const requests = h.requests.length;
    await h.register();
    await expect(
      queue.flush(h.deliver, h.identity, h.sender({ ...transfer.capability }))
    ).rejects.toMatchObject({ reason: "acceptance_failed" });
    expect(h.requests).toHaveLength(requests);
    expect(sideEffects).toBe(1);
    expect(JSON.stringify({ ...event, message: h.received[0] })).toBe(original);
    const response = await h.post("/events", {
      ...h.identity,
      batchId: "ordinary-retry",
      events: [event],
    });
    // The large ordinary request is still subject to the HTTP cap.
    expect(response.status).toBe(400);
  });

  it("advertises the capability to current and previous protocol followers", async () => {
    for (const protocolVersion of [INSTANCE_PROTOCOL_VERSION, OLDEST_FOLLOWER_PROTOCOL_VERSION]) {
      const h = await setup({ protocolVersion });
      expect(h.registration.eventTransfer).toEqual(EVENT_TRANSFER_CAPABILITY);
    }
  });

  it.each([
    ["an 8 MiB+ ASCII log", log("big-log", "x".repeat(9 * MiB))],
    [
      "an 8 MiB+ request/complete result",
      {
        eventId: "big-complete",
        actorId: "actor-1",
        message: {
          type: "request",
          requestId: 7,
          request: {
            op: "complete",
            result: { success: false, exitCode: 143, output: `${"\u0001".repeat(3 * MiB)}✓ tail` },
          },
        },
      } satisfies FollowerEvent,
    ],
    ["a 2,100,000-emoji log", log("big-emoji", "😀".repeat(2_100_000))],
  ])(
    "delivers %s with exact content, then the later ready event",
    async (_label, event) => {
      const h = await setup();
      const queue = new FollowerEventQueue();
      const transfer = h.sender(h.registration.eventTransfer as EventTransferCapability);
      const original = JSON.stringify(event);
      queue.enqueue(event);
      queue.enqueue(ready());
      expect(await drain(queue, () => queue.flush(h.deliver, h.identity, transfer))).toEqual([]);
      expect(queue.hasPending).toBe(false);
      expect(h.received).toEqual([event.message, ready().message]);
      expect(JSON.stringify({ ...event, message: h.received[0] })).toBe(original);
      const transferRequests = h.requests.filter((r) => r.path === "/events/transfer");
      expect(transferRequests.length).toBe(Math.ceil(Buffer.byteLength(original) / MiB));
      expect(Math.max(...h.requests.map((r) => r.bytes))).toBeLessThanOrEqual(
        FOLLOWER_HTTP_BODY_LIMIT_BYTES
      );
      expect(h.requests.every((r) => r.status === 200)).toBe(true);
    },
    60_000
  );

  it("sends the batch exactly at the body limit ordinarily and one byte over by transfer", async () => {
    const h = await setup();
    const transfer = h.sender(h.registration.eventTransfer as EventTransferCapability);
    const envelopeBytes = (chunk: string) =>
      Buffer.byteLength(
        JSON.stringify({ ...h.identity, batchId: "0".repeat(36), events: [log("edge", chunk)] })
      );
    const fill = "x".repeat(FOLLOWER_HTTP_BODY_LIMIT_BYTES - envelopeBytes(""));
    expect(envelopeBytes(fill)).toBe(FOLLOWER_HTTP_BODY_LIMIT_BYTES);
    const queue = new FollowerEventQueue();
    queue.enqueue(log("edge", fill));
    queue.enqueue(log("over", `${fill}x`));
    queue.enqueue(ready());
    expect(await drain(queue, () => queue.flush(h.deliver, h.identity, transfer))).toEqual([]);
    expect(h.requests[0]).toEqual({
      path: "/events",
      bytes: FOLLOWER_HTTP_BODY_LIMIT_BYTES,
      status: 200,
    });
    expect(h.requests.slice(1, -1).every((r) => r.path === "/events/transfer")).toBe(true);
    expect(h.requests.at(-1)?.path).toBe("/events");
    expect(h.received.map((m) => (m as { type: string }).type)).toEqual(["log", "log", "ready"]);
  });

  it("delivers once across lost intermediate and final acknowledgements", async () => {
    const h = await setup();
    const base = h.sender(h.registration.eventTransfer as EventTransferCapability);
    // Call 1 is fragment 1; call 10 is the final fragment 9 (after one retry).
    const lose = new Set([1, 10]);
    let calls = 0;
    const transfer: FollowerEventTransferSender = {
      capability: base.capability,
      send: async (fragment) => {
        const reply = await base.send(fragment);
        if (lose.delete(calls++)) throw new Error("synthetic lost acknowledgement");
        return reply;
      },
    };
    const event = log("big", "x".repeat(9 * MiB));
    const queue = new FollowerEventQueue();
    queue.enqueue(event);
    queue.enqueue(ready());
    const errors = await drain(queue, () => queue.flush(h.deliver, h.identity, transfer));
    expect(errors.map(String)).toEqual([
      "Error: synthetic lost acknowledgement",
      "Error: synthetic lost acknowledgement",
    ]);
    expect(h.received).toEqual([event.message, ready().message]);
  });

  it("completes a final acknowledgement lost after staging expiry from committed dedupe", async () => {
    let now = 0;
    const h = await setup({
      receiver: new EventTransferReceiver(EVENT_TRANSFER_LIMITS, () => now),
    });
    const base = h.sender(h.registration.eventTransfer as EventTransferCapability);
    let loseFinal = true;
    const replies: string[] = [];
    const transfer: FollowerEventTransferSender = {
      capability: base.capability,
      send: async (fragment) => {
        const reply = await base.send(fragment);
        replies.push(reply.status);
        if (reply.status === "complete" && loseFinal) {
          loseFinal = false;
          now += 31 * 60_000;
          throw new Error("synthetic lost final acknowledgement");
        }
        return reply;
      },
    };
    const event = log("big", "x".repeat(9 * MiB));
    const queue = new FollowerEventQueue();
    queue.enqueue(event);
    await drain(queue, () => queue.flush(h.deliver, h.identity, transfer));
    // The retried final fragment is answered from the existing event fence.
    expect(replies).toEqual([...Array(9).fill("fragment"), "complete", "complete"]);
    expect(h.received).toEqual([event.message]);
  });

  it("restarts from fragment zero after staging expiry with the same original event", async () => {
    let now = 0;
    const h = await setup({
      receiver: new EventTransferReceiver(EVENT_TRANSFER_LIMITS, () => now),
    });
    const base = h.sender(h.registration.eventTransfer as EventTransferCapability);
    const sent: string[] = [];
    const transfer: FollowerEventTransferSender = {
      capability: base.capability,
      send: async (fragment) => {
        if (sent.length === 1) now += 6 * 60_000;
        sent.push(`${fragment.transferId}:${fragment.eventId}:${fragment.index}`);
        return base.send(fragment);
      },
    };
    const event = log("big", "x".repeat(9 * MiB));
    const queue = new FollowerEventQueue();
    queue.enqueue(event);
    const errors = await drain(queue, () => queue.flush(h.deliver, h.identity, transfer));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(FollowerEventTransferRetryError);
    expect((errors[0] as FollowerEventTransferRetryError).reason).toBe("unknown_transfer");
    const [transferId] = sent[0].split(":");
    expect(sent).toEqual([
      `${transferId}:big:0`,
      `${transferId}:big:1`,
      ...Array.from({ length: 10 }, (_, index) => `${transferId}:big:${index}`),
    ]);
    expect(h.received).toEqual([event.message]);
  });

  it("resumes the same transfer after a same-process session renewal", async () => {
    const h = await setup();
    const base = h.sender(h.registration.eventTransfer as EventTransferCapability);
    let renewed = false;
    const transfer: FollowerEventTransferSender = {
      capability: base.capability,
      send: async (fragment) => {
        const reply = await base.send(fragment);
        if (fragment.index === 1 && !renewed) {
          renewed = true;
          await h.register();
        }
        return reply;
      },
    };
    const event = log("big", "x".repeat(9 * MiB));
    const queue = new FollowerEventQueue();
    queue.enqueue(event);
    expect(await drain(queue, () => queue.flush(h.deliver, h.identity, transfer))).toEqual([]);
    expect(h.requests.filter((r) => r.path === "/events/transfer")).toHaveLength(10);
    expect(h.received).toEqual([event.message]);
  });

  it("joins concurrent flushes and fences a queue cleared while a fragment is in flight", async () => {
    const h = await setup();
    const base = h.sender(h.registration.eventTransfer as EventTransferCapability);
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let sends = 0;
    const transfer: FollowerEventTransferSender = {
      capability: base.capability,
      send: async (fragment) => {
        sends++;
        const reply = await base.send(fragment);
        if (fragment.index === 0) await held;
        return reply;
      },
    };
    const queue = new FollowerEventQueue();
    queue.enqueue(log("old", "x".repeat(9 * MiB)));
    const first = queue.flush(h.deliver, h.identity, transfer);
    const joined = queue.flush(h.deliver, h.identity, transfer);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(sends).toBe(1);
    // Leader-incarnation fence: the old in-flight reply must not advance the new queue.
    queue.clear();
    queue.enqueue(ready("after-fence"));
    release?.();
    await Promise.all([first, joined]);
    // The new head was delivered on its own; the stale reply removed nothing.
    expect(queue.hasPending).toBe(false);
    expect(sends).toBe(1);
    expect(h.received).toEqual([ready().message]);
  });

  it("parks an oversized event visibly without network when the leader did not advertise transfer", async () => {
    const h = await setup();
    const queue = new FollowerEventQueue();
    queue.enqueue(log("big", "x".repeat(9 * MiB)));
    queue.enqueue(ready());
    const first = await queue.flush(h.deliver, h.identity).catch((e) => e);
    const second = await queue.flush(h.deliver, h.identity).catch((e) => e);
    expect(first).toBeInstanceOf(FollowerEventParkedError);
    expect(first).toMatchObject({
      reason: "capability_missing",
      eventId: "big",
      eventType: "log",
      limitBytes: FOLLOWER_HTTP_BODY_LIMIT_BYTES,
      repeated: false,
    });
    expect(String(first.message)).not.toContain("xxx");
    expect(second).toMatchObject({ reason: "capability_missing", repeated: true });
    expect(h.requests).toEqual([]);
    expect(h.received).toEqual([]);
    expect(queue.hasPending).toBe(true);

    // Capability arriving with a later registration releases the same event.
    const transfer = h.sender(h.registration.eventTransfer as EventTransferCapability);
    expect(await drain(queue, () => queue.flush(h.deliver, h.identity, transfer))).toEqual([]);
    expect(h.received.map((m) => (m as { type: string }).type)).toEqual(["log", "ready"]);
  });

  it("parks events above the maximum, and holds a leader refusal until a new capability", async () => {
    const limits = { ...EVENT_TRANSFER_LIMITS, maxEventBytes: 10 * MiB };
    const h = await setup({ receiver: new EventTransferReceiver(limits) });
    const queue = new FollowerEventQueue();
    // Sender-side bound: an event above 64 MiB never reaches the network.
    queue.enqueue(log("over-64", "x".repeat(64 * MiB)));
    // A follower holding an advertisement larger than this leader now enforces.
    const capability = EVENT_TRANSFER_CAPABILITY;
    const tooLarge = await queue.flush(h.deliver, h.identity, h.sender(capability)).catch((e) => e);
    expect(tooLarge).toMatchObject({ reason: "event_too_large", limitBytes: 64 * MiB });
    expect(h.requests).toEqual([]);

    // Leader-side bound below the follower's: refused, then parked without retry traffic.
    const refusedQueue = new FollowerEventQueue();
    refusedQueue.enqueue(log("over-10", "x".repeat(11 * MiB)));
    refusedQueue.enqueue(ready());
    const transfer = h.sender(capability);
    const refused = await refusedQueue.flush(h.deliver, h.identity, transfer).catch((e) => e);
    expect(refused).toMatchObject({
      reason: "event_too_large",
      limitBytes: 10 * MiB,
      repeated: false,
    });
    expect(h.requests.map((r) => r.status)).toEqual([413]);
    const again = await refusedQueue.flush(h.deliver, h.identity, transfer).catch((e) => e);
    expect(again).toMatchObject({ reason: "event_too_large", repeated: true });
    expect(h.requests).toHaveLength(1);
    expect(h.received).toEqual([]);
    expect(refusedQueue.hasPending).toBe(true);

    // A new registration's capability permits one fresh attempt.
    const retry = await refusedQueue
      .flush(h.deliver, h.identity, h.sender({ ...capability }))
      .catch((e) => e);
    expect(retry).toMatchObject({ reason: "event_too_large" });
    expect(h.requests).toHaveLength(2);
  });

  it("returns retryable backpressure at capacity and proceeds after release", async () => {
    const limits = { ...EVENT_TRANSFER_LIMITS, maxReservedBytes: 12 * MiB };
    const receiver = new EventTransferReceiver(limits);
    const h = await setup({ receiver });
    // Another follower's incomplete transfer holds 10 MiB of the 12 MiB budget.
    const other = fragmentsOf(log("other", "y".repeat(10 * MiB)), "other", MiB);
    expect(receiver.accept("other-follower", "g", other[0], () => undefined)).toMatchObject({
      httpStatus: 200,
    });
    const queue = new FollowerEventQueue();
    queue.enqueue(log("big", "x".repeat(9 * MiB)));
    const transfer = h.sender(h.registration.eventTransfer as EventTransferCapability);
    const busy = await queue.flush(h.deliver, h.identity, transfer).catch((e) => e);
    expect(busy).toBeInstanceOf(FollowerEventTransferRetryError);
    expect(busy).toMatchObject({ reason: "capacity", retryAfterMs: 5000 });
    expect(h.requests.map((r) => r.status)).toEqual([429]);
    receiver.discard("other-follower");
    expect(await drain(queue, () => queue.flush(h.deliver, h.identity, transfer))).toEqual([]);
    expect(h.received).toHaveLength(1);
    expect(receiver.usage).toEqual({ transfers: 0, reservedBytes: 0 });
  });

  it("refuses reassembled bytes that are not the declared event", async () => {
    const h = await setup();
    const notJson = Buffer.from("not an event");
    const response = await h.post("/events/transfer", {
      ...h.identity,
      transferId: "t1",
      eventId: "e1",
      totalBytes: notJson.length,
      digest: sha256(notJson),
      index: 0,
      offset: 0,
      data: notJson.toString("base64"),
      fragmentDigest: sha256(notJson),
    });
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ status: "refused", reason: "invalid_event" });
    expect(h.received).toEqual([]);
  });

  it("discards staging when a new follower process generation registers", async () => {
    const receiver = new EventTransferReceiver();
    const h = await setup({ receiver });
    const frags = fragmentsOf(log("big", "x".repeat(3 * MiB)), "t1", MiB);
    expect((await h.post("/events/transfer", { ...h.identity, ...frags[0] })).status).toBe(200);
    expect(receiver.usage.transfers).toBe(1);
    await h.register("process-two");
    expect(receiver.usage).toEqual({ transfers: 0, reservedBytes: 0 });
    const response = await h.post("/events/transfer", { ...h.identity, ...frags[1] });
    expect(await response.json()).toEqual({ status: "restart", reason: "unknown_transfer" });
  });
});
