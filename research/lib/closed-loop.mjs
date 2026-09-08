// Deterministic closed-loop plant model for the #291 controller study (v1).
//
// The point of this model is the feedback path that fixed-input probes cannot
// have: the controller's own output sets run spacing, run spacing sets quota
// burn, and quota burn sets the error the controller sees next. Nothing here
// runs in production and nothing here reads production data.
//
// Plant elements, per the v1 scope:
//   * model runs with a fixed duration and a fixed quota cost each;
//   * run arrivals split into responsive and external work;
//   * daytime activity shaping the arrival rate;
//   * applied throttling through a faithful copy of ProviderPacer's
//     start-to-start gate, including responsive bypass;
//   * a weekly quota window with rollover, refill, and exhaustion.

import { advance, makeRandom, REFILL_EPSILON_POINTS } from "./controller.mjs";

export const WINDOW_SECONDS = 7 * 24 * 60 * 60;
export const HORIZON_SECONDS = 8 * 24 * 60 * 60;
export const OBSERVATION_PERIOD_SECONDS = 600;

/**
 * v1 uses one fixed quota cost per completed run, so the weekly budget is a
 * run count. 2,000 runs per week is the calibration point; it makes the
 * perfectly paced spacing 302 s, which sits well inside the 36,000 s cap and
 * keeps the actuator in its informative range rather than pinned at a bound.
 */
export const BUDGET_RUNS_PER_WEEK = 2_000;
export const QUOTA_COST_PER_RUN_POINTS = 100 / BUDGET_RUNS_PER_WEEK;
export const RUN_DURATION_SECONDS = 240;
export const MAX_CONCURRENT_RUNS = 4;

const ARRIVAL_STEP_SECONDS = 60;
const DAY_START_HOUR = 7;
const DAY_LENGTH_HOURS = 14;
const NIGHT_FLOOR = 0.15;

/** Daytime activity: a raised half-sine across working hours over a night floor. */
export function daytimeFactor(seconds) {
  const hour = (((seconds / 3_600) % 24) + 24) % 24;
  const phase = (hour - DAY_START_HOUR) / DAY_LENGTH_HOURS;
  if (phase <= 0 || phase >= 1) return NIGHT_FLOOR;
  return NIGHT_FLOOR + (1 - NIGHT_FLOOR) * Math.sin(Math.PI * phase);
}

function meanDaytimeFactor() {
  let total = 0;
  const steps = 24 * 60;
  for (let index = 0; index < steps; index++) total += daytimeFactor(index * 60);
  return total / steps;
}

const MEAN_DAYTIME_FACTOR = meanDaytimeFactor();

function poisson(mean, random) {
  if (mean <= 0) return 0;
  const limit = Math.exp(-mean);
  let count = 0;
  let product = random();
  while (product > limit) {
    count++;
    product *= random();
    if (count > 64) break;
  }
  return count;
}

/**
 * Build one scenario's arrival list. Arrivals depend only on the seed and the
 * demand profile, never on the controller, so every candidate is compared on
 * exactly the same demand.
 */
export function generateArrivals({ seed, externalRunsPerWeek, responsiveRunsPerWeek, shape }) {
  const random = makeRandom(seed);
  const arrivals = [];
  const perStep = (perWeek) =>
    ((perWeek / WINDOW_SECONDS) * ARRIVAL_STEP_SECONDS) / MEAN_DAYTIME_FACTOR;
  for (let t = 0; t < HORIZON_SECONDS; t += ARRIVAL_STEP_SECONDS) {
    const shaping = daytimeFactor(t) * (shape ? shape(t) : 1);
    const external = poisson(perStep(externalRunsPerWeek) * shaping, random);
    const responsive = poisson(perStep(responsiveRunsPerWeek) * shaping, random);
    for (let index = 0; index < external; index++) arrivals.push({ at: t, responsive: false });
    for (let index = 0; index < responsive; index++) arrivals.push({ at: t, responsive: true });
  }
  return arrivals;
}

/**
 * Run the closed loop for one candidate against one prepared scenario.
 *
 * The pacer copy is faithful on the detail that matters most to this study:
 * a responsive run skips the interval wait but still charges the start-to-start
 * clock, so responsive load displaces external work rather than adding to it.
 */
