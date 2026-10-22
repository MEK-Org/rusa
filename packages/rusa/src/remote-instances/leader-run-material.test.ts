import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import type { ActorLifecycleStartEvent } from "../actor/actor-lifecycle.js";
import { runMigrations } from "../db/migrations/runner.js";
import { MeshEventRepository } from "../db/repositories/mesh-event-repository.js";
import type { Logger } from "../observability/logger.js";
import {
  type RunMaterialReaderDeps,
  readRunMaterial,
  runMaterialListener,
} from "./leader-run-material.js";
import { MaterialReadUnavailableError } from "./remote-instance.js";
import {
  RUN_MATERIAL_READ_MAX_BYTES,
  type RunMaterialRead,
  RunMaterialStore,
} from "./run-material.js";

const RUN = "0f7e3c1a-1111-4222-8333-444455556666";
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function store(): RunMaterialStore {
  const dir = mkdtempSync(join(tmpdir(), "rusa-leader-material-"));
  dirs.push(dir);
  return new RunMaterialStore(join(dir, "run-material", "v1"));
}
const records: Array<{ event: string; fields?: Record<string, unknown> }> = [];
const log: Logger = {
  debug: () => {},
  info: () => {},
  warn: (event, fields) => records.push({ event, fields }),
  error: (event, fields) => records.push({ event, fields }),
  child: () => log,
};
const start = (material?: { version: 1; host: string }) =>
  ({
    actorId: "worker",
    runId: RUN,
    responsive: false,
    mode: "ordinary",
    selected: { provider: "claude", model: "opus" },
    ...(material ? { material } : {}),
  }) as unknown as ActorLifecycleStartEvent;

describe("runMaterialListener", () => {
  it("keeps an unbound run's prompt in run_prompts, as before", async () => {
    const legacy: string[] = [];
    const listener = runMaterialListener("worker", store(), (_r, p) => legacy.push(p), log);
    await listener.onStart?.(start());
    await listener.onPrompt?.({ actorId: "worker", runId: RUN, prompt: "full" });
    expect(legacy).toEqual(["full"]);
  });

  it("retains a bound run's full fallback under the host's key, and nothing it already kept", async () => {
    const local = store();
    const legacy: string[] = [];
    const listener = runMaterialListener("worker", local, (_r, p) => legacy.push(p), log);
    await listener.onStart?.(start({ version: 1, host: "mac" }));
    await listener.onPrompt?.({ actorId: "worker", runId: RUN, prompt: "first", attempt: 3 });
    await listener.onEnd?.({
      actorId: "worker",
      runId: RUN,
      terminal: { kind: "result", result: { success: true, exitCode: 0, output: "all of it" } },
    });
    expect(legacy).toEqual([]);
    const prompt = local.read("worker", RUN, "prompt");
    expect(prompt.status === "ok" && [prompt.attempt, prompt.content.toString()]).toEqual([
      3,
      "first",
    ]);
    const output = local.read("worker", RUN, "output");
    expect(output.status === "ok" && output.content.toString()).toBe("all of it");

    const other = "1f7e3c1a-1111-4222-8333-444455556666";
    await listener.onStart?.({ ...start({ version: 1, host: "mac" }), runId: other });
    await listener.onEnd?.({
      actorId: "worker",
      runId: other,
      terminal: {
        kind: "result",
        result: {
          success: true,
          exitCode: 0,
          output: "tail",
          outputBound: { version: 1, totalChars: 4, bytes: 4, sha256: "a".repeat(64) },
        },
      },
    });
    expect(local.read("worker", other, "output")).toEqual({ status: "missing" });
  });
});

