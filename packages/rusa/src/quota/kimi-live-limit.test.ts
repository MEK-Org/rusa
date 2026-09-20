import { describe, expect, it } from "vitest";
import { isKimiFiveHourLimit403 } from "./kimi-live-limit.js";

describe("isKimiFiveHourLimit403", () => {
  it("accepts Kimi's reproduced authenticated five-hour limit response", () => {
    expect(
      isKimiFiveHourLimit403("provider.auth_error: 403 You've reached your 5-hour usage limit")
    ).toBe(true);
  });

  it("does not turn unrelated 403s or generic rate limits into a five-hour exhaustion", () => {
    expect(isKimiFiveHourLimit403("provider.auth_error: 403 token expired")).toBe(false);
    expect(isKimiFiveHourLimit403("429 usage limit reached")).toBe(false);
  });
});
