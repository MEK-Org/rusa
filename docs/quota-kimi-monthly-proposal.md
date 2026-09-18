# Locally tracked Kimi monthly quota period — design proposal

Design-only proposal for #543. It describes the design for tracking a Kimi monthly quota
period locally from observed token usage in the rusa quota coordinator and exposing it
as an additional quota period for pacing, model-class selection, and dashboard
observability. Nothing here is implemented. No runtime code changes or schema migrations
are made with this document; the proposed future implementation includes the isolated
accounting ledger described in §4.2.

Every source citation below is against `origin/staging` at `106a432`. Paths are
repository-relative; line numbers are that commit's.

---

## 1. What this proposal is, in one paragraph

**A synthetic, locally tracked monthly quota window.** Kimi enforces a monthly usage
ceiling on its service, but its CLI `/usage` display (`packages/rusa/src/providers/kimi-usage-scrape.ts`)
reports only short-window buckets (`5h limit` and `Weekly limit`), omitting monthly
usage and remaining quota entirely. An observed monthly-exhaustion response showed that
short-window headroom alone cannot prevent a monthly lockout. This proposal defines a
locally derived `kimi:monthly` window, anchored to an operator-configured instant and
timezone, accumulated from per-run token usage records
(`packages/rusa/src/providers/token-accounting.ts`), and reasoned about by a sibling of
the existing closed-loop PID controller (`shared-store.ts:426-608`). The derived window is
combined with, but is not inserted into, native scrape observations. It provides smooth
backpressure, early diversion of model-class pools
(`packages/rusa/src/actor/provider-pacer.ts:391-419`), and honest dashboard visibility
before a hard provider lockout occurs.

---

## 2. Background and problem statement

### 2.1 The provider visibility gap

The rusa quota coordinator probes and scrapes provider status panels via interactive
PTY sessions (`packages/rusa/src/mcp/quota-mcp.ts:1323-1372`). For Claude, Codex, and AGY,
provider status panels surface remaining quota percentages and reset deadlines for all
enforced windows. Kimi Code (`packages/rusa/src/providers/kimi-usage-scrape.ts`), however,
renders a text-mode `/usage` panel that exposes only two windows:

```text
Kimi Code Platform Usage

5h limit       [██████████████░░░░░░] 72% left (resets 3h 10m)
Weekly limit   [██████████░░░░░░░░░░] 50% left (resets 2 days, 22 hours)

This display is separate from Open Platform API quotas.
```

See fixture `packages/rusa/src/mcp/fixtures/kimi-usage-expected.txt`. The provider panel
provides no monthly usage figure, no monthly token ceiling, and no billing cycle indicator.

### 2.2 Observed monthly exhaustion

An observed provider response classified as a monthly-exhaustion response supplied the
single initial calibration point. The public design deliberately omits account-specific
timestamps, usage totals, and provider-account details; those are not needed to specify
the mechanism.

Because the quota coordinator had visibility only into Kimi's `five_hour` and `weekly`
buckets (`packages/rusa/src/quota/shared-store.ts:644-729`), the closed-loop controller
reported healthy headroom on both short windows. Pacing did not slow down launches, and
multi-provider candidate selection in `selectPoolLane` (`packages/rusa/src/actor/provider-pacer.ts:391`)
continued directing traffic to Kimi until a monthly lockout was encountered.

### 2.3 Proposed architecture

Because the provider does not publish monthly telemetry, rusa must track monthly usage
locally. The proposed architecture consists of four cooperating mechanisms:

1. **Configured period definition**: An operator-configured anchor instant and IANA
   timezone in `config.yaml` defining the monthly cycle boundary, evaluated using civil
   calendar arithmetic across daylight-saving transitions and varying month lengths.
2. **Local token accumulation**: Ingesting immutable source records from
   `run_token_records` (`packages/rusa/src/db/migrations/0010_run_token_records.ts`) into
   a dedicated shared accounting ledger, preserving input, output, and cache-read splits
   with cross-instance deduplication.
3. **Limit estimation and confidence rating**: Estimating the monthly token ceiling from
   exhaustion events, expressed with an explicit confidence level and safety margin to
   prevent over-trusting a single data point.
