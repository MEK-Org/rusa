// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  attachDashboardPhaseClock,
  beginDashboardRoutePhase,
  DashboardPhaseClock,
  measureDashboardPhase,
  runDashboardRequestScope,
  startDashboardPhase,
} from "./timing-phases.js";

/** A manual clock: phases see exactly the synthetic times the test sets. */
function manualClock() {
  let now = 0;
  return {
    clock: new DashboardPhaseClock(() => now),
    at: (ms: number) => {
      now = ms;
    },
  };
}

describe("dashboard phase clock", () => {
  it("unions overlapping intervals of one phase instead of adding them", () => {
    const { clock, at } = manualClock();
    at(10);
    const first = clock.start("enrichment");
    at(15);
    const second = clock.start("enrichment");
    at(50);
    first();
    at(55);
    second();
    at(70);
    const later = clock.start("enrichment");
    at(80);
    later();

    // [10, 55] ∪ [70, 80] = 55 ms, not 40 + 40 + 10.
    expect(clock.durations(100)).toEqual({ enrichment: 55 });
  });

  it("ends route at serialization and never subtracts nested phases", () => {
    const { clock, at } = manualClock();
    at(0);
    const endAuth = clock.start("auth");
    at(30);
    endAuth();
    at(31);
    clock.beginRoute();
    at(40);
    const endEnrichment = clock.start("enrichment");
    at(90);
    endEnrichment();
    at(100);
    const endSerialization = clock.start("serialization");
    at(104);
    endSerialization();

    expect(clock.durations(120)).toEqual({
      auth: 30,
      route: 69,
      enrichment: 50,
      serialization: 4,
    });
  });

  it("opens route once and clips an interval still open at response finish", () => {
    const { clock, at } = manualClock();
    at(0);
    clock.beginRoute();
    at(5);
    clock.beginRoute();
    clock.start("compression");
    at(20);

    expect(clock.durations(12)).toEqual({ route: 12, compression: 7 });
  });

  it("closes an interval once, even when its closer is called again", () => {
    const { clock, at } = manualClock();
    at(0);
    const end = clock.start("auth");
    at(10);
    end();
    at(90);
    end();

    expect(clock.durations(100)).toEqual({ auth: 10 });
  });

  it("counts all elapsed time while an awaited phase remains open", () => {
    const { clock, at } = manualClock();
    at(10);
    const end = clock.start("enrichment");
    // A scheduler stall while the awaited resolver is open is elapsed work for
    // this phase; only time before/after its interval is unassigned.
    at(85);
    end();

    expect(clock.durations(100)).toEqual({ enrichment: 75 });
  });

  it("reports nothing for a request that reached no phase", () => {
    expect(new DashboardPhaseClock(() => 0).durations(10)).toEqual({});
  });
});

describe("dashboard request scope", () => {
  it("ignores phases outside a timed request", async () => {
    expect(() => startDashboardPhase("auth")()).not.toThrow();
    expect(() => beginDashboardRoutePhase()).not.toThrow();
    await expect(measureDashboardPhase("enrichment", async () => 7)).resolves.toBe(7);
  });

  it("keeps concurrent requests' phases apart across awaits", async () => {
    const run = (enrichmentMs: number) =>
      runDashboardRequestScope(async () => {
        let now = 0;
        const clock = new DashboardPhaseClock(() => now);
        attachDashboardPhaseClock(clock);
        await new Promise((resolve) => setImmediate(resolve));
        await measureDashboardPhase("enrichment", async () => {
          await new Promise((resolve) => setImmediate(resolve));
          now = enrichmentMs;
        });
        return clock.durations(100);
      });

    await expect(Promise.all([run(20), run(60)])).resolves.toEqual([
      { enrichment: 20 },
      { enrichment: 60 },
    ]);
  });

  it("closes a measured phase when the work rejects", async () => {
    await runDashboardRequestScope(async () => {
      let now = 0;
      const clock = new DashboardPhaseClock(() => now);
      attachDashboardPhaseClock(clock);
      await expect(
        measureDashboardPhase("auth", async () => {
          now = 25;
          throw new Error("synthetic auth failure");
        })
      ).rejects.toThrow("synthetic auth failure");
      now = 90;
      expect(clock.durations(100)).toEqual({ auth: 25 });
    });
  });
});
