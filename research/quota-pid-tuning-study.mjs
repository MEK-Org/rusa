#!/usr/bin/env node
// Analysis-only, deterministic controller study for MEK-Org/rusa#291.
//
// This mirrors the public controller equations in origin/staging. It neither
// imports production state nor changes production controller code. The first
// scenario is the sanitized historical trace published in #291; every other
// scenario is explicitly synthetic fixed-input data.
//
// Run `node research/quota-pid-tuning-study.mjs --write` to regenerate the
// checked-in artifacts. Run it with `--check` to prove they are current.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  advance,
  assertProductionParity,
  BASE_KI,
  BASELINE,
  CANDIDATES,
  COLORS,
  csv,
  INTEGRAL_MAX_STEP_SECONDS,
  MAX_INTERVAL_SECONDS,
  matchedState,
  percentile,
} from "./lib/controller.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const GENERATED = join(HERE, "generated");

// time, error, stored integral, observed interval. The first row is a seed;
// the remaining 54 rows are the sanitized processed observations published in
// #291 comment 5571318662.
const TRACE = [
  ["06:05:47", -0.254, 1077731.0, 35928],
  ["06:15:46", -0.353, 1077625.0, 35915],
  ["06:25:47", -0.452, 1077489.3, 35902],
  ["06:35:47", -0.552, 1077323.8, 35887],
  ["06:45:46", -0.651, 1077128.6, 35872],
  ["06:55:46", -0.75, 1076903.6, 35856],
  ["07:05:46", -0.849, 1076648.8, 35838],
  ["07:15:46", -0.948, 1076364.3, 35820],
  ["07:25:46", -1.048, 1076050.0, 35800],
  ["07:35:47", -1.147, 1075706.0, 35780],
  ["07:45:46", -1.246, 1075332.2, 35759],
  ["07:55:46", -1.345, 1074928.6, 35736],
  ["08:05:47", -1.444, 1074495.3, 35713],
  ["08:15:47", -1.544, 1074032.2, 35689],
  ["08:22:57", -1.613, 1073548.2, 35664],
  ["08:25:47", -1.643, 1073268.8, 35643],
  ["08:31:52", -1.702, 1072758.1, 35621],
  ["08:35:46", -1.742, 1072351.1, 35599],
  ["08:41:53", -1.802, 1071810.7, 35577],
  ["08:45:47", -1.841, 1071379.7, 35556],
  ["08:51:52", -1.901, 1070809.5, 35533],
  ["08:55:46", -1.94, 1070353.9, 35511],
  ["09:00:12", -1.98, 1069827.6, 35489],
  ["09:06:55", -2.05, 1069212.7, 35465],
  ["09:16:56", -2.149, 1068568.1, 35439],
  ["09:26:55", -2.248, 1067893.7, 35411],
  ["09:36:59", -2.347, 1067189.5, 35381],
  ["09:43:55", -2.417, 1066464.5, 35350],
  ["09:47:34", -2.446, 1065927.9, 35322],
  ["09:51:55", -2.496, 1065275.4, 35294],
  ["09:57:38", -2.546, 1064511.7, 35265],
  ["10:01:29", -2.585, 1063913.9, 35237],
  ["10:07:10", -2.645, 1063120.5, 35208],
  ["10:15:51", -2.734, 1062300.2, 35176],
  ["10:21:16", -2.784, 1061465.1, 35144],
  ["10:26:39", -2.833, 1060615.1, 35111],
  ["10:31:57", -2.893, 1059747.3, 35078],
  ["10:35:37", -2.923, 1059103.7, 35047],
  ["10:43:17", -3.002, 1058203.1, 35013],
  ["10:45:35", -3.022, 1057784.7, 34984],
  ["10:50:16", -3.062, 1056923.7, 34954],
  ["10:55:36", -3.121, 1055987.4, 34922],
  ["11:01:58", -3.19, 1055030.3, 34887],
  ["11:05:12", -3.22, 1054407.4, 34856],
  ["11:11:24", -3.28, 1053423.5, 34822],
  ["11:15:41", -3.319, 1052569.7, 34788],
  ["11:25:14", -3.419, 1051544.1, 34751],
  ["11:34:51", -3.518, 1050488.7, 34712],
  ["11:35:39", -3.518, 1050320.4, 34681],
  ["11:40:00", -3.567, 1049389.8, 34649],
  ["11:45:14", -3.617, 1048304.6, 34614],
  ["11:55:20", -3.716, 1047189.8, 34575],
  ["12:04:29", -3.806, 1046048.1, 34534],
  ["12:08:41", -3.845, 1045077.7, 34494],
  ["12:10:13", -3.865, 1044723.1, 34461],
];

