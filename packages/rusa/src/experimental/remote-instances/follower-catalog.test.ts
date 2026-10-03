import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeAll, expect, it } from "vitest";
import type { ActorOptions } from "../../actor/actor.js";
import type { ActorFactoryContext } from "../../actor/actor-mesh.js";
import type { RusaConfig } from "../../config/types.js";
import {
  clearProviderModelCatalog,
  setProviderModelCatalog,
} from "../../providers/model-catalog.js";
import type { RawProviderModelConfig } from "../../providers/model-config.js";
import type { ActorHandle } from "./actor-handle.js";
import { instanceWorkerFactory } from "./e2e-adapter.js";
import { FollowerHub } from "./follower-hub.js";
import { waitUntil } from "./harness.js";
import type { ActorEvent, Bootstrap } from "./protocol.js";
import { RemoteInstance } from "./remote-instance.js";

beforeAll(() => {
  execFileSync("pnpm", ["run", "build:follower"], { timeout: 30_000, stdio: "pipe" });
}, 35_000);
afterEach(() => clearProviderModelCatalog());

// Use the actual leader adapter's serialized init, rather than seeding the child's Map.
function leaderBootstrap(
  selected: RawProviderModelConfig,
  beforeReconnect?: () => void
): Bootstrap {
  const remote = new RemoteInstance("fixture", process.platform, process.pid);
  const config: RusaConfig = {
    github: { account: "fixture" },
    webhook: { port: 0, secret: "synthetic" },
    providers: { antigravity: { cliCommand: "agy" } },
    rootActor: { provider: "antigravity", model: "gemini-fixture" },
  };
  const actor = instanceWorkerFactory(config, {
    createHost: (_target: string, id: string) => remote.createHost(id),
    toolUrls: () => [],
  } as unknown as FollowerHub)(
    {
      onRuntimeStateChanged: () => {},
      onRunEnd: () => {},
      onQueued: () => {},
      executionTarget: "fixture",
      record: { id: "actor" },
      getRecord: () => ({ id: "actor" }),
    } as unknown as ActorFactoryContext,
    {
      cwd: "/ignored",
      modelConfig: [selected],
      mcpServers: [],
      loadSessionId: () => undefined,
      buildPrompt: () => ({ prompt: "synthetic prompt" }),
    } as unknown as ActorOptions
  );
  let command = remote.commands[0];
  if (beforeReconnect) {
    beforeReconnect();
    const reattached = new RemoteInstance("fixture", process.platform, process.pid);
    (actor as ActorHandle).attachHost(reattached.createHost("actor"));
    command = reattached.commands[0];
    reattached.close();
  }
  if (!("actorId" in command) || command.message.type !== "init") throw new Error("Missing init");
  const bootstrap = JSON.parse(JSON.stringify(command.message.bootstrap)) as Bootstrap;
  (actor as ActorHandle).ready.catch(() => {});
  remote.close();
  return bootstrap;
}

