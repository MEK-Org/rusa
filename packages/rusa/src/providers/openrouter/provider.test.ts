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
import { OpenRouterProvider } from "./provider.js";

vi.mock("../../config/loader.js", () => ({
  loadConfig: () => ({ github: { account: "test" }, providers: {}, gitBridge: false }),
}));

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function fixture(options: { peerMode?: "failure" | "wait" } = {}) {
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
  const peerMarkerPath = join(root, "peer-progress.json");
  await writeFile(
    piCommand,
    `#!/bin/sh\nRUSA_TEST_PEER_MODE='${options.peerMode ?? "settle"}' RUSA_TEST_PEER_MARKER='${peerMarkerPath}' exec '${process.execPath}' '${fileURLToPath(new URL("./fixtures/rpc-child.mjs", import.meta.url))}' "$@"\n`,
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
    peerMarkerPath,
    apiKeyPath,
    config,
    provider: new OpenRouterProvider("test", config, "vendor/fixed-model"),
  };
}

async function readPeerProgress(path: string): Promise<{ pid: number; stage: string }> {
  const progress = JSON.parse(await readFile(path, "utf8")) as { pid: number; stage: string };
  expect(progress).toMatchObject({ stage: "prompt-accepted" });
  return progress;
}

/** Wait on the peer's protocol marker, not a host-dependent stdout chunk count. */
async function waitForPeerProgress(path: string): Promise<{ pid: number; stage: string }> {
  // Vitest's installed waitFor polls with its safe (real) timers while also
  // advancing fake test timers, so this observes the real peer write without
  // adding a filesystem watcher or a second cleanup lifecycle.
  return vi.waitFor(() => readPeerProgress(path), { timeout: 10_000 });
}

async function waitForParentProgress(
  hasProgress: () => boolean,
  terminal: Promise<void>
): Promise<void> {
  await Promise.race([
    vi.waitFor(() => expect(hasProgress()).toBe(true), { timeout: 10_000 }),
    terminal.then(() => Promise.reject(new Error("Actor settled before parent observed progress"))),
  ]);
}

function createOpenRouterActor(
  root: string,
  provider: OpenRouterProvider,
  lifecycle: ReturnType<typeof createActorLifecycle>,
  options: { id?: string; log?: (chunk: string) => void; timeoutMs?: number } = {}
): Actor {
  return new Actor({
    id: options.id ?? "child",
    cwd: root,
    modelConfig: [{ provider: "openrouter", model: "vendor/fixed-model" }],
    resolveProvider: () => provider,
    mcpServers: [],
    loadSessionId: () => undefined,
    saveSessionId: () => {},
    buildPrompt: () => ({ prompt: "synthetic peer" }),
    debounceMs: 0,
    lifecycle,
    log: options.log,
    timeoutMs: options.timeoutMs,
  });
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

it("honors a supplied in-flight deadline after peer protocol progress", async () => {
  const { root, peerMarkerPath, provider } = await fixture({ peerMode: "wait" });
  vi.stubEnv("RUSA_OPENROUTER_POC", "1");
  const controller = new AbortController();
  let settled = false;
  let run: ReturnType<OpenRouterProvider["run"]> | undefined;
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    run = provider.run({
      cwd: root,
      prompt: "wait for deadline",
      timeoutMs: 180_000,
      signal: controller.signal,
    });
    void run.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      }
    );
    const peer = await waitForPeerProgress(peerMarkerPath);
    await vi.advanceTimersByTimeAsync(120_001);
    expect(settled).toBe(false);
    expect(() => process.kill(peer.pid, 0)).not.toThrow();

    controller.abort("interrupt:deadline-test");
    await expect(run).resolves.toMatchObject({
      success: false,
      cancelled: true,
      interrupted: true,
      interruptSource: "deadline-test",
      output: expect.stringContaining("Pi invocation cancelled"),
    });
  } finally {
    if (!controller.signal.aborted) controller.abort("interrupt:deadline-test-cleanup");
    await run?.catch(() => {});
    vi.useRealTimers();
  }
}, 15_000);

it("keeps the Pi cancellation diagnosis on an adapter-local deadline", async () => {
  const { root, peerMarkerPath, provider } = await fixture({ peerMode: "wait" });
  vi.stubEnv("RUSA_OPENROUTER_POC", "1");
  let run: ReturnType<OpenRouterProvider["run"]> | undefined;
  try {
    run = provider.run({
      cwd: root,
      prompt: "wait for adapter deadline",
      timeoutMs: 300,
    });
    await waitForPeerProgress(peerMarkerPath);
    await expect(run).resolves.toMatchObject({
      success: false,
      cancelled: true,
      exitCode: 143,
      abortReason: "unknown",
      output: expect.stringContaining("Pi invocation cancelled"),
    });
  } finally {
    await run?.catch(() => {});
  }
}, 15_000);

