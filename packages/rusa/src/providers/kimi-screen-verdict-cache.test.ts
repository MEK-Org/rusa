import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  classifierIdFor,
  KIMI_SCREEN_STATES,
  KimiScreenVerdictCache,
  MAX_CACHED_VERDICTS,
  normalizeScreen,
  recognizeKimiScreenState,
  screenIsBlank,
} from "./kimi-screen-verdict-cache.js";

const dirs: string[] = [];
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "rusa-kimi-verdicts-"));
  dirs.push(dir);
  return dir;
};

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

const ID = "classifier-under-test";

describe("normalizeScreen — the weakest normalization that still matches a resampled pane", () => {
  it("ignores the right-edge padding tmux adds or clips between captures", () => {
    expect(normalizeScreen("> \n  ")).toBe(normalizeScreen(">\n"));
    expect(normalizeScreen("\n\n> ready   \n\n  \n")).toBe("> ready");
  });

  it("leaves a countdown intact, so a ticking panel is a DIFFERENT screen", () => {
    // The load-bearing negative. Two /usage panels a minute apart differ only in the
    // countdown minute; normalizing that away would make the cache answer for a screen it
    // never saw, and the only way to do it is the pattern-matching ISSUE_NUM forbids. Measured
    // on this plane: this is why the payload read is a guaranteed cache MISS by construction,
    // and why "degrade honestly" — not this cache — has to carry darkness on that read.
    const a = "Weekly limit  28% used\nresets in 5d 13h 42m";
    const b = "Weekly limit  28% used\nresets in 5d 13h 41m";
    expect(normalizeScreen(a)).not.toBe(normalizeScreen(b));

    const cache = new KimiScreenVerdictCache(null, ID);
    cache.set(a, "usage_panel");
    expect(cache.get(b)).toBeNull();
  });
});

describe("screenIsBlank", () => {
  it("is true only for a pane with nothing painted on it", () => {
    expect(screenIsBlank("")).toBe(true);
    expect(screenIsBlank("\n\n\n")).toBe(true);
    expect(screenIsBlank("   \n \n")).toBe(true);
    expect(screenIsBlank(">")).toBe(false);
    expect(screenIsBlank("\n\n  Welcome to Kimi Code!  \n")).toBe(false);
  });
});

describe("recognizeKimiScreenState — a named verdict vs the absence of one", () => {
  it("returns null rather than `unknown` for anything the vocabulary does not name", () => {
    // `unknown` is a verdict about a screen; null is "nothing answered". Only the first is
    // cacheable, so collapsing them is what let a schema failure be stored as an answer.
    expect(recognizeKimiScreenState("usage_panel")).toBe("usage_panel");
    expect(recognizeKimiScreenState("unknown")).toBe("unknown");
    expect(recognizeKimiScreenState("probably_usage")).toBeNull();
    expect(recognizeKimiScreenState(undefined)).toBeNull();
    expect(recognizeKimiScreenState(null)).toBeNull();
    expect(recognizeKimiScreenState(7)).toBeNull();
  });
});

describe("classifierIdFor", () => {
  it("changes when the model, the instruction, or the vocabulary changes", () => {
    const base = classifierIdFor("model-a", "instruction", KIMI_SCREEN_STATES);
    expect(classifierIdFor("model-b", "instruction", KIMI_SCREEN_STATES)).not.toBe(base);
    expect(classifierIdFor("model-a", "instruction!", KIMI_SCREEN_STATES)).not.toBe(base);
    expect(classifierIdFor("model-a", "instruction", ["ready"])).not.toBe(base);
    expect(classifierIdFor("model-a", "instruction", KIMI_SCREEN_STATES)).toBe(base);
  });
});

describe("KimiScreenVerdictCache", () => {
  it("replays a recorded verdict for a byte-identical screen and misses on a new one", () => {
    const cache = new KimiScreenVerdictCache(null, ID);
    const boot = "  Welcome to Kimi Code!  \n  > \n";

    expect(cache.get(boot)).toBeNull();
    cache.set(boot, "ready");
    expect(cache.get(boot)).toBe("ready");
    expect(cache.get(`${boot}\n`)).toBe("ready"); // same screen, resampled
    expect(cache.get("a different screen")).toBeNull();

    expect(cache.stats()).toMatchObject({ hits: 2, misses: 2, stored: 1 });
  });

  it("replays across processes, which is the only place the win exists", () => {
    // scrapeKimiUsage runs in a short-lived probe, so an in-process memo is dead before the
    // next reading. Measured: boot panes are byte-identical ACROSS readings, so this — a
    // second cache instance over the same file — is the case that saves the calls.
    const path = join(tempDir(), "verdicts.json");
    const boot = "Welcome to Kimi Code!\n>";

    new KimiScreenVerdictCache(path, ID).set(boot, "ready");

    const reopened = new KimiScreenVerdictCache(path, ID);
    expect(reopened.stats().loaded).toBe(1);
    expect(reopened.get(boot)).toBe("ready");
    expect(reopened.stats().degraded).toBeNull();
  });

  it("does not replay verdicts a different classifier produced", () => {
    const path = join(tempDir(), "verdicts.json");
    new KimiScreenVerdictCache(path, "old-prompt").set("screen", "usage_panel");

    const reopened = new KimiScreenVerdictCache(path, "new-prompt");
    expect(reopened.stats().loaded).toBe(0);
    expect(reopened.get("screen")).toBeNull();
  });

  it("drops a stored state the current vocabulary does not name, rather than coercing it", () => {
    // Coercing an unrecognized state to `unknown` would look harmless and would be a
    // fabricated classification: nothing ever judged that screen to be unknown.
    const path = join(tempDir(), "verdicts.json");
    writeFileSync(
      path,
      JSON.stringify({
        classifierId: ID,
        entries: [
          { key: "abc", state: "probably_usage" },
          { key: "def", state: "ready" },
        ],
      })
    );

    expect(new KimiScreenVerdictCache(path, ID).stats().loaded).toBe(1);
  });

  it("starts empty and says so when the file is corrupt, instead of failing the reading", () => {
    const path = join(tempDir(), "verdicts.json");
    writeFileSync(path, "{ not json");

    const cache = new KimiScreenVerdictCache(path, ID);

    expect(cache.stats().loaded).toBe(0);
    expect(cache.get("screen")).toBeNull();
    expect(cache.stats().degraded).toContain("could not read verdict cache");
  });

  it("degrades to memory-only on an unwritable path and reports it", () => {
    // This worker plane hits EROFS . A cache must never be able to break the probe
    // it serves, and "I could not persist" must be visible rather than silent.
    const notADir = join(tempDir(), "occupied");
    writeFileSync(notADir, "");
    const cache = new KimiScreenVerdictCache(join(notADir, "verdicts.json"), ID);

    expect(() => cache.set("screen", "ready")).not.toThrow();
    expect(cache.get("screen")).toBe("ready"); // still replays within the run
    expect(cache.stats().degraded).toContain("memory-only");
  });

  it("stays bounded, dropping the least recently written first", () => {
    const path = join(tempDir(), "verdicts.json");
    const cache = new KimiScreenVerdictCache(path, ID);
    for (let i = 0; i < MAX_CACHED_VERDICTS + 5; i++) cache.set(`screen ${i}`, "ready");

    const file = JSON.parse(readFileSync(path, "utf8")) as { entries: unknown[] };
    expect(file.entries).toHaveLength(MAX_CACHED_VERDICTS);
    expect(cache.get("screen 0")).toBeNull();
    expect(cache.get(`screen ${MAX_CACHED_VERDICTS + 4}`)).toBe("ready");
  });
});
