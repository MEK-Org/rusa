// @vitest-environment node

import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Actor } from "../actor/actor.js";
import { createActorLifecycle } from "../actor/actor-lifecycle.js";
import type { ActorRecord } from "../actor/actor-record.js";
import { routeRunFailure } from "../actor/failure-sink.js";
import type { ProviderConfig } from "../config/types.js";
import { AntigravityProvider } from "./antigravity.js";
import { ClaudeProvider } from "./claude.js";
import { CodexProvider } from "./codex.js";
import { CopilotProvider } from "./copilot.js";
import { KimiProvider } from "./kimi.js";
import type { CodingProvider } from "./types.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function hangingCli(): Promise<{ root: string; command: string }> {
  const root = await mkdtemp(join(tmpdir(), "rusa-provider-lifecycle-"));
  roots.push(root);
  const command = join(root, "fixture-cli.sh");
  await writeFile(command, "#!/bin/sh\nprintf 'ready\\n'\nwhile :; do sleep 1; done\n", {
    mode: 0o700,
  });
  await chmod(command, 0o700);
  return { root, command };
}

function readinessLatch(): { ready: Promise<void>; markReady: () => void } {
  let markReady!: () => void;
  const ready = new Promise<void>((resolve) => {
    markReady = resolve;
  });
  return { ready, markReady };
}

async function waitForReady<T>(ready: Promise<void>, run: Promise<T>): Promise<void> {
  await Promise.race([
    ready,
    run.then(
      () => {
        throw new Error("Synthetic subprocess settled before it emitted readiness");
      },
      (error) => Promise.reject(error)
    ),
  ]);
}

const adapters: { name: string; create: (config: ProviderConfig) => CodingProvider }[] = [
  { name: "Claude", create: (config) => new ClaudeProvider("claude", config) },
  { name: "Codex", create: (config) => new CodexProvider("codex", config) },
  { name: "Antigravity", create: (config) => new AntigravityProvider("agy", config) },
  { name: "Kimi", create: (config) => new KimiProvider("kimi", config) },
  { name: "Copilot", create: (config) => new CopilotProvider("copilot", config) },
];

function actorFor(
  root: string,
  provider: CodingProvider,
  lifecycle: ReturnType<typeof createActorLifecycle>,
  onChunk: (chunk: string) => void,
  id: string
): Actor {
  return new Actor({
    id,
    cwd: root,
    modelConfig: [{ provider: provider.providerName }],
    resolveProvider: () => provider,
    mcpServers: [],
    loadSessionId: () => undefined,
    saveSessionId: () => {},
    buildPrompt: () => ({ prompt: "synthetic lifecycle interruption" }),
    debounceMs: 0,
    lifecycle,
    log: onChunk,
  });
}

describe("subprocess provider lifecycle parity", () => {
  it.each(adapters)("honors a supplied deadline after the $name process is in flight", async ({
    create,
  }) => {
    const { root, command } = await hangingCli();
    const controller = new AbortController();
    const { ready, markReady } = readinessLatch();
    let resultPromise: ReturnType<CodingProvider["run"]> | undefined;
    try {
      resultPromise = create({ cliCommand: command }).run({
        prompt: "synthetic lifecycle deadline",
        cwd: root,
        timeoutMs: 300,
        signal: controller.signal,
        onStdout: (chunk) => {
          if (chunk.includes("ready")) markReady();
        },
        onChunk: (chunk) => {
          if (chunk.includes("ready")) markReady();
        },
      });
      await waitForReady(ready, resultPromise);
      await expect(resultPromise).resolves.toMatchObject({
        success: false,
        cancelled: true,
        exitCode: 143,
        abortReason: "unknown",
      });
    } finally {
      if (!controller.signal.aborted) controller.abort("interrupt:parity-deadline-cleanup");
      await resultPromise?.catch(() => {});
    }
  });

  it.each(adapters)("preserves an in-flight $name interruption's shared attribution", async ({
    create,
  }) => {
    const { root, command } = await hangingCli();
    const controller = new AbortController();
    const { ready, markReady } = readinessLatch();
    let resultPromise: ReturnType<CodingProvider["run"]> | undefined;
    try {
      resultPromise = create({ cliCommand: command }).run({
        prompt: "synthetic lifecycle interruption",
        cwd: root,
        timeoutMs: 10_000,
        signal: controller.signal,
        onStdout: (chunk) => {
          if (chunk.includes("ready")) markReady();
        },
        onChunk: (chunk) => {
          if (chunk.includes("ready")) markReady();
        },
      });
      await waitForReady(ready, resultPromise);
      controller.abort("interrupt:parity-fixture");

      await expect(resultPromise).resolves.toMatchObject({
        success: false,
        cancelled: true,
        interrupted: true,
        interruptSource: "parity-fixture",
        abortReason: "interrupt:parity-fixture",
        exitCode: 143,
      });
    } finally {
      if (!controller.signal.aborted) controller.abort("interrupt:parity-cleanup");
      await resultPromise?.catch(() => {});
    }
  });

  it.each(
    adapters
  )("suppresses in-flight $name responsive and human interrupts through Actor and the failure sink", async ({
    create,
  }) => {
    for (const { actorId, source } of [
      { actorId: "child", source: "responsive-notification" },
      { actorId: "root", source: "operator" },
    ] as const) {
      const { root, command } = await hangingCli();
      const notices: string[] = [];
      let ended: Awaited<ReturnType<CodingProvider["run"]>> | undefined;
      let resolveTerminal!: (result: Awaited<ReturnType<CodingProvider["run"]>>) => void;
      const terminal = new Promise<Awaited<ReturnType<CodingProvider["run"]>>>((resolve) => {
        resolveTerminal = resolve;
      });
      let ready = false;
      const lifecycle = createActorLifecycle([
        {
          onEnd: async (event) => {
            if (event.terminal.kind !== "result") return;
            ended = event.terminal.result;
            resolveTerminal(event.terminal.result);
            await routeRunFailure(
              {
                actors: {
                  get: () =>
                    ({
                      id: actorId,
                      parentId: actorId === "root" ? null : "parent",
                    }) as ActorRecord,
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
              actorId,
              event.terminal.result
            );
          },
        },
      ]);
      const actor = actorFor(
        root,
        create({ cliCommand: command }),
        lifecycle,
        (chunk) => {
          if (chunk.includes("ready")) ready = true;
        },
        actorId
      );

      try {
        actor.requestRun({ priority: "responsive" });
        await Promise.race([
          vi.waitFor(() => expect(ready).toBe(true), { timeout: 10_000 }),
          terminal.then(() => Promise.reject(new Error("Actor settled before fixture readiness"))),
        ]);
        if (source === "operator") expect(actor.interrupt(source).interrupted).toBe(true);
        else expect(actor.preemptForResponsive().preempted).toBe(true);
        await expect(terminal).resolves.toBeDefined();
        expect(ended).toMatchObject({
          success: false,
          cancelled: true,
          interrupted: true,
          interruptSource: source,
        });
        expect(notices).toEqual([]);
      } finally {
        if (!ended) {
          actor.interrupt("parity-test-cleanup");
          await terminal;
        }
        actor.close();
      }
    }
  }, 15_000);
});
