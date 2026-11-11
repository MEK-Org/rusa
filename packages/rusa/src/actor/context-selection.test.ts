import { describe, expect, it } from "vitest";
import {
  assertSpawnContextSupported,
  CONTEXT_SELECTIONS,
  resolveContextConfig,
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

  it("maps each supported portable mode to itself", () => {
    expect(resolveContextSelection("tail")).toEqual({ type: "portable", mode: "tail" });
    expect(resolveContextSelection("brief")).toEqual({ type: "portable", mode: "brief" });
  });

  it("rejects retired ledger mode immediately at configuration boundaries (#1266)", () => {
    expect(() => resolveContextSelection("ledger")).toThrow(
      "portable ledger mode has been retired; use 'brief' or 'tail' mode instead"
    );
    expect(() => resolveContextSelection("ledger", { compactionModel: "gemini-x" })).toThrow(
      "portable ledger mode has been retired; use 'brief' or 'tail' mode instead"
    );
    expect(() => resolveContextConfig({ type: "portable", mode: "ledger" })).toThrow(
      "portable ledger mode has been retired; use 'brief' or 'tail' mode instead"
    );
    expect(() =>
      resolveContextConfig({ type: "portable", mode: "ledger", compactionModel: "gemini-x" })
    ).toThrow("portable ledger mode has been retired; use 'brief' or 'tail' mode instead");
  });

  it("has no bare portable selection", () => {
    expect(() => resolveContextSelection("portable")).toThrow("unknown context selection");
  });

  it("refuses compactionModel with clear retirement error (#1266)", () => {
    expect(() => resolveContextSelection("tail", { compactionModel: "gemini-x" })).toThrow(
      "compactionModel is not supported; portable ledger mode has been retired"
    );
    expect(() => resolveContextSelection("native", { compactionModel: "gemini-x" })).toThrow(
      "compactionModel is not supported; portable ledger mode has been retired"
    );
    expect(() => resolveContextSelection(undefined, { compactionModel: "gemini-x" })).toThrow(
      "compactionModel is not supported; portable ledger mode has been retired"
    );
    expect(() => resolveContextSelection("brief", { compactionModel: "gemini-x" })).toThrow(
      "compactionModel is not supported; portable ledger mode has been retired"
    );
    expect(() =>
      resolveContextConfig({ type: "portable", mode: "brief", compactionModel: "gemini-x" })
    ).toThrow("compactionModel is not supported; portable ledger mode has been retired");
  });

  it("names the valid values when the selection is unknown", () => {
    expect(() => resolveContextSelection("portible")).toThrow("portible");
    expect(() => resolveContextSelection("portible")).toThrow("native, tail, brief");
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
  it("ignores native and unspecified spawns", () => {
    expect(() => assertSpawnContextSupported({})).not.toThrow();
    expect(() => assertSpawnContextSupported({ context: { type: "native" } })).not.toThrow();
    // A native spawn may still seed a conversation — that path is untouched.
    expect(() =>
      assertSpawnContextSupported({ context: { type: "native" }, conversationId: "conv-1" })
    ).not.toThrow();
  });

  it("refuses to seed a conversation into a stateless actor", () => {
    // Portable actors never resume, so the id would be written to the record and
    // silently never used — the caller would think it promoted a conversation.
    expect(() =>
      assertSpawnContextSupported({
        context: { type: "portable", mode: "tail" },
        conversationId: "conv-1",
      })
    ).toThrow("never resumes a provider conversation");
  });

  it("refuses retired ledger context immediately (#1266)", () => {
    expect(() =>
      assertSpawnContextSupported({ context: { type: "portable", mode: "ledger" } })
    ).toThrow("portable ledger mode has been retired; use 'brief' or 'tail' mode instead");
  });

  it("allows tail and brief modes", () => {
    expect(() =>
      assertSpawnContextSupported({ context: { type: "portable", mode: "brief" } })
    ).not.toThrow();
    expect(() =>
      assertSpawnContextSupported({ context: { type: "portable", mode: "tail" } })
    ).not.toThrow();
  });
});
