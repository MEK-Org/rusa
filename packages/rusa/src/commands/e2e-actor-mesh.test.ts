import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExternalRootDriver } from "../actor/external-root-driver.js";
import { FakeChatClient, FakeChatSource } from "../chat/fake.js";
import {
  createDashboardE2EQuotaApi,
  startChatControlServer,
  startRootControlServer,
} from "./e2e-actor-mesh.js";
import type { RunStartE2EHandles } from "./start.js";

describe("external root E2E control server", () => {
  let close: (() => Promise<void>) | undefined;

  afterEach(async () => close?.());

  it("spawns and messages through the shared e2e-controller principal", async () => {
    const spawnChild = vi.fn(() => "child-1");
    const sendMessage = vi.fn();
    const retireChild = vi.fn();
    const externalRoot = new ExternalRootDriver("root", vi.fn());
    const handles = {
      externalRoot,
      rootControl: { spawnChild, sendMessage, retireChild },
      mesh: { list: () => [] },
      inboxStore: { list: vi.fn(), markHandled: vi.fn() },
    } as unknown as RunStartE2EHandles;
    const server = startRootControlServer({ port: 0, handles });
    await new Promise<void>((resolve) => server.once("listening", resolve));
    close = () =>
      new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    const port = (server.address() as AddressInfo).port;

    const spawned = await fetch(`http://127.0.0.1:${port}/actors`, {
      method: "POST",
      body: JSON.stringify({
        charter: "implement the fixture",
        provider: "agy",
        model: "gemini-3.5-flash-medium",
      }),
    });
    expect(spawned.status).toBe(201);
    expect(await spawned.json()).toEqual({ id: "child-1" });
    expect(spawnChild).toHaveBeenCalledWith(
      expect.objectContaining({
        charter: "implement the fixture",
        modelConfig: { provider: "agy", model: "gemini-3.5-flash-medium", effort: undefined },
      }),
      "e2e-controller"
    );

    const messaged = await fetch(`http://127.0.0.1:${port}/actors/child-1/messages`, {
      method: "POST",
      body: JSON.stringify({ body: "continue" }),
    });
    expect(messaged.status).toBe(200);
    expect(sendMessage).toHaveBeenCalledWith("child-1", "continue", "e2e-controller");

    const retired = await fetch(`http://127.0.0.1:${port}/actors/child-1/retire`, {
      method: "POST",
      body: "{}",
    });
    expect(retired.status).toBe(200);
    expect(await retired.json()).toEqual({ id: "child-1", status: "retired" });
    expect(retireChild).toHaveBeenCalledWith("child-1", "e2e-controller");
  });

  it("refuses a blank execution target at the HTTP boundary instead of running it locally", async () => {
    const spawnChild = vi.fn(() => "child-1");
    const handles = {
      externalRoot: new ExternalRootDriver("root", vi.fn()),
      rootControl: { spawnChild },
      mesh: { list: () => [] },
      inboxStore: { list: vi.fn(), markHandled: vi.fn() },
    } as unknown as RunStartE2EHandles;
    const followerHub = {
      list: () => [{ id: "mac-follower" }],
    } as unknown as Parameters<typeof startRootControlServer>[0]["followerHub"];
    const server = startRootControlServer({ port: 0, handles, followerHub });
    await new Promise<void>((resolve) => server.once("listening", resolve));
    close = () =>
      new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    const port = (server.address() as AddressInfo).port;
    const spawn = (target: unknown) =>
      fetch(`http://127.0.0.1:${port}/actors`, {
        method: "POST",
        body: JSON.stringify({
          charter: "place me",
          provider: "agy",
          model: "gemini-3.5-flash-medium",
          target,
        }),
      });

    // `target: ""` is a request to place the actor, not an omission. It names no
    // connected follower, so it is refused here rather than quietly becoming a
    // local run in the leader's own process.
    const blank = await spawn("");
    expect(blank.status).toBe(400);
    expect(await blank.json()).toEqual({ error: "Requested follower is not connected" });
    expect((await spawn("   ")).status).toBe(400);
    expect((await spawn("linux-follower")).status).toBe(400);
    expect(spawnChild).not.toHaveBeenCalled();

    const placed = await spawn("mac-follower");
    expect(placed.status).toBe(201);
    expect(spawnChild).toHaveBeenCalledWith(
      expect.objectContaining({ executionTarget: "mac-follower" }),
      "e2e-controller"
    );
  });

  it("enables portable ledger context through the shared spawn surface", async () => {
    const spawnChild = vi.fn(() => "child-ledger");
    const handles = {
      externalRoot: new ExternalRootDriver("root", vi.fn()),
      rootControl: { spawnChild },
      mesh: { list: () => [] },
      inboxStore: { list: vi.fn(), markHandled: vi.fn() },
    } as unknown as RunStartE2EHandles;
    const server = startRootControlServer({ port: 0, handles });
    await new Promise<void>((resolve) => server.once("listening", resolve));
    close = () =>
      new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    const port = (server.address() as AddressInfo).port;

    const spawned = await fetch(`http://127.0.0.1:${port}/actors`, {
      method: "POST",
      body: JSON.stringify({
        charter: "implement the fixture",
        provider: "agy",
        model: "gemini-3.5-flash-medium",
        contextMode: "ledger",
        compactionModel: "gemini-test-compactor",
      }),
    });

    expect(spawned.status).toBe(201);
    expect(await spawned.json()).toEqual({
      id: "child-ledger",
      contextMode: "ledger",
      compactionModel: "gemini-test-compactor",
    });
    expect(spawnChild).toHaveBeenCalledWith(
      expect.objectContaining({
        context: {
          type: "portable",
          mode: "ledger",
          compactionModel: "gemini-test-compactor",
        },
      }),
      "e2e-controller"
    );
  });

  it("exposes queued root wakes and acknowledges them explicitly", async () => {
    const externalRoot = new ExternalRootDriver("root");
    externalRoot.requestRun();
    const handles = {
      externalRoot,
      rootControl: {},
      mesh: { list: () => [] },
      inboxStore: { list: vi.fn(), markHandled: vi.fn() },
    } as unknown as RunStartE2EHandles;
    const server = startRootControlServer({ port: 0, handles });
    await new Promise<void>((resolve) => server.once("listening", resolve));
    close = () =>
      new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    const port = (server.address() as AddressInfo).port;

    const wakeResponse = await fetch(`http://127.0.0.1:${port}/root/wakes`);
    const wakes = (await wakeResponse.json()) as { wakes: Array<{ id: string }> };
    expect(wakes.wakes).toHaveLength(1);

    const ack = await fetch(`http://127.0.0.1:${port}/root/wakes/ack`, {
      method: "POST",
      body: JSON.stringify({ ids: [wakes.wakes[0].id] }),
    });
    expect(ack.status).toBe(200);
    expect(externalRoot.listWakes()).toEqual([]);
  });
});

