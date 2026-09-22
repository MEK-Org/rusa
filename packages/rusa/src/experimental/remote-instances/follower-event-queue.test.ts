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
    const deliver = async (batch: { events: FollowerEvent[] }) => {
      delivered.push(
        batch.events.map((event) =>
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
});
