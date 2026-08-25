import { describe, expect, it } from "vitest";
import type { MeshEvent } from "../db/repositories/mesh-event-repository.js";
import { type IdleWaitDeps, summarizeActivity, waitForActorIdle } from "./wait-idle.js";

const mk = (kind: string, actorId = "w"): MeshEvent => ({
  id: `${kind}-${actorId}`,
  ts: "2026-07-08T00:00:00.000Z",
  kind,
  actorId,
  detail: null,
  body: null,
  payload: null,
  success: null,
});

const RS = mk("run_start");
const RE = mk("run_end");

/** A `run_abandoned` as the production factories emit it . */
const abandoned = (started: boolean, id = `abandon-${started}`): MeshEvent => ({
  ...mk("run_abandoned"),
  id,
  payload: JSON.stringify({ started }),
});

/**
 * Build injected deps over a scripted list of event snapshots. `sleep` advances a
 * fake clock (time only passes when the waiter sleeps), and each poll returns the
 * next snapshot (repeating the last once exhausted) — fully deterministic.
 */
function scriptedDeps(snapshots: MeshEvent[][]): IdleWaitDeps & { clock: () => number } {
  let clock = 0;
  let i = 0;
  return {
    poll: () => {
      const snap = snapshots[Math.min(i, snapshots.length - 1)];
      i += 1;
      return Promise.resolve(snap);
    },
    sleep: (ms: number) => {
      clock += ms;
      return Promise.resolve();
    },
    now: () => clock,
    clock: () => clock,
  };
}

describe("summarizeActivity", () => {
  it("counts run_start/run_end for the given actor only", () => {
    const events = [RS, RE, mk("run_start", "other"), RS];
    expect(summarizeActivity(events, "w")).toEqual({ runStarts: 2, runEnds: 1, runClosures: 1 });
  });

  it("closes a started run on an after-start abandonment, without counting it as work", () => {
    // The two counts answer different questions and must not move together: the
    // run is OVER (closure) but it produced nothing (not an end), so the per-step
    // cap and the cross-step baseline are unaffected by a coalesce-abort.
    const events = [RS, abandoned(true)];
    expect(summarizeActivity(events, "w")).toEqual({ runStarts: 1, runEnds: 0, runClosures: 1 });
  });

  it("does not let a never-started abandonment close some other run's bracket", () => {
    // The trap: a run cancelled while queued behind the concurrency cap emits
    // run_abandoned with NO run_start. Counting it as a closure here would cancel
    // out the live run below and report the actor idle mid-run.
    const events = [RS, abandoned(false)];
    expect(summarizeActivity(events, "w")).toEqual({ runStarts: 1, runEnds: 0, runClosures: 0 });
  });

  it("treats an abandonment with no readable payload as not closing a start", () => {
    // Conservative direction on purpose: a missing/corrupt payload leaves the
    // waiter waiting (visible timeout) rather than declaring idle over a run that
    // may still be live (silently wrong step data).
    const events = [RS, { ...mk("run_abandoned"), payload: "{not json" }];
    expect(summarizeActivity(events, "w").runClosures).toBe(0);
  });

  it("windows activity strictly after afterEventId", () => {
    const historicalRS = { ...mk("run_start"), id: "rs-historical" };
    const stepRS = { ...mk("run_start"), id: "rs-step" };
    const stepRE = { ...mk("run_end"), id: "re-step" };
    const events = [historicalRS, stepRS, stepRE];

    const result = summarizeActivity(events, "w", { afterEventId: "rs-historical" });
    expect(result).toEqual({ runStarts: 1, runEnds: 1, runClosures: 1 });
  });

  it("windows activity at or after sinceEventId", () => {
    const historicalRS = { ...mk("run_start"), id: "rs-historical" };
    const stepRS = { ...mk("run_start"), id: "rs-step" };
    const stepRE = { ...mk("run_end"), id: "re-step" };
    const events = [historicalRS, stepRS, stepRE];

    const result = summarizeActivity(events, "w", { sinceEventId: "rs-step" });
    expect(result).toEqual({ runStarts: 1, runEnds: 1, runClosures: 1 });
  });
});