async function runFollower(bootstrap: Bootstrap, reconnects: Bootstrap[] = []) {
  const home = mkdtempSync(join(tmpdir(), "rusa-catalog-fixture-"));
  const bin = join(home, "bin");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "agy"),
    `#!${process.execPath}\nimport { writeFileSync } from 'node:fs';\nwriteFileSync('argv.json', JSON.stringify(process.argv.slice(2))+'\\n', {flag:'a'});\nprocess.stdout.write(JSON.stringify({event:'result',result:{status:'SUCCESS',response:'synthetic CLI completed'}})+'\\n');\n`,
    { mode: 0o755 }
  );
  writeFileSync(join(bin, "package.json"), '{"type":"module"}');
  const tokenFile = join(home, "token");
  writeFileSync(tokenFile, "synthetic-enrollment-token-fixture-878", { mode: 0o600 });
  const hub = new FollowerHub("synthetic-enrollment-token-fixture-878");
  const origin = await hub.listen("127.0.0.1", 0);
  const child = spawn(
    process.execPath,
    [
      resolve("build/follower/follower.js"),
      "--leader",
      origin,
      "--id",
      "fixture",
      "--home",
      home,
      "--token-file",
      tokenFile,
      "--sandbox",
      "none",
    ],
    {
      env: { PATH: `${bin}:${process.env.PATH}`, HOME: home },
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
  const exited = once(child, "exit");
  let logs = "";
  child.stdout.on("data", (chunk) => {
    logs += chunk;
  });
  child.stderr.on("data", (chunk) => {
    logs += chunk;
  });
  const events: ActorEvent[] = [];
  let currentBootstrap = bootstrap;
  try {
    await waitUntil(() => hub.list().length === 1);
    const channel = hub.createHost("fixture", "actor");
    const send = (message: Parameters<typeof channel.send>[0]) =>
      channel.send(message, (error) => {
        if (error) throw error;
      });
    channel.on("message", (event: ActorEvent) => {
      events.push(event);
      if (event.type !== "request") return;
      let value: unknown;
      switch (event.request.op) {
        case "beforeRun":
          value = { allowed: true };
          break;
        case "admit":
          value = {
            record: { id: "actor" },
            prompt: "synthetic prompt",
            selected: currentBootstrap.modelConfig?.[0],
          };
          break;
      }
      send({ type: "reply", requestId: event.requestId, value });
    });
    send({ type: "init", bootstrap });
    await waitUntil(() => events.some((e) => e.type === "ready" || e.type === "fatal"));
    if (events.some((e) => e.type === "ready")) {
      send({ type: "wake" });
      await waitUntil(() =>
        events.some(
          (e) =>
            (e.type === "request" && e.request.op === "complete") ||
            e.type === "error" ||
            e.type === "fatal"
        )
      );
    }
    for (const reconnect of reconnects) {
      currentBootstrap = reconnect;
      const readyCount = events.filter((e) => e.type === "ready").length;
      const failureCount = events.filter((e) => e.type === "error" || e.type === "fatal").length;
      const completionCount = events.filter(
        (e) => e.type === "request" && e.request.op === "complete"
      ).length;
      send({ type: "init", bootstrap: { ...reconnect, reconnect: true } });
      await waitUntil(
        () =>
          events.filter((e) => e.type === "ready").length > readyCount ||
          events.filter((e) => e.type === "error" || e.type === "fatal").length > failureCount
      );
      if (events.filter((e) => e.type === "ready").length > readyCount) {
        send({ type: "wake" });
        await waitUntil(
          () =>
            events.filter((e) => e.type === "request" && e.request.op === "complete").length >
              completionCount ||
            events.filter((e) => e.type === "error" || e.type === "fatal").length > failureCount
        );
      }
    }
    const argvFile = join(home, "workers", "actor", "argv.json");
    const launches = existsSync(argvFile)
      ? readFileSync(argvFile, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as string[])
      : [];
    const receiptPath = process.env.RUSA_FOLLOWER_CATALOG_RECEIPT;
    if (receiptPath) {
      writeFileSync(
        receiptPath,
        `${JSON.stringify({
          selections: [bootstrap, ...reconnects].map((entry) => entry.modelConfig),
          launches,
          failures: events.filter((event) => event.type === "error" || event.type === "fatal"),
        })}\n`,
        { flag: "a" }
      );
    }
    return {
      events,
      launches,
      argv: existsSync(argvFile) ? launches.at(-1) : undefined,
    };
  } catch (error) {
    throw new Error(`${String(error)}\n${logs}\n${JSON.stringify(events)}`);
  } finally {
    child.kill("SIGTERM");
    const force = setTimeout(() => child.kill("SIGKILL"), 2000);
    await exited;
    clearTimeout(force);
    await hub.close();
    rmSync(home, { recursive: true, force: true });
  }
}

it("a fresh follower launches the leader-admitted normalized Antigravity tuple", async () => {
  setProviderModelCatalog("agy", [
    { identifier: "gemini-fixture-high", displayLabel: "Gemini Fixture (High)", passable: true },
  ]);
  const observed = await runFollower(
    leaderBootstrap({ provider: "antigravity", model: "Gemini Fixture (High)", effort: "HIGH" })
  );
  expect(observed.events.filter((e) => e.type === "error" || e.type === "fatal")).toEqual([]);
  expect(
    observed.events.find((e) => e.type === "request" && e.request.op === "complete")
  ).toMatchObject({ request: { result: { success: true } } });
  expect(observed.argv).toEqual(
    expect.arrayContaining(["--model", "gemini-fixture", "--effort", "high"])
  );
}, 30_000);

it.each([
  {
    catalog: undefined,
    model: "gemini-fixture",
    effort: "high",
    reason: "catalog is empty or missing",
  },
  { catalog: [], model: "gemini-fixture", effort: "high", reason: "catalog is empty or missing" },
  {
    catalog: [{ identifier: "gemini-fixture-high", displayLabel: "Gemini Fixture (High)" }],
    model: "gemini-unknown",
    effort: "high",
    reason: "model pin validation failed",
  },
  {
    catalog: [{ identifier: "gemini-fixture-high", displayLabel: "Gemini Fixture (High)" }],
    model: "gemini-fixture",
    effort: "low",
    reason: "reasoning effort validation failed",
  },
])("refuses a fresh follower selection: $reason ($model/$effort)", async ({
  catalog,
  model,
  effort,
  reason,
}) => {
  if (catalog) setProviderModelCatalog("agy", catalog);
  const observed = await runFollower(leaderBootstrap({ provider: "antigravity", model, effort }));
  expect(observed.argv).toBeUndefined();
  expect(JSON.stringify(observed.events)).toContain(reason);
}, 30_000);

it("restores catalogs on actor reconnect and leaves old bootstrap defaults working", async () => {
  const oldBootstrap = leaderBootstrap({ provider: "antigravity", effort: "high" });
  delete oldBootstrap.providerOptions?.modelCatalogs;
  setProviderModelCatalog("antigravity", [
    { identifier: "gemini-fixture-high", displayLabel: "Gemini Fixture (High)" },
  ]);
  const current = leaderBootstrap({
    provider: "antigravity",
    model: "gemini-fixture",
    effort: "high",
  });
  const observed = await runFollower(oldBootstrap, [current]);
  expect(
    observed.events.filter((e) => e.type === "request" && e.request.op === "complete")
  ).toMatchObject([
    { request: { result: { success: true } } },
    { request: { result: { success: true } } },
  ]);
  expect(observed.argv).toEqual(
    expect.arrayContaining(["--model", "gemini-fixture", "--effort", "high"])
  );
}, 30_000);

function populatedBootstrap(model = "gemini-fixture", effort = "high"): Bootstrap {
  clearProviderModelCatalog();
  setProviderModelCatalog("agy", [
    { identifier: `${model}-${effort}`, displayLabel: `${model} (${effort})`, passable: true },
  ]);
  return leaderBootstrap({ provider: "antigravity", model, effort });
}

it("reconnect replaces the catalog and passes the new admitted model/effort to the CLI", async () => {
  const first = populatedBootstrap();
  const replacement = populatedBootstrap("gemini-replacement", "low");
  const observed = await runFollower(first, [replacement]);
  expect(observed.launches).toHaveLength(2);
  expect(observed.launches[0]).toEqual(
    expect.arrayContaining(["--model", "gemini-fixture", "--effort", "high"])
  );
  expect(observed.launches[1]).toEqual(
    expect.arrayContaining(["--model", "gemini-replacement", "--effort", "low"])
  );
  expect(observed.events.filter((e) => e.type === "error" || e.type === "fatal")).toEqual([]);
}, 30_000);

it.each([
  "empty snapshot",
  "removed provider",
  "omitted field",
])("reconnect %s clears a stale explicit selection", async (kind) => {
  const first = populatedBootstrap();
  const removed = JSON.parse(JSON.stringify(first)) as Bootstrap;
  if (kind === "omitted field") delete removed.providerOptions?.modelCatalogs;
  else if (removed.providerOptions)
    removed.providerOptions.modelCatalogs = kind === "removed provider" ? { codex: [] } : {};
  const observed = await runFollower(first, [removed]);
  expect(observed.launches).toHaveLength(1);
  expect(JSON.stringify(observed.events)).toContain("catalog is empty or missing");
}, 30_000);

it("reconnect omission keeps an old bootstrap's default-provider execution compatible", async () => {
  const first = populatedBootstrap();
  const old = leaderBootstrap({ provider: "antigravity", effort: "high" });
  delete old.providerOptions?.modelCatalogs;
  const observed = await runFollower(first, [old]);
  expect(observed.launches).toHaveLength(2);
  expect(observed.launches[1]).not.toContain("--model");
  expect(observed.events.filter((e) => e.type === "error" || e.type === "fatal")).toEqual([]);
}, 30_000);

it.each(
  [
    null,
    [],
    { agy: null },
    { agy: [{ identifier: 17, displayLabel: "fixture" }] },
    { agy: [{ identifier: "gemini-fixture", displayLabel: "fixture", efforts: ["HIGH"] }] },
    { agy: [{ identifier: "gemini-fixture", displayLabel: "fixture", passable: "yes" }] },
  ].map((catalogs) => ({ catalogs }))
)("refuses malformed normalized catalog metadata: $catalogs", async ({ catalogs }) => {
  const bootstrap = populatedBootstrap();
  if (bootstrap.providerOptions) bootstrap.providerOptions.modelCatalogs = catalogs;
  const observed = await runFollower(bootstrap);
  expect(observed.launches).toEqual([]);
  expect(observed.events).toContainEqual(
    expect.objectContaining({
      type: "fatal",
      error: expect.stringContaining("Invalid model catalog snapshot"),
    })
  );
}, 30_000);

it("the real leader reconnect bootstrap reads the current catalog and its removals", () => {
  setProviderModelCatalog("agy", [
    { identifier: "gemini-fixture-high", displayLabel: "Fixture (High)" },
  ]);
  const selected = { provider: "antigravity", model: "gemini-fixture", effort: "high" };
  const replacement = leaderBootstrap(selected, () => {
    clearProviderModelCatalog();
    setProviderModelCatalog("agy", [
      { identifier: "gemini-replacement-low", displayLabel: "Replacement (Low)" },
    ]);
  });
  expect(replacement.providerOptions?.modelCatalogs).toEqual({
    agy: [{ identifier: "gemini-replacement", displayLabel: "Replacement", efforts: ["low"] }],
  });
  const removed = leaderBootstrap(selected, () => clearProviderModelCatalog());
  expect(removed.providerOptions?.modelCatalogs).toEqual({});
});

it("malformed reconnect fails explicitly and cannot run the stale catalog", async () => {
  const first = populatedBootstrap();
  const invalid = JSON.parse(JSON.stringify(first)) as Bootstrap;
  if (invalid.providerOptions) invalid.providerOptions.modelCatalogs = { agy: [{}] };
  const observed = await runFollower(first, [invalid]);
  expect(observed.launches).toHaveLength(1);
  expect(observed.events).toContainEqual(
    expect.objectContaining({
      type: "fatal",
      error: expect.stringContaining("Invalid model catalog snapshot"),
    })
  );
}, 30_000);
