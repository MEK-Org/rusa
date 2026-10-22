import { describe, expect, it } from "vitest";
import { MessageStampService } from "./message-stamp.js";
import { type ActiveRunContext, bindRunContext, resolveRunContextProvider } from "./run-context.js";

const context = (overrides: Partial<ActiveRunContext> = {}): ActiveRunContext => ({
  actorId: "actor-a",
  runId: "run-a",
  startedAt: "2026-10-22T00:00:00.000Z",
  selectedInboxEntryIds: [],
  primaryObligationId: null,
  effectiveResponsive: false,
  ...overrides,
});

describe("bound run context", () => {
  it("keeps omitted actual-attempt fields as provider defaults", () => {
    expect(
      resolveRunContextProvider(
        { provider: "codex" },
        { provider: "antigravity", model: "Gemini 3.7 Flash", effort: "high" }
      )
    ).toStrictEqual({ provider: "codex" });
  });

  it("reads fresh focus and attempt facts only for its exact active run", () => {
    let current: ActiveRunContext | undefined = context({ provider: "first" });
    const lease = bindRunContext("actor-a", "run-a", () => current);
    expect(lease.reader.current()).toMatchObject({ provider: "first", effectiveResponsive: false });

    current = context({
      provider: "fallback",
      selectedInboxEntryIds: ["entry-1"],
      primaryObligationId: "obligation-1",
      effectiveResponsive: true,
    });
    expect(lease.reader.current()).toMatchObject({
      provider: "fallback",
      selectedInboxEntryIds: ["entry-1"],
      effectiveResponsive: true,
    });
  });

  it("never falls forward to a later run and rejects after revocation", () => {
    let current: ActiveRunContext | undefined = context();
    const lease = bindRunContext("actor-a", "run-a", () => current);
    current = context({ runId: "run-b", effectiveResponsive: true });
    expect(lease.reader.current()).toBeUndefined();

    current = context();
    lease.revoke();
    expect(lease.reader.current()).toBeUndefined();
  });

  it("stamps human ingress and refuses ended actor contexts", () => {
    const stamps = new MessageStampService();
    expect(stamps.stampHuman()).toEqual({ responsive: true, responsiveReason: "human message" });

    let current: ActiveRunContext | undefined = context({ effectiveResponsive: true });
    const lease = bindRunContext("actor-a", "run-a", () => current);
    expect(stamps.stampActor(lease.reader)).toEqual({
      responsive: true,
      responsiveReason: "responsive obligation",
    });
    current = undefined;
    expect(() => stamps.stampActor(lease.reader)).toThrow("has ended");
  });
});