4. **Coordinator integration**: Keeping native scrape freshness in `calculateFreshness`,
   then combining a separately derived monthly result with `getProviderThrottle`,
   `ProviderPacer`, `selectPoolLane`, and the dashboard API as an estimated window.

---

## 3. Period definition and calendar mechanics

### 3.1 The configured anchor

The monthly reset schedule is treated as a **hypothesis to be validated, not a known
fact**. The reset period is not hardcoded. Instead, it is configured in `config.yaml` under
the quota provider configuration:

```yaml
quota:
  providers:
    kimi:
      monthlyAnchor:
        instant: "<configured-anchor-instant>"
        timezone: "<configured-anchor-timezone>"
```

The configuration requires two values:
- `instant`: A reference instant representing the configured anchor instant (ISO-8601).
- `timezone`: An IANA timezone identifier defining the civil clock against which the
  provider's billing cycle is presumed to operate.

If `monthlyAnchor` is omitted, synthetic monthly tracking remains disabled and Kimi
operates with standard 5h and weekly scraping only.

### 3.2 Handling daylight-saving transitions and month lengths

A calendar month is not a fixed millisecond interval. Depending on the month and leap
years, month durations vary between 28 days (2,419,200 s) and 31 days (2,678,400 s).
Furthermore, transitions between Standard Time and Daylight Saving Time (e.g. EST to EDT)
shift the UTC offset by ±1 hour.

#### 3.2.1 Civil calendar advancement
Period boundary evaluation must be performed in the configured civil timezone, not by
adding a fixed duration (such as `30 * 86400s` or `720h`) to a UTC timestamp.

Given the configured anchor instant $A$ with civil components $(Y_A, M_A, D_A, H_A, Min_A)$
in timezone $Z$:
1. For any current evaluation instant $t$, convert $t$ to its civil components in timezone $Z$.
2. Determine the active cycle index $k \in \mathbb{Z}$ such that the cycle start $T_{\text{start}}$
   and cycle end $T_{\text{reset}}$ satisfy $T_{\text{start}} \le t < T_{\text{reset}}$.
3. Candidate cycle start is computed by setting year and month in timezone $Z$ to
   $(Y_k, M_k)$ while preserving $(D_A, H_A, Min_A)$.

#### 3.2.2 Month-length clamping
If the anchor day $D_A$ exceeds the number of days in the target month (for example,
$D_A = 31$ evaluated in April, June, September, November, or February):
- The boundary date is clamped to the **last valid day of that month** in timezone $Z$
  (e.g., April 30, February 28 or 29).
- **Anchor preservation invariant**: Clamping is computed per evaluation and does not
  permanently mutate $D_A$. A cycle in May following an April cycle recovers the original
  anchor day 31.

#### 3.2.3 Daylight-saving transition invariance
By computing boundaries in local civil time in timezone $Z$ and resolving them to UTC
instants, the reset time remains fixed to the configured anchor's local civil time.
When daylight saving time begins or ends, the UTC reset timestamp automatically adjusts
by 3,600,000 ms to preserve the local civil schedule.

The dynamic duration of the active window is defined as:
$$\text{durationMs} = T_{\text{reset}} - T_{\text{start}}$$
This dynamic `durationMs` is supplied to `windowMs` in `QuotaWindowDto`
(`packages/rusa/src/dashboard/quota-api.ts:68`) and used to compute `timeRemainingPct`.

### 3.3 Persistence across restarts

The anchor configuration is immutable across coordinator restarts unless modified by
the operator. The current period $[T_{\text{start}}, T_{\text{reset}})$ is a deterministic
function of `(monthlyAnchor, nowMs)`.

On coordinator boot:
1. `QuotaService` reads the configured anchor and calculates $[T_{\text{start}}, T_{\text{reset}})$.
2. The coordinator queries the dedicated accounting ledger for source records spanning
   $[T_{\text{start}}, \text{now})$.
3. It derives cumulative usage from those immutable splits; it does **not** create a
   `quota_observations` row or advance a synthetic scrape timestamp.
4. If active pacing is enabled, it restores the small, cycle-keyed monthly controller
   state separately from the native-observation controller state.
The active-period total is therefore reconstructed from immutable configuration and
durable accounting records, while controller memory remains isolated and disposable at
a cycle boundary.

---

