import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { LocalTracker } from "./local-tracker.js";
import { createTrackerRequestHandler } from "./tracker-server.js";

describe("tracker server PR activity routes", () => {
  let server: Server | undefined;

  afterEach(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = undefined;
  });

  async function start() {
    const events: string[] = [];
    const tracker = new LocalTracker({
      repo: "rusa-e2e/scratch",
      baseUrl: "http://localhost:8084",
      botAccount: "rusa-e2e-bot",
      onEvent: (type, payload) => {
        events.push(`${type}.${String(payload.action)}`);
      },
    });
    server = createServer(createTrackerRequestHandler(tracker));
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const post = async (path: string, body: unknown = {}) => {
      const res = await fetch(`http://127.0.0.1:${port}/repos/rusa-e2e/scratch${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      return { status: res.status, json: (await res.json()) as Record<string, unknown> };
    };
    return { tracker, events, post };
  }

  it("drives a PR from open to merge, emitting each webhook", async () => {
    const { tracker, events, post } = await start();

    const opened = await post("/pulls", { title: "Fix flaky test", body: "Retries." });
    expect(opened.status).toBe(201);
    const n = opened.json.number as number;

    expect((await post(`/pulls/${n}/comments`, { body: "Looks close" })).status).toBe(201);
    expect(
      (await post(`/pulls/${n}/review-comments`, { body: "Off by one", path: "src/a.ts", line: 3 }))
        .status
    ).toBe(201);
    expect((await post(`/pulls/${n}/push`)).status).toBe(200);
    expect((await post(`/pulls/${n}/edit`, { title: "Fix the flaky test" })).status).toBe(200);
    expect((await post(`/pulls/${n}/close`, { merged: true })).status).toBe(200);

    expect(events).toEqual([
      "pull_request.opened",
      "issue_comment.created",
      "pull_request_review_comment.created",
      "pull_request.synchronize",
      "pull_request.edited",
      "pull_request.closed",
    ]);
    expect(tracker.getPr(n)?.state).toBe("closed");
  });

  it("refuses PR activity on a PR that does not exist", async () => {
    const { post } = await start();
    expect((await post("/pulls/99/comments", { body: "hi" })).status).toBe(404);
  });
});
