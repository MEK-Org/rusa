# Quota PID tuning study

This directory holds analysis-only, deterministic studies for #291. Nothing here
imports production quota data, and nothing here alters the quota controller: both
studies read the production weights and update rule and re-implement them for
simulation only.

There are two studies, and they answer different questions.

| Study | Question | Inputs |
| --- | --- | --- |
| Fixed-input (`quota-pid-tuning-study.mjs`) | Given this exact error sequence, what does each candidate command? | A sanitized historical trace plus fixed synthetic probes |
| Closed-loop (`quota-closed-loop-study.mjs`) | When the command changes quota consumption, where does the loop settle? | Simulated run arrivals and quota spend |

The fixed-input study is a calibration and baseline: it replays a fixed error
sequence, so the controller cannot influence its own input. That makes it precise
about the update rule and silent about stability. The closed-loop study exists
because the controller does affect the quota consumption rate, so candidates must
be compared against demand they are allowed to change.

The public workflow context is [#291 comment 5583079033](https://github.com/MEK-Org/rusa/issues/291#issuecomment-5583079033): the follow-up is evidence-first and analysis-only, with deterministic simulations explicitly labeled as such. It is not telemetry or authorization to select weights. The historical input remains the separately published sanitized trace below.

That public context specifies the analysis boundary, not the plant constants. The
budget, completion lag, capacity, arrival mix, and daytime/burst shapes are all
modeler assumptions, explicitly varied or limited where the artifacts say so.

Run either study from the repository root. `--write` regenerates the checked-in
artifacts, `--check` fails if regeneration would change them:

```sh
node research/quota-pid-tuning-study.mjs --write
node research/quota-pid-tuning-study.mjs --check

node research/quota-closed-loop-study.mjs --write
node research/quota-closed-loop-study.mjs --check
```

`research/lib/controller.mjs` holds the single copy of the simulated controller
and the candidate list that both studies import, so the two cannot drift apart.
`research/lib/closed-loop.mjs` holds the plant model used only by the closed-loop
study. The scripts also assert the mirrored controller constants and update-rule
markers against the checkout's production source; the recorded staging revision is
`04a8b99228a5d6baa2992d3d0776fa75b060021a`.

## Fixed-input artifacts

- `quota-pid-tuning-summary.csv` — metric inputs for candidate comparison.
- `quota-pid-tuning-charts.svg` — dependency-free six-panel convergence chart.
- `quota-pid-tuning-report.md` — method, tradeoffs, limits, and bounded recommendation.

The historical fixture is the 55-observation sanitized trace from [#291 comment 5571318662](https://github.com/MEK-Org/rusa/issues/291#issuecomment-5571318662). Synthetic scenarios are deterministic fixed-input probes for recovery, sustained overspend, reversal, refill/reset, and noisy or irregular cadence. They are not closed-loop forecasts of usage, traffic, quota exhaustion, or safe production PID values.

`matchedState` is used only by the fixed-input study, at its historical and synthetic scenario handoffs; the closed-loop study starts every candidate from the same fresh in-memory controller state and never rescales one. It preserves `Ki × I` for a counterfactual comparison so a changed interpretation of persisted integral state is not mistaken for faster dynamics. It is deliberately not a deployment model, database migration, or production-weight proposal.

## Closed-loop artifacts

- `quota-closed-loop-summary.csv` — per-candidate, per-scenario metrics.
- `quota-closed-loop-robustness.csv` — every scenario re-run across 8 demand seeds.
- `quota-closed-loop-thresholds.csv` — recovery rankings at 1×, 1.5×, 2×, and 2.5× ideal spacing.
- `quota-closed-loop-plant-sensitivity.csv` — burst-demand variants over 30/240/600-second completion lags, concurrency capacity, observation cadence, and cost variance.
- `quota-closed-loop-baseline-charts.svg` — the current controller's quota, commanded vs applied wait, and backlog per scenario.
- `quota-closed-loop-candidate-charts.svg` — one parameter axis per row on the burst scenario.
- `quota-closed-loop-tradeoffs.svg` — safety and throughput per candidate and scenario.
- `quota-closed-loop-report.md` — method, evidence accounting, findings, assumptions, limits, and recommendation.

### High-fidelity simulator calibration and evidence accounting

The closed-loop simulation accounts for the eight elements identified in #291:

1. **Applied throttling (Calibrated):** Faithful implementation of `ProviderPacer`'s two-stage staging pipeline (`packages/rusa/src/actor/provider-pacer.ts`). External runs stage behind the interval clock, then wait for `ConcurrencyLimiter` slots. Selection-time revalidation returns staged requests to the queue if the interval increases or responsive runs start. Interval lengthening rebases pending wait on `lastStartedAt`.
2. **Observation cadence (Calibrated):** Calibrated to the production 300 s slot cadence (`SLOT_MS = 5 * 60 * 1000` in `packages/rusa/src/quota/shared-store.ts`). This resolves the integral step-bound truncation in earlier 600 s models where `QUOTA_INTEGRAL_MAX_STEP_SECONDS = 300` clipped half the accumulated error.
3. **Execution duration and concurrency (Calibrated baseline + Sensitivity):** 240 s duration and 4 concurrent slots (matching default mesh configuration), varied across 30 s/240 s/600 s and 1/4 slots.
4. **Quota reset behavior (Calibrated):** Exact match with `shared-store.ts` cycle rollover at 7 days, 100% refill, integral/derivative zeroing, and post-reset slew/smoothing.
5. **Responsive and external demand (Calibrated gating, uncalibrated split):** Responsive runs bypass pacing and mesh concurrency while updating the interval clock. Demand split is an explicit assumption.
6. **Quota usage (Calibrated baseline + Sensitivity):** Fixed 0.050 points per run baseline (2,000 runs/week budget), with deterministic bimodal variance sensitivity (1.8× and 0.6×). Per-token usage telemetry is unobserved in public data.
7. **Model-run arrivals (Uncalibrated assumption):** Deterministic thinned-Poisson draws (no public arrival telemetry).
8. **Daytime activity (Uncalibrated assumption):** Raised half-sine across a 14-hour day over a 0.15 night floor (synthetic profile).

The scripts intentionally do not check in sample-by-sample CSV dumps. The compact
summary tables, report, and charts are sufficient to inspect the reported
metrics, while the deterministic scripts remain the reproducible recipe for every
plotted sample.

Absolute run counts and hours carry no operational meaning; only comparisons
between candidates on identical demand do. Failures, retries, cancellations,
multi-bucket interaction, and the five-hour window remain out of scope.
