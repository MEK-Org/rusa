// @vitest-environment node

import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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

const adapters: { name: string; create: (config: ProviderConfig) => CodingProvider }[] = [
  { name: "Claude", create: (config) => new ClaudeProvider("claude", config) },
  { name: "Codex", create: (config) => new CodexProvider("codex", config) },
  { name: "Antigravity", create: (config) => new AntigravityProvider("agy", config) },
  { name: "Kimi", create: (config) => new KimiProvider("kimi", config) },
  { name: "Copilot", create: (config) => new CopilotProvider("copilot", config) },
];

describe("subprocess provider lifecycle parity", () => {
  it.each(adapters)("honors a supplied deadline after the $name process is in flight", async ({
    create,
  }) => {
    const { root, command } = await hangingCli();
    const stdout: string[] = [];

    const result = await create({ cliCommand: command }).run({
      prompt: "synthetic lifecycle deadline",
      cwd: root,
      timeoutMs: 300,
      onStdout: (chunk) => stdout.push(chunk),
      onChunk: (chunk) => stdout.push(chunk),
    });

    expect(stdout.join("")).toContain("ready");
    expect(result).toMatchObject({
      success: false,
      cancelled: true,
      exitCode: 143,
      abortReason: "unknown",
    });
  });

  it.each(adapters)("preserves an in-flight $name interruption's shared attribution", async ({
    create,
  }) => {
    const { root, command } = await hangingCli();
    const controller = new AbortController();
    let markReady: (() => void) | undefined;
    const ready = new Promise<void>((resolve) => {
      markReady = resolve;
    });

    const resultPromise = create({ cliCommand: command }).run({
      prompt: "synthetic lifecycle interruption",
      cwd: root,
      timeoutMs: 10_000,
      signal: controller.signal,
      onStdout: (chunk) => {
        if (chunk.includes("ready")) markReady?.();
      },
      onChunk: (chunk) => {
        if (chunk.includes("ready")) markReady?.();
      },
    });

    await ready;
    controller.abort("interrupt:parity-fixture");

    await expect(resultPromise).resolves.toMatchObject({
      success: false,
      cancelled: true,
      interrupted: true,
      interruptSource: "parity-fixture",
      abortReason: "interrupt:parity-fixture",
      exitCode: 143,
    });
  });
});