describe("waitForActorIdle", () => {
  const opts = {
    actorId: "w",
    baselineRunEnds: 0,
    quietMs: 100,
    pollMs: 50,
    timeoutMs: 100_000,
  };

  it("returns idle once a run completed and the actor stayed quiet", async () => {
    const deps = scriptedDeps([[RS], [RS, RE], [RS, RE], [RS, RE]]);
    const result = await waitForActorIdle(deps, opts);
    expect(result.idle).toBe(true);
    expect(result.runEnds).toBe(1);
  });

  it("does not go idle while a run is in flight (run_start without run_end)", async () => {
    // Always in-flight → never idle → times out (idle:false), not a false-positive.
    const deps = scriptedDeps([[RS]]);
    const result = await waitForActorIdle(deps, { ...opts, timeoutMs: 500 });
    expect(result.idle).toBe(false);
  });

  it("resets the quiet window when self-continuation starts another run", async () => {
    // re1 lands, then a NEW run_start (continuation) — must NOT return until the
    // second run ends AND the quiet window passes with no further run_start.
    const deps = scriptedDeps([
      [RS], // in flight
      [RS, RE], // 1 done — but a continuation is coming
      [RS, RE, mk("run_start")], // continuation started → quiet resets, in flight
      [RS, RE, mk("run_start"), mk("run_end")], // 2 done
      [RS, RE, mk("run_start"), mk("run_end")], // quiet
      [RS, RE, mk("run_start"), mk("run_end")],
    ]);
    const result = await waitForActorIdle(deps, opts);
    expect(result.idle).toBe(true);
    expect(result.runEnds).toBe(2);
  });

  it("does not go idle on a long run's first run_end while a continuation is still coming", async () => {
    // The bug: a run longer than quietMs. Its run_end arrives with the last
    // run_start already >quietMs in the past, so watching ONLY run_start would
    // report `quiet` immediately and return idle at runEnds=1 — missing the
    // self-continuation that starts a moment later. Resetting the quiet clock on
    // run_end too keeps us waiting, so we return only after the 2nd run (runEnds=2).
    const deps = scriptedDeps([
      [RS], // in flight (run_start at t=0)
      [RS], // still running past quietMs...
      [RS], // ...still running
      [RS, RE], // long run ends — OLD code would see quiet satisfied and return here
      [RS, RE, mk("run_start")], // but a continuation starts
      [RS, RE, mk("run_start"), mk("run_end")], // continuation ends
    ]);
    const result = await waitForActorIdle(deps, opts);
    expect(result.idle).toBe(true);
    expect(result.runEnds).toBe(2);
  });

  it("releases the waiter when a started run is abandoned instead of ending ", async () => {
    // A self-continuation that gets coalesced away: it emits run_start and then
    // run_abandoned, never run_end. Bracketing on run_end alone leaves the waiter
    // in-flight forever — every later step of the arm then burns to the timeout or
    // the cap, so the run reads as a hung arm rather than a completed step.
    const deps = scriptedDeps([
      [RS], // step's real run, in flight
      [RS, RE], // ...completes
      [RS, RE, mk("run_start")], // continuation starts
      [RS, RE, mk("run_start"), abandoned(true)], // ...and is coalesced away
      [RS, RE, mk("run_start"), abandoned(true)], // quiet
      [RS, RE, mk("run_start"), abandoned(true)],
    ]);
    const result = await waitForActorIdle(deps, { ...opts, timeoutMs: 5000 });
    expect(result.idle).toBe(true);
    // The abandoned run closed its bracket but did NOT count as work.
    expect(result.runEnds).toBe(1);
  });

  it("keeps waiting when an abandonment never started, even with a live run ", async () => {
    // The counter-assertion to the cell above, and the reason this isn't just
    // "count every abandonment": a run cancelled while queued behind the
    // concurrency cap emits no run_start. Cancelling it against the unrelated LIVE
    // run here would report idle mid-run and slice that run's output into the next
    // step — silently wrong data, where staying in-flight merely times out.
    const live = [RS, RE, mk("run_start")];
    const deps = scriptedDeps([[RS], [RS, RE], live, [...live, abandoned(false)]]);
    const result = await waitForActorIdle(deps, { ...opts, timeoutMs: 500 });
    expect(result.idle).toBe(false);
  });

  it("returns idle when historical unclosed run_start is present in baselineActivity ", async () => {
    // an issue: a historical unclosed run_start (e.g. from pre-ISSUE_NUM coalesce aborts)
    // left lifetime runStarts > runClosures forever. Windowing the in-flight check
    // against baselineActivity ensures old unclosed starts do not permanently hang the arm.
    const staleHistoricalRS = { ...mk("run_start"), id: "rs-stale-historical" };
    const historical = [staleHistoricalRS];
    const baselineActivity = summarizeActivity(historical, "w");
    expect(baselineActivity).toEqual({ runStarts: 1, runEnds: 0, runClosures: 0 });

    const stepRS = { ...mk("run_start"), id: "rs-step" };
    const stepRE = { ...mk("run_end"), id: "re-step" };

    const deps = scriptedDeps([
      [...historical, stepRS],
      [...historical, stepRS, stepRE],
      [...historical, stepRS, stepRE],
      [...historical, stepRS, stepRE],
    ]);

    const result = await waitForActorIdle(deps, {
      ...opts,
      baselineActivity,
      timeoutMs: 5000,
    });
    expect(result.idle).toBe(true);
    expect(result.runEnds).toBe(1);
  });

  it("returns idle when historical unclosed run_start is present with baselineRunStarts/Closures ", async () => {
    const staleHistoricalRS = { ...mk("run_start"), id: "rs-stale-historical" };
    const historical = [staleHistoricalRS];
    const stepRS = { ...mk("run_start"), id: "rs-step" };
    const stepRE = { ...mk("run_end"), id: "re-step" };

    const deps = scriptedDeps([
      [...historical, stepRS],
      [...historical, stepRS, stepRE],
      [...historical, stepRS, stepRE],
      [...historical, stepRS, stepRE],
    ]);

    const result = await waitForActorIdle(deps, {
      ...opts,
      baselineRunEnds: 0,
      baselineRunStarts: 1,
      baselineRunClosures: 0,
      timeoutMs: 5000,
    });
    expect(result.idle).toBe(true);
    expect(result.runEnds).toBe(1);
  });

  it("returns idle when historical unclosed run_start is present with afterEventId ", async () => {
    const staleHistoricalRS = { ...mk("run_start"), id: "rs-stale-historical" };
    const historical = [staleHistoricalRS];
    const stepRS = { ...mk("run_start"), id: "rs-step" };
    const stepRE = { ...mk("run_end"), id: "re-step" };

    const deps = scriptedDeps([
      [...historical, stepRS],
      [...historical, stepRS, stepRE],
      [...historical, stepRS, stepRE],
      [...historical, stepRS, stepRE],
    ]);

    const result = await waitForActorIdle(deps, {
      ...opts,
      baselineRunEnds: 0,
      afterEventId: staleHistoricalRS.id,
      timeoutMs: 5000,
    });
    expect(result.idle).toBe(true);
    expect(result.runEnds).toBe(1);
  });

  it("stays in-flight during active step run even with unclosed historical run_start ", async () => {
    const staleHistoricalRS = { ...mk("run_start"), id: "rs-stale-historical" };
    const historical = [staleHistoricalRS];
    const baselineActivity = summarizeActivity(historical, "w");
    const stepRS = { ...mk("run_start"), id: "rs-step" };

    // Step has started (stepRS in flight) and never ends
    const deps = scriptedDeps([[...historical, stepRS]]);

    const result = await waitForActorIdle(deps, {
      ...opts,
      baselineActivity,
      timeoutMs: 300,
    });
    expect(result.idle).toBe(false);
  });

  it("times out to idle:false rather than throwing when the actor never progresses", async () => {
    const deps = scriptedDeps([[]]); // no runs ever
    const result = await waitForActorIdle(deps, { ...opts, timeoutMs: 300 });
    expect(result.idle).toBe(false);
    expect(result.runEnds).toBe(0);
    expect(result.capped).toBe(false);
  });

  it("stops waiting once the step burns maxRunEnds, and says CAPPED not timed-out", async () => {
    // A self-continuing actor that never goes quiet: without the cap this step runs to
    // the timeout, eating the shared provider window. `capped` must be distinguishable
    // from a hang — they are different findings about the arm.
    const busy = [RS, RE, mk("run_start"), mk("run_end"), mk("run_start")];
    const deps = scriptedDeps([[RS], [RS, RE], busy]);
    const result = await waitForActorIdle(deps, { ...opts, maxRunEnds: 2 });
    expect(result.capped).toBe(true);
    expect(result.idle).toBe(false);
    expect(result.runEnds).toBe(2);
  });

  it("counts the cap from the step's baseline, not the actor's lifetime runs", async () => {
    // The actor already has 5 run_ends from earlier steps; a cap of 2 must allow 2 MORE.
    const prior = [RS, RE, RE, RE, RE, RE];
    const deps = scriptedDeps([
      [...prior, mk("run_start")],
      [...prior, mk("run_start"), mk("run_end")],
      [...prior, mk("run_start"), mk("run_end"), mk("run_start"), mk("run_end")],
    ]);
    const result = await waitForActorIdle(deps, {
      ...opts,
      baselineRunEnds: 5,
      maxRunEnds: 2,
    });
    expect(result.capped).toBe(true);
    expect(result.runEnds).toBe(7);
  });

  it("caps a step that spent its budget even if it was about to settle anyway", async () => {
    // Deliberate, and worth pinning down: the cap fires the moment the budget is spent,
    // which is necessarily BEFORE the quiet window could confirm the arm stopped on its
    // own. So a step that used exactly its budget and was already finished still comes
    // back capped:true, idle:false. That over-reports truncation — the cheap direction
    // to be wrong in, since `capped` is a warning and the failure this rig exists to
    // stop is a green signal over a step that produced nothing.
    const deps = scriptedDeps([[RS], [RS, RE], [RS, RE], [RS, RE]]);
    const result = await waitForActorIdle(deps, { ...opts, maxRunEnds: 1 });
    expect(result.capped).toBe(true);
    expect(result.idle).toBe(false);
    expect(result.runEnds).toBe(1);
  });

  it("leaves the cap inert when unset (v2 behaviour is unchanged)", async () => {
    const deps = scriptedDeps([[RS], [RS, RE], [RS, RE], [RS, RE]]);
    const result = await waitForActorIdle(deps, opts);
    expect(result.capped).toBe(false);
    expect(result.idle).toBe(true);
  });
});