## 4. Usage measurement and token accounting

### 4.1 What counts: raw tokens versus provider-weighted tokens

Kimi Code token telemetry is extracted from worker session wire logs
(`sessions/<workspace>/<session>/agents/<agent>/wire.jsonl`) via `extractKimiTokenUsage`
in `packages/rusa/src/providers/token-accounting.ts:147-180`.

The parser records three discrete dimensions:
- `uncachedInput`: Composite of `inputOther` (turn prompt/system instructions) and
  `inputCacheCreation` (tokens written to cache).
- `cacheRead`: `inputCacheRead` (tokens read from the server prompt cache).
- `output`: Completion tokens generated by the model.

These dimensions are persisted in `run_token_records`
(`packages/rusa/src/db/migrations/0010_run_token_records.ts:9-30`).

#### 4.1.1 Weighting hypothesis
Providers often apply different tariffs or accounting ratios to prompt cache reads
versus uncached generation. Standard industry conventions include:
- **Raw token sum**: $T_{\text{raw}} = \text{uncachedInput} + \text{cacheRead} + \text{output}$
- **Discounted cache sum**: $T_{\text{weighted}} = 1.0 \times \text{uncachedInput} + 0.1 \times \text{cacheRead} + 1.0 \times \text{output}$

The available local history is dominated by `cache_read` tokens. If the provider counts
cache reads at 1:1, the monthly ceiling is governed almost entirely by cache reads. If the
provider applies a substantial cache-read discount, the same raw history can imply a much
larger raw-token ceiling. This uncertainty is material: it rules out active monthly gating
until the calibration plan in §7.2 has produced evidence for a weight tuple.

#### 4.1.2 Storage contract
To remain robust against unannounced provider accounting changes:
1. **Durable storage retains raw splits**: A new shared accounting ledger retains raw
   integer counts for `uncached_input`, `cache_read`, and `output`. Raw values are never
   pre-multiplied before insertion. The existing `run_token_records` table remains source
   evidence; it is not repurposed as the coordinator's mutable state.
2. **Configurable evaluation formula**: Effective tokens are calculated at evaluation
   time using a calibrated weight tuple:
   $$U = w_{\text{uncached}} \cdot \text{uncachedInput} + w_{\text{cache}} \cdot \text{cacheRead} + w_{\text{output}} \cdot \text{output}$$
   Before calibration, the raw tuple $(1.0, 1.0, 1.0)$ is a diagnostic baseline only;
   shadow mode does not use it to gate a lane. A configured override remains possible
   after it is backed by provider documentation or the observed calibration evidence.

### 4.2 Source identity, aggregation, and deduplication

#### 4.2.1 Existing source-record semantics
`run_token_records` is an observability source, not a per-run uniqueness constraint.
Its primary key is `id`; `run_id` has a non-unique index, and `provider` is an ordinary
column (`packages/rusa/src/db/migrations/0010_run_token_records.ts:9-30`). Today
`ActorMesh.accountRun` is called at a terminal run result and writes a token total once
for that result (`packages/rusa/src/actor/actor-mesh.ts:1092-1097, 4299-4328`), but the
schema permits more than one source record for a run. The proposal must preserve that
distinction.

#### 4.2.2 Proposed shared ledger and idempotency key
The future implementation adds a dedicated, append-only accounting ledger in the shared
coordinator database. Each imported event carries:

```text
(source_instance_id, source_record_id, run_id, provider, measured_at,
 uncached_input, cache_read, output, measurement_kind)
```

- `source_record_id` is the existing `run_token_records.id`, not `run_id`.
- `(source_instance_id, source_record_id)` is the ledger's unique key. The collector uses
  `INSERT OR IGNORE` on that pair, so retrying delivery or two coordinator connections
  cannot double-count a source record.
- `source_instance_id` distinguishes otherwise independent instance databases. It is a
  local stable identifier and is not displayed in the dashboard or public diagnostics.
- The ledger is a proposed future schema; this design-only PR makes no schema change.

For the present terminal-result writer, `measurement_kind = final_total`: the imported
splits are the total for that source record. If future instrumentation emits multiple
records for a long-running `run_id`, it must choose one explicit contract before import:
either monotonic `snapshot_total` records with a sequence number (the collector retains
the greatest sequence), or `delta` records (the collector sums each distinct source
record). It must never sum multiple cumulative snapshots. A source record that lacks this
contract is reported as unattributed rather than guessed.

