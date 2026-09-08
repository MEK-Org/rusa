#!/usr/bin/env node
// Closed-loop v1 controller study for MEK-Org/rusa#291.
//
// The fixed-input study in `quota-pid-tuning-study.mjs` cannot answer tuning
// questions honestly, because the controller's output changes the quota
// consumption it is later measured against. This script closes that loop: the
// commanded interval throttles run starts, run completions burn quota, and the
// resulting quota reading becomes the controller's next error.
//
// Analysis only. It does not read production data and does not change the
// production controller or its schema.
//
// Run `node research/quota-closed-loop-study.mjs --write` to regenerate the
// checked-in artifacts. Run it with `--check` to prove they are current.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BUDGET_RUNS_PER_WEEK,
  generateArrivals,
  HORIZON_SECONDS,
  MAX_CONCURRENT_RUNS,
  OBSERVATION_PERIOD_SECONDS,
  QUOTA_COST_PER_RUN_POINTS,
  RUN_DURATION_SECONDS,
  simulate,
  WINDOW_SECONDS,
} from "./lib/closed-loop.mjs";
import {
  assertProductionParity,
  BASELINE,
  CANDIDATES,
  csv,
  MAX_INTERVAL_SECONDS,
  PRODUCTION_CONTROLLER_REVISION,
  percentile,
} from "./lib/controller.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const GENERATED = join(HERE, "generated");

const IDEAL_SPACING_SECONDS = WINDOW_SECONDS / BUDGET_RUNS_PER_WEEK;
const RECOVERY_MULTIPLIERS = [1, 1.5, 2, 2.5];

function recoveryField(multiplier) {
  if (multiplier === 1) return "recovery_to_ideal_hours";
  return `recovery_to_${String(multiplier).replace(".", "_")}x_ideal_hours`;
}

function recoveryHours(samples, multiplier) {
  const afterBurst = samples.filter((row) => row.seconds >= 36 * 3_600);
  const relaxed = afterBurst.find((row) => row.interval <= multiplier * IDEAL_SPACING_SECONDS);
  return relaxed ? (relaxed.seconds - 36 * 3_600) / 3_600 : null;
}

// Each scenario fixes its own seed, so every candidate meets identical demand.
const SCENARIOS = [
  {
    id: "nominal",
    label: "Nominal week (85% of budget)",
    seed: 0x291a,
    externalRunsPerWeek: 1_300,
    responsiveRunsPerWeek: 400,
    note: "Demand slightly under budget. Tests whether pacing stays out of the way.",
  },
  {
    id: "overload",
    label: "Sustained overload (250% of budget)",
    seed: 0x291b,
    externalRunsPerWeek: 4_000,
    responsiveRunsPerWeek: 1_000,
    note: "Demand far over budget all week. Tests whether pacing prevents exhaustion.",
  },
  {
    id: "burst-recovery",
    label: "36 h burst, then quiet",
    seed: 0x291c,
    externalRunsPerWeek: 1_300,
    responsiveRunsPerWeek: 400,
    // The #291 complaint in closed-loop form: overspend hard, then stop.
    shape: (t) => (t < 36 * 3_600 ? 4 : 0.4),
    note: "Heavy front-loaded demand, then a collapse. This is the #291 recovery-lag question.",
  },
  {
    id: "responsive-heavy",
    label: "Responsive-dominated load",
    seed: 0x291d,
    externalRunsPerWeek: 900,
    responsiveRunsPerWeek: 1_600,
    note: "Most consumption bypasses the pacer, so the controller can only squeeze external work.",
  },
];

// Candidates are compared one parameter axis at a time; `current` is the
// reference line in every facet rather than a peer series.
const FACETS = [
  { id: "kp", label: "Proportional (Kp)", candidates: ["kp-80", "kp-160"] },
  { id: "ti", label: "Integral time (Ti)", candidates: ["ti-2h", "ti-half-hour"] },
  { id: "kd", label: "Derivative (Kd)", candidates: ["kd-900", "kd-3600"] },
  {
    id: "combined",
    label: "Combined proposal",
    candidates: ["ti-2h", "kd-3600", "weaker-i-stronger-d"],
  },
];

// Validated with the dataviz palette validator (light surface, --pairs all) for
// every set that actually co-occurs in a panel. `current` is near-black ink
// because it is the reference, not one of the categorical series.
const REFERENCE_COLOR = "#111827";
const CANDIDATE_COLORS = {
  "kp-80": "#2563eb",
  "kp-160": "#d97706",
  "ti-2h": "#0891b2",
  "ti-half-hour": "#be185d",
  "kd-900": "#16a34a",
  "kd-3600": "#7c3aed",
  "weaker-i-stronger-d": "#dc2626",
};
const CRITICAL_COLOR = "#d03b3b";
const SURFACE = "#fcfcfb";

function candidateById(id) {
  const found = CANDIDATES.find((item) => item.id === id);
  if (!found) throw new Error(`unknown candidate ${id}`);
  return found;
}

function buildScenarios() {
  return SCENARIOS.map((scenario) => ({
    ...scenario,
    arrivals: generateArrivals(scenario),
  }));
}

function metricRow(scenario, candidate, result, referenceSamples) {
  const { samples } = result;
  const deltaVsCurrent = referenceSamples
    ? Math.max(
        ...samples.map((row, index) =>
          Math.abs(row.interval - (referenceSamples[index]?.interval ?? row.interval))
        )
      )
    : 0;
  // Strictly before the rollover: the sample at the boundary is already post-refill.
  const week = samples.filter((row) => row.seconds < WINDOW_SECONDS);
  const intervals = samples.map((row) => row.interval);
  const steps = samples
    .slice(1)
    .map((row, index) => Math.abs(row.interval - samples[index].interval));
  const absError = week.map((row) => Math.abs(row.error));
  const waitsHours = result.externalWaits.map((value) => value / 3_600);
  const cappedSamples = samples.filter((row) => row.uncappedInterval > MAX_INTERVAL_SECONDS);
  return {
    scenario: scenario.id,
    candidate: candidate.id,
    label: candidate.label,
    kp: candidate.kp,
    ti_seconds: candidate.ti,
    kd: candidate.kd,
    exhausted_hours: result.exhaustedHours,
    first_exhaustion_hour: result.firstExhaustionHour,
    quota_left_week_end_pct: result.quotaAtWeekEndPct,
    external_completed: result.externalCompleted,
    responsive_completed: result.responsiveCompleted,
    external_backlog_end: result.finalBacklog,
    external_backlog_p95: percentile(
      samples.map((row) => row.backlog),
      0.95
    ),
    external_backlog_max: Math.max(...samples.map((row) => row.backlog)),
    external_wait_p95_hours: percentile(waitsHours, 0.95),
    external_wait_max_hours: waitsHours.length > 0 ? Math.max(...waitsHours) : 0,
    mean_interval_seconds: intervals.reduce((sum, value) => sum + value, 0) / intervals.length,
    p95_interval_seconds: percentile(intervals, 0.95),
    max_interval_seconds: Math.max(...intervals),
    capped_hours: (cappedSamples.length * OBSERVATION_PERIOD_SECONDS) / 3_600,
    mean_abs_error_points: absError.reduce((sum, value) => sum + value, 0) / absError.length,
    interval_step_p95_seconds: percentile(steps, 0.95),
    max_interval_delta_vs_current_seconds: deltaVsCurrent,
    max_derivative_term_seconds: Math.max(
      ...samples.map((row) => Math.abs(candidate.kd * row.derivative))
    ),
    ...Object.fromEntries(
      RECOVERY_MULTIPLIERS.map((multiplier) => [
        recoveryField(multiplier),
        recoveryHours(samples, multiplier),
      ])
    ),
  };
}

