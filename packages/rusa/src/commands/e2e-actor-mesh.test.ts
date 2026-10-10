import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExternalRootDriver } from "../actor/external-root-driver.js";
import { FakeChatClient, FakeChatSource } from "../chat/fake.js";
import {
  createDashboardE2EQuotaApi,
  loopbackRewriteToAppend,
  resolveE2EInstance,
  startChatControlServer,
  startRootControlServer,
} from "./e2e-actor-mesh.js";
import type { RunStartE2EHandles } from "./start.js";

const TEST_TMPDIR = tmpdir();
const E2E_ENV_KEYS = [
  "RUSA_HOME",
  "GIT_CONFIG_GLOBAL",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "TMPDIR",
] as const;
const ORIGINAL_E2E_ENV = new Map(E2E_ENV_KEYS.map((key) => [key, process.env[key]]));

function restoreE2EEnvironment(): void {
  for (const key of E2E_ENV_KEYS) {
    const value = ORIGINAL_E2E_ENV.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

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

  it("subscribes an actor to an event source in its own name", async () => {
    const addEventSourceSubscriber = vi.fn();
    const handles = {
      externalRoot: new ExternalRootDriver("root", vi.fn()),
      rootControl: {},
      mesh: { list: () => [], addEventSourceSubscriber },
      inboxStore: { list: vi.fn(), markHandled: vi.fn() },
    } as unknown as RunStartE2EHandles;
    const server = startRootControlServer({ port: 0, handles });
    await new Promise<void>((resolve) => server.once("listening", resolve));
    close = () =>
      new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    const port = (server.address() as AddressInfo).port;

    const subscribed = await fetch(`http://127.0.0.1:${port}/actors/child-1/subscriptions`, {
      method: "POST",
      body: JSON.stringify({ source: "github:rusa-e2e/scratch/pulls/3" }),
    });

    expect(subscribed.status).toBe(200);
    expect(addEventSourceSubscriber).toHaveBeenCalledWith(
      "github:rusa-e2e/scratch/pulls/3",
      "child-1",
      "child-1"
    );
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

describe("resolveE2EInstance", () => {
  let root = "";

  beforeEach(() => {
    restoreE2EEnvironment();
  });

  afterEach(() => {
    if (root) {
      rmSync(root, { recursive: true, force: true });
      root = "";
    }
    restoreE2EEnvironment();
  });

  it("automatically resumes a complete existing root without --resume (watcher restart)", () => {
    root = mkdtempSync(join(TEST_TMPDIR, "e2e-resolve-watcher-"));
    const initial = resolveE2EInstance({ root, rootDriver: "external" });
    expect(initial.resumed).toBe(false);
    expect(initial.instance.root).toBe(root);

    // Simulate database initialization that happens during the first run.
    mkdirSync(join(initial.instance.home, "data"), { recursive: true });
    writeFileSync(join(initial.instance.home, "data", "mesh.db"), "", "utf8");

    // Scratch file written by the first run.
    writeFileSync(
      join(initial.instance.scratchPath, "NOTE.txt"),
      "preserve across watcher restart\n",
      "utf8"
    );

    // Next watcher rebuild calls without --resume, passing the same --root.
    const resolved = resolveE2EInstance({ root, rootDriver: "external" });
    expect(resolved.resumed).toBe(true);
    expect(resolved.instance.root).toBe(root);
    expect(readFileSync(join(resolved.instance.scratchPath, "NOTE.txt"), "utf8")).toBe(
      "preserve across watcher restart\n"
    );
  });
});

describe("loopbackRewriteToAppend", () => {
  const repo = "acme/widgets";
  const url = "http://127.0.0.1:8087/git/repo.git";

  it("appends nothing when the gitconfig already routes to this loopback URL", () => {
    const gitconfig = `[user]\n\tname = e2e\n${loopbackRewriteToAppend("", url, repo) ?? ""}`;
    expect(loopbackRewriteToAppend(gitconfig, url, repo)).toBeNull();
  });

  it("appends the stanza for a root provisioned by ab-context or under another port offset", () => {
    const abContext = `[url "/runs/run-1/remote/repo.git"]\n\tinsteadOf = https://github.com/${repo}\n`;
    const otherOffset =
      loopbackRewriteToAppend("", "http://127.0.0.1:8088/git/repo.git", repo) ?? "";
    for (const gitconfig of [abContext, otherOffset]) {
      expect(loopbackRewriteToAppend(gitconfig, url, repo)).toBe(
        [
          `[url "${url}"]`,
          `\tinsteadOf = https://github.com/${repo}`,
          `\tinsteadOf = https://github.com/${repo}.git`,
          `\tinsteadOf = git@github.com:${repo}.git`,
          "",
        ].join("\n")
      );
    }
  });

  it("appends the missing mappings when the loopback header carries wrong or partial values", () => {
    const wrongRepo = `[url "${url}"]\n\tinsteadOf = https://github.com/acme/other\n`;
    expect(loopbackRewriteToAppend(wrongRepo, url, repo)).toBe(
      loopbackRewriteToAppend("", url, repo)
    );
    const partial = `[url "${url}"]\n\tinsteadOf = https://github.com/${repo}\n`;
    expect(loopbackRewriteToAppend(partial, url, repo)).toBe(
      [
        `[url "${url}"]`,
        `\tinsteadOf = https://github.com/${repo}.git`,
        `\tinsteadOf = git@github.com:${repo}.git`,
        "",
      ].join("\n")
    );
    expect(
      loopbackRewriteToAppend(`${partial}${loopbackRewriteToAppend(partial, url, repo)}`, url, repo)
    ).toBeNull();
  });

  it("starts the stanza on its own line when the gitconfig lacks a trailing newline", () => {
    expect(loopbackRewriteToAppend("[user]\n\tname = e2e", url, repo)).toMatch(
      /^\n\[url "http:\/\/127\.0\.0\.1:8087\/git\/repo\.git"\]\n/
    );
  });
});
