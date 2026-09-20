import { describe, expect, it } from "vitest";
import type { RusaConfig } from "../config/types.js";
import { resolveErrorSink } from "./error-sink.js";

const base = {
  github: { account: "test" },
  providers: {},
  webhook: { port: 0, secret: "" },
} as RusaConfig;

describe("writable error sink", () => {
  it("resolves Google Chat and Slack event source references", () => {
    expect(
      resolveErrorSink({
        ...base,
        chat: {} as RusaConfig["chat"],
        observability: { errorSink: "gchat:spaces/AAAA" },
      })
    ).toEqual({ ref: "gchat:spaces/AAAA", kind: "gchat", target: "spaces/AAAA" });
    expect(
      resolveErrorSink({
        ...base,
        slack: {} as RusaConfig["slack"],
        observability: { errorSink: "slack:channels/C123" },
      })
    ).toEqual({ ref: "slack:channels/C123", kind: "slack", target: "C123" });
  });

  it("keeps chat.errorChat as a deprecated fallback", () => {
    expect(
      resolveErrorSink({
        ...base,
        chat: { errorChat: "spaces/AAAA" } as RusaConfig["chat"],
      })
    ).toEqual({ ref: "gchat:spaces/AAAA", kind: "gchat", target: "spaces/AAAA" });
    expect(
      resolveErrorSink({
        ...base,
        chat: { errorChat: "spaces/AAAA" } as RusaConfig["chat"],
        observability: { errorSink: "gchat:spaces/AAAA" },
      })
    ).toEqual({ ref: "gchat:spaces/AAAA", kind: "gchat", target: "spaces/AAAA" });
  });

  it("rejects conflicting, unsupported, and non-writable references", () => {
    expect(() =>
      resolveErrorSink({
        ...base,
        chat: { errorChat: "spaces/AAAA" } as RusaConfig["chat"],
        observability: { errorSink: "slack:channels/C123" },
      })
    ).toThrow(/conflicts/);
    for (const ref of ["github:org/repo", "gchat:spaces/AAAA/messages/M1", "slack:channels"]) {
      expect(() => resolveErrorSink({ ...base, observability: { errorSink: ref } })).toThrow();
    }
    expect(() =>
      resolveErrorSink({ ...base, observability: { errorSink: "slack:channels/C123" } })
    ).toThrow(/no configured writer/);
  });
});