export function simulate(scenario, candidate, plant = {}) {
  // These overrides exist only for the deterministic sensitivity study. The
  // baseline simulation continues to use the v1 values exported above.
  const runDurationSeconds = plant.runDurationSeconds ?? RUN_DURATION_SECONDS;
  const maxConcurrentRuns = plant.maxConcurrentRuns ?? MAX_CONCURRENT_RUNS;
  const arrivals = scenario.arrivals;
  let arrivalIndex = 0;
  let now = 0;
  let quotaPct = 100;
  let resetAt = WINDOW_SECONDS;
  let nextAvailableAt = 0;
  let lastStartedAt = null;
  let nextObservationAt = OBSERVATION_PERIOD_SECONDS;
  let controller = { error: 0, derivative: 0, integral: 0, interval: 0, uncappedInterval: 0 };
  let previousObservation = null;
  let exhaustedSeconds = 0;
  let firstExhaustionAt = null;
  let quotaAtWeekEnd = null;

  const running = [];
  const externalQueue = [];
  const responsiveQueue = [];
  const samples = [];
  const externalWaits = [];
  let externalCompleted = 0;
  let responsiveCompleted = 0;

  const exhausted = () => quotaPct <= 0;

  const startRun = (request, responsive) => {
    lastStartedAt = now;
    nextAvailableAt = now + controller.interval;
    running.push({ completesAt: now + runDurationSeconds, responsive });
    running.sort((a, b) => a.completesAt - b.completesAt);
    if (!responsive) externalWaits.push(now - request.at);
  };

  while (now < HORIZON_SECONDS) {
    // Everything the loop can do at `now`, before advancing the clock.
    let progressed = true;
    while (progressed) {
      progressed = false;
      while (arrivalIndex < arrivals.length && arrivals[arrivalIndex].at <= now) {
        const arrival = arrivals[arrivalIndex++];
        (arrival.responsive ? responsiveQueue : externalQueue).push(arrival);
        progressed = true;
      }
      while (running.length > 0 && running[0].completesAt <= now) {
        const finished = running.shift();
        quotaPct = Math.max(0, quotaPct - QUOTA_COST_PER_RUN_POINTS);
        if (finished.responsive) responsiveCompleted++;
        else externalCompleted++;
        progressed = true;
      }
      // A responsive run bypasses the interval wait but not concurrency.
      if (responsiveQueue.length > 0 && running.length < maxConcurrentRuns && !exhausted()) {
        startRun(responsiveQueue.shift(), true);
        progressed = true;
      } else if (
        externalQueue.length > 0 &&
        running.length < maxConcurrentRuns &&
        !exhausted() &&
        now >= nextAvailableAt
      ) {
        startRun(externalQueue.shift(), false);
        progressed = true;
      }
    }

    if (now >= nextObservationAt) {
      const timeRemainingPct = Math.min(100, Math.max(0, ((resetAt - now) / WINDOW_SECONDS) * 100));
      // Production skips the controller entirely once the bucket reads empty
      // and defers the pacer to the reset instant instead.
      if (quotaPct > 0) {
        const error = timeRemainingPct - quotaPct;
        const resetMoved =
          previousObservation != null &&
          Math.abs(previousObservation.resetAt - resetAt) > Math.min(3_600, WINDOW_SECONDS * 0.05);
        const quotaRefilled =
          previousObservation != null &&
          quotaPct - previousObservation.quotaPct > REFILL_EPSILON_POINTS;
        const dtSeconds = previousObservation ? now - previousObservation.at : 0;
        controller = advance(
          controller,
          { dtSeconds, error, cycleChanged: resetMoved || quotaRefilled },
          candidate
        );
        // ProviderPacer.setInterval re-bases the pending wait on the last
        // actual start, so a raised interval pushes the queued run out and a
        // lowered one pulls it in without waiting for the next start.
        if (lastStartedAt !== null) nextAvailableAt = lastStartedAt + controller.interval;
        previousObservation = { at: now, resetAt, quotaPct };
      }
      samples.push({
        seconds: now,
        hours: now / 3_600,
        quotaPct,
        timeRemainingPct,
        error: controller.error,
        interval: controller.interval,
        uncappedInterval: controller.uncappedInterval,
        integral: controller.integral,
        derivative: controller.derivative,
        backlog: externalQueue.length,
        running: running.length,
        externalCompleted,
        responsiveCompleted,
        exhausted: exhausted(),
      });
      nextObservationAt += OBSERVATION_PERIOD_SECONDS;
    }

    if (quotaAtWeekEnd === null && now >= WINDOW_SECONDS) quotaAtWeekEnd = quotaPct;

    // Advance to the next instant anything can happen.
    const candidates = [nextObservationAt, resetAt, HORIZON_SECONDS];
    if (arrivalIndex < arrivals.length) candidates.push(arrivals[arrivalIndex].at);
    if (running.length > 0) candidates.push(running[0].completesAt);
    if (externalQueue.length > 0 && running.length < maxConcurrentRuns && !exhausted()) {
      candidates.push(Math.max(now, nextAvailableAt));
    }
    const next = Math.min(...candidates.filter((value) => value > now));
    if (!Number.isFinite(next)) break;
    if (exhausted()) exhaustedSeconds += Math.min(next, resetAt) - now;
    if (exhausted() && firstExhaustionAt === null) firstExhaustionAt = now;

    if (next >= resetAt) {
      // Weekly rollover: the budget refills and the window moves. The pacer's
      // exhaustion deferral ends here, exactly as `deferUntil(resetAt)` does.
      now = resetAt;
      // Record the week-one outcome before the budget refills underneath it.
      if (quotaAtWeekEnd === null) quotaAtWeekEnd = quotaPct;
      quotaPct = 100;
      nextAvailableAt = Math.max(nextAvailableAt, now);
      resetAt += WINDOW_SECONDS;
      continue;
    }
    now = next;
  }

  return {
    samples,
    externalWaits,
    externalCompleted,
    responsiveCompleted,
    exhaustedHours: exhaustedSeconds / 3_600,
    firstExhaustionHour: firstExhaustionAt === null ? null : firstExhaustionAt / 3_600,
    quotaAtWeekEndPct: quotaAtWeekEnd ?? quotaPct,
    finalBacklog: externalQueue.length,
  };
}