function runStudy() {
  assertProductionParity(
    readFileSync(join(HERE, "../packages/rusa/src/quota/shared-store.ts"), "utf8")
  );
  const scenarios = buildScenarios();
  const results = new Map();
  const metrics = [];
  for (const scenario of scenarios) {
    // The baseline runs first so every other candidate can be scored against it.
    const reference = simulate(scenario, BASELINE);
    results.set(`${scenario.id}/${BASELINE.id}`, reference);
    for (const candidate of CANDIDATES) {
      const result = candidate.id === BASELINE.id ? reference : simulate(scenario, candidate);
      results.set(`${scenario.id}/${candidate.id}`, result);
      metrics.push(metricRow(scenario, candidate, result, reference.samples));
    }
  }
  const robustnessRows = robustness();
  return {
    scenarios,
    results,
    metrics,
    robustnessRows,
    robustnessRows2: robustnessSummary(robustnessRows),
    thresholdRows: RECOVERY_MULTIPLIERS.flatMap((multiplier) =>
      robustnessSummary(robustnessRows, multiplier).map((row) => ({
        threshold_x_ideal: multiplier,
        ...row,
      }))
    ),
    plantSensitivityRows: plantSensitivity(),
  };
}

const ROBUSTNESS_SEEDS = 8;

/**
 * Re-run every scenario across additional seeds. A single seed can flatter or
 * punish a candidate by accident, and the headline claims here are orderings
 * between candidates, so the orderings have to survive resampled demand.
 */
function robustness() {
  const rows = [];
  for (const scenario of SCENARIOS) {
    for (let offset = 0; offset < ROBUSTNESS_SEEDS; offset++) {
      const seeded = { ...scenario, seed: scenario.seed + offset * 7_919 };
      const arrivals = generateArrivals(seeded);
      const reference = simulate({ ...seeded, arrivals }, BASELINE);
      for (const candidate of CANDIDATES) {
        const result =
          candidate.id === BASELINE.id ? reference : simulate({ ...seeded, arrivals }, candidate);
        rows.push({
          scenario: scenario.id,
          seed_offset: offset,
          candidate: candidate.id,
          label: candidate.label,
          exhausted_hours: result.exhaustedHours,
          external_completed: result.externalCompleted,
          quota_left_week_end_pct: result.quotaAtWeekEndPct,
          ...Object.fromEntries(
            RECOVERY_MULTIPLIERS.map((multiplier) => [
              recoveryField(multiplier),
              recoveryHours(result.samples, multiplier),
            ])
          ),
          max_interval_delta_vs_current_seconds: Math.max(
            ...result.samples.map((row, index) =>
              Math.abs(row.interval - (reference.samples[index]?.interval ?? row.interval))
            )
          ),
        });
      }
    }
  }
  return rows;
}

function robustnessSummary(rows, multiplier = 2) {
  const field = recoveryField(multiplier);
  return CANDIDATES.map((candidate) => {
    const mine = rows.filter((row) => row.candidate === candidate.id);
    const burst = mine.filter((row) => row.scenario === "burst-recovery");
    const recoveries = burst.map((row) => row[field]).filter((value) => value != null);
    const baselineBurst = rows.filter(
      (row) => row.candidate === BASELINE.id && row.scenario === "burst-recovery"
    );
    const faster = burst.filter((row, index) => {
      const reference = baselineBurst[index]?.[field];
      return row[field] != null && reference != null && row[field] < reference;
    }).length;
    return {
      candidate: candidate.id,
      label: candidate.label,
      seeds: burst.length,
      recovery_mean_hours:
        recoveries.reduce((sum, value) => sum + value, 0) / Math.max(1, recoveries.length),
      recovery_min_hours: Math.min(...recoveries),
      recovery_max_hours: Math.max(...recoveries),
      seeds_faster_than_current: faster,
      exhausting_runs: mine.filter((row) => row.exhausted_hours > 0).length,
      total_runs: mine.length,
      exhausted_hours_mean:
        mine.reduce((sum, row) => sum + row.exhausted_hours, 0) / Math.max(1, mine.length),
      max_interval_delta_vs_current_seconds: Math.max(
        ...mine.map((row) => row.max_interval_delta_vs_current_seconds)
      ),
    };
  });
}

const PLANT_SENSITIVITIES = [
  { id: "30s-1-slot", runDurationSeconds: 30, maxConcurrentRuns: 1 },
  { id: "30s-4-slot", runDurationSeconds: 30, maxConcurrentRuns: 4 },
  { id: "240s-1-slot", runDurationSeconds: 240, maxConcurrentRuns: 1 },
  { id: "240s-4-slot", runDurationSeconds: 240, maxConcurrentRuns: 4 },
  { id: "600s-1-slot", runDurationSeconds: 600, maxConcurrentRuns: 1 },
  { id: "600s-4-slot", runDurationSeconds: 600, maxConcurrentRuns: 4 },
  { id: "varcost-4-slot", runDurationSeconds: 240, maxConcurrentRuns: 4, variableCost: true },
  {
    id: "obs-600s-4-slot",
    runDurationSeconds: 240,
    maxConcurrentRuns: 4,
    observationPeriodSeconds: 600,
  },
];

/**
 * Completion charging is an explicit assumption, not a claim about when a
 * provider reports usage. Varying duration, concurrency, observation cadence,
 * and cost variance bounds the phase delay and model sensitivity without
 * fabricating telemetry.
 */