it.each([
  ["responsive preemption", "responsive-notification"],
  ["human interruption", "operator"],
] as const)(
  "suppresses a %s after real peer progress",
  async (_label, source) => {
    const { root, peerMarkerPath, provider } = await fixture({ peerMode: "wait" });
    vi.stubEnv("RUSA_OPENROUTER_POC", "1");
    const notices: string[] = [];
    let ended: Awaited<ReturnType<OpenRouterProvider["run"]>> | undefined;
    let terminalSeen = false;
    let resolveTerminal!: () => void;
    const terminal = new Promise<void>((resolve) => {
      resolveTerminal = resolve;
    });
    const lifecycle = createActorLifecycle([
      {
        onEnd: async (event) => {
          terminalSeen = true;
          if (event.terminal.kind === "result") {
            ended = event.terminal.result;
            await routeRunFailure(
              {
                actors: {
                  get: () =>
                    (source === "operator"
                      ? { id: "root", parentId: null }
                      : { id: "child", parentId: "parent" }) as ActorRecord,
                },
                sendToParent: (_parentId, body) => notices.push(body),
                postToErrorChat: (body) => notices.push(body),
                principals:
                  source === "operator"
                    ? {
                        getUser: (id) =>
                          id === "operator"
                            ? {
                                kind: "user" as const,
                                id,
                                createdAt: "2026-01-01",
                                email: "operator@example.invalid",
                              }
                            : undefined,
                      }
                    : undefined,
                rootId: "root",
                log: () => {},
              },
              source === "operator" ? "root" : "child",
              event.terminal.result
            );
          }
          resolveTerminal();
        },
      },
    ]);
    let parentProgressAt: number | undefined;
    const actor = createOpenRouterActor(root, provider, lifecycle, {
      id: source === "operator" ? "root" : "child",
      log: () => {
        parentProgressAt = Date.now();
      },
    });
    try {
      actor.requestRun({ priority: "responsive" });
      await waitForPeerProgress(peerMarkerPath);
      await waitForParentProgress(() => parentProgressAt !== undefined, terminal);
      if (source === "operator") expect(actor.interrupt(source).interrupted).toBe(true);
      else expect(actor.preemptForResponsive().preempted).toBe(true);
      await vi.waitFor(() => expect(ended).toBeDefined(), { timeout: 10_000 });

      expect(ended).toMatchObject({
        success: false,
        cancelled: true,
        interrupted: true,
        interruptSource: source,
      });
      expect(notices).toEqual([]);
    } finally {
      if (!terminalSeen) {
        const interrupted = actor.interrupt("provider-test-cleanup");
        if (interrupted.interrupted && !interrupted.wasQueued) await terminal;
      }
      actor.close();
    }
  },
  15_000
);

it.each([
  ["stall watchdog", 15 * 60 * 1000, "stall-watchdog"],
  ["run ceiling", 60_000, "run-ceiling"],
] as const)(
  "attributes the %s after real peer progress goes quiet",
  async (_label, timeoutMs, reason) => {
    const { root, peerMarkerPath, provider } = await fixture({ peerMode: "wait" });
    vi.stubEnv("RUSA_OPENROUTER_POC", "1");
    let ended: Awaited<ReturnType<OpenRouterProvider["run"]>> | undefined;
    let terminalSeen = false;
    let resolveTerminal!: () => void;
    const terminal = new Promise<void>((resolve) => {
      resolveTerminal = resolve;
    });
    const lifecycle = createActorLifecycle([
      {
        onStart: () => {
          runStartedAt = Date.now();
        },
        onEnd: (event) => {
          terminalSeen = true;
          if (event.terminal.kind === "result") ended = event.terminal.result;
          resolveTerminal();
        },
      },
    ]);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    let actor: Actor | undefined;
    let parentProgressAt: number | undefined;
    let runStartedAt: number | undefined;
    try {
      actor = createOpenRouterActor(root, provider, lifecycle, {
        timeoutMs: reason === "run-ceiling" ? timeoutMs : undefined,
        log: () => {
          parentProgressAt = Date.now();
        },
      });
      actor.requestRun({ priority: "responsive" });
      await waitForPeerProgress(peerMarkerPath);
      await waitForParentProgress(() => parentProgressAt !== undefined, terminal);
      const timerAnchor = reason === "stall-watchdog" ? parentProgressAt : runStartedAt;
      expect(timerAnchor).toBeDefined();
      const remainingMs = timeoutMs - (Date.now() - (timerAnchor as number));
      expect(remainingMs).toBeGreaterThan(1);
      await vi.advanceTimersByTimeAsync(remainingMs - 1);
      expect(terminalSeen).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await terminal;
      expect(ended).toMatchObject({
        success: false,
        cancelled: true,
        abortReason: reason,
        output: expect.stringContaining(
          reason === "stall-watchdog" ? "stall watchdog" : "run ceiling"
        ),
      });
    } finally {
      if (actor && !terminalSeen) {
        const interrupted = actor.interrupt("provider-test-cleanup");
        if (interrupted.interrupted && !interrupted.wasQueued) await terminal;
      }
      actor?.close();
      vi.useRealTimers();
    }
  },
  15_000
);

it("reports an ordinary peer failure after protocol progress", async () => {
  const { root, peerMarkerPath, provider } = await fixture({ peerMode: "failure" });
  vi.stubEnv("RUSA_OPENROUTER_POC", "1");
  const notices: string[] = [];
  let ended: Awaited<ReturnType<OpenRouterProvider["run"]>> | undefined;
  const lifecycle = createActorLifecycle([
    {
      onEnd: async (event) => {
        if (event.terminal.kind !== "result") return;
        ended = event.terminal.result;
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
  const actor = createOpenRouterActor(root, provider, lifecycle);
  try {
    actor.requestRun({ priority: "responsive" });
    await waitForPeerProgress(peerMarkerPath);
    await vi.waitFor(() => expect(ended).toBeDefined(), { timeout: 10_000 });

    expect(ended).toMatchObject({ success: false, exitCode: 1 });
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("Pi reported a provider error or abort");
  } finally {
    actor.close();
  }
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
  const { root, peerMarkerPath, provider } = await fixture();
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
  const peer = await waitForPeerProgress(peerMarkerPath);
  expect(() => process.kill(peer.pid, 0)).toThrow();
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
