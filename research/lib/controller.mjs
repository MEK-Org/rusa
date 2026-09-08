// Shared, analysis-only model of the #291 quota controller.
//
// Both research scripts import this module so the controller equations exist
// exactly once. It mirrors the public update in
// `packages/rusa/src/quota/shared-store.ts` and is parameterized only so a
// study can compare candidate weights. Nothing here runs in production.

export const MAX_INTERVAL_SECONDS = 36_000;
export const INTEGRAL_MAX_STEP_SECONDS = 300;
export const DERIVATIVE_TAU_SECONDS = 1_800;
export const ACTUATOR_SMOOTHING = 0.25;
export const MAX_SLEW_SECONDS = 900;
export const REFILL_EPSILON_POINTS = 2;

// This is the public staging revision whose controller source was read while
// preparing this study. The scripts also run the marker check below against the
// checkout's source, so a changed equation or constant fails regeneration.
export const PRODUCTION_CONTROLLER_REVISION = "04a8b99228a5d6baa2992d3d0776fa75b060021a";

export const BASELINE = {
  id: "current",
  label: "current (120 / 1h / 1800)",
  kp: 120,
  ti: 3_600,
  kd: 1_800,
};

// One-axis perturbations make the attribution legible; the final row is the
// stronger-derivative / weaker-integral combination raised for comparison.
export const CANDIDATES = [
  BASELINE,
  { id: "kp-80", label: "Kp 80", kp: 80, ti: 3_600, kd: 1_800 },
  { id: "kp-160", label: "Kp 160", kp: 160, ti: 3_600, kd: 1_800 },
  { id: "ti-2h", label: "Ti 2h", kp: 120, ti: 7_200, kd: 1_800 },
  { id: "ti-half-hour", label: "Ti 0.5h", kp: 120, ti: 1_800, kd: 1_800 },
  { id: "kd-900", label: "Kd 900", kp: 120, ti: 3_600, kd: 900 },
  { id: "kd-3600", label: "Kd 3600", kp: 120, ti: 3_600, kd: 3_600 },
  { id: "weaker-i-stronger-d", label: "Ti 2h + Kd 3600", kp: 120, ti: 7_200, kd: 3_600 },
];

export const COLORS = [
  "#111827",
  "#2563eb",
  "#dc2626",
  "#7c3aed",
  "#d97706",
  "#0891b2",
  "#16a34a",
  "#be185d",
];

export function parameters(candidate) {
  return { ...candidate, ki: candidate.kp / candidate.ti };
}

export const BASE_KI = parameters(BASELINE).ki;

/**
 * Keep the handwritten, dependency-free study mirror honest about the source
 * it models. Importing the production store would pull database/runtime
 * dependencies into a deterministic research script, so this compact parity
 * check intentionally pins its constants and update-rule markers instead.
 */
export function assertProductionParity(source) {
  const required = [
    "export const QUOTA_KP_SECONDS_PER_POINT = 120;",
    "export const QUOTA_KD_SECONDS_SQUARED_PER_POINT = 1800;",
    "export const QUOTA_INTEGRAL_TIME_SECONDS = 3600;",
    "export const QUOTA_DERIVATIVE_TAU_SECONDS = 1800;",
    "export const QUOTA_ACTUATOR_SMOOTHING = 0.25;",
    "export const QUOTA_MAX_SLEW_SECONDS = 900;",
    "export const QUOTA_REFILL_EPSILON_POINTS = 2;",
    "const cycleChanged = resetMoved || quotaRefilled;",
    "Math.min(dtSeconds, QUOTA_INTEGRAL_MAX_STEP_SECONDS)",
    "Math.min(candidateIntegral, Math.max(previousIntegral, upperBound))",
    "Math.max(candidateIntegral, Math.min(previousIntegral, lowerBound))",
    "previousInterval + QUOTA_ACTUATOR_SMOOTHING * (uncappedCandidate - previousInterval)",
    "previousInterval + QUOTA_MAX_SLEW_SECONDS",
  ];
  const missing = required.filter((fragment) => !source.includes(fragment));
  if (missing.length > 0) {
    throw new Error(
      `production controller parity changed since ${PRODUCTION_CONTROLLER_REVISION}: ${missing.join("; ")}`
    );
  }
}

/** Exact fixed-weight update from shared-store.ts, parameterized only for study. */
export function advance(previous, input, candidate) {
  const { kp, ki, kd } = parameters(candidate);
  const dtSeconds = Math.max(0, input.dtSeconds);
  const cycleChanged = input.cycleChanged ?? false;
  const derivativeAlpha = dtSeconds > 0 ? dtSeconds / (DERIVATIVE_TAU_SECONDS + dtSeconds) : 1;
  const previousDerivative = cycleChanged ? 0 : previous.derivative;
  const rawDerivative =
    !cycleChanged && dtSeconds > 0 ? (input.error - previous.error) / dtSeconds : 0;
  const derivative = previousDerivative + derivativeAlpha * (rawDerivative - previousDerivative);
  const integralDtSeconds = cycleChanged ? 0 : Math.min(dtSeconds, INTEGRAL_MAX_STEP_SECONDS);
  const previousIntegral = cycleChanged ? 0 : previous.integral;
  const candidateIntegral = previousIntegral + input.error * integralDtSeconds;
  const rawWithoutIntegral = kp * input.error + kd * derivative;
  const rawInterval = (integral) => rawWithoutIntegral + ki * integral;
  const candidateRaw = rawInterval(candidateIntegral);
  let integral = candidateIntegral;
  if (input.error > 0 && candidateRaw > MAX_INTERVAL_SECONDS) {
    const upperBound = (MAX_INTERVAL_SECONDS - rawWithoutIntegral) / ki;
    integral = Math.min(candidateIntegral, Math.max(previousIntegral, upperBound));
  } else if (input.error < 0 && candidateRaw < 0) {
    const lowerBound = -rawWithoutIntegral / ki;
    integral = Math.max(candidateIntegral, Math.min(previousIntegral, lowerBound));
  }
  const target = Math.max(0, rawInterval(integral));
  const smoothed = previous.interval + ACTUATOR_SMOOTHING * (target - previous.interval);
  const uncappedInterval = Math.max(
    0,
    Math.min(
      previous.interval + MAX_SLEW_SECONDS,
      Math.max(previous.interval - MAX_SLEW_SECONDS, smoothed)
    )
  );
  return {
    error: input.error,
    derivative,
    integral,
    interval: Math.min(MAX_INTERVAL_SECONDS, uncappedInterval),
    uncappedInterval,
    integralDtSeconds,
    cycleChanged,
  };
}

/**
 * Preserve Ki*I when a candidate takes over a state produced under different
 * weights. Otherwise changing Kp or Ti silently changes the active command
 * merely by reinterpreting stored integral state.
 */
export function matchedState(state, candidate) {
  return { ...state, integral: state.integral * (BASE_KI / parameters(candidate).ki) };
}

export function round(value) {
  return typeof value === "number" ? Number(value.toFixed(6)) : value;
}

export function csvEscape(value) {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function csv(rows) {
  const headers = Object.keys(rows[0]);
  return `${headers.join(",")}\n${rows.map((row) => headers.map((header) => csvEscape(round(row[header]))).join(",")).join("\n")}\n`;
}

export function percentile(values, p) {
  if (values.length === 0) return 0;
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.min(ordered.length - 1, Math.floor((ordered.length - 1) * p))];
}

/** Deterministic 32-bit LCG so every scenario is reproducible from its seed. */
export function makeRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 2 ** 32;
  };
}
