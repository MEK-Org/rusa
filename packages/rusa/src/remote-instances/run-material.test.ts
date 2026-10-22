import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { failureDiagnostic } from "../actor/failure-sink.js";
import { ACTOR_RUN_OUTPUT_MAX_CHARS } from "../db/repositories/actor-run-repository.js";
import type { RunResult } from "../providers/types.js";
import {
  BOUNDED_COMPLETE_MAX_BYTES,
  boundedCompleteFits,
  boundRunResult,
  outputOmittedChars,
  parseOutputBound,
  RUN_MATERIAL_READ_MAX_BYTES,
  RUN_MATERIAL_RETENTION_MS,
  RunMaterialIntegrityError,
  type RunMaterialIo,
  RunMaterialStore,
} from "./run-material.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function root(): string {
  const dir = mkdtempSync(join(tmpdir(), "rusa-run-material-"));
  dirs.push(dir);
  return join(dir, "run-material", "v1");
}

const sha = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");
const RUN = "0f7e3c1a-1111-4222-8333-444455556666";

describe("RunMaterialStore", () => {
  it("retains every prompt attempt and the output byte-exactly under content-named files", () => {
    const store = new RunMaterialStore(root());
    const first = "prompt one ✓";
    const second = "x".repeat(3 * 1024 * 1024);
    const a1 = store.nextPromptAttempt("actor-a", RUN);
    expect(store.putPrompt("actor-a", RUN, a1, first)).toEqual({
      bytes: Buffer.byteLength(first),
      sha256: sha(first),
    });
    const a2 = store.nextPromptAttempt("actor-a", RUN);
    store.putPrompt("actor-a", RUN, a2, second);
    const output = `${"o".repeat(5 * 1024 * 1024)}🙂`;
    store.putOutput("actor-a", RUN, output);

    expect([a1, a2]).toEqual([1, 2]);
    expect(readdirSync(join(store.root, "actor-a", RUN)).sort()).toEqual(
      [
        "attempt",
        `output.${sha(output)}`,
        `prompt-1.${sha(first)}`,
        `prompt-2.${sha(second)}`,
      ].sort()
    );
    const one = store.read("actor-a", RUN, "prompt", 1);
    expect(one.status === "ok" && one.content.toString("utf8")).toBe(first);
    const latest = store.read("actor-a", RUN, "prompt");
    expect(latest.status === "ok" && latest.attempt).toBe(2);
    expect(latest.status === "ok" && latest.content.toString("utf8")).toBe(second);
    const out = store.read("actor-a", RUN, "output");
    expect(out.status === "ok" && out.content.equals(Buffer.from(output, "utf8"))).toBe(true);
    expect(store.read("actor-a", RUN, "prompt", 3)).toEqual({ status: "missing" });
    expect(store.read("actor-a", "1f7e3c1a-1111-4222-8333-444455556666", "output")).toEqual({
      status: "missing",
    });
  });

  it("advances the attempt key through failed writes and across a restart", () => {
    const dir = root();
    let failLinks = true;
    const io: RunMaterialIo = {
      ...fs,
      linkSync: (from: fs.PathLike, to: fs.PathLike) => {
        if (failLinks) throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
        fs.linkSync(from, to);
      },
    };
    const store = new RunMaterialStore(dir, io);
    const failed = store.nextPromptAttempt("actor-a", RUN);
    expect(() => store.putPrompt("actor-a", RUN, failed, "lost here")).toThrow("disk full");
    // Nothing is published for a failed write, not even a temporary file.
    expect(readdirSync(join(dir, "actor-a", RUN))).toEqual(["attempt"]);
    failLinks = false;
    expect(store.nextPromptAttempt("actor-a", RUN)).toBe(2);
    // A fresh process finds the persisted key, not only the highest stored file.
    const restarted = new RunMaterialStore(dir);
    expect(restarted.nextPromptAttempt("actor-a", RUN)).toBe(3);
  });

  it("keeps allocating attempts from memory when the run directory cannot be written", () => {
    const io: RunMaterialIo = {
      ...fs,
      mkdirSync: () => {
        throw Object.assign(new Error("read-only file system"), { code: "EROFS" });
      },
    };
    const store = new RunMaterialStore(root(), io);
    expect(store.nextPromptAttempt("actor-a", RUN)).toBe(1);
    expect(store.nextPromptAttempt("actor-a", RUN)).toBe(2);
    expect(() => store.putOutput("actor-a", RUN, "out")).toThrow("read-only");
  });

  it("verifies an existing file on EEXIST and refuses a corrupt one", () => {
    const store = new RunMaterialStore(root());
    const text = "the original";
    store.putOutput("actor-a", RUN, text);
    // Same content again is the same immutable file.
    expect(store.putOutput("actor-a", RUN, text)).toEqual({
      bytes: Buffer.byteLength(text),
      sha256: sha(text),
    });
    writeFileSync(join(store.root, "actor-a", RUN, `output.${sha(text)}`), "tampered");
    expect(() => store.putOutput("actor-a", RUN, text)).toThrow(RunMaterialIntegrityError);
    expect(store.read("actor-a", RUN, "output")).toEqual({ status: "integrity" });
  });

  it("refuses reads above the raw cap without discarding the original", () => {
    const store = new RunMaterialStore(root());
    const big = "b".repeat(RUN_MATERIAL_READ_MAX_BYTES + 1);
    store.putOutput("actor-a", RUN, big);
    expect(store.read("actor-a", RUN, "output")).toEqual({
      status: "tooLarge",
      bytes: big.length,
      sha256: sha(big),
    });
    const file = join(store.root, "actor-a", RUN, `output.${sha(big)}`);
    expect(readFileSync(file).length).toBe(big.length);
  });

  it("expires idle runs after retention but never an open run", () => {
    const store = new RunMaterialStore(root());
    const OTHER = "2f7e3c1a-1111-4222-8333-444455556666";
    store.openRun("actor-a", RUN);
    store.putPrompt("actor-a", RUN, store.nextPromptAttempt("actor-a", RUN), "active");
    store.putOutput("actor-a", OTHER, "idle");
    const old = (Date.now() - RUN_MATERIAL_RETENTION_MS - 60_000) / 1000;
    for (const runId of [RUN, OTHER]) {
      const dir = join(store.root, "actor-a", runId);
      for (const name of readdirSync(dir)) utimesSync(join(dir, name), old, old);
      utimesSync(dir, old, old);
    }
    expect(store.sweep()).toBe(1);
    expect(store.read("actor-a", OTHER, "output")).toEqual({ status: "missing" });
    expect(store.read("actor-a", RUN, "prompt", 1).status).toBe("ok");
    store.closeRun("actor-a", RUN);
    expect(store.sweep()).toBe(1);
    expect(store.read("actor-a", RUN, "prompt", 1)).toEqual({ status: "missing" });
  });

  it("refuses identifiers that could leave the store", () => {
    const store = new RunMaterialStore(root());
    expect(() => store.putOutput("../escape", RUN, "x")).toThrow("Invalid");
    expect(() => store.read("actor-a", "../../etc", "output")).toThrow("Invalid");
  });
});

