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
import { BASELINE, CANDIDATES, csv, MAX_INTERVAL_SECONDS, percentile } from "./lib/controller.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const GENERATED = join(HERE, "generated");

const IDEAL_SPACING_SECONDS = WINDOW_SECONDS / BUDGET_RUNS_PER_WEEK;

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
  // Recovery lag: after the burst ends, how long until pacing is back to a
  // level that no longer materially delays work?
  const afterBurst = samples.filter((row) => row.seconds >= 36 * 3_600);
  const relaxed = afterBurst.find((row) => row.interval <= 2 * IDEAL_SPACING_SECONDS);
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
    recovery_to_2x_ideal_hours: relaxed ? (relaxed.seconds - 36 * 3_600) / 3_600 : null,
  };
}

function runStudy() {
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
        const afterBurst = result.samples.filter((row) => row.seconds >= 36 * 3_600);
        const relaxed = afterBurst.find((row) => row.interval <= 2 * IDEAL_SPACING_SECONDS);
        rows.push({
          scenario: scenario.id,
          seed_offset: offset,
          candidate: candidate.id,
          label: candidate.label,
          exhausted_hours: result.exhaustedHours,
          external_completed: result.externalCompleted,
          quota_left_week_end_pct: result.quotaAtWeekEndPct,
          recovery_to_2x_ideal_hours: relaxed ? (relaxed.seconds - 36 * 3_600) / 3_600 : null,
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

function robustnessSummary(rows) {
  return CANDIDATES.map((candidate) => {
    const mine = rows.filter((row) => row.candidate === candidate.id);
    const burst = mine.filter((row) => row.scenario === "burst-recovery");
    const recoveries = burst
      .map((row) => row.recovery_to_2x_ideal_hours)
      .filter((value) => value != null);
    const baselineBurst = rows.filter(
      (row) => row.candidate === BASELINE.id && row.scenario === "burst-recovery"
    );
    const faster = burst.filter((row, index) => {
      const reference = baselineBurst[index]?.recovery_to_2x_ideal_hours;
      return (
        row.recovery_to_2x_ideal_hours != null &&
        reference != null &&
        row.recovery_to_2x_ideal_hours < reference
      );
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

function traceRows({ scenarios, results }) {
  const rows = [];
  for (const scenario of scenarios) {
    for (const candidate of CANDIDATES) {
      for (const row of results.get(`${scenario.id}/${candidate.id}`).samples) {
        rows.push({
          scenario: scenario.id,
          source: "closed-loop-simulation",
          candidate: candidate.id,
          time_hours: row.hours,
          quota_left_pct: row.quotaPct,
          time_remaining_pct: row.timeRemainingPct,
          error: row.error,
          applied_interval_seconds: row.interval,
          commanded_interval_seconds: row.uncappedInterval,
          integral: row.integral,
          derivative: row.derivative,
          external_backlog: row.backlog,
          running: row.running,
          external_completed: row.externalCompleted,
          responsive_completed: row.responsiveCompleted,
          exhausted: row.exhausted,
        });
      }
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
    footer: `Fixed v1 plant: ${BUDGET_RUNS_PER_WEEK} runs per weekly budget (${QUOTA_COST_PER_RUN_POINTS.toFixed(3)} points each), ${RUN_DURATION_SECONDS} s per run, ${MAX_CONCURRENT_RUNS} concurrent; responsive runs bypass pacing but still charge the start-to-start clock. Not a production forecast.`,
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

function report({ scenarios, metrics, robustnessRows2 }) {
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
  const derivativeRobust = ["kd-900", "kd-3600"].map(robustBy);
  const maxDerivativeGap = Math.max(
    ...derivativeRobust.map((row) => row.max_interval_delta_vs_current_seconds)
  );
  const fasterEverySeed = robustnessRows2.filter(
    (row) => row.candidate !== BASELINE.id && row.seeds_faster_than_current === row.seeds
  );
  const slowerEverySeed = robustnessRows2.filter(
    (row) =>
      row.candidate !== BASELINE.id &&
      row.seeds_faster_than_current === 0 &&
      row.exhausting_runs > baselineRobust.exhausting_runs
  );
  const proposalRobust = robustBy("weaker-i-stronger-d");
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
    `# #291 closed-loop controller study (v1)\n\n` +
    `Generated by \`node research/quota-closed-loop-study.mjs --write\`. Do not edit this report by hand.\n\n` +
    `## Why this exists\n\n` +
    `The companion fixed-input study replays a supplied error sequence. That is a valid calibration check and an invalid tuning experiment, because the controller's own output changes how fast quota is consumed and therefore what error it sees next. A candidate cannot be scored against errors that were recorded under different weights.\n\n` +
    `This study closes the loop. The commanded interval throttles run starts, started runs complete and burn a fixed quota cost, and the resulting quota level produces the next controller error. Demand is generated once per scenario from a fixed seed and replayed identically for every candidate, so differences between candidates are caused only by the weights.\n\n` +
    `## Plant model (v1)\n\n` +
    `- **Quota window:** weekly, ${WINDOW_SECONDS.toLocaleString()} s, simulated for ${(HORIZON_SECONDS / 86_400).toFixed(0)} days so the rollover, refill, and post-reset behaviour all occur inside the loop.\n` +
    `- **Quota cost:** a fixed ${QUOTA_COST_PER_RUN_POINTS.toFixed(3)} points per completed run, which is the v1 simplification requested for this iteration. The weekly budget is therefore ${BUDGET_RUNS_PER_WEEK.toLocaleString()} runs and perfectly even pacing is ${IDEAL_SPACING_SECONDS.toFixed(0)} s between starts.\n` +
    `- **Runs:** ${RUN_DURATION_SECONDS} s each, at most ${MAX_CONCURRENT_RUNS} concurrent. Quota is charged at completion.\n` +
    `- **Arrivals:** deterministic thinned-Poisson draws split into responsive and external work, shaped by a daytime activity profile (a raised half-sine across a 14-hour working day over a 0.15 night floor).\n` +
    `- **Applied throttling:** a faithful copy of \`ProviderPacer\`'s start-to-start gate. External runs wait for the commanded interval; responsive runs bypass the wait but still charge the interval clock, so responsive load displaces external work instead of adding to it. Raising the interval re-bases the pending wait on the last actual start, exactly as \`setInterval\` does.\n` +
    `- **Exhaustion:** at zero quota the controller update is skipped and the pacer is deferred to the reset instant, matching the production early return and \`deferUntil\`.\n` +
    `- **Controller:** the unchanged update from \`packages/rusa/src/quota/shared-store.ts\`, shared with the fixed-input study via \`research/lib/controller.mjs\`. Conditional integration, the 300 s integral step bound, the 1,800 s derivative filter, 0.25 smoothing, ±900 s slew, and the deliberate 36,000 s cap are all preserved.\n\n` +
    `## Current controller, closed loop\n\n` +
    `| scenario | exhausted (h) | quota left at week end (%) | external done | responsive done | external wait p95 (h) | mean wait (s) |\n` +
    `| --- | ---: | ---: | ---: | ---: | ---: | ---: |\n${baselineRows}\n\n` +
    `## Burst then quiet — the #291 recovery question\n\n` +
    `Recovery is measured as the time from the end of the 36-hour burst until the applied wait returns to twice the ideal ${IDEAL_SPACING_SECONDS.toFixed(0)} s spacing.\n\n` +
    `| candidate | recovery (h) | exhausted (h) | external done | external wait p95 (h) | mean abs error (pts) |\n` +
    `| --- | ---: | ---: | ---: | ---: | ---: |\n${burst}\n\n` +
    `## Sustained overload — the safety side of the same choice\n\n` +
    `| candidate | exhausted (h) | quota left at week end (%) | external done | max wait (s) | mean abs error (pts) |\n` +
    `| --- | ---: | ---: | ---: | ---: | ---: |\n${overload}\n\n` +
    `## Reading these results\n\n` +
    `The closed loop does not reproduce the tradeoff the fixed-input probes implied. Recovery speed and exhaustion protection did not trade off against each other here.\n\n` +
    `- **The derivative term is inert at this cadence.** Across every scenario and candidate the largest derivative contribution to the command was ${fixed(maxDerivativeTerm, 2)} s, against commands in the hundreds to thousands of seconds. Over the resampled sweep, \`Kd 900\` and \`Kd 3600\` never moved the applied wait more than ${fixed(maxDerivativeGap, 0)} s away from the current weights and reproduced its recovery time on every seed. Quota moves slowly and smoothly relative to the ${OBSERVATION_PERIOD_SECONDS} s observation period, so there is almost no slope for the derivative to act on. **A stronger derivative is not a recovery lever in this plant.**\n` +
    `- **The weaker-integral direction was worse on both axes.** ${slowerEverySeed.length > 0 ? `${slowerEverySeed.map((row) => `\`${row.label}\``).join(", ")} recovered more slowly than the current weights on every seed tested *and* ran the weekly budget to zero more often (${slowerEverySeed.map((row) => describeExhaustion(row)).join("; ")}).` : "No candidate was worse on both axes across the sweep."} The mechanism is visible in the traces: a longer integral time needs a proportionally larger accumulated integral to hold the same command, so unwinding it against the same error takes longer.\n` +
    `- **The combined proposal inherits that.** \`${proposal.label}\` recovered in ${fixed(proposalRobust.recovery_mean_hours)} h on average against the current controller's ${fixed(baselineRobust.recovery_mean_hours)} h, was slower on ${proposalRobust.seeds - proposalRobust.seeds_faster_than_current} of ${proposalRobust.seeds} seeds, and the stronger derivative did not offset it.\n` +
    `${fasterEverySeed.length > 0 ? `- **What did improve recovery was moving the opposite way.** ${fasterEverySeed.map((row) => `\`${row.label}\` recovered faster than current on all ${row.seeds} seeds (${fixed(row.recovery_mean_hours)} h mean vs ${fixed(baselineRobust.recovery_mean_hours)} h) and exhausted quota in ${describeExhaustion(row)}`).join("; ")}. Both buy that recovery with a higher peak command \u2014 up to ${fixed(fasterPeakRise, 0)} s above the current weights at a scenario peak. On these runs that extra pacing did not turn into much extra queueing (external p95 wait moved by at most ${fixed(fasterWaitRise, 2)} h), because the backlog is already dominated by demand exceeding what the budget can serve.\n` : ""}` +
    `\n${anyExhaustion.length} of ${metrics.length} candidate-scenario pairs reached zero quota on the headline seed. Exhaustion appears only in the responsive-dominated and sustained-overload scenarios, which is where the controller has the least authority: responsive work bypasses pacing entirely, so the only lever left is squeezing external work that is already queued.\n\n` +
    `## Assumptions and limits\n\n` +
    `This is v1 and is deliberately coarse. It should not be used to pick production weights on its own.\n\n` +
    `- Every run costs the same quota. Real runs vary by model, context length, and tool use, and that variance is exactly what determines the tail behaviour near exhaustion.\n` +
    `- Run duration is fixed and failures, retries, and cancellations are not modelled.\n` +
    `- Demand is resampled across ${ROBUSTNESS_SEEDS} seeds, but the *shape* — the arrival rates, the responsive/external split, the daytime curve — is a plausible guess rather than a measurement. Resampling shows an ordering is not a seed artifact; it cannot show the shape is right. Absolute run counts carry no operational meaning; only the comparison between candidates on identical demand does.\n` +
    `- Responsive work is assumed to be admitted unconditionally. Real responsive load has its own upstream limits.\n` +
    `- One provider, one bucket, one weekly window. Multi-bucket interaction and the five-hour window are out of scope.\n` +
    `- The observation cadence is a clean ${OBSERVATION_PERIOD_SECONDS} s. The historical trace in #291 shows irregular cadence, which the fixed-input study covers instead.\n\n` +
    `## Recommendation\n\n` +
    `Still no production retune from this evidence alone, and this study is not a mandate to change weights. What it does support is a narrowing:\n\n` +
    `1. **The stronger-derivative direction is not worth pursuing further in this form.** The derivative contribution is too small at the production observation cadence to move the command, so raising \`Kd\` changes nothing measurable. Making it matter would mean observing far more often, which is a different change with its own cost.\n` +
    `2. **The weaker-integral direction should not be adopted on recovery grounds.** In closed loop it recovered more slowly than the current weights, not faster, and it exhausted the budget in a scenario where the current weights did not.\n` +
    `3. **If faster recovery is the goal, the candidates that achieved it moved the opposite way** — a shorter integral time or a stronger proportional term, each faster than the current weights on every seed tested. That is a live hypothesis worth a v2, not a recommendation: both hold external work at a higher peak wait to do it, and both were measured against an uncalibrated demand model.\n\n` +
    `Before any of this becomes a weight change it needs an operator target in operational units — acceptable exhausted hours per week, acceptable p95 delay for external work, and whether responsive work should keep bypassing pacing under load — plus a per-run quota cost and arrival rates calibrated against real telemetry. That calibration is the natural v2.\n\n` +
    `## Artifacts\n\n` +
    `- [closed-loop traces CSV](quota-closed-loop-traces.csv) — every simulated observation for every candidate and scenario.\n` +
    `- [closed-loop metrics CSV](quota-closed-loop-summary.csv) — the table inputs above.\n` +
    `- [seed robustness CSV](quota-closed-loop-robustness.csv) — every scenario re-run across ${ROBUSTNESS_SEEDS} demand seeds.\n` +
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
    [join(GENERATED, "quota-closed-loop-traces.csv"), csv(traceRows(study))],
    [join(GENERATED, "quota-closed-loop-summary.csv"), csv(study.metrics)],
    [join(GENERATED, "quota-closed-loop-robustness.csv"), csv(study.robustnessRows)],
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
