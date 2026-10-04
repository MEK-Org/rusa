import { describe, expect, it } from "vitest";
import { FollowerEventQueue } from "./follower-event-queue.js";
import type { FollowerEvent } from "./follower-hub.js";

describe("FollowerEventQueue", () => {
  it("serializes the terminal restarting batch behind an in-flight /events delivery", async () => {
    const queue = new FollowerEventQueue();
    const delivered: string[][] = [];
    let releaseFirstRequest: (() => void) | undefined;
    const firstRequestStarted = new Promise<void>((resolve) => {
      releaseFirstRequest = resolve;
    });
    let completeFirstRequest: (() => void) | undefined;
    const firstRequest = new Promise<void>((resolve) => {
      completeFirstRequest = resolve;
    });

    const event = (status: "building" | "restarting"): FollowerEvent => ({
      eventId: status,
      actorId: "$instance",
      message: {
        type: "update_status",
        updateId: status,
        status,
      },
    });
    const deliver = async (batch: { body: string }) => {
      delivered.push(
        (JSON.parse(batch.body) as { events: FollowerEvent[] }).events.map((event) =>
          event.message.type === "update_status" ? event.message.status : "unexpected"
        )
      );
      if (delivered.length === 1) {
        releaseFirstRequest?.();
        await firstRequest;
      }
    };

    queue.enqueue(event("building"));
    void queue.flush(deliver);
    await firstRequestStarted;

    queue.enqueue(event("restarting"));
    const terminalFlush = queue.flush(deliver);
    await Promise.resolve();
    expect(delivered).toEqual([["building"]]);

    completeFirstRequest?.();
    await terminalFlush;
    expect(delivered).toEqual([["building"], ["restarting"]]);
  });

  it("fences an ordinary flush waiting across two clears before the held request settles", async () => {
    const queue = new FollowerEventQueue();
    const sent: unknown[] = [];
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const enqueue = (id: string) =>
      queue.enqueue({
        eventId: id,
        actorId: "actor-1",
        message: { type: "ready", pid: 123 },
      });
    const deliver = async (batch: { body: string }) => {
      sent.push(JSON.parse(batch.body));
      if (sent.length === 1) await held;
    };
    enqueue("old");
    const first = queue.flush(deliver, { session: "A" });
    queue.clear();
    const intermediate = queue.flush(deliver, { session: "B" });
    queue.clear();
    enqueue("new");
    const current = queue.flush(deliver, { session: "C" });
    release?.();
    await Promise.all([first, intermediate, current]);
    expect(sent).toMatchObject([
      { session: "A", events: [{ eventId: "old" }] },
      { session: "C", events: [{ eventId: "new" }] },
    ]);
    expect(queue.hasPending).toBe(false);
  });

  it("retries the bytes frozen at enqueue under the current envelope", async () => {
    const queue = new FollowerEventQueue();
    const event: FollowerEvent = {
      eventId: "original-id",
      actorId: "actor-1",
      message: { type: "log", chunk: "original" },
    };
    const original = JSON.stringify(event);
    queue.enqueue(event);
    const sent: { batchId: string; eventIds: string[]; body: string }[] = [];
    const deliver = async (batch: { batchId: string; eventIds: string[]; body: string }) => {
      sent.push(batch);
      if (sent.length === 1) throw new Error("synthetic lost acknowledgement");
    };
    const envelope = { id: "mac", session: "first" };
    await expect(queue.flush(deliver, envelope)).rejects.toThrow("synthetic lost acknowledgement");

    // The emitter reuses its object, and the session is renewed, before the retry.
    event.eventId = "changed-id";
    event.message = { type: "log", chunk: "changed, and longer than the original" };
    envelope.session = "second, renewed";
    await queue.flush(deliver, envelope);

    expect(queue.hasPending).toBe(false);
    expect(sent).toHaveLength(2);
    expect(sent[1].batchId).toBe(sent[0].batchId);
    expect(sent.map((batch) => batch.eventIds)).toEqual([["original-id"], ["original-id"]]);
    const bodies = sent.map((batch) => JSON.parse(batch.body));
    expect(bodies.map((body) => body.session)).toEqual(["first", "second, renewed"]);
    for (const [index, body] of bodies.entries()) {
      expect(body).toEqual({ ...body, id: "mac", batchId: sent[0].batchId });
      expect(body.events.map((sentEvent: unknown) => JSON.stringify(sentEvent))).toEqual([
        original,
      ]);
      expect(sent[index].body).toContain(original);
    }
  });
});
