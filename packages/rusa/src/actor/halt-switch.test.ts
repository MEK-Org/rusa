import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findUnpooledHaltModels, HaltSwitch, parseHaltCommand } from "./halt-switch.js";

describe("HaltSwitch", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "halt-"));
    file = join(dir, "nested", "HALT");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("is not halted until the sentinel exists", () => {
    const halt = new HaltSwitch(file);
    expect(halt.isHalted()).toBe(false);
    halt.halt();
    expect(halt.isHalted()).toBe(true);
    expect(existsSync(file)).toBe(true); // creates intermediate dirs
  });

  it("resume removes the sentinel", () => {
    const halt = new HaltSwitch(file);
    halt.halt();
    halt.resume();
    expect(halt.isHalted()).toBe(false);
  });

  it("records and reads back a reason", () => {
    const halt = new HaltSwitch(file);
    halt.halt("rate-limit storm");
    expect(halt.reason()).toBe("rate-limit storm");
  });

  it("reflects a hand-created file (no cached state)", () => {
    const halt = new HaltSwitch(file);
    expect(halt.isHalted()).toBe(false);
    // Simulate `touch ~/.rusa/HALT` by another process.
    new HaltSwitch(file).halt();
    expect(halt.isHalted()).toBe(true);
  });

  it("halt and resume are idempotent", () => {
    const halt = new HaltSwitch(file);
    halt.resume(); // resuming when not halted is a no-op
    halt.halt();
    halt.halt(); // re-halting is fine
    expect(halt.isHalted()).toBe(true);
    halt.resume();
    halt.resume();
    expect(halt.isHalted()).toBe(false);
  });

  it("applies provider-scoped halts, including the agy alias", () => {
    const halt = new HaltSwitch(file);
    expect(halt.halt("quota", { providers: ["claude", "agy"] })).toBe(true);
    expect(halt.hasActiveHalt()).toBe(true);
    expect(halt.isHalted()).toBe(false);
    expect(halt.isHalted("claude")).toBe(true);
    expect(halt.isHalted("antigravity")).toBe(true);
    expect(halt.isHalted("codex")).toBe(false);
  });

  it("refuses to replace an active halt until resume", () => {
    const halt = new HaltSwitch(file);
    expect(halt.halt("first", { providers: ["claude"] })).toBe(true);
    expect(halt.halt("second", { providers: ["codex"] })).toBe(false);
    expect(halt.isHalted("claude")).toBe(true);
    expect(halt.isHalted("codex")).toBe(false);
  });

  it("treats an expired halt as absent and allows it to be replaced", () => {
    let now = Date.parse("2026-07-26T12:00:00Z");
    const halt = new HaltSwitch(file, () => now);
    halt.halt("lunch", { until: "2026-07-26T13:00:00Z" });
    expect(halt.hasActiveHalt()).toBe(true);
    expect(halt.isHalted()).toBe(true);
    now = Date.parse("2026-07-26T13:00:00Z");
    expect(halt.hasActiveHalt()).toBe(false);
    expect(halt.isHalted()).toBe(false);
    expect(halt.halt("later")).toBe(true);
    expect(halt.reason()).toBe("later");
  });

  it("keeps hand-created and legacy sentinels as global halts", () => {
    new HaltSwitch(file).halt();
    writeFileSync(file, "", "utf8");
    const halt = new HaltSwitch(file);
    expect(halt.isHalted("codex")).toBe(true);
    writeFileSync(file, "operator maintenance\n", "utf8");
    expect(halt.isHalted("claude")).toBe(true);
    expect(halt.reason()).toBe("operator maintenance");
  });

  it("applies model-scoped halts, blocking only matching entries", () => {
    const halt = new HaltSwitch(file);
    expect(
      halt.halt("model issue", {
        providers: ["claude"],
        models: ["claude-sonnet-4-6"],
      })
    ).toBe(true);
    expect(halt.hasActiveHalt()).toBe(true);
    expect(halt.isHalted()).toBe(false);
    // A caller without a selected model must stop rather than run on a model
    // it cannot prove is outside the scoped hold.
    expect(halt.isHalted("claude")).toBe(true);
    expect(halt.isHalted("claude", "claude-sonnet-4-6")).toBe(true);
    expect(halt.isHalted("claude", "claude-opus-4-6")).toBe(false);
    expect(halt.isHalted("codex", "claude-sonnet-4-6")).toBe(false);
  });
});

describe("parseHaltCommand", () => {
  it("parses multiple providers and an expiry", () => {
    expect(parseHaltCommand("/halt provider:claude,agy until:2026-07-27T03:00:00Z")).toEqual({
      providers: ["claude", "antigravity"],
      until: "2026-07-27T03:00:00.000Z",
    });
  });

  it("accepts the pause alias and rejects unknown or malformed atoms", () => {
    expect(parseHaltCommand("/pause")).toEqual({});
    expect(() => parseHaltCommand("/halt provider:")).toThrow(/invalid halt option/);
    expect(() => parseHaltCommand("/halt model:")).toThrow(/invalid halt option/);
    expect(() => parseHaltCommand("/halt foo:bar")).toThrow(/unknown halt option/);
    expect(parseHaltCommand("please halt")).toBeNull();
  });

  it("parses a provider-bound model option", () => {
    expect(parseHaltCommand("/halt provider:claude model:claude-sonnet-4-6")).toEqual({
      providers: ["claude"],
      models: ["claude-sonnet-4-6"],
    });
    expect(() => parseHaltCommand("/halt model:claude-sonnet-4-6")).toThrow(/requires a provider/);
    expect(() => parseHaltCommand("/halt providers:claude")).toThrow(/unknown halt option/);
    expect(() => parseHaltCommand("/halt models:claude-sonnet-4-6")).toThrow(/unknown halt option/);
  });
});

describe("findUnpooledHaltModels", () => {
  const pool = ["claude-opus-5", "Claude-Sonnet-5", "gemini-2.5-flash"];

  it("finds the model no pool entry names and offers the closest entries", () => {
    expect(findUnpooledHaltModels(["claude-opus-5-hihg"], pool)).toEqual([
      { model: "claude-opus-5-hihg", nearest: ["claude-opus-5", "Claude-Sonnet-5"] },
    ]);
  });

  it("matches a pool entry case-insensitively, because the parser lowercases what was typed", () => {
    // `/halt provider:claude model:claude-sonnet-5` arrives here lowercased;
    // a pool configured with mixed-casing like "Claude-Sonnet-5" would otherwise
    // warn about a model that is in fact held.
    expect(findUnpooledHaltModels(["claude-sonnet-5"], pool)).toEqual([]);
  });

  it("reports every unmatched model and keeps the operator's spelling", () => {
    expect(findUnpooledHaltModels(["claude-opus-5", "gpt-5-codex"], pool)).toEqual([
      { model: "gpt-5-codex", nearest: ["claude-opus-5", "Claude-Sonnet-5"] },
    ]);
  });

  it("says nothing when the provider has no pool at all", () => {
    // A provider no live actor is using cannot distinguish a typo from a model
    // the mesh has simply not been told about; warning on every name there
    // would teach the operator to ignore the warning.
    expect(findUnpooledHaltModels(["anything"], [])).toEqual([]);
  });
});