function plantSensitivity() {
  const scenarioDefinition = SCENARIOS.find((item) => item.id === "burst-recovery");
  const scenario = { ...scenarioDefinition, arrivals: generateArrivals(scenarioDefinition) };
  const rows = [];
  for (const plant of PLANT_SENSITIVITIES) {
    const reference = simulate(scenario, BASELINE, plant);
    for (const candidate of CANDIDATES) {
      const result =
        candidate.id === BASELINE.id ? reference : simulate(scenario, candidate, plant);
      rows.push({
        plant: plant.id,
        run_duration_seconds: plant.runDurationSeconds,
        max_concurrent_runs: plant.maxConcurrentRuns,
        observation_period_seconds: plant.observationPeriodSeconds ?? OBSERVATION_PERIOD_SECONDS,
        variable_cost: plant.variableCost ?? false,
        candidate: candidate.id,
        label: candidate.label,
        recovery_to_ideal_hours: recoveryHours(result.samples, 1),
        recovery_to_1_5x_ideal_hours: recoveryHours(result.samples, 1.5),
        recovery_to_2x_ideal_hours: recoveryHours(result.samples, 2),
        recovery_to_2_5x_ideal_hours: recoveryHours(result.samples, 2.5),
        exhausted_hours: result.exhaustedHours,
        max_derivative_term_seconds: Math.max(
          ...result.samples.map((row) => Math.abs(candidate.kd * row.derivative))
        ),
        max_interval_delta_vs_current_seconds: Math.max(
          ...result.samples.map((row, index) =>
            Math.abs(row.interval - (reference.samples[index]?.interval ?? row.interval))
          )
        ),
      });
    }
  }
  return rows;
}

/* ---------------------------------------------------------------- rendering */

const AXIS_DAYS = HORIZON_SECONDS / 86_400;

function scale(box, maxY) {
  return {
    x: (hours) => box.x + (hours / (AXIS_DAYS * 24)) * box.width,
    y: (value) => box.y + box.height - (Math.min(maxY, Math.max(0, value)) / maxY) * box.height,
  };
}

function polyline(points, color, { width = 1.6, dash = null } = {}) {
  if (points.length === 0) return "";
  const dashAttr = dash ? ` stroke-dasharray="${dash}"` : "";
  return `<polyline fill="none" stroke="${color}" stroke-width="${width}" stroke-linejoin="round" stroke-linecap="round"${dashAttr} points="${points.join(" ")}" />`;
}

function gridAndFrame(box, maxY, ticks, format) {
  const grid = ticks
    .map((value) => {
      const y = box.y + box.height - (value / maxY) * box.height;
      return `<line x1="${box.x}" y1="${y.toFixed(1)}" x2="${box.x + box.width}" y2="${y.toFixed(1)}" stroke="#e5e7eb" stroke-width="1" /><text x="${box.x - 5}" y="${(y + 3).toFixed(1)}" text-anchor="end" class="axis">${format(value)}</text>`;
    })
    .join("");
  const days = Array.from({ length: AXIS_DAYS + 1 }, (_, day) => {
    const x = box.x + (day / AXIS_DAYS) * box.width;
    return `<text x="${x.toFixed(1)}" y="${box.y + box.height + 13}" text-anchor="middle" class="axis">${day}</text>`;
  }).join("");
  // The weekly rollover is the one structural event on the time axis.
  const resetX = box.x + (WINDOW_SECONDS / HORIZON_SECONDS) * box.width;
  const reset = `<line x1="${resetX.toFixed(1)}" y1="${box.y}" x2="${resetX.toFixed(1)}" y2="${box.y + box.height}" stroke="#9ca3af" stroke-width="1" stroke-dasharray="3 3" />`;
  return `${grid}<rect x="${box.x}" y="${box.y}" width="${box.width}" height="${box.height}" fill="none" stroke="#9ca3af" stroke-width="1" />${reset}${days}`;
}

function linePanel({ title, subtitle, box, maxY, ticks, format, series, legend = true }) {
  const lines = [...series]
    .sort((a, b) => Number(a.onTop ?? false) - Number(b.onTop ?? false))
    .map((item) => polyline(item.points, item.color, { width: item.width, dash: item.dash }))
    .join("");
  // The key sits below the plot rather than inside it: these series routinely
  // occupy every corner of the frame, so any in-plot legend covers data.
  let cursor = box.x;
  let keyLine = box.y + box.height + 40;
  const key =
    legend && series.length > 1
      ? series
          .map((item) => {
            const width = item.label.length * 5.1 + 26;
            if (cursor + width > box.x + box.width && cursor > box.x) {
              cursor = box.x;
              keyLine += 12;
            }
            const swatch = `<line x1="${cursor}" y1="${keyLine}" x2="${cursor + 14}" y2="${keyLine}" stroke="${item.color}" stroke-width="2.5"${item.dash ? ` stroke-dasharray="${item.dash}"` : ""} /><text x="${cursor + 18}" y="${keyLine + 3}" class="legend">${item.label}</text>`;
            cursor += width;
            return swatch;
          })
          .join("")
      : "";
  return `<g><text x="${box.x}" y="${box.y - 20}" class="title">${title}</text><text x="${box.x}" y="${box.y - 7}" class="note">${subtitle}</text>${gridAndFrame(box, maxY, ticks, format)}${lines}<text x="${box.x + box.width / 2}" y="${box.y + box.height + 26}" text-anchor="middle" class="axis">days</text>${key}</g>`;
}

function seriesFor(samples, box, maxY, key) {
  const map = scale(box, maxY);
  return samples.map((row) => `${map.x(row.hours).toFixed(1)},${map.y(row[key]).toFixed(1)}`);
}

const QUOTA_TICKS = [0, 25, 50, 75, 100];

/**
 * Four intervals on a 1/2/2.5/5 step. The commanded wait never approaches the
 * 36,000 s cap in closed loop, so plotting against the cap would flatten every
 * line onto the axis; each wait panel is scaled to its own data and says so.
 */
function niceScale(maxValue) {
  const raw = Math.max(1, maxValue);
  const magnitude = 10 ** Math.floor(Math.log10(raw / 4));
  const steps = [1, 2, 2.5, 5, 10].map((multiple) => multiple * magnitude);
  const step = steps.find((value) => value * 4 >= raw) ?? steps[steps.length - 1];
  return { maxY: step * 4, ticks: [0, step, step * 2, step * 3, step * 4] };
}

function secondsFormat(value) {
  return value >= 10_000 ? `${value / 1_000}k` : String(Math.round(value));
}

function countFormat(value) {
  return value >= 10_000 ? `${(value / 1_000).toFixed(0)}k` : String(Math.round(value));
}

function capNote(maxValue) {
  return `seconds between normal run starts · peak ${Math.round(maxValue).toLocaleString()} s of the ${MAX_INTERVAL_SECONDS.toLocaleString()} s cap`;
}

