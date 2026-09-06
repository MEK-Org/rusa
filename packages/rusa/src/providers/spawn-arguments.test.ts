import { describe, expect, it } from "vitest";
import {
  ARGV_NUL_REPLACEMENT,
  SPAWN_ARGUMENT_ERROR_NAME,
  SpawnArgumentError,
  sanitizeArgv,
  sanitizeArgvValue,
  toSpawnArgumentError,
} from "./spawn-arguments.js";

// Written as an escape so the byte under test survives an editor, a copy-paste
// and a diff view on its way into this file.
const NUL = "\u0000";

// A stand-in for the kind of value that must never reach a run record. Not a
// real credential — the point is only that it is recognizable in an assertion.
const NEVER_DISCLOSE = "fixture-argv-value-must-not-appear";

describe("sanitizeArgvValue", () => {
  it("replaces a NUL with U+FFFD and keeps everything around it", () => {
    expect(sanitizeArgvValue(`before${NUL}after`)).toBe(`before${ARGV_NUL_REPLACEMENT}after`);
  });

  it("replaces every NUL, not just the first", () => {
    const value = `${NUL}a${NUL}b${NUL}`;
    const sanitized = sanitizeArgvValue(value);
    expect(sanitized).toBe(
      `${ARGV_NUL_REPLACEMENT}a${ARGV_NUL_REPLACEMENT}b${ARGV_NUL_REPLACEMENT}`
    );
    // Replacement, never truncation: the prompt keeps its shape.
    expect(sanitized).toHaveLength(value.length);
  });

  it("leaves a NUL-free value untouched, other control characters included", () => {
    const value = "tab\tnewline\ncarriage\rbell\u0007escape\u001b[0m emoji 🦌 end";
    expect(sanitizeArgvValue(value)).toBe(value);
  });

  it("leaves an existing U+FFFD alone, so sanitizing twice matches sanitizing once", () => {
    const once = sanitizeArgvValue(`x${NUL}y`);
    expect(sanitizeArgvValue(once)).toBe(once);
  });
});

describe("sanitizeArgv", () => {
  it("sanitizes every entry and preserves order and arity", () => {
    expect(sanitizeArgv(["-p", `prompt${NUL}tail`, "--model", "claude-opus-5"])).toEqual([
      "-p",
      `prompt${ARGV_NUL_REPLACEMENT}tail`,
      "--model",
      "claude-opus-5",
    ]);
  });
});

describe("toSpawnArgumentError", () => {
  it("keeps the class and code of a real spawn rejection and drops the quoted value", () => {
    // The shape Node throws from `spawn`: the message quotes the rejected argv.
    const nodeError = Object.assign(
      new TypeError(
        `The argument 'args[0]' must be a string without null bytes. Received '${NEVER_DISCLOSE}'`
      ),
      { code: "ERR_INVALID_ARG_VALUE" }
    );

    const error = toSpawnArgumentError(nodeError);

    expect(error).toBeInstanceOf(SpawnArgumentError);
    expect(error.name).toBe(SPAWN_ARGUMENT_ERROR_NAME);
    expect(error.errorClass).toBe("TypeError");
    expect(error.code).toBe("ERR_INVALID_ARG_VALUE");
    expect(error.message).toContain("TypeError [ERR_INVALID_ARG_VALUE]");
    expect(error.message).not.toContain(NEVER_DISCLOSE);
    // No cause chain: a serializer that walks `cause` would re-publish the value.
    expect(error.cause).toBeUndefined();
    expect(error.stack ?? "").not.toContain(NEVER_DISCLOSE);
  });

  it("still names a rejection that carries no code", () => {
    const error = toSpawnArgumentError(new RangeError(NEVER_DISCLOSE));
    expect(error.errorClass).toBe("RangeError");
    expect(error.code).toBeUndefined();
    expect(error.message).toContain("(RangeError)");
    expect(error.message).not.toContain(NEVER_DISCLOSE);
  });

  it("names a non-Error throw rather than letting it through unclassified", () => {
    const error = toSpawnArgumentError(NEVER_DISCLOSE);
    expect(error).toBeInstanceOf(SpawnArgumentError);
    expect(error.message).not.toContain(NEVER_DISCLOSE);
  });

  it("is idempotent on an error it already produced", () => {
    const error = toSpawnArgumentError(new TypeError("x"));
    expect(toSpawnArgumentError(error)).toBe(error);
  });
});
