# Quota PID tuning study

This directory holds an analysis-only, deterministic study for #291. It does not import production quota data and does not alter the quota controller.

Run the study from the repository root:

```sh
node research/quota-pid-tuning-study.mjs --write
node research/quota-pid-tuning-study.mjs --check
```

The checked-in artifacts live in `research/generated/`:

- `quota-pid-tuning-traces.csv` — every plotted sample, including a `source` field that separates the sanitized historical trace from synthetic inputs.
- `quota-pid-tuning-summary.csv` — metric inputs for candidate comparison.
- `quota-pid-tuning-charts.svg` — dependency-free six-panel convergence chart.
- `quota-pid-tuning-report.md` — method, tradeoffs, limits, and bounded recommendation.

The historical fixture is the 55-observation sanitized trace from [#291 comment 5571318662](https://github.com/MEK-Org/rusa/issues/291#issuecomment-5571318662). Synthetic scenarios are deterministic fixed-input probes for recovery, sustained overspend, reversal, refill/reset, and noisy or irregular cadence. They are not closed-loop forecasts of usage, traffic, quota exhaustion, or safe production PID values.

Candidates begin from contribution-matched state (`Ki × I` equal to current) so a change in `Kp` or `Ti` is not mistaken for a one-time reinterpretation of persisted integral state. That comparison rule is analysis-only; it proposes neither a database migration nor production weights.