#### 4.2.3 Failed runs and retries
When an actor run fails (for example, due to a tool failure, linter rejection, or provider
timeout), the LLM tokens emitted during the attempt were still processed and charged by
the provider.
- **Rule**: All completed LLM responses recorded in `wire.jsonl` are counted, regardless
  of whether `actor_runs.success` is `1` or `0`.
- **Exclusion**: Aborted connections where zero wire records were written produce null
  usage (`unattributedTokenUsage`) and add 0 tokens.

#### 4.2.4 Unattributed usage handling
If a run completes without parseable token usage (e.g. an unhandled crash or a legacy session
format), `run_token_records` records NULLs.
- Attributed runs represent ground truth.
- Unattributed runs are tracked as an integer count $N_{\text{unattributed}}$.
- In limit estimation, the coordinator maintains an uncertainty band based on the average
  tokens per attributed run:
  $$U_{\text{imputed}} = N_{\text{unattributed}} \times \bar{T}_{\text{run}}$$
  This imputed figure is reported in observability diagnostics but is not used to advance
  the PID controller without operator confirmation.

---

## 5. Limit estimation and confidence model

### 5.1 Estimation from a single exhaustion event

One classified monthly-exhaustion event supplies one calibration sample. At the event,
the ledger holds its raw split vector $(u_1, c_1, o_1)$ for the active configured period.
For an already calibrated weight tuple $w$, the first candidate limit is:
$$\hat{L}_1 = w_u u_1 + w_c c_1 + w_o o_1$$

The public document intentionally does not publish the account-specific event timestamp,
run count, or token totals. They are inputs to the local estimator, not design facts.
Until the weighting calibration is credible, this first sample is shown as a diagnostic
range in shadow mode and is not used to reduce Kimi dispatch capacity.

### 5.2 Confidence expression and safety margins

A single data point carries high epistemic uncertainty:
1. Were unmonitored requests made outside rusa (e.g. interactive CLI debugging by the operator)?
2. Did prompt cache hits count toward the limit at 100%, 10%, or 0%?
3. Does the provider enforce a token limit, a request count limit, or a credit limit?

To prevent the pacing system from over-trusting an initial estimate, the proposal introduces
an explicit **Confidence Model**:

| Exhaustion count ($N$) | Confidence Tier | Confidence Score ($C$) | Safety Headroom Factor ($\alpha$) |
|:---|:---|:---|:---|
| 0 | Uncalibrated | 0.00 | N/A (Tracking only, no gating) |
| 1 | `low` | 0.30 | 0.80 (Pace against 80% of estimate) |
| 2 | `medium` | 0.70 | 0.90 (Pace against 90% of estimate) |
| $\ge 3$ (consistent) | `high` | 0.95 | 0.95 (Pace against 95% of estimate) |

The effective limit used for PID pacing calculation is scaled by the safety factor:
$$L_{\text{effective}} = \alpha(C) \times \hat{L}$$

After weighting calibration and an explicit promotion out of shadow mode, pacing toward
the safety-adjusted first estimate introduces gradual spacing before the hypothesized
ceiling. The safety factor protects against an overestimate; shadow mode and tariff
calibration protect against wasting capacity through an underestimate.

### 5.3 Refinement across subsequent cycles

#### 5.3.1 Subsequent exhaustion ($N \ge 2$)
When a subsequent exhaustion event is observed at weighted usage $U_k$:
1. If the token split $(u_k, c_k, o_k)$ matches previous ratios, $\hat{L}$ is refined using
   an exponentially weighted or running average:
   $$\hat{L}_{k} = \frac{1}{k} \sum_{i=1}^k U_i$$
2. If token splits differ significantly (e.g. Cycle 1 had 95% cache reads, Cycle 2 had
   30% cache reads), the coordinator formulates a system of linear equations across cycles
   to solve for the true provider dimension weights $(w_u, w_c, w_o)$ and true scalar
   budget $B$:
   $$w_u u_1 + w_c c_1 + w_o o_1 = B$$
   $$w_u u_2 + w_c c_2 + w_o o_2 = B$$