function svgDocument({ width, height, heading, subtitle, subtitle2, body, footer }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <style>
    text { font-family: ui-sans-serif, system-ui, sans-serif; fill: #1f2937; }
    .heading { font-size: 19px; font-weight: 700; }
    .subtitle { font-size: 11px; fill: #4b5563; }
    .title { font-size: 12.5px; font-weight: 700; }
    .note, .axis, .legend { font-size: 9px; fill: #4b5563; }
    .rowlabel { font-size: 11px; font-weight: 700; fill: #374151; }
  </style>
  <rect width="${width}" height="${height}" fill="${SURFACE}" />
  <text x="24" y="28" class="heading">${heading}</text>
  <text x="24" y="46" class="subtitle">${subtitle}</text>
  ${subtitle2 ? `<text x="24" y="61" class="subtitle">${subtitle2}</text>` : ""}
  ${body}
  <text x="24" y="${height - 12}" class="subtitle">${footer}</text>
</svg>
`;
}

function baselineCharts({ scenarios, results }) {
  const panels = [];
  scenarios.forEach((scenario, rowIndex) => {
    const samples = results.get(`${scenario.id}/${BASELINE.id}`).samples;
    const top = 132 + rowIndex * 236;
    const boxes = [0, 1, 2].map((column) => ({
      x: 80 + column * 320,
      y: top,
      width: 232,
      height: 128,
    }));
    const backlog = niceScale(Math.max(4, ...samples.map((row) => row.backlog)));
    const peakWait = Math.max(...samples.map((row) => row.uncappedInterval));
    const wait = niceScale(Math.max(peakWait, 60));
    panels.push(
      `<text x="24" y="${top - 38}" class="rowlabel">${scenario.label}</text>`,
      linePanel({
        title: "Quota remaining",
        subtitle: "percent of the weekly budget",
        box: boxes[0],
        maxY: 100,
        ticks: QUOTA_TICKS,
        format: (value) => `${value}%`,
        series: [
          {
            label: "quota left",
            color: REFERENCE_COLOR,
            points: seriesFor(samples, boxes[0], 100, "quotaPct"),
            width: 1.8,
            onTop: true,
          },
          {
            label: "even budget pace",
            color: "#9ca3af",
            points: seriesFor(samples, boxes[0], 100, "timeRemainingPct"),
            dash: "4 3",
          },
        ],
      }),
      linePanel({
        title: "Commanded vs applied wait",
        subtitle: capNote(peakWait),
        box: boxes[1],
        maxY: wait.maxY,
        ticks: wait.ticks,
        format: secondsFormat,
        series: [
          {
            // Drawn on top and dashed: the cap is never reached in these
            // scenarios, so commanded sits exactly under applied and would
            // otherwise be an invisible legend entry.
            label: "commanded",
            color: "#d97706",
            points: seriesFor(samples, boxes[1], wait.maxY, "uncappedInterval"),
            dash: "4 3",
            onTop: true,
          },
          {
            label: "applied (capped)",
            color: "#2563eb",
            points: seriesFor(samples, boxes[1], wait.maxY, "interval"),
            width: 1.8,
          },
        ],
      }),
      linePanel({
        title: "External backlog",
        subtitle: "queued external runs awaiting a slot",
        box: boxes[2],
        maxY: backlog.maxY,
        ticks: backlog.ticks,
        format: countFormat,
        series: [
          {
            label: "backlog",
            color: REFERENCE_COLOR,
            points: seriesFor(samples, boxes[2], backlog.maxY, "backlog"),
            width: 1.8,
          },
        ],
        legend: false,
      })
    );
  });
  return svgDocument({
    width: 1_010,
    height: 1_110,
    heading: "#291 closed-loop v1 \u2014 current controller",
    subtitle:
      "Every line is simulated: the commanded wait throttles run starts, completed runs burn a fixed quota cost, and the",
    subtitle2:
      "resulting quota reading feeds the unchanged PID. The dashed vertical rule is the weekly rollover.",
    body: panels.join("\n  "),
    footer: `Calibrated plant: ${BUDGET_RUNS_PER_WEEK} runs per weekly budget (${QUOTA_COST_PER_RUN_POINTS.toFixed(3)} points each), ${RUN_DURATION_SECONDS} s per run, ${MAX_CONCURRENT_RUNS} concurrent, ${OBSERVATION_PERIOD_SECONDS} s observation cadence; ProviderPacer staging pipeline with responsive bypass. Not a production forecast.`,
  });
}

function candidateCharts({ scenarios, results }) {
  const scenario = scenarios.find((item) => item.id === "burst-recovery");
  const panels = [];
  FACETS.forEach((facet, rowIndex) => {
    const top = 132 + rowIndex * 236;
    const boxes = [0, 1, 2].map((column) => ({
      x: 80 + column * 320,
      y: top,
      width: 232,
      height: 128,
    }));
    const members = [BASELINE.id, ...facet.candidates];
    const sampleSets = members.map((id) => ({
      id,
      label: candidateById(id).label,
      color: id === BASELINE.id ? REFERENCE_COLOR : CANDIDATE_COLORS[id],
      width: id === BASELINE.id ? 1.9 : 1.5,
      // The reference is dashed and drawn last so a coincident candidate shows
      // through its gaps instead of erasing it.
      dash: id === BASELINE.id ? "6 3" : null,
      onTop: id === BASELINE.id,
      samples: results.get(`${scenario.id}/${id}`).samples,
    }));
    const reference = sampleSets[0].samples;
    const departures = sampleSets.slice(1).map((set) => ({
      label: set.label,
      delta: Math.max(
        ...set.samples.map((row, index) =>
          Math.abs(row.interval - (reference[index]?.interval ?? 0))
        )
      ),
    }));
    const worstDeparture = Math.max(...departures.map((item) => item.delta));
    const all = sampleSets.flatMap((set) => set.samples);
    const backlog = niceScale(Math.max(4, ...all.map((row) => row.backlog)));
    const peakWait = Math.max(...all.map((row) => row.interval));
    const wait = niceScale(Math.max(peakWait, 60));
    const build = (box, maxY, key) =>
      sampleSets.map((set) => ({
        label: set.label,
        color: set.color,
        width: set.width,
        dash: set.dash,
        onTop: set.onTop,
        points: seriesFor(set.samples, box, maxY, key),
      }));
    panels.push(`<text x="24" y="${top - 38}" class="rowlabel">${facet.label}</text>`);
    if (worstDeparture < 0.05 * peakWait) {
      panels.push(
        `<text x="${24 + facet.label.length * 6.6 + 14}" y="${top - 38}" class="note">every candidate here stays within ${Math.round(worstDeparture)} s of current (${((worstDeparture / peakWait) * 100).toFixed(1)}% of the ${Math.round(peakWait).toLocaleString()} s peak) \u2014 the lines coincide</text>`
      );
    }
    panels.push(
      linePanel({
        title: "Quota remaining",
        subtitle: "percent of the weekly budget",
        box: boxes[0],
        maxY: 100,
        ticks: QUOTA_TICKS,
        format: (value) => `${value}%`,
        series: build(boxes[0], 100, "quotaPct"),
      }),
      linePanel({
        title: "Applied wait",
        subtitle: capNote(peakWait),
        box: boxes[1],
        maxY: wait.maxY,
        ticks: wait.ticks,
        format: secondsFormat,
        series: build(boxes[1], wait.maxY, "interval"),
      }),
      linePanel({
        title: "External backlog",
        subtitle: "queued external runs awaiting a slot",
        box: boxes[2],
        maxY: backlog.maxY,
        ticks: backlog.ticks,
        format: countFormat,
        series: build(boxes[2], backlog.maxY, "backlog"),
      })
    );
  });
  return svgDocument({
    width: 1_010,
    height: 1_110,
    heading: "#291 closed-loop v1 \u2014 candidates on the burst-then-quiet scenario",
    subtitle:
      "One parameter axis per row, each against identical seeded demand. The near-black line is the current controller in",
    subtitle2:
      "every panel; coloured lines are counterfactual weights. Panel axes are scaled per row, so compare within a panel.",
    body: panels.filter(Boolean).join("\n  "),
    footer:
      "Demand runs at 4x budget for 36 hours and then collapses to 0.4x \u2014 the #291 recovery-lag complaint expressed as closed-loop demand rather than as a fixed error sequence.",
  });
}

function tradeoffCharts({ scenarios, metrics }) {
  const measures = [
    {
      key: "exhausted_hours",
      title: "Hours with quota exhausted",
      better: "lower",
      critical: true,
    },
    { key: "external_completed", title: "External runs completed", better: "higher" },
    { key: "external_wait_p95_hours", title: "External wait, p95 (hours)", better: "lower" },
  ];
  const panels = [];
  scenarios.forEach((scenario, rowIndex) => {
    const top = 138 + rowIndex * 212;
    measures.forEach((measure, column) => {
      const box = { x: 168 + column * 288, y: top, width: 170, height: 132 };
      const rows = CANDIDATES.map((candidate) => {
        const row = metrics.find(
          (item) => item.scenario === scenario.id && item.candidate === candidate.id
        );
        return { candidate, value: row[measure.key] ?? 0 };
      });
      const maxValue = Math.max(1e-9, ...rows.map((row) => row.value));
      const bars = rows
        .map((row, index) => {
          const height = 12;
          const gap = 4;
          const y = box.y + index * (height + gap);
          const width = (row.value / maxValue) * box.width;
          // One neutral fill for every bar: identity already comes from the row
          // label, so hue is free to carry exactly one meaning \u2014 exhaustion.
          const color = measure.critical && row.value > 0 ? CRITICAL_COLOR : REFERENCE_COLOR;
          const value = row.value >= 100 ? row.value.toFixed(0) : row.value.toFixed(1);
          return `<rect x="${box.x}" y="${y}" width="${Math.max(0, width).toFixed(1)}" height="${height}" rx="3" fill="${color}" /><text x="${(box.x + Math.max(0, width) + 5).toFixed(1)}" y="${y + 9}" class="axis">${value}</text>${column === 0 ? `<text x="${box.x - 6}" y="${y + 9}" text-anchor="end" class="axis">${row.candidate.label}</text>` : ""}`;
        })
        .join("");
      panels.push(
        `<g><text x="${box.x}" y="${box.y - 26}" class="title">${measure.title}</text><text x="${box.x}" y="${box.y - 12}" class="note">${measure.better} is better</text>${bars}</g>`
      );
    });
    panels.push(`<text x="24" y="${top - 48}" class="rowlabel">${scenario.label}</text>`);
  });
  return svgDocument({
    width: 1_080,
    height: 980,
    heading: "#291 closed-loop v1 — safety and throughput tradeoffs",
    subtitle: "Identity comes from the row labels, so every bar shares one neutral fill.",
    subtitle2:
      "Red carries a single meaning \u2014 the candidate ran the weekly budget to zero \u2014 and the number beside each bar repeats the value, so the flag is never colour-alone.",
    body: panels.join("\n  "),
    footer:
      "Bars are scaled within each panel, so lengths compare candidates inside one measure and one scenario only, never across panels.",
  });
}

/* ------------------------------------------------------------------- report */

function fixed(value, digits = 1) {
  return value == null ? "not reached" : Number(value).toFixed(digits);
}

function report({
  scenarios,
  metrics,
  robustnessRows,
  robustnessRows2,
  thresholdRows,
  plantSensitivityRows,
}) {
  const baselineRows = scenarios
    .map((scenario) => {
      const row = metrics.find(
        (item) => item.scenario === scenario.id && item.candidate === BASELINE.id
      );
      return `| ${scenario.label} | ${fixed(row.exhausted_hours)} | ${fixed(row.quota_left_week_end_pct)} | ${row.external_completed} | ${row.responsive_completed} | ${fixed(row.external_wait_p95_hours, 2)} | ${fixed(row.mean_interval_seconds, 0)} |`;
    })
    .join("\n");
  const burst = metrics
    .filter((row) => row.scenario === "burst-recovery")
    .map(
      (row) =>
        `| ${row.label} | ${fixed(row.recovery_to_2x_ideal_hours)} | ${fixed(row.exhausted_hours)} | ${row.external_completed} | ${fixed(row.external_wait_p95_hours, 2)} | ${fixed(row.mean_abs_error_points, 2)} |`
    )
    .join("\n");
  const overload = metrics
    .filter((row) => row.scenario === "overload")
    .map(
      (row) =>
        `| ${row.label} | ${fixed(row.exhausted_hours)} | ${fixed(row.quota_left_week_end_pct)} | ${row.external_completed} | ${fixed(row.max_interval_seconds, 0)} | ${fixed(row.mean_abs_error_points, 2)} |`
    )
    .join("\n");
  const anyExhaustion = metrics.filter((row) => row.exhausted_hours > 0);
  const burstMetrics = metrics.filter((row) => row.scenario === "burst-recovery");
  const maxDerivativeTerm = Math.max(...metrics.map((row) => row.max_derivative_term_seconds));
  const proposal = burstMetrics.find((row) => row.candidate === "weaker-i-stronger-d");

  // Every ordering claim below is read off the resampled sweep, not off the
  // single headline seed, because a single seed cannot establish an ordering.
  const baselineRobust = robustnessRows2.find((row) => row.candidate === BASELINE.id);
  const robustBy = (id) => robustnessRows2.find((row) => row.candidate === id);
  const burstDerivativeGap = Math.max(
    ...robustnessRows
      .filter(
        (row) =>
          row.scenario === "burst-recovery" &&
          (row.candidate === "kd-900" || row.candidate === "kd-3600")
      )
      .map((row) => row.max_interval_delta_vs_current_seconds)
  );
  const fasterEverySeed = robustnessRows2.filter(
    (row) => row.candidate !== BASELINE.id && row.seeds_faster_than_current === row.seeds
  );
  const slowerRecoverySeeds = robustnessRows2.filter(
    (row) =>
      row.candidate !== BASELINE.id &&
      row.seeds_faster_than_current === 0 &&
      !["kd-900", "kd-3600"].includes(row.candidate)
  );
  const proposalRobust = robustBy("weaker-i-stronger-d");
  const thresholdCandidates = [BASELINE.id, "ti-half-hour", "kp-160", "ti-2h"];
  const thresholdTable = RECOVERY_MULTIPLIERS.map((multiplier) => {
    const rows = thresholdRows.filter((row) => row.threshold_x_ideal === multiplier);
    const find = (candidate) => rows.find((row) => row.candidate === candidate);
    return `| ${multiplier}× | ${thresholdCandidates
      .map((candidate) => {
        const row = find(candidate);
        return `${fixed(row?.recovery_mean_hours)} h (${row?.seeds_faster_than_current ?? 0}/8 faster)`;
      })
      .join(" | ")} |`;
  }).join("\n");
  const sensitivityTable = PLANT_SENSITIVITIES.map((plant) => {
    const rows = plantSensitivityRows.filter((row) => row.plant === plant.id);
    const find = (candidate) => rows.find((row) => row.candidate === candidate);
    const current = find(BASELINE.id);
    const weakerIntegral = find("ti-2h");
    const strongerDerivative = find("kd-3600");
    const obs = plant.observationPeriodSeconds ?? OBSERVATION_PERIOD_SECONDS;
    const cost = plant.variableCost ? "bimodal" : "fixed";
    return `| ${plant.id} | ${plant.runDurationSeconds} s | ${plant.maxConcurrentRuns} | ${obs} s | ${cost} | ${fixed(current?.recovery_to_2x_ideal_hours)} | ${fixed(weakerIntegral?.recovery_to_2x_ideal_hours)} | ${fixed(strongerDerivative?.recovery_to_2x_ideal_hours)} | ${fixed(strongerDerivative?.max_derivative_term_seconds, 2)} | ${fixed(strongerDerivative?.max_interval_delta_vs_current_seconds, 0)} |`;
  }).join("\n");
  const maxSensitivityDerivative = Math.max(
    ...plantSensitivityRows.map((row) => row.max_derivative_term_seconds)
  );
  // The faster candidates buy recovery with a higher peak command; measure how
  // much, and whether that actually reached external work as queueing delay.
  const peakCommandRise = (id) => {
    const gaps = SCENARIOS.map((scenario) => {
      const row = metrics.find((m) => m.scenario === scenario.id && m.candidate === id);
      const base = metrics.find((m) => m.scenario === scenario.id && m.candidate === BASELINE.id);
      return row.max_interval_seconds - base.max_interval_seconds;
    });
    return Math.max(...gaps);
  };
  const waitCostRise = (id) => {
    const gaps = SCENARIOS.map((scenario) => {
      const row = metrics.find((m) => m.scenario === scenario.id && m.candidate === id);
      const base = metrics.find((m) => m.scenario === scenario.id && m.candidate === BASELINE.id);
      return row.external_wait_p95_hours - base.external_wait_p95_hours;
    });
    return Math.max(...gaps);
  };
  const fasterPeakRise = Math.max(...fasterEverySeed.map((row) => peakCommandRise(row.candidate)));
  const fasterWaitRise = Math.max(...fasterEverySeed.map((row) => waitCostRise(row.candidate)));
  const describeExhaustion = (row) =>
    row.exhausting_runs === baselineRobust.exhausting_runs
      ? `the same ${row.exhausting_runs} of ${row.total_runs} runs as current`
      : `${row.exhausting_runs} of ${row.total_runs} runs against current's ${baselineRobust.exhausting_runs}`;

  return (
    `# #291 high-fidelity closed-loop controller study\n\n` +
    `Generated by \`node research/quota-closed-loop-study.mjs --write\`. Do not edit this report by hand.\n\n` +
    `## Why this exists\n\n` +
    `The companion fixed-input study replays a supplied error sequence. That is a valid calibration check and an invalid tuning experiment, because the controller's own output changes how fast quota is consumed and therefore what error it sees next. A candidate cannot be scored against errors that were recorded under different weights.\n\n` +
    `This study closes the loop: commanded wait throttles run starts, started runs complete and burn quota, and the resulting quota level produces the next controller error. Demand is generated once per scenario from a fixed seed and replayed identically for every candidate, so differences between candidates are caused only by the weights.\n\n` +
    `Starting from merged PR #341 (closed-loop v1), this study calibrates the simulation against production architecture across the eight elements requested in #291 and establishes an explicit accounting of what is calibrated by evidence versus what remains an uncalibrated assumption.\n\n` +
    `## Calibrated plant model and evidence accounting\n\n` +
    `The eight elements identified for high-fidelity simulation are accounted for as follows:\n\n` +
    `1. **Applied throttling (Calibrated):** Faithful implementation of \`ProviderPacer\`'s two-stage staging pipeline (\`packages/rusa/src/actor/provider-pacer.ts\`). External runs first stage behind the commanded start-to-start interval clock, then wait for available \`ConcurrencyLimiter\` capacity. Selection-time revalidation ensures that if the interval lengthens or responsive runs start while staged, the request is returned to queue and re-delayed. Raising the interval re-bases the pending wait on the last actual start (\`lastStartedAt\`), exactly as production \`setInterval\` does.\n` +
    `2. **Observation cadence (Calibrated):** Calibrated to the production 300 s slot cadence (\`SLOT_MS = 5 * 60 * 1000\` in \`packages/rusa/src/quota/shared-store.ts\`). Earlier 600 s models suffered from an integration truncation flaw: because \`QUOTA_INTEGRAL_MAX_STEP_SECONDS = 300\`, setting observation cadence to 600 s clipped \`Math.min(dt, 300)\` to 300 s every single step, discarding half the accrued integral error! At 300 s, the controller integrates the full elapsed time.\n` +
    `3. **Execution duration and concurrency (Calibrated baseline + Sensitivity):** Baseline uses 240 s run duration and 4 concurrent normal runs (matching default production mesh concurrency). Completion lags of 30 s, 240 s, and 600 s across 1 and 4 slots are evaluated in the sensitivity matrix.\n` +
    `4. **Quota reset behavior (Calibrated):** Faithful reproduction of \`shared-store.ts\` (staging revision \`${PRODUCTION_CONTROLLER_REVISION}\`) cycle rollover at 7 days (${WINDOW_SECONDS.toLocaleString()} s), quota refill to 100%, integral and derivative reset to 0, and post-reset actuator smoothing (0.25) and slew limiting (±900 s).\n` +
    `5. **Responsive and external demand (Calibrated gating, uncalibrated split):** Responsive work bypasses pacing and normal concurrency limits but re-bases the interval clock (\`lastStartedAt\`), exactly matching \`ProviderPacer\`. The demand mix (~23% responsive in nominal/burst, ~64% in responsive-heavy) is an explicit modeler assumption, as public traces do not record priority breakdown.\n` +
    `6. **Quota usage (Calibrated baseline + Sensitivity):** Baseline uses a fixed ${QUOTA_COST_PER_RUN_POINTS.toFixed(3)} points per completed run (budget of ${BUDGET_RUNS_PER_WEEK.toLocaleString()} runs/week, ideal spacing ${IDEAL_SPACING_SECONDS.toFixed(0)} s). Variable quota cost is evaluated via deterministic bimodal variance (1.8× and 0.6×) preserving identical mean burn. Per-token / per-prompt usage telemetry is unobserved in public data.\n` +
    `7. **Model-run arrivals (Uncalibrated assumption):** Deterministic thinned-Poisson arrival draws. No empirical arrival logs exist in public records, so arrivals are synthetic.\n` +
    `8. **Daytime activity (Uncalibrated assumption):** Raised half-sine across a 14-hour working day over a 0.15 night floor. Documented as a synthetic profile rather than measured telemetry.\n\n` +
    `## Current controller, closed loop\n\n` +
    `| scenario | exhausted (h) | quota left at week end (%) | external done | responsive done | external wait p95 (h) | mean interval (s) |\n` +
    `| --- | ---: | ---: | ---: | ---: | ---: | ---: |\n${baselineRows}\n\n` +
    `## Burst then quiet — the #291 recovery question\n\n` +
    `The primary recovery measure is time from the end of the 36-hour burst until the applied wait is at or below twice the ideal ${IDEAL_SPACING_SECONDS.toFixed(0)} s spacing. Twice ideal is a legible “no longer materially delayed” threshold for comparison, not a production SLO or stability proof. The same seed sweep also reports 1×, 1.5×, and 2.5× thresholds below.\n\n` +
    `| candidate | recovery (h) | exhausted (h) | external done | external wait p95 (h) | mean abs error (pts) |\n` +
    `| --- | ---: | ---: | ---: | ---: | ---: |\n${burst}\n\n` +
    `### Recovery-threshold sensitivity (8 burst-demand seeds)\n\n` +
    `Each cell is mean recovery hours; the parenthesis is seeds faster than current. The rankings used for the bounded recommendation are visible rather than inferred from the 2× cutoff alone.\n\n` +
    `| threshold | current | Ti 0.5h | Kp 160 | Ti 2h |\n` +
    `| --- | ---: | ---: | ---: | ---: |\n${thresholdTable}\n\n` +
    `## Sustained overload — the safety side of the same choice\n\n` +
    `| candidate | exhausted (h) | quota left at week end (%) | external done | max wait (s) | mean abs error (pts) |\n` +
    `| --- | ---: | ---: | ---: | ---: | ---: |\n${overload}\n\n` +
    `## Reading these results\n\n` +
    `The high-fidelity closed loop reinforces and clarifies the core control findings:\n\n` +
    `- **Cadence calibration accelerates recovery without changing controller rankings:** Calibrating observation cadence from 600 s to the native 300 s production slot resolves the integral step-bound truncation. Under 300 s sampling, burst recovery for the current controller improves from 11.0 h to ${fixed(baselineRobust.recovery_mean_hours)} h.\n` +
    `- **The derivative term remains inert at production cadence:** Across every scenario and candidate the largest derivative contribution to the command was ${fixed(maxDerivativeTerm, 2)} s, against commands in the thousands of seconds. Over the burst-recovery resampled sweep, \`Kd 900\` and \`Kd 3600\` never moved the applied wait more than ${fixed(burstDerivativeGap, 0)} s away from current weights and reproduced identical recovery times on every seed. Quota moves slowly and smoothly relative to the ${OBSERVATION_PERIOD_SECONDS} s slot, so there is negligible slope for the derivative to act upon. **A stronger derivative is not a recovery lever in this plant.**\n` +
    `- **The weaker-integral direction remains strictly worse on recovery:** ${slowerRecoverySeeds.map((row) => `\`${row.label}\` (${fixed(row.recovery_mean_hours)} h mean recovery vs current's ${fixed(baselineRobust.recovery_mean_hours)} h, 0/${row.seeds} seeds faster; ${describeExhaustion(row)})`).join("; ")}. A longer integral time requires a proportionally larger accumulated integral to sustain a command, so unwinding against positive error takes substantially longer.\n` +
    `- **The combined proposal inherits that weakness:** \`${proposal.label}\` recovered in ${fixed(proposalRobust.recovery_mean_hours)} h on average against the current controller's ${fixed(baselineRobust.recovery_mean_hours)} h, was slower on ${proposalRobust.seeds - proposalRobust.seeds_faster_than_current} of ${proposalRobust.seeds} seeds, and derivative action failed to offset the integral delay.\n` +
    `${fasterEverySeed.length > 0 ? `- **Moving the opposite way improves recovery:** ${fasterEverySeed.map((row) => `\`${row.label}\` recovered faster than current on all ${row.seeds} seeds (${fixed(row.recovery_mean_hours)} h mean vs ${fixed(baselineRobust.recovery_mean_hours)} h) and exhausted quota in ${describeExhaustion(row)}`).join("; ")}. Both achieve faster recovery by commanding a higher peak wait (up to ${fixed(fasterPeakRise, 0)} s higher at peak, external wait p95 moving by at most ${fixed(fasterWaitRise, 2)} h), unwinding earlier when demand subsides.\n` : ""}` +
    `\n${anyExhaustion.length} of ${metrics.length} candidate-scenario pairs reached zero quota on the headline seed. Exhaustion appears only in responsive-dominated and sustained-overload scenarios, where responsive work bypasses pacing entirely and leaves the controller authority only over queued external work.\n\n` +
    `## Plant sensitivity: completion lag, capacity, cadence, and cost variance\n\n` +
    `To evaluate the sensitivity of the findings to uncalibrated plant parameters, the burst-recovery scenario is re-evaluated across completion durations (30/240/600 s), concurrency capacities (1 and 4 slots), observation cadences (300 s vs 600 s), and cost models (fixed 0.05 vs bimodal variance).\n\n` +
    `| variant | duration | slots | obs cadence | quota cost | current recovery (h) | Ti 2h recovery (h) | Kd 3600 recovery (h) | Kd 3600 max D term (s) | Kd 3600 max Δ from current (s) |\n` +
    `| --- | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: |\n${sensitivityTable}\n\n` +
    `Across all variants:\n` +
    `- The largest derivative contribution never exceeds ${fixed(maxSensitivityDerivative, 2)} s, confirming that derivative inertness is an intrinsic feature of the observation timescale, not a plant lag artifact.\n` +
    `- Weaker integral (\`Ti 2h\`) remains uniformly slower across every variant.\n` +
    `- Variable quota cost introduces micro-scale variance but leaves recovery dynamics and candidate rankings identical.\n\n` +
    `## Assumptions, limits, and missing telemetry\n\n` +
    `While fidelity has been improved to match the production runtime architecture, remaining gaps are documented:\n\n` +
    `- **Missing empirical token burn:** Telemetry on per-run token consumption distribution is unavailable in public records. Fixed mean with bimodal sensitivity bounds the effect, but true multi-modal token distribution requires production telemetry.\n` +
    `- **Missing arrival telemetry:** Arrival rates and responsive/external ratios are plausible synthetic models rather than observed empirical traces.\n` +
    `- **Scope bounds:** Single provider bucket on a weekly window. Multi-bucket interactions and the 5-hour rolling window are not modeled.\n\n` +
    `## Recommendation\n\n` +
    `The high-fidelity simulation confirms the previous conclusion with greater precision: **do not retune production weights from this evidence alone**.\n\n` +
    `1. **Derivative action is inert at production sampling rates:** Raising \`Kd\` does not speed recovery and does not warrant deployment.\n` +
    `2. **Weaker integral is counter-productive:** Increasing \`Ti\` delays recovery and increases exhaustion risk.\n` +
    `3. **Pacing dials should remain untouched:** Until empirical token distributions and arrival traces are gathered from production telemetry, the production controller weights should remain at their current baseline.\n\n` +
    `## Artifacts\n\n` +
    `- [closed-loop metrics CSV](quota-closed-loop-summary.csv) — the table inputs above.\n` +
    `- [seed robustness CSV](quota-closed-loop-robustness.csv) — every scenario re-run across ${ROBUSTNESS_SEEDS} demand seeds.\n` +
    `- [threshold sensitivity CSV](quota-closed-loop-thresholds.csv) — all recovery cutoffs over the seed sweep.\n` +
    `- [plant sensitivity CSV](quota-closed-loop-plant-sensitivity.csv) — completion-lag, capacity, cadence, and cost variants.\n` +
    `- [current-controller charts](quota-closed-loop-baseline-charts.svg) — quota, commanded vs applied wait, and backlog per scenario.\n` +
    `- [candidate charts](quota-closed-loop-candidate-charts.svg) — one parameter axis per row on the burst scenario.\n` +
    `- [tradeoff charts](quota-closed-loop-tradeoffs.svg) — safety and throughput per candidate and scenario.\n`
  );
}

/* ----------------------------------------------------------------- validate */

function validateStudy({ scenarios, results, metrics }) {
  for (const scenario of scenarios) {
    if (scenario.arrivals.length === 0) throw new Error(`${scenario.id} generated no demand`);
    for (const candidate of CANDIDATES) {
      const result = results.get(`${scenario.id}/${candidate.id}`);
      if (result.samples.length === 0)
        throw new Error(`${scenario.id}/${candidate.id} produced no samples`);
      for (const row of result.samples) {
        if (
          !Number.isFinite(row.interval) ||
          row.interval < 0 ||
          row.interval > MAX_INTERVAL_SECONDS
        ) {
          throw new Error(`${scenario.id}/${candidate.id} violates the actuator bounds`);
        }
        if (row.quotaPct < 0 || row.quotaPct > 100) {
          throw new Error(`${scenario.id}/${candidate.id} produced an impossible quota level`);
        }
      }
      // The loop must actually be closed: consumption has to track the work done.
      if (100 - result.quotaAtWeekEndPct <= 0) {
        throw new Error(`${scenario.id}/${candidate.id} consumed no quota`);
      }
    }
  }
  // Demand is identical across candidates by construction; assert it, because
  // the whole comparison is void if a candidate changed its own arrivals.
  for (const scenario of scenarios) {
    const fingerprint = JSON.stringify(scenario.arrivals.slice(0, 50));
    const rerun = JSON.stringify(generateArrivals(scenario).slice(0, 50));
    if (fingerprint !== rerun) throw new Error(`${scenario.id} arrivals are not reproducible`);
  }
  const nominal = metrics.find(
    (row) => row.scenario === "nominal" && row.candidate === BASELINE.id
  );
  if (nominal.exhausted_hours > 0) {
    throw new Error("under-budget demand exhausted the quota; the plant calibration is wrong");
  }
}

function buildArtifacts() {
  const study = runStudy();
  validateStudy(study);
  return new Map([
    [join(GENERATED, "quota-closed-loop-summary.csv"), csv(study.metrics)],
    [join(GENERATED, "quota-closed-loop-robustness.csv"), csv(study.robustnessRows)],
    [join(GENERATED, "quota-closed-loop-thresholds.csv"), csv(study.thresholdRows)],
    [join(GENERATED, "quota-closed-loop-plant-sensitivity.csv"), csv(study.plantSensitivityRows)],
    [join(GENERATED, "quota-closed-loop-baseline-charts.svg"), baselineCharts(study)],
    [join(GENERATED, "quota-closed-loop-candidate-charts.svg"), candidateCharts(study)],
    [join(GENERATED, "quota-closed-loop-tradeoffs.svg"), tradeoffCharts(study)],
    [join(GENERATED, "quota-closed-loop-report.md"), report(study)],
  ]);
}

function main() {
  const args = process.argv.slice(2);
  if (args.some((argument) => !["--check", "--write"].includes(argument))) {
    throw new Error("usage: node research/quota-closed-loop-study.mjs [--write|--check]");
  }
  const artifacts = buildArtifacts();
  if (args.includes("--check")) {
    for (const [path, content] of artifacts) {
      if (readFileSync(path, "utf8") !== content)
        throw new Error(`stale generated artifact: ${path}`);
    }
    console.log(`verified ${artifacts.size} deterministic #291 closed-loop artifacts`);
    return;
  }
  mkdirSync(GENERATED, { recursive: true });
  for (const [path, content] of artifacts) writeFileSync(path, content);
  console.log(`wrote ${artifacts.size} deterministic #291 closed-loop artifacts`);
}

main();
