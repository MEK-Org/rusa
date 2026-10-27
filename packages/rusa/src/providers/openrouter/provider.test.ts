// @vitest-environment node

import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { Actor } from "../../actor/actor.js";
import { createActorLifecycle } from "../../actor/actor-lifecycle.js";
import type { ActorRecord } from "../../actor/actor-record.js";
import { routeRunFailure } from "../../actor/failure-sink.js";
import { OpenRouterProvider, openRouterTimeoutMs } from "./provider.js";

vi.mock("../../config/loader.js", () => ({
  loadConfig: () => ({ github: { account: "test" }, providers: {}, gitBridge: false }),
}));

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "openrouter-provider-test-"));
  roots.push(root);
  const apiKeyPath = join(root, "auth.json");
  await writeFile(
    apiKeyPath,
    JSON.stringify({
      openrouter: {
        type: "oauth",
        access: "synthetic-not-a-real-key",
        refresh: "",
        expires: Number.MAX_SAFE_INTEGER,
      },
      other: { type: "api_key", key: "other-secret" },
    }),
    { mode: 0o600 }
  );
  const executableRoot = await mkdtemp(join(process.cwd(), ".openrouter-host-probe-"));
  roots.push(executableRoot);
  const piCommand = join(executableRoot, "pi");
  await writeFile(
    piCommand,
    `#!/bin/sh\nexec '${process.execPath}' '${fileURLToPath(new URL("./fixtures/rpc-child.mjs", import.meta.url))}' "$@"\n`,
    { mode: 0o700 }
  );
  const config = {
    openrouterPoc: {
      piCommand,
      authDir: root,
      artifactDir: join(root, "artifacts"),
    },
  };
  return {
    root,
    apiKeyPath,
    config,
    provider: new OpenRouterProvider("test", config, "vendor/fixed-model"),
  };
}
it("requires opt-in and refuses native sessions before inference", async () => {
  const { root, provider } = await fixture();
  vi.stubEnv("RUSA_OPENROUTER_POC", "");
  await expect(provider.run({ cwd: root, prompt: "ping" })).rejects.toThrow(/requires/);
  vi.stubEnv("RUSA_OPENROUTER_POC", "1");
  await expect(
    provider.run({
      cwd: root,
      prompt: "ping",
      session: { id: "native-session" },
    })
  ).rejects.toThrow(/fresh runs/);
});

it("honors the actor-supplied subprocess backstop instead of imposing an adapter cap", () => {
  expect(openRouterTimeoutMs({ timeoutMs: 3_630_000 })).toBe(3_630_000);
  expect(openRouterTimeoutMs({})).toBe(120_000);
});

it("returns full shared interruption attribution when the synthetic peer is cancelled", async () => {
  const { root, provider } = await fixture();
  vi.stubEnv("RUSA_OPENROUTER_POC", "1");
  const controller = new AbortController();
  controller.abort("interrupt:responsive-notification");

  await expect(
    provider.run({ cwd: root, prompt: "cancelled", signal: controller.signal })
  ).resolves.toMatchObject({
    success: false,
    exitCode: 143,
    cancelled: true,
    interrupted: true,
    interruptSource: "responsive-notification",
    abortReason: "interrupt:responsive-notification",
  });
});

it("carries a real adapter preemption through the actor into the failure sink", async () => {
  const { root, provider } = await fixture();
  vi.stubEnv("RUSA_OPENROUTER_POC", "1");
  const notices: string[] = [];
  let actor: Actor;
  let ended = false;
  let terminalOutput = "";
  const lifecycle = createActorLifecycle([
    {
      onPrompt: () => {
        if (!ended) actor.preemptForResponsive();
      },
      onEnd: async (event) => {
        if (event.terminal.kind !== "result") return;
        ended = true;
        terminalOutput = event.terminal.result.output;
        await routeRunFailure(
          {
            actors: { get: () => ({ id: "child", parentId: "parent" }) as ActorRecord },
            sendToParent: (_parentId, body) => notices.push(body),
            postToErrorChat: null,
            rootId: "root",
            log: () => {},
          },
          "child",
          event.terminal.result
        );
      },
    },
  ]);
  actor = new Actor({
    id: "child",
    cwd: root,
    modelConfig: [{ provider: "openrouter", model: "vendor/fixed-model" }],
    resolveProvider: () => provider,
    mcpServers: [],
    loadSessionId: () => undefined,
    saveSessionId: () => {},
    buildPrompt: () => ({ prompt: "synthetic preemption" }),
    debounceMs: 0,
    lifecycle,
  });

  actor.requestRun({ priority: "responsive" });
  await vi.waitFor(() => expect(ended).toBe(true), { timeout: 10_000 });
  actor.close();
  expect(notices).toEqual([]);
  expect(terminalOutput.match(/\[Task interrupted by responsive-notification\]/g)).toHaveLength(1);
}, 15_000);
it("requires the independently managed Pi login", async () => {
  const { root, apiKeyPath, provider } = await fixture();
  vi.stubEnv("RUSA_OPENROUTER_POC", "1");
  await rm(apiKeyPath);
  await expect(provider.run({ cwd: root, prompt: "ping" })).rejects.toThrow(/launch pi/);
});
it("uses a static Pi login without changing the source profile", async () => {
  const { root, apiKeyPath, provider } = await fixture();
  vi.stubEnv("RUSA_OPENROUTER_POC", "1");
  const source = JSON.stringify({
    openrouter: { type: "api_key", key: "synthetic-not-a-real-key" },
  });
  await writeFile(apiKeyPath, source);
  expect((await provider.run({ cwd: root, prompt: "ping" })).success).toBe(true);
  expect(await readFile(apiKeyPath, "utf8")).toBe(source);
  await writeFile(
    apiKeyPath,
    JSON.stringify({ openrouter: { type: "api_key", key: "!echo secret" } })
  );
  await expect(provider.run({ cwd: root, prompt: "ping" })).rejects.toThrow(/launch pi/);
});
it("settles through real pipes, reaps the peer and retains usage without a subscription token record", async () => {
  const { root, provider } = await fixture();
  vi.stubEnv("RUSA_OPENROUTER_POC", "1");
  const result = await provider.run({
    cwd: root,
    prompt: "ping-unique",
    mcpServers: [{ name: "inbox", url: "http://synthetic.invalid" }],
  });
  expect(result).toEqual({
    success: true,
    output: "ping-unique",
    exitCode: 0,
  });
  const artifacts = await readdir(join(root, "artifacts"));
  expect(artifacts).toHaveLength(1);
  const receipt = await readFile(join(root, "artifacts", artifacts[0] as string), "utf8");
  expect(JSON.parse(receipt).requests[0].usage).toEqual({ input: 3, output: 2 });
  expect(receipt).not.toContain("synthetic-not-a-real-key");
}, 10000);

