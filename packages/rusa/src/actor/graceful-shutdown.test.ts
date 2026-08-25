import { describe, expect, it } from "vitest";
import { GracefulShutdown } from "./graceful-shutdown.js";

describe("GracefulShutdown", () => {
  it("starts not-shutting-down (a fresh process boots clear)", () => {
    expect(new GracefulShutdown().isShuttingDown()).toBe(false);
  });

  it("request() engages the brake and records the reason; idempotent", () => {
    const g = new GracefulShutdown();
    g.request("redeploy");
    expect(g.isShuttingDown()).toBe(true);
    expect(g.reason()).toBe("redeploy");
    g.request("redeploy again");
    expect(g.isShuttingDown()).toBe(true);
  });

  it("cancel() lifts the brake and clears the reason (dry-run hand-back)", () => {
    const g = new GracefulShutdown();
    g.request("dry-run");
    g.cancel();
    expect(g.isShuttingDown()).toBe(false);
    expect(g.reason()).toBe("");
    g.cancel(); // idempotent
    expect(g.isShuttingDown()).toBe(false);
  });
});
