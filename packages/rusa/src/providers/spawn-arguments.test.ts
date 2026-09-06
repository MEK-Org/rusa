import { describe, expect, it } from "vitest";
import { ARGV_NUL_REPLACEMENT, sanitizeArgvText } from "./spawn-arguments.js";

// Written as an escape so the byte under test survives an editor, a copy-paste
// and a diff view on its way into this file.
const NUL = "\u0000";

describe("sanitizeArgvText", () => {
  it("replaces a NUL with U+FFFD and keeps everything around it", () => {
    expect(sanitizeArgvText(`before${NUL}after`)).toBe(`before${ARGV_NUL_REPLACEMENT}after`);
  });

  it("replaces every NUL, not just the first", () => {
    const value = `${NUL}a${NUL}b${NUL}`;
    const sanitized = sanitizeArgvText(value);
    expect(sanitized).toBe(
      `${ARGV_NUL_REPLACEMENT}a${ARGV_NUL_REPLACEMENT}b${ARGV_NUL_REPLACEMENT}`
    );
    // Replacement, never truncation: the prompt keeps its shape.
    expect(sanitized).toHaveLength(value.length);
  });

  it("leaves a NUL-free value untouched, other control characters included", () => {
    // Everything else the process API accepts is delivered as assembled: this is
    // the launch boundary, not a general text normalizer.
    const value = "tab\tnewline\ncarriage\rbell\u0007escape\u001b[0m emoji 🦌 end";
    expect(sanitizeArgvText(value)).toBe(value);
  });

  it("leaves an existing U+FFFD alone, so sanitizing twice matches sanitizing once", () => {
    const once = sanitizeArgvText(`x${NUL}y`);
    expect(sanitizeArgvText(once)).toBe(once);
  });
});