describe("dashboard E2E quota fixture", () => {
  it("serves deterministic full and exhausted weekly/session extremes", async () => {
    const now = Date.parse("2026-08-08T12:00:00.000Z");
    const fixture = createDashboardE2EQuotaApi(now);

    const claude = await fixture.getQuota("claude");
    const codex = await fixture.getQuota("codex");

    expect(claude.limits?.map((limit) => limit.percentLeft)).toEqual([100, 0]);
    expect(claude.status).toBe("exhausted");
    expect(codex.limits?.map((limit) => limit.percentLeft)).toEqual([0, 100]);
    expect(codex.status).toBe("available");
    expect(fixture.now?.()).toBe(now);
  });
});

describe("chat E2E control server", () => {
  let close: (() => Promise<void>) | undefined;

  afterEach(async () => close?.());

  it("populates FakeChatClient messages when POSTing to /chat/send so messages are readable", async () => {
    const chatSource = new FakeChatSource();
    await chatSource.start(() => {});
    const chatClient = new FakeChatClient();
    const server = startChatControlServer({ port: 0, chatSource, chatClient });
    await new Promise<void>((resolve) => server.once("listening", resolve));
    close = () =>
      new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    const port = (server.address() as AddressInfo).port;

    const res = await fetch(`http://127.0.0.1:${port}/chat/send`, {
      method: "POST",
      body: JSON.stringify({ text: "Hello E2E", dm: true }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; delivered: string };
    expect(body.ok).toBe(true);
    expect(body.delivered).toBeDefined();

    const fetched = await chatClient.getMessage(body.delivered);
    expect(fetched).toEqual(
      expect.objectContaining({
        name: body.delivered,
        text: "Hello E2E",
      })
    );
  });
});
