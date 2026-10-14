import Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  InMemoryEventSourceOwnerStore,
  InMemoryEventSourceSubscriptionStore,
  parentOf,
} from "../actor/event-subscriptions.js";
import { runMigrations } from "../db/migrations/runner.js";
import { SqliteInboxRepository } from "../db/repositories/sqlite-inbox-repository.js";
import type { InboxRepository } from "../repositories/inbox-repository.js";
import { EventManager, HierarchicalEventSourceResolver } from "../runtime/event-manager.js";
import { SlackClient } from "./slack-client.js";
import {
  rememberSlackSelf,
  SlackSocketSource,
  slackInboxEvent,
  withReceiptReaction,
} from "./socket-source.js";
import { slackWakeModeFromConfig, trySlackConversationResource } from "./wake-mode.js";

type SocketEnvelope = { type: string; body: unknown; ack: () => Promise<void> };
const mock = vi.hoisted(() => ({
  listeners: new Map<string, (envelope: SocketEnvelope) => Promise<void>>(),
}));

vi.mock("@slack/socket-mode", () => ({
  SocketModeClient: class {
    on(name: string, listener: (envelope: SocketEnvelope) => Promise<void>) {
      mock.listeners.set(name, listener);
    }
    async start() {}
    async disconnect() {}
  },
}));

// Synthetic identifiers only: the installed bot, a human, and one owner per conversation.
const BOT = "UBOT";
const HUMAN = "UHUMAN";
const CONVERSATIONS = [
  { channel: "D1", channelType: "im", owner: "owner-dm" },
  { channel: "C1", channelType: "channel", owner: "owner-public" },
  { channel: "G1", channelType: "group", owner: "owner-private" },
  { channel: "M1", channelType: "mpim", owner: "owner-group-dm" },
] as const;

const settle = () => new Promise((resolve) => setImmediate(resolve));

/**
 * The production composition from `start`, around a real SQLite inbox: the
 * socket source admits by the exact row's stored mode, the inbox event is keyed
 * by message identity, and the receipt follows durable acceptance.
 */
async function harness(
  options: {
    inbox?: (real: InboxRepository) => InboxRepository;
    /** How the first identity lookup, made as the source starts, answers. */
    firstIdentify?: () => Promise<{ ok: boolean; user_id?: string }>;
  } = {}
) {
  mock.listeners.clear();
  const owners = new InMemoryEventSourceOwnerStore();
  const subscriptions = new InMemoryEventSourceSubscriptionStore();
  const at = "2026-10-14T00:00:00.000Z";
  for (const { channel, owner } of CONVERSATIONS) {
    owners.subscribe({
      resource: `slack:channels/${channel}`,
      actorId: owner,
      subscribedBy: "root",
      subscribedAt: at,
    });
  }
  const db = new Database(":memory:");
  runMigrations(db);
  const realInbox = new SqliteInboxRepository(db);
  const inbox = options.inbox?.(realInbox) ?? realInbox;
  const manager = new EventManager({
    inboxStore: inbox,
    resolver: new HierarchicalEventSourceResolver({
      ports: {
        parentOf,
        isLive: () => true,
        activeDelegationsFor: (resource) => owners.activeForResource(resource),
        directSubscribersFor: (resource) => subscriptions.subscribersOf(resource),
        eventSourceConfigFor: (resource) => owners.getConfig(resource),
        resolveActor: (id) => ({ id }),
      },
    }),
  });

  // A real client over a recording Web API: only identity and receipts are
  // ever called, never anything that would change the app's access.
  const webCalls: string[] = [];
  const react = vi.fn(async (_args: { channel: string; timestamp: string }) => ({ ok: true }));
  const identify = vi.fn(
    async (): Promise<{ ok: boolean; user_id?: string }> => ({
      ok: true,
      user_id: BOT,
    })
  );
  if (options.firstIdentify) identify.mockImplementationOnce(options.firstIdentify);
  const slack = new SlackClient("xoxb-synthetic");
  const recording = (name: string, fn: (...args: never[]) => unknown) =>
    vi.fn((...args: never[]) => {
      webCalls.push(name);
      return fn(...args);
    });
  Object.defineProperty(slack, "web", {
    value: { reactions: { add: recording("reactions.add", react) } },
  });
  // Identity goes through the bounded client, which neither retries nor waits
  // out a rate limit.
  Object.defineProperty(slack, "historyWeb", {
    value: { auth: { test: recording("auth.test", identify) } },
  });

  const deliver = vi.fn(async (message: Parameters<typeof slackInboxEvent>[0]) =>
    manager.handleExternalEvent(slackInboxEvent(message))
  );
  const onError = vi.fn();
  const onReactionError = vi.fn();
  await new SlackSocketSource("xapp-synthetic", onError).start(
    withReceiptReaction(deliver, (channel, ts) => slack.react(channel, ts), onReactionError),
    {
      selfUserId: rememberSlackSelf(() => slack.identify(), onError),
      wakeModeFor: (channel) => {
        const resource = trySlackConversationResource(channel);
        return resource ? slackWakeModeFromConfig(owners.getConfig(resource)) : undefined;
      },
    }
  );
  // Let the identity lookup made at start settle, as it does before real traffic.
  await settle();

  let seq = 0;
  const send = async (event: Record<string, unknown>, eventId = `Ev${++seq}`) => {
    const ack = vi.fn(async () => {});
    await mock.listeners.get("slack_event")?.({
      type: "events_api",
      body: { event_id: eventId, event },
      ack,
    });
    await settle();
    return ack;
  };
  const items = (owner: string) => inbox.list(owner, { status: "all", limit: 100 }).entries;
  const setMode = (channel: string, config: Record<string, unknown> | null) =>
    owners.setConfig(`slack:channels/${channel}`, config === null ? null : JSON.stringify(config));
  return {
    owners,
    subscriptions,
    send,
    items,
    setMode,
    deliver,
    react,
    identify,
    onError,
    onReactionError,
    webCalls,
  };
}