#### 5.3.2 Non-exhausted cycle completion
If a monthly billing period completes without an exhaustion error, reaching peak usage
$U_{\text{peak}}$:
- The true limit is lower-bounded by $U_{\text{peak}}$:
  $$L \ge U_{\text{peak}}$$
- If $U_{\text{peak}} > \hat{L}$, the previous estimate was too low. $\hat{L}$ is immediately
  revised upward to $U_{\text{peak}}$, and confidence is updated.

---

## 6. Interaction with existing behaviour

### 6.1 Freshness evaluation and `calculateFreshness`

`calculateFreshness` in `packages/rusa/src/quota/coordinator-protocol.ts:183-218` assesses
staleness across provider buckets. At the cited `origin/staging` baseline, its age is the
oldest represented bucket age:
```ts
const bucketAges = Object.values(buckets);
const ageMs = bucketAges.length > 0 ? Math.max(...bucketAges) : updatedAge;
const stale = ageMs > staleAfterMs;
const hardStale = ageMs > hardStaleAfterMs;
```

The newer native-scrape design keys lane freshness and governing election to the newest
scrape's members. That makes a tick-stamped synthetic row especially unsafe: it could
become the newest member, hide aged native rows from freshness, and become the sole
eligible governor. The monthly design must not change either native rule.

#### 6.1.1 The synthetic staleness hazard
For native scraped windows (`five_hour`, `weekly`), `observedAt` represents the instant
a PTY scrape queried the provider CLI. If no scrape occurs for >15 minutes
(`DEFAULT_STALE_AFTER_MS`), the bucket is `stale`; if >1 hour (`DEFAULT_HARD_STALE_AFTER_MS`),
it is `hardStale`, causing `publishedThrottle` (`coordinator-protocol.ts:227-229`) to widen
the interval to `maxIntervalSeconds` (36,000 s).

If a synthetic `kimi:monthly` bucket were inserted into `quota_observations`, its
accounting timestamp would be mistaken for a scrape timestamp. Stamping it on an actor
run would make ordinary idle time look hard-stale; stamping it every coordinator tick
would instead distort newest-scrape membership. Neither is correct.

#### 6.1.2 Resolution
The derived monthly window is outside `quota_observations`, `quota_scrapes`, and the
native `calculateFreshness` input. A composition step after native `publishedThrottle`
combines it with the native result. Monthly accounting health is separately reported from
the last successful ledger ingestion or scan; it never refreshes native scrape freshness.
If accounting health is stale, the dashboard marks the monthly estimate unavailable and
active monthly pacing holds its last safe state according to an explicit fail-safe policy.

### 6.2 Closed-loop pacing and `SharedQuotaStore.getProviderThrottle`

In `packages/rusa/src/quota/shared-store.ts:644-729`, `getProviderThrottle` evaluates
reasoned **native** observations and elects a native governing bucket. The proposed
`deriveKimiMonthlyWindow(now, ledger, config)` is called alongside that read, rather than
being persisted as a native observation. This preserves native retention, history,
`quota-pacing-reset`, scrape membership, and dashboard history semantics.

```ts
reasoned.sort((a, b) => b.uncappedIntervalSeconds - a.uncappedIntervalSeconds);
const governing = reasoned[0];
```

#### 6.2.1 Derived window and isolated controller state
At throttle publication time, and after ledger ingestion, the monthly derivation computes:
1. $usedTokens$: Cumulative effective tokens in $[T_{\text{start}}, \text{now})$.
2. $percentLeft$:
   $$\text{percentLeft} = \max\left(0, \min\left(100, \left(1 - \frac{usedTokens}{L_{\text{effective}}}\right) \times 100\right)\right)$$
3. $timeRemainingPct$:
   $$\text{timeRemainingPct} = \max\left(0, \min\left(100, \frac{T_{\text{reset}} - \text{nowMs}}{\text{durationMs}} \times 100\right)\right)$$
4. $error$ (matching `advanceObservation`):
   $$\text{error} = \text{timeRemainingPct} - \text{percentLeft}$$
   - When $\text{error} > 0$: Quota is being burned faster than even pacing; the
     controller calculates a non-zero interval.
   - When $\text{error} \le 0$: Remaining quota meets or exceeds the calendar schedule.

