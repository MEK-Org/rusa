import { describe, expect, it } from "vitest";
import type { RusaConfig } from "../config/types.js";
import { resolveWritableErrorSource } from "./error-source.js";

const base = {
  github: { account: "test" },
  providers: {},
  webhook: { port: 0, secret: "" },
} as RusaConfig;

describe("writable error source", () => {
  it("resolves Google Chat and Slack event source references", () => {
    expect(
      resolveWritableErrorSource({
        ...base,
        chat: {} as RusaConfig["chat"],
        observability: { errorSource: "gchat:spaces/AAAA" },
      })
    ).toEqual({ ref: "gchat:spaces/AAAA", kind: "gchat", target: "spaces/AAAA" });
    expect(
      resolveWritableErrorSource({
        ...base,
        slack: {} as RusaConfig["slack"],
        observability: { errorSource: "slack:channels/C123" },
      })
    ).toEqual({ ref: "slack:channels/C123", kind: "slack", target: "C123" });
  });

  it("keeps chat.errorChat as a deprecated fallback", () => {
    expect(
      resolveWritableErrorSource({
        ...base,
        chat: { errorChat: "spaces/AAAA" } as RusaConfig["chat"],
      })
    ).toEqual({ ref: "gchat:spaces/AAAA", kind: "gchat", target: "spaces/AAAA" });
    expect(
      resolveWritableErrorSource({
        ...base,
        chat: { errorChat: "spaces/AAAA" } as RusaConfig["chat"],
        observability: { errorSource: "gchat:spaces/AAAA" },
      })
    ).toEqual({ ref: "gchat:spaces/AAAA", kind: "gchat", target: "spaces/AAAA" });
  });

  it("rejects conflicting, unsupported, and non-writable references", () => {
    expect(() =>
      resolveWritableErrorSource({
        ...base,
        chat: { errorChat: "spaces/AAAA" } as RusaConfig["chat"],
        observability: { errorSource: "slack:channels/C123" },
      })
    ).toThrow(/conflicts/);
    for (const ref of ["github:org/repo", "gchat:spaces/AAAA/messages/M1", "slack:channels"]) {
      expect(() =>
        resolveWritableErrorSource({ ...base, observability: { errorSource: ref } })
      ).toThrow();
    }
    expect(() =>
      resolveWritableErrorSource({ ...base, observability: { errorSource: "slack:channels/C123" } })
    ).toThrow(/no configured writer/);
  });
});
