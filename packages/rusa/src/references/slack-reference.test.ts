import Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { actorInbox } from "../db/migrations/0003_actor_inbox.js";
import { actorInboxSeen } from "../db/migrations/0012_actor_inbox_seen.js";
import { actorInboxHandledNote } from "../db/migrations/0015_actor_inbox_handled_note.js";
import type { ReferenceCacheRepository } from "../db/repositories/reference-cache-repository.js";
import { SqliteInboxRepository } from "../db/repositories/sqlite-inbox-repository.js";
import { ReferenceCacheService } from "./cache-service.js";
import { resolveReference } from "./resolve.js";

const ref = "slack:channels/C123/messages/1720000000.000001";
const slackClient = {
  getChannel: vi.fn().mockResolvedValue({ id: "C123", name: "test" }),
  getMessage: vi.fn().mockResolvedValue({
    channel: "C123",
    ts: "1720000000.000001",
    text: "The decision is yes",
    user: "U123",
  }),
  installationWorkspaceId: undefined,
};

describe("Slack obligation references", () => {
  it("fetches the exact message body and preserves a browsable URL", async () => {
    const result = await resolveReference(ref, { slackClient });
    expect(slackClient.getMessage).toHaveBeenCalledWith("C123", "1720000000.000001");
    expect(result.body).toBe("The decision is yes");
    expect(result.entity).toEqual({ type: "slack_message", contents: "The decision is yes" });
    expect(result.url).toBe("https://app.slack.com/archives/C123/p1720000000000001");
  });

  it("retains message contents in the dashboard reference cache", async () => {
    const rows = new Map<string, unknown>();
    const repo = {
      get: (key: string) => rows.get(key) ?? null,
      set: (row: { ref: string }) => {
        rows.set(row.ref, row);
      },
    } as unknown as ReferenceCacheRepository;
    const cache = new ReferenceCacheService({ repo, deadlineMs: 1000 });
    expect((await cache.get(ref, { slackClient })).entity).toEqual({
      type: "slack_message",
      contents: "The decision is yes",
    });
    expect((await cache.get(ref, { slackClient })).entity).toEqual({
      type: "slack_message",
      contents: "The decision is yes",
    });
    expect(slackClient.getMessage).toHaveBeenCalledTimes(2);
  });
});

