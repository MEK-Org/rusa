import { describe, expect, it } from "vitest";
import { runEndModel, runEndPayload } from "./mesh-events.js";

describe("run_end payload", () => {
  it("round-trips the model a run reported", () => {
    expect(runEndModel(runEndPayload({ model: "gpt-5.5-codex" }))).toBe("gpt-5.5-codex");
    expect(runEndModel(runEndPayload({ runId: "run-1", model: "gpt-5.5-codex" }))).toBe(
      "gpt-5.5-codex"
    );
    // A run recorded before #828 still carries the historical yield keys.
    expect(
      runEndModel(
        JSON.stringify({ model: "gpt-5.5-codex", graceKilled: true, yieldStatus: "blocked" })
      )
    ).toBe("gpt-5.5-codex");
  });

  it("round-trips the abortReason a run reported", () => {
    const payload = runEndPayload({ runId: "run-1", abortReason: "stall-watchdog" });
    expect(payload).toBeDefined();
    expect(JSON.parse(payload ?? "{}")).toMatchObject({
      runId: "run-1",
      abortReason: "stall-watchdog",
    });
  });

  it("records no payload at all for an ordinary run", () => {
    // An unremarkable run must not start writing `{"model":null}` rows: the payload
    // column is read by other consumers, and an object of nulls is not "nothing".
    expect(runEndPayload({})).toBeUndefined();
    expect(runEndPayload({ model: undefined })).toBeUndefined();
    // ...but a run with something else to say still carries it, model or no model.
    expect(runEndPayload({ runId: "run-1" })).toBeDefined();
    expect(runEndModel(runEndPayload({ runId: "run-1" }))).toBeNull();
  });

  it("reads NOT REPORTED as null, never as a value", () => {
    // Each of these is a different way of not knowing, and they must not diverge: a
    // caller that got a string back from any of them would treat an unmeasured run as
    // measured, which is the failure `harness/model-identity.ts` exists to prevent.
    expect(runEndModel(undefined)).toBeNull();
    expect(runEndModel(null)).toBeNull();
    expect(runEndModel("")).toBeNull();
    expect(runEndModel("not json")).toBeNull();
    expect(runEndModel(JSON.stringify({ graceKilled: true }))).toBeNull();
    expect(runEndModel(JSON.stringify({ model: null }))).toBeNull();
    expect(runEndModel(JSON.stringify({ model: "" }))).toBeNull();
    // A non-string model is a producer bug, not a model. Coercing it would publish
    // "42" as the model a run ran on.
    expect(runEndModel(JSON.stringify({ model: 42 }))).toBeNull();
  });
});