The result is returned as `DerivedQuotaWindow { estimated: true, confidence, ... }`.
It is not stored as a `quota_observations` row. A small `monthly_controller_state` keyed
by provider and active period may retain PID integral/derivative state after active
pacing is promoted; raw evidence and dashboard history remain in their own stores.

#### 6.2.2 PID controller step
The existing controller logic in `advancePendingController` (`shared-store.ts:426-608`)
is the reference for a new `advanceMonthlyController` over the derived value and isolated
monthly controller state. It uses the same gains initially:
- `QUOTA_KP_SECONDS_PER_POINT = 120`
- `QUOTA_KD_SECONDS_SQUARED_PER_POINT = 1800`
- `QUOTA_KI_SECONDS_PER_POINT_SECOND = 120 / 3600 = 0.0333`

When monthly consumption surges ahead of the calendar schedule, that step widens the
derived monthly interval. It neither writes a synthetic raw observation nor participates
in native scrape election.

#### 6.2.3 Governing election and hard exhaustion
At the composition boundary:
- If the derived monthly interval exceeds the native interval, the published result uses
  that interval and identifies `kimi:monthly` as the composite governing source; native
  `getProviderThrottle` still elects only among native buckets.
- When $usedTokens \ge L_{\text{effective}}$:
  - `percentLeft = 0`
  - `resetAtIso = T_{\text{reset}}`
  - `pacer.deferUntil(T_{\text{reset}})` defers all non-responsive launches on the Kimi
    lane until the next billing cycle reset.

An actual monthly-exhaustion response uses an explicit new path, not an implied existing
one: the terminal run-result handler adjacent to `ActorMesh.accountRun`
(`packages/rusa/src/actor/actor-mesh.ts:1092-1097, 4299-4328`) classifies the provider
outcome, then reports a deduplicated exhaustion event to the coordinator. The report is
keyed by the source run result and records only the classification and event time. The
monthly derivation consumes it to set known exhaustion until $T_{\text{reset}}$.
`getExhaustedUntil` (`shared-store.ts:620-642`) remains a native-scrape mechanism and is
not claimed to observe actor failures.

### 6.3 Model-class selection (`selectPoolLane`)

Rusa routes multi-model pools via `selectPoolLane` in `packages/rusa/src/actor/provider-pacer.ts:391-419`:
```ts
export function selectPoolLane<C>(
  candidates: readonly PoolLaneCandidate<C>[],
  now: number
): PoolLaneCandidate<C> | undefined
```

1. **Automatic diversion via quotes**: Each lane quotes its availability:
   $$\text{quote} = \max(\text{now}, \text{nextAvailableAt}) + \text{waiting} \times \text{intervalMs}$$
   When `kimi:monthly` increases its pacing interval, Kimi's quoted start time moves
   into the future. In pools declaring multiple options (e.g. `[kimi, claude, codex]`),
   `selectPoolLane` automatically routes runs to immediately available alternative
   providers without requiring code changes to model definitions.
2. **Tie-breaking via headroom**: When multiple lanes are immediately available
   ($\text{quote} \le \text{now}$), `weeklyQuotaHeadroom` (`provider-pacer.ts:364-379`)
   breaks the tie.
   - **Proposal**: Extend headroom evaluation to consider both weekly and monthly headroom:
     $$\text{headroom} = \min(H_{\text{weekly}}, H_{\text{monthly}})$$
     If Kimi has 80% weekly headroom but only 5% monthly headroom, its composite headroom
     is 0.05. A candidate with balanced 40% headroom across all windows will win the tie,
     sparing Kimi from premature monthly exhaustion.

### 6.4 Dashboard and UI representation

#### 6.4.1 DTO protocol expansion
- Extend `QUOTA_WINDOW_KINDS` in `packages/rusa/src/quota/coordinator-protocol.ts:274` and
  `packages/rusa/src/mcp/quota-mcp.ts:48`:
  ```ts
  export type QuotaWindowKind = "session" | "five_hour" | "weekly" | "monthly" | "other";
  ```