describe("Slack per-conversation wake policy (#1037)", () => {
  beforeEach(() => mock.listeners.clear());

  // Root's contract table, for an ordinary `message` event.
  function messageWakes(
    channelType: string,
    mode: "all" | "mentions" | undefined,
    mention: "plain" | "self" | "other"
  ): boolean {
    if (mode === "all") return true;
    if (mode === "mentions") return mention === "self";
    return channelType === "im";
  }

  it("admits each conversation × mode × mention × placement exactly as the policy table says", async () => {
    const h = await harness();
    const modes = [undefined, "all", "mentions"] as const;
    const mentions = { plain: "hello", self: `<@${BOT}> hello`, other: "<@UOTHER> hello" };
    let ts = 1000;
    for (const { channel, channelType, owner } of CONVERSATIONS) {
      for (const mode of modes) {
        h.setMode(channel, mode ? { version: 1, slackWakeMode: mode } : null);
        for (const [mention, text] of Object.entries(mentions) as [
          keyof typeof mentions,
          string,
        ][]) {
          for (const threadTs of [undefined, "999.000001"]) {
            const messageTs = `${++ts}.000001`;
            const reactions = h.react.mock.calls.length;
            const ack = await h.send({
              type: "message",
              channel_type: channelType,
              channel,
              ts: messageTs,
              ...(threadTs ? { thread_ts: threadTs } : {}),
              user: HUMAN,
              text,
            });
            const label = `${channelType} ${mode ?? "unset"} ${mention} ${threadTs ? "reply" : "top"}`;
            expect(ack, label).toHaveBeenCalledOnce();
            const added = h
              .items(owner)
              .filter(
                (item) =>
                  item.payload.messageRef === `slack:channels/${channel}/messages/${messageTs}`
              );
            if (messageWakes(channelType, mode, mention)) {
              expect(added, label).toHaveLength(1);
              expect(added[0]?.source, label).toBe(`slack:channels/${channel}`);
              expect(added[0]?.payload, label).toMatchObject({
                type: "slack.message",
                messageRef: `slack:channels/${channel}/messages/${messageTs}`,
              });
              expect(added[0]?.payload.threadTs, label).toBe(threadTs);
              expect(h.react.mock.calls.slice(reactions), label).toEqual([
                [{ channel, timestamp: messageTs, name: "eyes" }],
              ]);
            } else {
              expect(added, label).toEqual([]);
              expect(h.react.mock.calls.length, label).toBe(reactions);
            }
          }
        }
      }
    }
    // Every delivery stayed with its own conversation's owner.
    for (const { channel, owner } of CONVERSATIONS) {
      expect(new Set(h.items(owner).map((item) => item.source))).toEqual(
        new Set([`slack:channels/${channel}`])
      );
    }
    expect(h.onError).not.toHaveBeenCalled();
  });

  it("admits app_mention in every mode, with or without channel_type, keeping its thread", async () => {
    const h = await harness();
    let ts = 5000;
    for (const { channel, channelType, owner } of CONVERSATIONS.filter(
      (c) => c.channelType !== "im"
    )) {
      for (const mode of [undefined, "all", "mentions"] as const) {
        h.setMode(channel, mode ? { version: 1, slackWakeMode: mode } : null);
        for (const omitType of [false, true]) {
          for (const threadTs of [undefined, "999.000001"]) {
            const messageTs = `${++ts}.000001`;
            await h.send({
              type: "app_mention",
              ...(omitType ? {} : { channel_type: channelType }),
              channel,
              ts: messageTs,
              ...(threadTs ? { thread_ts: threadTs } : {}),
              user: HUMAN,
              text: `<@${BOT}> look`,
            });
            const item = h
              .items(owner)
              .find(
                (entry) =>
                  entry.payload.messageRef === `slack:channels/${channel}/messages/${messageTs}`
              );
            expect(item?.payload.threadTs, `${channelType} ${mode} ${omitType}`).toBe(threadTs);
          }
        }
      }
    }
  });

  it("keeps one durable item per owner when one message arrives as message and app_mention, in either order and on retry", async () => {
    const h = await harness();
    // A second recipient on the same conversation, so "per owner" is visible.
    h.subscriptions.subscribe({
      resource: "slack:channels/C1",
      actorId: "watcher",
      subscribedBy: "root",
      subscribedAt: "2026-10-14T00:00:00.000Z",
    });
    h.setMode("C1", { version: 1, slackWakeMode: "all" });
    const event = (type: string, ts: string) => ({
      type,
      channel_type: "channel",
      channel: "C1",
      ts,
      user: HUMAN,
      text: `<@${BOT}> deploy?`,
    });

    for (const [ts, order] of [
      ["2001.000001", ["message", "app_mention"]],
      ["2002.000001", ["app_mention", "message"]],
    ] as const) {
      const [first, second] = order;
      const acks = [
        await h.send(event(first, ts), `Ev-${ts}-a`),
        await h.send(event(second, ts), `Ev-${ts}-b`),
        // Slack's retry of either envelope reuses its event ID.
        await h.send(event(first, ts), `Ev-${ts}-a`),
        await h.send(event(second, ts), `Ev-${ts}-b`),
      ];
      for (const ack of acks) expect(ack).toHaveBeenCalledOnce();
    }

    for (const owner of ["owner-public", "watcher"]) {
      expect(
        h
          .items(owner)
          .map((item) => item.payload.ts)
          .sort()
      ).toEqual(["2001.000001", "2002.000001"]);
    }
    // Every envelope reached delivery; only message identity collapsed them.
    expect(h.deliver).toHaveBeenCalledTimes(8);
  });

  it("wakes no one and posts no receipt for self, bot, subtype, malformed, unknown, or uncovered events", async () => {
    const h = await harness();
    for (const { channel } of CONVERSATIONS)
      h.setMode(channel, { version: 1, slackWakeMode: "all" });
    const human = {
      type: "message",
      channel_type: "im",
      channel: "D1",
      ts: "3000.000001",
      user: HUMAN,
      text: "hi",
    };
    const ignored = [
      { ...human, user: BOT },
      { ...human, type: "app_mention", channel_type: "channel", channel: "C1", user: BOT },
      { ...human, bot_id: "B1" },
      { ...human, subtype: "message_changed" },
      { ...human, subtype: "message_deleted" },
      { ...human, subtype: "channel_join" },
      { ...human, channel_type: "app_home" },
      { ...human, channel_type: undefined },
      { ...human, type: "reaction_added" },
      { ...human, channel: undefined },
      { ...human, user: undefined },
      { ...human, ts: undefined },
    ];
    for (const event of ignored) {
      const ack = await h.send(event);
      expect(ack, JSON.stringify(event)).toHaveBeenCalledOnce();
    }
    // A non-object body and a non-Events API envelope are acknowledged too.
    const ack = vi.fn(async () => {});
    await mock.listeners.get("slack_event")?.({ type: "events_api", body: "garbage", ack });
    await mock.listeners.get("slack_event")?.({ type: "hello", body: {}, ack });
    expect(ack).toHaveBeenCalledTimes(2);
    expect(h.deliver).not.toHaveBeenCalled();

    // A DM no row covers is admitted by default but reaches nobody: no receipt.
    const uncovered = await h.send({ ...human, channel: "D9" });
    expect(uncovered).toHaveBeenCalledOnce();
    expect(h.deliver).toHaveBeenCalledOnce();

    for (const { owner } of CONVERSATIONS) expect(h.items(owner)).toEqual([]);
    expect(h.react).not.toHaveBeenCalled();
  });

  it("applies each stored mode change to the next event without restart, and falls back on invalid config", async () => {
    const h = await harness();
    const plain = (ts: string) => ({
      type: "message",
      channel_type: "channel",
      channel: "C1",
      ts,
      user: HUMAN,
      text: "status?",
    });
    const delivered = () =>
      h
        .items("owner-public")
        .map((item) => item.payload.ts)
        .sort();

    h.setMode("C1", { version: 1, slackWakeMode: "all", note: "kept" });
    expect(h.owners.getConfig("slack:channels/C1")).toBe(
      JSON.stringify({ version: 1, slackWakeMode: "all", note: "kept" })
    );
    await h.send(plain("4001.000001"));
    h.setMode("C1", { version: 1, slackWakeMode: "mentions", note: "kept" });
    await h.send(plain("4002.000001"));
    h.setMode("C1", null);
    expect(h.owners.getConfig("slack:channels/C1")).toBeNull();
    await h.send(plain("4003.000001"));
    expect(delivered()).toEqual(["4001.000001"]);

    // Invalid or unsupported config never widens coverage: the channel keeps
    // its app_mention-only default, and a DM keeps waking.
    const invalid = [
      { version: 1, slackWakeMode: "everything" },
      { version: 2, slackWakeMode: "all" },
      { slackWakeMode: "all" },
    ];
    for (const [index, config] of invalid.entries()) {
      h.setMode("C1", config);
      await h.send(plain(`401${index}.000001`));
    }
    expect(delivered()).toEqual(["4001.000001"]);
    h.setMode("D1", { version: 2, slackWakeMode: "mentions" });
    await h.send({ ...plain("4020.000001"), channel_type: "im", channel: "D1" });
    expect(h.items("owner-dm")).toHaveLength(1);

    // A mode stored on another conversation does not reach this one.
    h.setMode("C1", null);
    h.setMode("G1", { version: 1, slackWakeMode: "all" });
    await h.send(plain("4030.000001"));
    expect(delivered()).toEqual(["4001.000001"]);
  });

  it("leaves a failed insert retryable with no receipt, and a failed receipt with its item intact", async () => {
    let failNext = true;
    const h = await harness({
      inbox: (real) =>
        new Proxy(real, {
          get(target, prop, receiver) {
            if (prop === "append") {
              return (inputs: Parameters<InboxRepository["append"]>[0]) => {
                if (failNext) {
                  failNext = false;
                  throw new Error("synthetic insert failure");
                }
                return target.append(inputs);
              };
            }
            const value = Reflect.get(target, prop, receiver);
            return typeof value === "function" ? value.bind(target) : value;
          },
        }),
    });
    const dm = {
      type: "message",
      channel_type: "im",
      channel: "D1",
      ts: "6001.000001",
      user: HUMAN,
      text: "hi",
    };

    const failed = await h.send(dm, "Ev-retry");
    expect(failed).not.toHaveBeenCalled();
    expect(h.onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "synthetic insert failure" })
    );
    expect(h.react).not.toHaveBeenCalled();
    expect(h.items("owner-dm")).toEqual([]);

    // Slack's retry of the unacknowledged envelope now lands once.
    const retried = await h.send(dm, "Ev-retry");
    expect(retried).toHaveBeenCalledOnce();
    expect(h.items("owner-dm")).toHaveLength(1);
    expect(h.react).toHaveBeenCalledOnce();

    // Synthetic missing scope and membership on the receipt: the item stays,
    // the event is acknowledged, nothing is redelivered or re-attempted, and
    // no access-changing API is called.
    for (const [code, ts] of [
      ["missing_scope", "6002.000001"],
      ["not_in_channel", "6003.000001"],
    ] as const) {
      h.react.mockRejectedValueOnce(Object.assign(new Error(code), { data: { error: code } }));
      const deliveries = h.deliver.mock.calls.length;
      const ack = await h.send({ ...dm, ts });
      expect(ack).toHaveBeenCalledOnce();
      expect(h.deliver.mock.calls.length).toBe(deliveries + 1);
      expect(h.items("owner-dm").map((item) => item.payload.ts)).toContain(ts);
    }
    expect(h.onReactionError).toHaveBeenCalledTimes(2);
    expect(new Set(h.webCalls)).toEqual(new Set(["auth.test", "reactions.add"]));
  });

  it("detects plain-text bot mentions only once the bot's identity is known", async () => {
    const h = await harness({
      firstIdentify: async () => {
        throw Object.assign(new Error("invalid_auth"), { data: { error: "invalid_auth" } });
      },
    });
    h.setMode("M1", { version: 1, slackWakeMode: "mentions" });
    const mention = (ts: string) => ({
      type: "message",
      channel_type: "mpim",
      channel: "M1",
      ts,
      user: HUMAN,
      text: `<@${BOT}> ping`,
    });
    // The lookup made at start failed and was reported.
    expect(h.onError).toHaveBeenCalledOnce();

    // Identity still unknown: the mention cannot be recognized, so nothing
    // wakes, and this event starts the retry.
    await h.send(mention("7001.000001"));
    expect(h.items("owner-group-dm")).toEqual([]);

    // Once the retry succeeds the mention is recognized; later events reuse it.
    await h.send(mention("7002.000001"));
    await h.send(mention("7003.000001"));
    expect(
      h
        .items("owner-group-dm")
        .map((item) => item.payload.ts)
        .sort()
    ).toEqual(["7002.000001", "7003.000001"]);
    expect(h.identify).toHaveBeenCalledTimes(2);
  });

  it("never holds an event or its ack behind an identity lookup", async () => {
    // A lookup that never settles, standing in for a slow or rate-limited Slack.
    const h = await harness({ firstIdentify: () => new Promise(() => {}) });
    h.setMode("C1", { version: 1, slackWakeMode: "mentions" });
    const dm = { type: "message", channel_type: "im", channel: "D1", user: HUMAN, text: "hi" };

    // A default-mode DM needs no identity: it is delivered and acked at once.
    const delivered = await h.send({ ...dm, ts: "8001.000001" });
    expect(delivered).toHaveBeenCalledOnce();
    expect(h.items("owner-dm").map((item) => item.payload.ts)).toEqual(["8001.000001"]);

    // An event that cannot wake is acked at once too.
    const ignored = await h.send({
      ...dm,
      channel_type: "channel",
      channel: "C1",
      ts: "8002.000001",
    });
    expect(ignored).toHaveBeenCalledOnce();
    expect(h.items("owner-public")).toEqual([]);

    // Slack's own app_mention still wakes a mentions-mode conversation.
    const mentioned = await h.send({
      type: "app_mention",
      channel: "C1",
      ts: "8003.000001",
      user: HUMAN,
      text: `<@${BOT}> hi`,
    });
    expect(mentioned).toHaveBeenCalledOnce();
    expect(h.items("owner-public").map((item) => item.payload.ts)).toEqual(["8003.000001"]);

    // The in-flight lookup is shared, not repeated per event.
    expect(h.identify).toHaveBeenCalledOnce();
  });
});