function secondsSinceMidnight(time) {
  const [hour, minute, second] = time.split(":").map(Number);
  return hour * 3_600 + minute * 60 + second;
}

function run(inputs, candidate, initial) {
  let state = { ...initial };
  let seconds = 0;
  return inputs.map((input) => {
    seconds += input.dtSeconds;
    state = advance(state, input, candidate);
    return {
      ...state,
      seconds,
      hours: seconds / 3_600,
      source: input.source,
      observed: input.observed ?? null,
    };
  });
}

function historicalInputs() {
  return TRACE.slice(1).map((row, index) => ({
    dtSeconds: secondsSinceMidnight(row[0]) - secondsSinceMidnight(TRACE[index][0]),
    error: row[1],
    observed: { integral: row[2], interval: row[3] },
    source: "sanitized-historical",
  }));
}

function historicalScenario(candidate) {
  const [time, error, integral, interval] = TRACE[0];
  void time;
  const seed = matchedState({ error, derivative: -0.0002, integral, interval }, candidate);
  return run(historicalInputs(), candidate, seed);
}

function repeat(error, steps, source, dtSeconds = 300) {
  return Array.from({ length: steps }, () => ({ dtSeconds, error, source }));
}

function recoveryScenario(candidate, history) {
  return run(repeat(-5, 24 * 12, "synthetic-recovery"), candidate, history.at(-1));
}

function overspendScenario(candidate) {
  return run(repeat(10, Math.round(3.8 * 24 * 12), "synthetic-overspend"), candidate, {
    error: 0,
    derivative: 0,
    integral: 0,
    interval: 0,
  });
}

function reversalScenario(candidate) {
  const pressure = run(repeat(10, 36 * 12, "synthetic-reversal-pressure"), candidate, {
    error: 0,
    derivative: 0,
    integral: 0,
    interval: 0,
  });
  return run(repeat(-5, 72 * 12, "synthetic-reversal"), candidate, pressure.at(-1));
}

function refillScenario(candidate) {
  const pressure = run(repeat(10, 24 * 12, "synthetic-refill-pressure"), candidate, {
    error: 0,
    derivative: 0,
    integral: 0,
    interval: 0,
  });
  const reset = [
    { dtSeconds: 300, error: 0, cycleChanged: true, source: "synthetic-refill-reset" },
  ];
  return run(
    [...reset, ...repeat(0, 24 * 12, "synthetic-refill-steady")],
    candidate,
    pressure.at(-1)
  );
}

function randomInputs() {
  const cadence = [48, 90, 234, 300, 367, 412, 600, 271, 1_200, 300, 14_400, 175, 421, 600];
  let seed = 0x291;
  return Array.from({ length: 224 }, (_, index) => {
    seed = (seed * 1_664_525 + 1_013_904_223) >>> 0;
    const noise = (seed / 2 ** 32 - 0.5) * 1.2;
    return {
      dtSeconds: cadence[index % cadence.length],
      error: 0.5 * Math.sin(index / 5) + noise,
      source: "synthetic-noisy-irregular",
    };
  });
}