- In `packages/rusa/src/dashboard/quota-api.ts`:
  - Update `windowMsFor(id: string)` (`quota-api.ts:39-41`) to dynamically resolve
    `monthly` duration from the active cycle $[T_{\text{start}}, T_{\text{reset}})$.
  - Extend `QuotaWindowDto` (`quota-api.ts:44-77`) with estimation metadata:
    ```ts
    export interface QuotaWindowDto {
      id: string;
      label: string;
      usedPercent: number | null;
      status: "available" | "exhausted" | "unknown" | "disabled" | "unsupported";
      resetAtIso: string | null;
      headline: boolean;
      windowMs: number;
      scrapedAt: string | null;
      /** True when the window is synthesized from local accounting rather than scraped from provider. */
      estimated?: boolean;
      /** Confidence score (0.0 - 1.0) and tier for estimated windows. */
      confidence?: "low" | "medium" | "high";
    }
    ```

#### 6.4.2 Dashboard UI presentation
In the Flutter dashboard (`packages/rusa/flutter_dashboard`):
1. **Header indicators** (`widgets/header.dart:719-750`):
   - Currently, `_ProviderQuotaRing` renders concentric circles for `weekly` (outer)
     and `session/5h` (inner).
   - An estimated monthly window must **never masquerade as a verified provider reading**.
   - The UI should render estimated windows with an **explicit visual distinction**:
     - A dashed perimeter or distinct border styling.
     - An `"EST"` badge indicator beside the label.
     - Tooltip detail showing:
       ```text
       Monthly limit: estimated (Low confidence)
       Used: locally tracked (estimated)
       Resets: at the configured anchor
       ```
2. **Quota history chart** (`widgets/quota_history_chart.dart:59-71`):
   - Allow toggling or plotting the `monthly` series alongside `weekly` headroom and
     throttle period.

---

## 7. Validation plan

Validating this design requires a disciplined verification sequence against future
observed resets and exhaustions before relying on the synthetic window for hard gating.

### 7.1 Phase 1: Validating the anchor hypothesis

The hypothesis states that Kimi's monthly usage resets at the configured anchor instant
and recurs on that day-of-month and time in the configured timezone.

1. **Pre-reset probe ($T_{\text{reset}} - 5\text{m}$)**:
   - When the provider is in a monthly-exhausted state, run an instrumented test prompt
     5 minutes before the hypothesized reset instant.
   - Confirm that the provider continues returning HTTP 403 monthly limit.
2. **At-reset probe ($T_{\text{reset}} + 1\text{m}$)**:
   - Run a minimal prompt 1 minute after the hypothesized reset instant.
   - If the request succeeds with HTTP 200, the anchor timestamp is verified to within a
     few minutes.
   - If the request still returns 403, poll at 15-minute intervals (and at UTC midnight)
     to detect whether the reset is tied to UTC midnight, local midnight, or an offset hour.
3. **Anchor refinement**:
   - Update `config.yaml` with the observed boundary timestamp.

### 7.2 Phase 2: Shadow tracking (observe-only)

Before allowing `kimi:monthly` to gate launches or throttle pacers:
1. Deploy ledger ingestion and derived-window calculation with `gating: false` (shadow
   mode).
2. At each pair of consecutive trustworthy native `five_hour` or `weekly` scrapes, align
   the provider-reported percentage-point delta with ledger increments over the same
   interval. Compare candidate raw and cache-discounted weight tuples, and record fit,
   residuals, coverage, and the influence of unattributed or external activity.
3. Promote a calibrated tuple only after enough independent scrape intervals agree within
   a predeclared tolerance. A low-coverage or conflicting result remains an explicit
   unknown; it cannot become an active gating policy.
4. The coordinator exposes the derived value with `estimated: true`, while native pacing
   continues to use only scraped `five_hour` and `weekly` buckets.
5. Over a complete billing period, compare the projected curve with observed reset and
   any exhaustion event before active closed-loop pacing.

### 7.3 Phase 3: Active closed-loop pacing

1. Enable `kimi:monthly` in `getProviderThrottle`.
2. Verify that when consumption outpaces the calendar schedule, `selectPoolLane` smoothly
   defers Kimi launches and shifts work to Claude or Codex.
3. Verify that if the limit is reached, `pacer.deferUntil(T_{\text{reset}})` holds the lane
   without throwing unhandled exceptions across the actor mesh.

---

