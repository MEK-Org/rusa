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
study.

## Fixed-input artifacts

- `quota-pid-tuning-traces.csv` — every plotted sample, including a `source` field that separates the sanitized historical trace from synthetic inputs.
- `quota-pid-tuning-summary.csv` — metric inputs for candidate comparison.
- `quota-pid-tuning-charts.svg` — dependency-free six-panel convergence chart.
- `quota-pid-tuning-report.md` — method, tradeoffs, limits, and bounded recommendation.

The historical fixture is the 55-observation sanitized trace from [#291 comment 5571318662](https://github.com/MEK-Org/rusa/issues/291#issuecomment-5571318662). Synthetic scenarios are deterministic fixed-input probes for recovery, sustained overspend, reversal, refill/reset, and noisy or irregular cadence. They are not closed-loop forecasts of usage, traffic, quota exhaustion, or safe production PID values.

Candidates begin from contribution-matched state (`Ki × I` equal to current) so a change in `Kp` or `Ti` is not mistaken for a one-time reinterpretation of persisted integral state. That comparison rule is analysis-only; it proposes neither a database migration nor production weights.

## Closed-loop artifacts

- `quota-closed-loop-traces.csv` — every simulated observation for every candidate and scenario.
- `quota-closed-loop-summary.csv` — per-candidate, per-scenario metrics.
- `quota-closed-loop-robustness.csv` — every scenario re-run across 8 demand seeds.
- `quota-closed-loop-baseline-charts.svg` — the current controller's quota, commanded vs applied wait, and backlog per scenario.
- `quota-closed-loop-candidate-charts.svg` — one parameter axis per row on the burst scenario.
- `quota-closed-loop-tradeoffs.svg` — safety and throughput per candidate and scenario.
- `quota-closed-loop-report.md` — method, findings, assumptions, limits, and recommendation.

### What the closed-loop model does and does not model

The v1 plant models run arrivals split into responsive and external work, a
daytime activity curve, admission through the pacing interval, a fixed quota cost
per completed run, and the resulting quota observations fed back into the
controller. Throttling is applied the way `ProviderPacer` applies it: responsive
runs bypass the interval wait but still charge the interval clock, and a changed
interval re-bases the pending wait on the last actual start.

Demand is generated from a seeded arrival process before the controller runs, so
every candidate faces byte-identical demand; only the controller's response to it
differs. The robustness sweep repeats each scenario across 8 seeds, which shows
whether an ordering survives resampled demand — it cannot show that the demand
*shape* is right, because that shape is a plausible guess and not a measurement.

Per-run quota cost, run duration, arrival rates, and the responsive/external split
are uncalibrated. Absolute run counts and hours therefore carry no operational
meaning; only comparisons between candidates on identical demand do. Failures,
retries, cancellations, multi-bucket interaction, and the five-hour window are out
of scope for v1. The report states the full list of assumptions and limits.
