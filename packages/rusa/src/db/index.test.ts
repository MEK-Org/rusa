import { describe, expect, it } from "vitest";
import { parseTimestampAsUtcMillis } from "./index.js";

describe("parseTimestampAsUtcMillis", () => {
  it("parses integer seconds correctly without trailing Z", () => {
    const input = "2026-07-04 03:00:58";
    const expected = Date.UTC(2026, 6, 4, 3, 0, 58);
    expect(parseTimestampAsUtcMillis(input)).toBe(expected);
  });

  it("parses integer seconds correctly with trailing Z", () => {
    const input = "2026-07-04 03:00:58Z";
    const expected = Date.UTC(2026, 6, 4, 3, 0, 58);
    expect(parseTimestampAsUtcMillis(input)).toBe(expected);
  });

  it("parses fractional seconds correctly without trailing Z", () => {
    const input = "2026-07-04 03:00:58.338";
    const expected = Date.UTC(2026, 6, 4, 3, 0, 58, 338);
    expect(parseTimestampAsUtcMillis(input)).toBe(expected);
  });

  it("parses fractional seconds correctly with trailing Z", () => {
    const input = "2026-07-04 03:00:58.338Z";
    const expected = Date.UTC(2026, 6, 4, 3, 0, 58, 338);
    expect(parseTimestampAsUtcMillis(input)).toBe(expected);
  });

  it("handles America/Los_Angeles timezone offset without shifting parsed epoch-millis", () => {
    const oldTz = process.env.TZ;
    process.env.TZ = "America/Los_Angeles";
    try {
      const input = "2026-07-04 03:00:58.338";
      const expected = Date.UTC(2026, 6, 4, 3, 0, 58, 338);
      const parsed = parseTimestampAsUtcMillis(input);
      expect(parsed).toBe(expected);
    } finally {
      process.env.TZ = oldTz;
    }
  });
});