function noisyScenario(candidate) {
  const initial = matchedState(
    { error: 0, derivative: 0, integral: 18_000 / BASE_KI, interval: 18_000 },
    candidate
  );
  return run(randomInputs(), candidate, initial);
}

function firstHourAtOrBelow(rows, limit) {
  const row = rows.find((item) => item.interval <= limit);
  return row ? row.hours : null;
}

function firstHourAtOrAbove(rows, limit) {
  const row = rows.find((item) => item.interval >= limit);
  return row ? row.hours : null;
}

function metricRow(candidate, history, recovery, overspend, reversal, refill, noisy) {
  const baselineDeltas = history.map((row) => ({
    integral: Math.abs(row.integral - row.observed.integral),
    interval: Math.abs(row.interval - row.observed.interval),
  }));
  const noiseSteps = noisy
    .slice(1)
    .map((row, index) => Math.abs(row.interval - noisy[index].interval));
  return {
    candidate: candidate.id,
    label: candidate.label,
    kp: candidate.kp,
    ti_seconds: candidate.ti,
    kd: candidate.kd,
    historical_final_interval_seconds: history.at(-1).interval,
    historical_max_integral_delta: Math.max(...baselineDeltas.map((item) => item.integral)),
    historical_max_interval_delta_seconds: Math.max(...baselineDeltas.map((item) => item.interval)),
    recovery_24h_interval_seconds: recovery.at(-1).interval,
    recovery_to_6h_hours: firstHourAtOrBelow(recovery, 21_600),
    overspend_3_8d_interval_seconds: overspend.at(-1).interval,
    overspend_to_90pct_cap_hours: firstHourAtOrAbove(overspend, 32_400),
    overspend_near_cap_hours: overspend.filter((row) => row.interval >= 32_400).length / 12,
    reversal_to_6h_hours: firstHourAtOrBelow(reversal, 21_600),
    refill_first_interval_seconds: refill[0].interval,
    refill_to_6h_hours: firstHourAtOrBelow(refill, 21_600),
    noisy_p95_step_seconds: percentile(noiseSteps, 0.95),
    noisy_max_step_seconds: Math.max(...noiseSteps),
    noisy_max_integral_step_seconds: Math.max(...noisy.map((row) => row.integralDtSeconds)),
  };
}

