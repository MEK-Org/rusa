import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  extractAgyTokenUsage,
  extractClaudeTokenUsage,
  extractCodexTokenUsage,
  extractKimiTokenUsage,
} from "./token-accounting.js";

const fixture = (name: string): string =>
  readFileSync(join(import.meta.dirname, "fixtures", name), "utf8");

describe("provider token normalizers", () => {
  it("folds Claude cache creation into uncached input", () => {
    const result = extractClaudeTokenUsage(fixture("token-claude.jsonl").trim().split("\n"));
    expect(result).toEqual({
      model: "claude-fixture",
      totals: {
        uncachedInput: 27,
        cacheRead: 9,
        output: 13,
        reasoning: null,
        response: null,
      },
    });
  });

  it("attributes only the second Codex run in a resumed session transcript", () => {
    expect(
      extractCodexTokenUsage(fixture("token-codex-resumed.jsonl"), "2026-07-24T10:00:00Z")
    ).toEqual({
      uncachedInput: 60,
      cacheRead: 30,
      output: 15,
      reasoning: null,
      response: null,
    });
  });

  it("attributes only the second Kimi run in a resumed session transcript", () => {
    expect(
      extractKimiTokenUsage(fixture("token-kimi-resumed.jsonl"), "2026-07-24T10:00:00Z")
    ).toEqual({
      uncachedInput: 25,
      cacheRead: 12,
      output: 11,
      reasoning: null,
      response: null,
    });
  });

  it("decodes agy fields and checks output = reasoning + response", () => {
    const rows = JSON.parse(fixture("token-agy.json")) as Array<{
      uncachedInput: number;
      cacheRead: number;
      output: number;
      reasoning: number;
      response: number;
      model: string;
    }>;
    const encoded = rows.map((row) =>
      message([
        [
          1,
          message([
            [
              4,
              message([
                [2, row.uncachedInput],
                [5, row.cacheRead],
                [3, row.output],
                [9, row.reasoning],
                [10, row.response],
              ]),
            ],
            [21, Buffer.from(row.model)],
          ]),
        ],
      ])
    );
    expect(extractAgyTokenUsage(encoded)).toEqual({
      model: "agy-fixture",
      totals: {
        uncachedInput: 36,
        cacheRead: 52,
        output: 27,
        reasoning: 13,
        response: 14,
      },
    });
  });
});

type Field = [number, number | Buffer];

function varint(value: number): Buffer {
  const bytes: number[] = [];
  let remaining = value;
  do {
    let byte = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
    if (remaining) byte |= 0x80;
    bytes.push(byte);
  } while (remaining);
  return Buffer.from(bytes);
}

function message(fields: Field[]): Buffer {
  return Buffer.concat(
    fields.flatMap(([number, value]) =>
      typeof value === "number"
        ? [varint(number * 8), varint(value)]
        : [varint(number * 8 + 2), varint(value.length), value]
    )
  );
}
