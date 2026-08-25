import { describe, expect, it } from "vitest";
import {
  assertSpawnContextSupported,
  CONTEXT_SELECTIONS,
  resolveContextSelection,
} from "./context-selection.js";

describe("resolveContextSelection", () => {
  it("leaves the record untouched when nothing is selected", () => {
    // Absent must stay absent, not become an explicit {type:"native"} — every
    // pre-ISSUE_NUM caller spawns without the field and its record must not change.
    expect(resolveContextSelection(undefined)).toBeUndefined();
    expect(resolveContextSelection("")).toBeUndefined();
    expect(resolveContextSelection("  ")).toBeUndefined();
  });

  it("maps native to native", () => {
    expect(resolveContextSelection("native")).toEqual({ type: "native" });
  });

  it("maps each portable mode to itself", () => {
    expect(resolveContextSelection("ledger")).toEqual({
      type: "portable",
      mode: "ledger",
      compactionModel: undefined,
    });
    expect(resolveContextSelection("tail")).toEqual({ type: "portable", mode: "tail" });
  });

  it("has no bare portable selection", () => {
    // Per Operator on 2026-08-08: `ledger` and `tail` ARE the portable modes, so a
    // word naming their family would sit at a different level than the rest of
    // the vocabulary. Asking for it is an unknown selection, not a silent ledger.
    expect(() => resolveContextSelection("portable")).toThrow("unknown context selection");
  });

  it("carries a compaction model onto ledger", () => {
    expect(resolveContextSelection("ledger", { compactionModel: " gemini-x " })).toMatchObject({
      compactionModel: "gemini-x",
    });
  });

  it("refuses a compaction model for modes that never compact", () => {
    // A knob that is accepted, stored, and never consulted is the failure this
    // arc keeps finding. Each of these must be an error, not an ignored field.
    expect(() => resolveContextSelection("tail", { compactionModel: "gemini-x" })).toThrow(
      "never compacts"
    );
    expect(() => resolveContextSelection("native", { compactionModel: "gemini-x" })).toThrow(
      "meaningless for native"
    );
    expect(() => resolveContextSelection(undefined, { compactionModel: "gemini-x" })).toThrow(
      "requires a portable context selection"
    );
  });

  it("names the valid values when the selection is unknown", () => {
    expect(() => resolveContextSelection("portible")).toThrow("portible");
    expect(() => resolveContextSelection("portible")).toThrow("native, ledger, tail");
    expect(() => resolveContextSelection(7)).toThrow("unknown context selection");
  });

  it("resolves every advertised selection", () => {
    // Counter-assertion to the throw cells above: the vocabulary the MCP enum
    // publishes must be exactly the vocabulary this door accepts, so a value
    // added to one and not the other fails here instead of at a caller.
    for (const selection of CONTEXT_SELECTIONS) {
      expect(() => resolveContextSelection(selection)).not.toThrow();
    }
  });
});

describe("assertSpawnContextSupported", () => {
  const available = { ledgerCompactionAvailable: true };
  const unavailable = { ledgerCompactionAvailable: false };

  it("ignores native and unspecified spawns", () => {
    expect(() => assertSpawnContextSupported({}, unavailable)).not.toThrow();
    expect(() =>
      assertSpawnContextSupported({ context: { type: "native" } }, unavailable)
    ).not.toThrow();
    // A native spawn may still seed a conversation — that path is untouched.
    expect(() =>
      assertSpawnContextSupported(
        { context: { type: "native" }, conversationId: "conv-1" },
        unavailable
      )
    ).not.toThrow();
  });

  it("refuses to seed a conversation into a stateless actor", () => {
    // Portable actors never resume, so the id would be written to the record and
    // silently never used — the caller would think it promoted a conversation.
    expect(() =>
      assertSpawnContextSupported(
        { context: { type: "portable", mode: "tail" }, conversationId: "conv-1" },
        available
      )
    ).toThrow("never resumes a provider conversation");
  });

  it("refuses ledger when compaction is unavailable", () => {
    expect(() =>
      assertSpawnContextSupported({ context: { type: "portable", mode: "ledger" } }, unavailable)
    ).toThrow("geminiApiKey");
  });

  it("allows ledger when compaction is available, and tail either way", () => {
    expect(() =>
      assertSpawnContextSupported({ context: { type: "portable", mode: "ledger" } }, available)
    ).not.toThrow();
    // Tail never calls the compactor, so a missing key must NOT block it —
    // otherwise the guard would be refusing a configuration that works.
    expect(() =>
      assertSpawnContextSupported({ context: { type: "portable", mode: "tail" } }, unavailable)
    ).not.toThrow();
  });
});