function svgLine(rows, box, color) {
  if (rows.length === 0) return "";
  const maxHours = Math.max(1, rows.at(-1).hours);
  const points = rows
    .map((row) => {
      const x = box.x + (row.hours / maxHours) * box.width;
      const y =
        box.y +
        box.height -
        (Math.min(MAX_INTERVAL_SECONDS, row.interval) / MAX_INTERVAL_SECONDS) * box.height;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return `<polyline fill="none" stroke="${color}" stroke-width="1.5" points="${points}" />`;
}

function panel(title, source, box, observed = null) {
  const lines = CANDIDATES.map((candidate, index) =>
    svgLine(source.get(candidate.id), box, COLORS[index])
  ).join("");
  const grid = [0, 9_000, 18_000, 27_000, 36_000]
    .map((value) => {
      const y = box.y + box.height - (value / MAX_INTERVAL_SECONDS) * box.height;
      return `<line x1="${box.x}" y1="${y}" x2="${box.x + box.width}" y2="${y}" stroke="#d1d5db" stroke-width="1" /><text x="${box.x - 4}" y="${y + 3}" text-anchor="end" class="axis">${value / 1000}k</text>`;
    })
    .join("");
  const observedPoints = observed
    ? observed
        .map((row) => {
          const x = box.x + (row.hours / Math.max(1, observed.at(-1).hours)) * box.width;
          const y =
            box.y + box.height - (row.observed.interval / MAX_INTERVAL_SECONDS) * box.height;
          return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="1.8" fill="#6b7280" />`;
        })
        .join("")
    : "";
  const hours = source.get(BASELINE.id).at(-1).hours;
  return `<g><text x="${box.x}" y="${box.y - 22}" class="title">${title}</text><text x="${box.x}" y="${box.y - 7}" class="note">${hours.toFixed(1)} h · all colored lines are fixed-input counterfactuals</text>${grid}<rect x="${box.x}" y="${box.y}" width="${box.width}" height="${box.height}" class="frame" />${lines}${observedPoints}<text x="${box.x + box.width / 2}" y="${box.y + box.height + 18}" text-anchor="middle" class="axis">hours</text></g>`;
}

function charts(scenarios) {
  const boxes = [
    { x: 75, y: 130, width: 250, height: 220 },
    { x: 405, y: 130, width: 250, height: 220 },
    { x: 735, y: 130, width: 250, height: 220 },
    { x: 75, y: 475, width: 250, height: 220 },
    { x: 405, y: 475, width: 250, height: 220 },
    { x: 735, y: 475, width: 250, height: 220 },
  ];
  const legend = CANDIDATES.map((candidate, index) => {
    const x = 24 + index * 123;
    return `<line x1="${x}" y1="75" x2="${x + 16}" y2="75" stroke="${COLORS[index]}" stroke-width="3" /><text x="${x + 21}" y="79" class="legend">${candidate.label}</text>`;
  }).join("");
  const history = scenarios.historical;
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1060" height="755" viewBox="0 0 1060 755">
  <style>
    text { font-family: ui-sans-serif, system-ui, sans-serif; fill: #1f2937; }
    .heading { font-size: 20px; font-weight: 700; } .subtitle { font-size: 11px; fill: #4b5563; }
    .title { font-size: 13px; font-weight: 700; } .note, .axis, .legend { font-size: 9px; fill: #4b5563; }
    .frame { fill: #fff; stroke: #9ca3af; stroke-width: 1; }
  </style>
  <rect width="1060" height="755" fill="#f9fafb" />
  <text x="24" y="29" class="heading">#291 PID tuning study — interval response (seconds)</text>
  <text x="24" y="48" class="subtitle">Historical panel: gray dots are supplied sanitized observations; every other panel is deterministic synthetic input. The controller code is unchanged.</text>
  ${legend}
  ${panel("Historical trace", history, boxes[0], history.get(BASELINE.id))}
  ${panel("Historical continuation: −5 error", scenarios.recovery, boxes[1])}
  ${panel("Sustained +10 overspend", scenarios.overspend, boxes[2])}
  ${panel("Reversal after 36 h at +10", scenarios.reversal, boxes[3])}
  ${panel("Refill/reset after 24 h at +10", scenarios.refill, boxes[4])}
  ${panel("Noisy, irregular cadence (includes 4 h gaps)", scenarios.noisy, boxes[5])}
  <text x="24" y="736" class="subtitle">Y-axis: 0–36,000 seconds. Candidate states are contribution-matched at scenario entry (Ki·I preserved); no chart represents a production migration or exhaustion forecast.</text>
</svg>
`;
}

function value(value, digits = 1) {
  return value == null ? "not reached" : Number(value).toFixed(digits);
}

function report(metrics) {
  const rows = metrics
    .map(
      (row) =>
        `| ${row.label} | ${value(row.historical_final_interval_seconds)} | ${value(row.recovery_24h_interval_seconds)} | ${value(row.overspend_3_8d_interval_seconds)} | ${value(row.overspend_near_cap_hours)} | ${value(row.reversal_to_6h_hours)} | ${value(row.noisy_p95_step_seconds)} |`
    )
    .join("\n");
  const baseline = metrics[0];
  return (
    `# #291 PID tuning study\n\n` +
    `Generated by \`node research/quota-pid-tuning-study.mjs --write\`. Do not edit this report by hand.\n\n` +
    `## Source separation\n\n` +
    `- **Historical input:** the 55-row sanitized, irregular-cadence controller trace published in [issue #291 comment 5571318662](https://github.com/MEK-Org/rusa/issues/291#issuecomment-5571318662). Its first row seeds the replay; its other 54 rows validate the current weights.\n` +
    `- **Synthetic input:** every continuation, sustained-overspend, reversal, refill/reset, and noisy/irregular-cadence row is generated locally by this script. These fixed errors are controller probes, not quota, admission, traffic, or exhaustion forecasts.\n\n` +
    `## Model and fairness rule\n\n` +
    `The update mirrors \`packages/rusa/src/quota/shared-store.ts\` on the study branch: conditional integration, 300-second maximum integral step, 1,800-second derivative filter, 0.25 output smoothing, ±900-second slew, and the deliberate 36,000-second cap. Only the in-memory model is parameterized.\n\n` +
    `For every counterfactual, the entry state is **contribution matched**: \`Ki × I\` is held equal to the current controller before the candidate begins. This avoids presenting a changed interpretation of persisted integral state as faster dynamics. It is an analysis convention, not a migration proposal.\n\n` +
    `## Scenario protocol\n\n` +
    `- **Historical trace:** replay the published irregular timestamps and errors from the supplied seed. Only current weights are scored for reproduction; other lines are labeled counterfactuals.\n` +
    `- **Recovery continuation:** append a fixed −5 error every five minutes for 24 hours after each candidate's historical terminal state.\n` +
    `- **Sustained overspend:** start cold and apply +10 every five minutes for 3.8 days.\n` +
    `- **Reversal:** start cold, apply +10 for 36 hours, then −5 every five minutes for 72 hours.\n` +
    `- **Refill/reset:** start cold, apply +10 for 24 hours, then process a zero-error cycle boundary followed by zero error for 24 hours. This explicitly exercises reset memory semantics while retaining the existing actuator smoothing and slew behavior.\n` +
    `- **Noisy/irregular cadence:** begin at a contribution-matched 18,000-second command, apply a deterministic seeded sine-plus-noise error sequence at 48-second through four-hour gaps, and report output-step jitter. The model preserves the production 300-second integration cap through each gap.\n\n` +
    `## Candidates and metrics\n\n` +
    `The six one-axis candidates bracket proportional, integral-time, and derivative changes around current \`Kp=120, Ti=3600s, Kd=1800\`; the final candidate combines the proposed weaker integral and stronger derivative. Each metric is reported rather than collapsed into a score: recovery favors a lower interval, sustained overspend favors more near-cap time, reversal favors earlier return below six hours, and noisy cadence favors smaller output steps. A candidate must preserve the cap and the 300-second integration bound before it is considered.\n\n` +
    `| candidate | historical end (s) | recovery after 24h (s) | +10 after 3.8d (s) | +10 near-cap (h) | reversal to ≤6h (h) | noisy p95 step (s) |\n` +
    `| --- | ---: | ---: | ---: | ---: | ---: | ---: |\n${rows}\n\n` +
    `The current-weight replay stays within ${value(baseline.historical_max_integral_delta, 1)} integral units and ${value(baseline.historical_max_interval_delta_seconds, 1)} seconds of the supplied later rows, matching the published rounding tolerance. Every candidate stays at or below 36,000 seconds, and the noisy/irregular trace records a maximum integrated step of at most ${value(Math.max(...metrics.map((row) => row.noisy_max_integral_step_seconds)), 0)} seconds.\n\n` +
    `## Bounded recommendation\n\n` +
    `Do **not** select new production PID weights from these probes. The historical trace validates only the current controller; the other scenarios deliberately hold errors fixed and cannot model the traffic/quota feedback that determines exhaustion. In particular, a weaker integral with a raw persisted integral would create an immediate protection reduction, which this contribution-matched study intentionally excludes.\n\n` +
    `The evidence is sufficient to rule out treating stronger derivative alone as a recovery fix and to show the explicit pacing/recovery tradeoff of the other candidates, but not to authorize a tuning change. Retain current weights, cap, conditional integration, and reset behavior until an operator supplies closed-loop safety targets (minimum sustained-overspend pacing, recovery target, and allowed noise/jitter) plus representative traces.\n\n` +
    `## Artifacts\n\n` +
    `- [metrics CSV](quota-pid-tuning-summary.csv) contains the table inputs.\n` +
    `- [SVG chart](quota-pid-tuning-charts.svg) is a dependency-free rendering of the six scenarios.\n`
  );
}

function validateStudy(scenarios, metrics) {
  const baseline = metrics.find((row) => row.candidate === BASELINE.id);
  if (!baseline) throw new Error("current controller result is missing");
  if (
    baseline.historical_max_integral_delta > 6 ||
    baseline.historical_max_interval_delta_seconds > 1
  ) {
    throw new Error("current controller no longer reproduces the sanitized trace within tolerance");
  }
  for (const [scenario, candidateMap] of Object.entries(scenarios)) {
    for (const [candidate, rows] of candidateMap) {
      for (const row of rows) {
        if (
          !Number.isFinite(row.interval) ||
          row.interval < 0 ||
          row.interval > MAX_INTERVAL_SECONDS
        ) {
          throw new Error(`${scenario}/${candidate} violates the actuator bounds`);
        }
        if (row.integralDtSeconds > INTEGRAL_MAX_STEP_SECONDS) {
          throw new Error(`${scenario}/${candidate} integrates an unobserved gap too far`);
        }
      }
    }
  }
  for (const candidate of CANDIDATES) {
    const reset = scenarios.refill.get(candidate.id)[0];
    if (!reset.cycleChanged || reset.integral !== 0 || reset.derivative !== 0) {
      throw new Error(`refill/reset semantics diverged for ${candidate.id}`);
    }
  }
}

function buildStudy() {
  assertProductionParity(
    readFileSync(join(HERE, "../packages/rusa/src/quota/shared-store.ts"), "utf8")
  );
  const scenarios = {
    historical: new Map(),
    recovery: new Map(),
    overspend: new Map(),
    reversal: new Map(),
    refill: new Map(),
    noisy: new Map(),
  };
  const metrics = [];
  for (const candidate of CANDIDATES) {
    const history = historicalScenario(candidate);
    const recovery = recoveryScenario(candidate, history);
    const overspend = overspendScenario(candidate);
    const reversal = reversalScenario(candidate);
    const refill = refillScenario(candidate);
    const noisy = noisyScenario(candidate);
    scenarios.historical.set(candidate.id, history);
    scenarios.recovery.set(candidate.id, recovery);
    scenarios.overspend.set(candidate.id, overspend);
    scenarios.reversal.set(candidate.id, reversal);
    scenarios.refill.set(candidate.id, refill);
    scenarios.noisy.set(candidate.id, noisy);
    metrics.push(metricRow(candidate, history, recovery, overspend, reversal, refill, noisy));
  }
  validateStudy(scenarios, metrics);
  return new Map([
    [join(GENERATED, "quota-pid-tuning-summary.csv"), csv(metrics)],
    [join(GENERATED, "quota-pid-tuning-charts.svg"), charts(scenarios)],
    [join(GENERATED, "quota-pid-tuning-report.md"), report(metrics)],
  ]);
}

function main() {
  const args = process.argv.slice(2);
  const mode = args.includes("--check") ? "check" : "write";
  if (args.some((argument) => !["--check", "--write"].includes(argument))) {
    throw new Error("usage: node research/quota-pid-tuning-study.mjs [--write|--check]");
  }
  const artifacts = buildStudy();
  if (mode === "check") {
    for (const [path, content] of artifacts) {
      if (readFileSync(path, "utf8") !== content)
        throw new Error(`stale generated artifact: ${path}`);
    }
    console.log(`verified ${artifacts.size} deterministic #291 study artifacts`);
    return;
  }
  mkdirSync(GENERATED, { recursive: true });
  for (const [path, content] of artifacts) writeFileSync(path, content);
  console.log(`wrote ${artifacts.size} deterministic #291 study artifacts`);
}

main();