describe("Slack message references across workspaces (#1038)", () => {
  let inbox: SqliteInboxRepository;

  beforeEach(() => {
    const db = new Database(":memory:");
    actorInbox.up(db);
    actorInboxSeen.up(db);
    actorInboxHandledNote.up(db);
    inbox = new SqliteInboxRepository(db);
  });

  /** An inbox row delivering the referenced message to `actorId`. */
  function delivered(actorId: string, workspaceId?: string) {
    inbox.append([
      {
        actorId,
        source: "slack:channels/C123",
        payload: {
          type: "slack.message",
          messageRef: ref,
          channel: "C123",
          ts: "1720000000.000001",
          senderName: "U123",
          ...(workspaceId ? { workspaceId } : {}),
          priority: "responsive",
        },
      },
    ]);
  }

  /** A connection installed in `workspaceId`, or one whose workspace is unknown. */
  function connection(workspaceId: string | undefined) {
    return {
      getChannel: vi.fn(),
      getMessage: vi.fn().mockResolvedValue({
        channel: "C123",
        ts: "1720000000.000001",
        text: "The decision is yes",
        user: "U123",
      }),
      installationWorkspaceId: workspaceId,
    };
  }

  function emptyCache() {
    const rows = new Map<string, unknown>();
    const repo = {
      get: (key: string) => rows.get(key) ?? null,
      set: (row: { ref: string }) => {
        rows.set(row.ref, row);
      },
    } as unknown as ReferenceCacheRepository;
    return { rows, cache: new ReferenceCacheService({ repo, deadlineMs: 1000 }) };
  }

  it("refuses a reference issued in another workspace, before any read and caching nothing", async () => {
    delivered("actor-a", "T0HOME");
    const slackClient = connection("T0OTHER");
    const result = await resolveReference(ref, { slackClient, inbox });
    expect(result).toMatchObject({ body: null, unavailable: expect.stringMatching(/workspace/) });
    expect(result.entity).toBeUndefined();

    const { rows, cache } = emptyCache();
    expect((await cache.get(ref, { slackClient, inbox })).entity).toBeUndefined();
    expect(rows.size).toBe(0);
    expect(slackClient.getMessage).not.toHaveBeenCalled();
  });

  it.each([
    ["fresh", undefined, "T0OTHER", /another workspace/],
    ["stale", 0, "T0OTHER", /another workspace/],
    ["fresh", undefined, undefined, /unknown/],
  ] as Array<
    [string, number | undefined, string | undefined, RegExp]
  >)("refuses a %s cached reference once the active workspace is %s", async (_state, ttlMs, later, reason) => {
    delivered("actor-a", "T0HOME");
    const rows = new Map<string, unknown>();
    const repo = {
      get: (key: string) => rows.get(key) ?? null,
      set: (row: { ref: string }) => {
        rows.set(row.ref, row);
      },
    } as unknown as ReferenceCacheRepository;
    const cache = new ReferenceCacheService({ repo, deadlineMs: 1000, ttlMs });
    const home = connection("T0HOME");
    expect((await cache.get(ref, { slackClient: home, inbox })).entity).toEqual({
      type: "slack_message",
      contents: "The decision is yes",
    });
    expect(rows.size).toBe(1);

    const other = connection(later);
    const result = await cache.get(ref, { slackClient: other, inbox });
    expect(result.unavailable).toMatch(reason);
    expect(result.entity).toBeUndefined();
    await new Promise((resolve) => setImmediate(resolve));
    expect(other.getMessage).not.toHaveBeenCalled();
  });

  it("resolves the same reference after reconnecting to the same workspace", async () => {
    delivered("actor-a", "T0HOME");
    const slackClient = connection("T0HOME");
    const result = await resolveReference(ref, { slackClient, inbox });
    expect(result).toMatchObject({ body: "The decision is yes", unavailable: null });
    expect(slackClient.getMessage).toHaveBeenCalledOnce();
  });

  it("refuses a proven reference while the active workspace is unknown", async () => {
    delivered("actor-a", "T0HOME");
    const slackClient = connection(undefined);
    const result = await resolveReference(ref, { slackClient, inbox });
    expect(result).toMatchObject({ body: null, unavailable: expect.stringMatching(/unknown/) });
    expect(slackClient.getMessage).not.toHaveBeenCalled();
  });

  it.each([
    ["no inbox row", [], undefined],
    ["no inbox row, workspace known", [], "T0OTHER"],
    ["only a row without a verified workspace", [["actor-a", undefined]], undefined],
  ] as Array<
    [string, Array<[string, string | undefined]>, string | undefined]
  >)("resolves a reference with %s as it did before #1038", async (_case, rows, active) => {
    for (const [actorId, workspaceId] of rows) delivered(actorId, workspaceId);
    const slackClient = connection(active);
    const result = await resolveReference(ref, { slackClient, inbox });
    expect(result).toMatchObject({ body: "The decision is yes", unavailable: null });
    expect(slackClient.getMessage).toHaveBeenCalledOnce();
  });

  it.each([
    ["agree", "T0HOME", "The decision is yes"],
    ["disagree", "T0OTHER", null],
  ])("checks every actor's proof row, passing when they %s", async (_case, second, body) => {
    delivered("actor-a", "T0HOME");
    delivered("actor-b", second);
    const slackClient = connection("T0HOME");
    const result = await resolveReference(ref, { slackClient, inbox });
    expect(result.body).toBe(body);
    expect(slackClient.getMessage).toHaveBeenCalledTimes(body === null ? 0 : 1);
  });
});
