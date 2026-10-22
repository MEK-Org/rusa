import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ActorLifecycleEndEvent, ActorLifecycleStartEvent } from "../actor/actor-lifecycle.js";
import { captureRunOutput } from "../db/repositories/actor-run-repository.js";
import type { Logger } from "../observability/logger.js";
import type { RunResult } from "../providers/types.js";
import type { RunMaterialOptions } from "./actor-runtime.js";
import { createHarness, waitUntil } from "./harness.js";
import { readRunMaterial, runMaterialListener } from "./leader-run-material.js";
import type { ProviderFactory } from "./protocol.js";
import { MaterialReadUnavailableError } from "./remote-instance.js";
import {
  BOUNDED_COMPLETE_MAX_BYTES,
  outputOmittedChars,
  RUN_MATERIAL_ROOT,
  type RunMaterialIo,
  RunMaterialStore,
} from "./run-material.js";

/**
 * A remote run end to end (#1020): follower runtime, follower instance, the
 * leader's instance channel and actor handle, over the in-process wire. The
 * same run is measured with a follower that negotiated bounded execution and
 * with one that did not.
 */
const CHARTER = `Synthetic charter ✓\n${"c".repeat(2 * 1024 * 1024)}`;
const OUTPUT = `Error: head of the output\n${"o".repeat(6 * 1024 * 1024)}\n🙂 tail`;

const instances: ReturnType<typeof createHarness>[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(instances.splice(0).map((h) => h.close()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "rusa-bounded-"));
  dirs.push(dir);
  return dir;
};
const quiet: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => quiet,
};

function run(material: { enabled: boolean; io?: RunMaterialIo } | undefined) {
  const cwd = tempDir();
  const prompts: string[] = [];
  const provider: ProviderFactory = (bridge, _options, selected) => ({
    name: "instance-fixture",
    providerName: "instance-fixture",
    model: selected?.model,
    async run(run) {
      prompts.push(run.prompt);
      run.onPromptLaunched?.(run.prompt);
      const { parentId } = JSON.parse(run.prompt) as { parentId: string };
      await bridge.sendMessage(parentId, "done");
      return {
        success: true,
        output: OUTPUT,
        exitCode: 0,
        sessionId: run.session?.id ?? randomUUID(),
        model: selected?.model,
      };
    },
  });
  const followerStore = new RunMaterialStore(join(cwd, RUN_MATERIAL_ROOT), material?.io);
  const options: RunMaterialOptions | undefined = material && {
    store: followerStore,
    enabled: () => material.enabled,
  };
  const leaderStore = new RunMaterialStore(join(tempDir(), RUN_MATERIAL_ROOT));
  const legacyPrompts: string[] = [];
  const starts: ActorLifecycleStartEvent[] = [];
  const ends: ActorLifecycleEndEvent[] = [];
  const h = createHarness({
    cwd,
    providerFactory: provider,
    material: options,
    lifecycle: (actorId) => {
      const listener = runMaterialListener(
        actorId,
        leaderStore,
        (_runId, prompt) => legacyPrompts.push(prompt),
        quiet
      );
      return {
        ...listener,
        onStart: (event) => {
          starts.push(event);
          return listener.onStart?.(event);
        },
        onEnd: (event) => {
          ends.push(event);
          return listener.onEnd?.(event);
        },
      };
    },
  });
  instances.push(h);
  const id = h.spawn(CHARTER);
  const done = waitUntil(() => ends.length === 1, 30_000);
  const wireBytes = () =>
    h.followerEvents
      .filter((event) => event.actorId === id)
      .reduce((sum, event) => sum + Buffer.byteLength(JSON.stringify(event)), 0);
  const result = () => {
    const terminal = ends[0]?.terminal;
    if (terminal?.kind !== "result") throw new Error("run did not complete");
    return terminal.result;
  };
  const read = (kind: "prompt" | "output", attempt?: number) => {
    const runId = ends[0]?.runId ?? "";
    return readRunMaterial(
      {
        runActor: () => id,
        binding: () => starts[0]?.material,
        local: leaderStore,
        remote: (host, actorId, request) =>
          host === "test-follower"
            ? h.remote.materialRead(actorId, request)
            : Promise.reject(new MaterialReadUnavailableError("offline", host)),
        legacyPrompt: () => legacyPrompts.at(-1),
      },
      id,
      runId,
      kind,
      attempt
    );
  };
  return { h, id, done, prompts, starts, ends, legacyPrompts, wireBytes, result, read };
}

