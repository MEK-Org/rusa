import { describe, expect, it } from "vitest";
import { FollowerEventQueue } from "./follower-event-queue.js";

describe("FollowerEventQueue", () => {
  it("serializes the terminal restarting batch behind an in-flight /events delivery", async () => {
    const queue = new FollowerEventQueue<{ status: string }>();
    const delivered: string[][] = [];
    let releaseFirstRequest: (() => void) | undefined;
    const firstRequestStarted = new Promise<void>((resolve) => {
      releaseFirstRequest = resolve;
    });
    let completeFirstRequest: (() => void) | undefined;
    const firstRequest = new Promise<void>((resolve) => {
      completeFirstRequest = resolve;
    });

    const deliver = async (batch: { events: Array<{ status: string }> }) => {
      delivered.push(batch.events.map((event) => event.status));
      if (delivered.length === 1) {
        releaseFirstRequest?.();
        await firstRequest;
      }
    };

    queue.enqueue({ status: "building" });
    void queue.flush(deliver);
    await firstRequestStarted;

    queue.enqueue({ status: "restarting" });
    const terminalFlush = queue.flush(deliver);
    await Promise.resolve();
    expect(delivered).toEqual([["building"]]);

    completeFirstRequest?.();
    await terminalFlush;
    expect(delivered).toEqual([["building"], ["restarting"]]);
  });
});