describe("bounded run results", () => {
  const failed = (output: string, extra: Partial<RunResult> = {}): RunResult => ({
    success: false,
    exitCode: 1,
    output,
    sessionId: "session-1",
    interruptSource: "operator",
    abortReason: "interrupt:operator",
    failure: { stage: "provider-selection", message: "cannot prepare" },
    ...extra,
  });

  it("keeps only the output tail and every other field untouched", () => {
    const output = `HEAD-ERROR ${"y".repeat(5 * 1024 * 1024)} TAIL`;
    const result = failed(output);
    const bounded = boundRunResult(result, {
      bytes: Buffer.byteLength(output),
      sha256: sha(output),
    });
    expect(bounded.output).toBe(output.slice(-ACTOR_RUN_OUTPUT_MAX_CHARS));
    expect(bounded.outputBound).toEqual({
      version: 1,
      totalChars: output.length,
      bytes: Buffer.byteLength(output),
      sha256: sha(output),
      failureDiagnostic: failureDiagnostic(result),
    });
    const { output: _a, outputBound: _b, ...rest } = bounded;
    const { output: _c, ...original } = result;
    expect(rest).toEqual(original);
    expect(outputOmittedChars(bounded)).toBe(output.length - ACTOR_RUN_OUTPUT_MAX_CHARS);
    expect(boundedCompleteFits(bounded)).toBe(true);
  });

  it("computes the diagnostic from the full output, not the tail", () => {
    const output = `Error: the real cause\n${"stack line\n".repeat(200_000)}`;
    const result = failed(output, { failure: undefined });
    const bounded = boundRunResult(result, { bytes: 1, sha256: sha("x") });
    expect(bounded.outputBound?.failureDiagnostic).toContain("Error: the real cause");
    expect(bounded.output).not.toContain("Error: the real cause");
  });

  it("does not fit when an untouched field makes the envelope too large", () => {
    const result = failed("short", { sessionId: "s".repeat(BOUNDED_COMPLETE_MAX_BYTES) });
    expect(boundedCompleteFits(boundRunResult(result, { bytes: 5, sha256: sha("short") }))).toBe(
      false
    );
  });

  it("validates a received bound before trusting its counts", () => {
    const good = boundRunResult(failed("z".repeat(50_000)), { bytes: 50_000, sha256: sha("z") });
    const bound = good.outputBound as NonNullable<RunResult["outputBound"]>;
    expect(parseOutputBound(good)).toEqual(good.outputBound);
    expect(parseOutputBound({ ...good, outputBound: { ...bound, totalChars: 3 } })).toBe(undefined);
    expect(parseOutputBound({ ...good, outputBound: { ...bound, sha256: "nope" } })).toBe(
      undefined
    );
    expect(parseOutputBound({ ...good, output: "z".repeat(40_001) })).toBe(undefined);
  });
});