const messageTypes = (r: ReturnType<typeof run>) =>
  r.h.followerEvents.filter((e) => e.actorId === r.id).map((e) => e.message.type);
const completion = (r: ReturnType<typeof run>): RunResult | undefined => {
  for (const { message } of r.h.followerEvents) {
    if (message.type === "request" && message.request.op === "complete") {
      return message.request.result;
    }
  }
  return undefined;
};

describe("bounded remote execution (#1020)", () => {
  it("keeps prompts and output on the host, sends refs and a bounded result, and reads originals back", async () => {
    const legacy = run({ enabled: false });
    await legacy.done;
    const bounded = run({ enabled: true });
    await bounded.done;

    // N−1 behaviour: the full prompt and output cross the wire as before.
    expect(messageTypes(legacy)).toContain("runPrompt");
    expect(messageTypes(legacy)).not.toContain("runPromptRef");
    expect(legacy.starts[0]?.material).toBeUndefined();
    expect(completion(legacy)?.output).toBe(OUTPUT);
    expect(legacy.legacyPrompts).toEqual(legacy.prompts);

    // N: refs and a bounded result; the run is bound to the host that started it.
    expect(messageTypes(bounded)).toContain("runPromptRef");
    expect(messageTypes(bounded)).not.toContain("runPrompt");
    expect(bounded.starts[0]?.material).toEqual({ version: 1, host: "test-follower" });
    expect(bounded.legacyPrompts).toEqual([]);
    const sent = completion(bounded);
    expect(sent?.outputBound).toMatchObject({ version: 1, totalChars: OUTPUT.length });
    expect(Buffer.byteLength(JSON.stringify(sent))).toBeLessThan(BOUNDED_COMPLETE_MAX_BYTES);

    const before = legacy.wireBytes();
    const after = bounded.wireBytes();
    expect(before).toBeGreaterThan(Buffer.byteLength(CHARTER) + Buffer.byteLength(OUTPUT));
    expect(after).toBeLessThan(BOUNDED_COMPLETE_MAX_BYTES);

    // The leader's stores see exactly what they saw from the full result.
    expect(captureRunOutput(bounded.result().output, outputOmittedChars(bounded.result()))).toBe(
      captureRunOutput(legacy.result().output)
    );

    // Every original reads back byte for byte from the recorded host.
    const prompt = await bounded.read("prompt");
    expect(prompt).toMatchObject({ status: 200, body: { attempt: 1, source: "host" } });
    expect(prompt.body.prompt).toBe(bounded.prompts[0]);
    expect(await bounded.read("prompt", 1)).toEqual(prompt);
    const output = await bounded.read("output");
    expect(output).toMatchObject({ status: 200, body: { source: "host" } });
    expect(output.body.output).toBe(OUTPUT);
    expect(await bounded.read("prompt", 2)).toEqual({
      status: 404,
      body: { error: "prompt not retained" },
    });
    // The N−1 run's prompt is still served from run_prompts.
    expect(await legacy.read("prompt")).toEqual({
      status: 200,
      body: { prompt: legacy.prompts[0] },
    });
  }, 60_000);

  it("falls back to the full prompt and result, disclosed, when the host cannot keep them", async () => {
    const failing: RunMaterialIo = {
      ...fs,
      linkSync: () => {
        throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
      },
    };
    const r = run({ enabled: true, io: failing });
    await r.done;
    const fallbacks = r.h.followerEvents.flatMap(({ actorId, message }) =>
      actorId === r.id && message.type === "error" ? [message.error] : []
    );
    expect(fallbacks).toEqual([
      expect.stringMatching(
        /^Run material fallback for run .*: .*no space left on device; sent in full$/
      ),
      expect.stringMatching(
        /^Run material fallback for run .*: .*no space left on device; sent in full$/
      ),
    ]);
    const prompt = r.h.followerEvents.find(
      ({ actorId, message }) => actorId === r.id && message.type === "runPrompt"
    );
    expect(prompt?.message).toMatchObject({ prompt: r.prompts[0], attempt: 1 });
    expect(completion(r)?.output).toBe(OUTPUT);
    expect(completion(r)?.outputBound).toBeUndefined();
    // The leader kept both, under the host's key, and serves them itself.
    expect(await r.read("prompt")).toMatchObject({
      status: 200,
      body: { prompt: r.prompts[0], attempt: 1, source: "leader" },
    });
    expect(await r.read("output")).toMatchObject({
      status: 200,
      body: { output: OUTPUT, source: "leader" },
    });
  }, 60_000);
});
