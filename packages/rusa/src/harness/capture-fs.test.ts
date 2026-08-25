import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { entryPresent, listEntries, type Probe } from "./capture-fs.js";

/**
 * These test the ENFORCEMENT, not a read.
 *
 * The first cut of this module exported the three-way union directly and claimed a two-state
 * read was structurally impossible. It wasn't: a reviewer collapsed it in four lines with no
 * cast and no type error (`probe.outcome === "ok" ? probe.value : null`), silently merging
 * `absent` with `unknown` — the exact bug the module exists to prevent, now available to
 * every future caller. A public tag union is a convention; only an unobservable one is an
 * enforcement.
 *
 * Every negative below is a `@ts-expect-error`, which is a real assertion in both directions:
 * if the code ever starts compiling, the directive becomes unused and the typecheck FAILS.
 * That is the counter-assertion, built into the mechanism instead of bolted beside it.
 */
describe("a Probe cannot be observed as two states (ISSUE_NUM enforcement)", () => {
  it("has no readable outcome tag — the reviewer's counterexample no longer compiles", () => {
    const probe: Probe<true> = entryPresent(import.meta.dirname);
    // @ts-expect-error — `outcome` lives in a `#private` field; no property access reaches it.
    const outcome = probe.outcome;
    // And it is private at runtime too, so an `as any` cast finds nothing either.
    expect(outcome).toBeUndefined();
  });

  it("requires a handler for all three outcomes", () => {
    const probe = listEntries(join(tmpdir(), "no-such-dir-1376"));
    // @ts-expect-error — omitting `unknown` is what turns a failed read into a fake absence,
    // so it must not be something a call site can express.
    const collapsed = probe.match({ ok: () => "ok", absent: () => "absent" });
    expect(collapsed).toBe("absent");
  });

  it("cannot be forged from a structurally identical object", () => {
    // @ts-expect-error — the private field makes the type nominal, so a hand-built union
    // cannot be smuggled past a consumer that expects the policy to have been applied.
    const forged: Probe<number> = { outcome: "ok", value: 1 };
    expect(forged).toBeDefined();
  });

  it("keeps its state private at runtime, not only in the type", () => {
    const probe = entryPresent(import.meta.dirname);
    expect(Object.keys(probe)).toEqual([]);
    expect(JSON.parse(JSON.stringify(probe))).toEqual({});
  });

  it("never throws: a missing path yields a probe, and ENOENT is the only absence", () => {
    const seen = listEntries(join(tmpdir(), "no-such-dir-1376")).match({
      ok: () => "ok",
      absent: () => "absent",
      unknown: (code) => code,
    });
    expect(seen).toBe("absent");
  });
});
