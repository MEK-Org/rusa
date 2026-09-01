import { describe, expect, it } from "vitest";
import { ExternalRootDriver } from "./external-root-driver.js";

describe("ExternalRootDriver", () => {
  it("queues a content-free root wake without reporting a provider run", () => {
    const driver = new ExternalRootDriver("root", () => "2026-07-21T00:00:00Z");
    driver.requestRun();
    expect(driver.isRunning).toBe(false);
    expect(driver.isQueued).toBe(true);
    expect(driver.listWakes()).toMatchObject([
      { receivedAt: "2026-07-21T00:00:00Z", responsive: false },
    ]);
  });

  it("coalesces nudges and preserves responsive priority", () => {
    const driver = new ExternalRootDriver("root");
    driver.requestRun();
    driver.requestRun({ priority: "responsive" });
    expect(driver.listWakes()).toHaveLength(1);
    expect(driver.listWakes()[0]?.responsive).toBe(true);
  });

  it("acknowledges the selected execution opportunity", () => {
    const states: string[] = [];
    const driver = new ExternalRootDriver("root", undefined, (state) => states.push(state));
    driver.requestRun();
    driver.requestRun();
    const wake = driver.listWakes()[0];
    if (!wake) throw new Error("wake not queued");
    expect(driver.acknowledge([wake.id])).toHaveLength(1);
    expect(driver.listWakes()).toEqual([]);
    expect(states).toEqual(["queued", "idle"]);
  });
});