## 8. Data-coverage statement

This section lists the stored evidence classes that can feed a local initial estimate.
It intentionally omits account-specific record counts, dates, event times, and token
totals from the public repository.

### 8.1 Inventory of stored observations

| Data Source | Location | Scope / Provider | Relevant Fields | Contribution |
|:---|:---|:---|:---|:---|
| `run_token_records` | Instance database (`mesh.db`) | `provider = 'kimi'` | `id`, `run_id`, `uncached_input`, `cache_read`, `output`, `scraped_at` | Raw split source records; `id` is the import identity. |
| `actor_runs` | Instance database (`mesh.db`) | Kimi terminal results | `id`, `started_at`, `ended_at`, `success`, `output` | Locates terminal outcomes and supports exhaustion classification. |
| `quota_observations` | Shared coordinator DB (`quota-coordinator.db`) | `provider = 'kimi'`, kinds `five_hour`, `weekly` | `observed_at`, `percent_left`, `reset_at_iso`, `interval_seconds` | Native short-window pacing and the calibration comparator; never a monthly derived-row store. |
| `quota_scrapes` | Shared coordinator DB (`quota-coordinator.db`) | `provider = 'kimi'` | `raw_output`, `parsed_state`, `scraped_at` | Audits parser provenance and identifies trustworthy native scrape pairs. |

### 8.2 Period attribution rules

- The estimator selects Kimi source records whose `scraped_at` lies in the active
  configured period. It retains each non-null raw split and counts null splits as
  unattributed coverage, not zero usage.
- Source records before the configured period may validate ingestion behavior but do not
  contribute to the active-period estimate.
- A classified monthly-exhaustion event is joined to the active-period ledger only through
  its internal source identity. Public diagnostics show its confidence implication, not
  the source run identifier, timestamp, or account-level aggregate.

### 8.3 Data gaps and coverage limitations

1. **Single exhaustion point ($N = 1$)**: Only one billing cutoff has been observed.
   The true ceiling and its tariff basis remain indeterminate without future cycles.
2. **Missing token splits for legacy runs**: Some source records can lack token splits,
   preventing retroactive verification of an earlier period.
3. **Unmetered host activity**: Token records in `run_token_records` capture only runs
   dispatched by rusa actors. Any manual CLI sessions executed by the operator directly
   on the host bypass rusa's database, which would cause rusa's local count to
   under-report total account consumption.
4. **Database locality**: `run_token_records` currently resides in the per-instance
   `mesh.db`, whereas quota observations reside in the shared `quota-coordinator.db`. A
   production implementation must bridge this boundary (see §9, Question 2).

---

## 9. Open questions

The following architectural and operational questions are left open for review:

1. **Token weighting policy**: What minimum scrape-pair coverage, residual tolerance, and
   stability are sufficient to promote a raw or cache-discounted tuple from shadow-only to
   active pacing?
   *Recommendation*: Keep the raw tuple diagnostic-only until this calibration criterion
   is met; do not sacrifice capacity based on a single uncalibrated weighting hypothesis.
2. **Storage location for token telemetry**: `run_token_records` is currently an instance
   table in `mesh.db`. Should a collector receive idempotent source events over the
   coordinator socket, or should `quota-coordinator.db` host the shared ledger written by
   actor instances?
   *Tradeoff*: A collector gives one writer and clear delivery acknowledgements; direct
   database access avoids a new endpoint but couples actors to SQLite write locks.
3. **Safety factor tuning**: Is an 80% safety margin ($\alpha = 0.80$) sufficiently
   conservative for $N=1$, or should Kimi begin soft pacing earlier (e.g. at 70% of estimated
   budget)?
4. **Dashboard window presentation**: Should the monthly window be displayed as a third
   ring in `_ProviderQuotaRing` (e.g. outer monthly, middle weekly, inner session), or
   as an auxiliary indicator pill?
   *Tradeoff*: Three concentric rings may crowd the 36px/48px header space on mobile
   displays; a separate pill or tooltip card may be cleaner.
5. **Multi-mesh account sharing**: If multiple independent rusa meshes or CLI installations
   share a single Kimi API credential, local token tracking within one mesh will not see
   the other's usage. How should multi-host usage be reconciled if this topology occurs?