it("leaves cwd untouched when artifact storage is not requested", async () => {
  const { root, config } = await fixture();
  vi.stubEnv("RUSA_OPENROUTER_POC", "1");
  const { artifactDir: _artifactDir, ...paths } = config.openrouterPoc;
  const provider = new OpenRouterProvider("test", { openrouterPoc: paths }, "vendor/fixed-model");
  const cwd = join(root, "nonexistent-workspace");
  expect((await provider.run({ cwd, prompt: "ping" })).success).toBe(true);
  await expect(readdir(cwd)).rejects.toThrow(/ENOENT/);
});

it("retains distinct artifacts for concurrent invocations", async () => {
  const { root, provider } = await fixture();
  vi.stubEnv("RUSA_OPENROUTER_POC", "1");
  const results = await Promise.all([
    provider.run({ cwd: root, prompt: "one" }),
    provider.run({ cwd: root, prompt: "two" }),
  ]);
  expect(results.every((result) => result.success)).toBe(true);
  expect(await readdir(join(root, "artifacts"))).toHaveLength(2);
});

let bwrapCapable = false;
try {
  execFileSync("bwrap", ["--ro-bind", "/", "/", "--", "/bin/true"], { stdio: "ignore" });
  bwrapCapable = true;
} catch {}
it.skipIf(!bwrapCapable)(
  "launches a worker without a provider grant and accepts a mixed Pi login profile",
  async () => {
    const { root, provider } = await fixture();
    vi.stubEnv("RUSA_OPENROUTER_POC", "1");
    const actor = join(root, "workers", "actor");
    const sibling = join(root, "workers", "sibling");
    const secrets = join(root, "secrets");
    await Promise.all([actor, sibling, secrets].map((path) => mkdir(path, { recursive: true })));
    const hostRoot = await mkdtemp(join(process.cwd(), ".openrouter-host-probe-"));
    roots.push(hostRoot);
    const probe = {
      ownFile: join(actor, "own"),
      siblingFile: join(sibling, "private"),
      secretFile: join(secrets, "ungranted"),
      hostFile: join(hostRoot, "host-file"),
    };
    await Promise.all(
      Object.entries(probe).map(([name, path]) =>
        writeFile(path, name === "ownFile" ? "own" : "private")
      )
    );
    const prompt = `sandbox-probe:${JSON.stringify(probe)}`;
    const result = await provider.run({
      cwd: actor,
      prompt,
      sandbox: { worktreePath: actor },
      mcpServers: [{ name: "inbox", url: "http://synthetic.invalid" }],
    });
    expect(result).toEqual({ success: true, output: prompt, exitCode: 0 });
    expect(await readFile(probe.ownFile, "utf8")).toBe("updated");
    expect(await readFile(probe.hostFile, "utf8")).toBe("private");
  },
  15000
);

it("resolves a relative Pi login directory against the host cwd", async () => {
  const { root, config } = await fixture();
  vi.stubEnv("RUSA_OPENROUTER_POC", "1");
  vi.stubEnv("PI_CODING_AGENT_DIR", relative(process.cwd(), root));
  const { authDir: _authDir, ...paths } = config.openrouterPoc;
  const provider = new OpenRouterProvider("test", { openrouterPoc: paths }, "vendor/fixed-model");
  expect((await provider.run({ cwd: root, prompt: "ping" })).success).toBe(true);
});

it.skipIf(!bwrapCapable)(
  "releases the supplied understanding snapshot after success and missing-login failure",
  async () => {
    const { root, apiKeyPath, provider } = await fixture();
    vi.stubEnv("RUSA_OPENROUTER_POC", "1");
    const actor = join(root, "workers", "actor");
    await mkdir(actor, { recursive: true });
    for (const missingLogin of [false, true]) {
      const understandingMount = await mkdtemp(join(tmpdir(), "rusa-iu-snapshot-"));
      roots.push(understandingMount);
      await writeFile(join(understandingMount, "snapshot"), "synthetic understanding");
      if (missingLogin) await rm(apiKeyPath);
      const run = provider.run({
        cwd: actor,
        prompt: "ping",
        sandbox: { worktreePath: actor, understandingMount },
      });
      if (missingLogin) await expect(run).rejects.toThrow(/launch pi/);
      else expect((await run).success).toBe(true);
      await expect(readdir(understandingMount)).rejects.toThrow(/ENOENT/);
    }
  },
  15000
);