describe("readRunMaterial", () => {
  const ok = (text: string, attempt?: number): RunMaterialRead => ({
    status: "ok",
    ...(attempt === undefined ? {} : { attempt }),
    bytes: Buffer.byteLength(text),
    sha256: "b".repeat(64),
    content: Buffer.from(text),
  });
  function deps(over: Partial<RunMaterialReaderDeps> = {}): RunMaterialReaderDeps & {
    asked: string[];
  } {
    const asked: string[] = [];
    return {
      asked,
      runActor: () => "worker",
      binding: () => ({ version: 1, host: "mac" }),
      local: store(),
      remote: async (host, actorId, request) => {
        asked.push(`${host}/${actorId}/${request.kind}/${request.attempt ?? "latest"}`);
        return { status: "missing" };
      },
      ...over,
    };
  }

  it("serves an unbound run's prompt only from run_prompts, in the #866 shape", async () => {
    const d = deps({ binding: () => undefined, legacyPrompt: () => "legacy text" });
    expect(await readRunMaterial(d, "worker", RUN, "prompt")).toEqual({
      status: 200,
      body: { prompt: "legacy text" },
    });
    expect(
      await readRunMaterial({ ...d, legacyPrompt: () => undefined }, "worker", RUN, "prompt")
    ).toEqual({ status: 404, body: { error: "prompt not retained" } });
    expect(await readRunMaterial(d, "worker", RUN, "output")).toEqual({
      status: 404,
      body: { error: "materialHostUnknown" },
    });
    expect(d.asked).toEqual([]);
  });

  it("asks the host recorded at the run's start and reports it unavailable by reason", async () => {
    const offline = deps({
      remote: () => Promise.reject(new MaterialReadUnavailableError("offline", "gone")),
    });
    expect(await readRunMaterial(offline, "worker", RUN, "output")).toEqual({
      status: 503,
      body: { error: "materialHostUnavailable", host: "mac", reason: "offline" },
    });
    const busy = deps({
      remote: () => Promise.reject(new MaterialReadUnavailableError("busy", "full")),
    });
    expect((await readRunMaterial(busy, "worker", RUN, "output")).retryAfter).toBe(1);
    const served = deps({ remote: async () => ok("from host") });
    expect(await readRunMaterial(served, "worker", RUN, "output")).toMatchObject({
      status: 200,
      body: { output: "from host", source: "host" },
    });
  });

  it("serves the leader's fallback copy first for an output or a named attempt", async () => {
    const d = deps();
    d.local.putOutput("worker", RUN, "leader copy");
    d.local.putPrompt("worker", RUN, 2, "attempt two");
    expect(await readRunMaterial(d, "worker", RUN, "output")).toMatchObject({
      status: 200,
      body: { output: "leader copy", source: "leader" },
    });
    expect(await readRunMaterial(d, "worker", RUN, "prompt", 2)).toMatchObject({
      status: 200,
      body: { prompt: "attempt two", attempt: 2, source: "leader" },
    });
    expect(await readRunMaterial(d, "worker", RUN, "prompt", 1)).toEqual({
      status: 404,
      body: { error: "prompt not retained" },
    });
    expect(d.asked).toEqual(["mac/worker/prompt/1"]);
  });

  it("returns the highest attempt on either side for the latest prompt, never a stale one", async () => {
    const hostNewer = deps({ remote: async () => ok("host three", 3) });
    hostNewer.local.putPrompt("worker", RUN, 2, "leader two");
    expect(await readRunMaterial(hostNewer, "worker", RUN, "prompt")).toMatchObject({
      body: { prompt: "host three", attempt: 3, source: "host" },
    });
    const leaderNewer = deps({ remote: async () => ok("host one", 1) });
    leaderNewer.local.putPrompt("worker", RUN, 2, "leader two");
    expect(await readRunMaterial(leaderNewer, "worker", RUN, "prompt")).toMatchObject({
      body: { prompt: "leader two", attempt: 2, source: "leader" },
    });
    const hostEmpty = deps();
    hostEmpty.local.putPrompt("worker", RUN, 1, "leader one");
    expect(await readRunMaterial(hostEmpty, "worker", RUN, "prompt")).toMatchObject({
      body: { prompt: "leader one", attempt: 1, source: "leader" },
    });
    // A host too large to send at a higher attempt still beats an older leader copy.
    const hostLarge = deps({
      remote: async () => ({ status: "tooLarge", attempt: 4, bytes: 9, sha256: "c".repeat(64) }),
    });
    hostLarge.local.putPrompt("worker", RUN, 2, "leader two");
    expect(await readRunMaterial(hostLarge, "worker", RUN, "prompt")).toEqual({
      status: 413,
      body: {
        error: "prompt exceeds the read limit",
        attempt: 4,
        bytes: 9,
        sha256: "c".repeat(64),
        limitBytes: RUN_MATERIAL_READ_MAX_BYTES,
      },
    });
    // A host that cannot answer may hold a newer attempt: fail rather than guess.
    const unreachable = deps({
      remote: () => Promise.reject(new MaterialReadUnavailableError("timeout", "slow")),
    });
    unreachable.local.putPrompt("worker", RUN, 2, "leader two");
    expect((await readRunMaterial(unreachable, "worker", RUN, "prompt")).status).toBe(503);
    const corrupt = deps({ remote: async () => ({ status: "integrity" }) });
    corrupt.local.putPrompt("worker", RUN, 2, "leader two");
    expect(await readRunMaterial(corrupt, "worker", RUN, "prompt")).toEqual({
      status: 502,
      body: { error: "integrity", source: "host" },
    });
  });

  it("does not replace an unavailable newest allocation with an older fallback", async () => {
    const d = deps({ remote: async () => ({ status: "missing", attempt: 2 }) });
    d.local.putPrompt("worker", RUN, 1, "older fallback");

    expect(await readRunMaterial(d, "worker", RUN, "prompt")).toEqual({
      status: 404,
      body: { error: "prompt not retained" },
    });
    expect(await readRunMaterial(d, "worker", RUN, "prompt", 1)).toMatchObject({
      status: 200,
      body: { prompt: "older fallback", attempt: 1, source: "leader" },
    });

    // A leader copy of the newest allocation is still a valid fallback.
    d.local.putPrompt("worker", RUN, 2, "newest fallback");
    expect(await readRunMaterial(d, "worker", RUN, "prompt")).toMatchObject({
      status: 200,
      body: { prompt: "newest fallback", attempt: 2, source: "leader" },
    });
  });
});

describe("getRunMaterialBinding", () => {
  it("finds the binding of one actor's run and ignores malformed or foreign rows", () => {
    const db = new Database(":memory:");
    runMigrations(db);
    const events = new MeshEventRepository(db);
    events.record({ kind: "run_start", actorId: "worker", payload: "{not json" });
    events.record({
      kind: "run_start",
      actorId: "other",
      payload: JSON.stringify({ runId: RUN, material: { version: 1, host: "elsewhere" } }),
    });
    events.record({
      kind: "run_start",
      actorId: "worker",
      payload: JSON.stringify({ runId: "legacy-run" }),
    });
    events.record({
      kind: "run_start",
      actorId: "worker",
      payload: JSON.stringify({ runId: "future-run", material: { version: 2, host: "mac" } }),
    });
    events.record({
      kind: "run_start",
      actorId: "worker",
      payload: JSON.stringify({ runId: RUN, material: { version: 1, host: "mac" } }),
    });
    expect(events.getRunMaterialBinding("worker", RUN)).toEqual({ version: 1, host: "mac" });
    expect(events.getRunMaterialBinding("worker", "legacy-run")).toBeUndefined();
    expect(events.getRunMaterialBinding("worker", "future-run")).toBeUndefined();
    expect(events.getRunMaterialBinding("absent", RUN)).toBeUndefined();
  });
});
