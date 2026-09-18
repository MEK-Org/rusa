# Locally tracked Kimi monthly quota period — design proposal

Design-only proposal for #543. It describes the design for tracking a Kimi monthly quota
period locally from observed token usage in the rusa quota coordinator and exposing it
as an additional quota period for pacing, model-class selection, and dashboard
observability. Nothing here is implemented. No runtime code changes, schema migrations,
or quota storage changes are made with this document.

Every source citation below is against `origin/staging` at `106a432`. Paths are
repository-relative; line numbers are that commit's.

---

## 1. What this proposal is, in one paragraph

**A synthetic, locally tracked monthly quota window.** Kimi enforces a monthly usage
ceiling on its service, but its CLI `/usage` display (`packages/rusa/src/providers/kimi-usage-scrape.ts`)
reports only short-window buckets (`5h limit` and `Weekly limit`), omitting monthly
usage and remaining quota entirely. On 2026-09-17, the provider returned an unannounced
HTTP 403 monthly limit error that abruptly halted every Kimi-selected actor. This proposal
defines a synthetic `kimi:monthly` quota bucket in the quota coordinator
(`packages/rusa/src/quota/shared-store.ts`), anchored to an operator-configured instant
and timezone, accumulated from per-run token usage records
(`packages/rusa/src/providers/token-accounting.ts`), and reasoned about by the existing
closed-loop PID controller (`shared-store.ts:426-608`). This synthetic window enters
`getProviderThrottle` alongside native scraped windows, providing smooth backpressure,
early diversion of model-class pools (`packages/rusa/src/actor/provider-pacer.ts:391-419`),
and honest dashboard visibility before a hard provider lockout occurs.

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

### 2.2 The 2026-09-17 exhaustion incident

On 2026-09-17, active Kimi-selected actor runs failed with the provider error:

```text
error: failed to run prompt: provider.auth_error: 403 You've reached your monthly usage limit for this billing cycle. Your quota will be refreshed in the next cycle. To continue now, purchase extra usage or upgrade your plan: https://www.kimi.com/membership/subscription?tab=quota
```

Because the quota coordinator had visibility only into Kimi's `five_hour` and `weekly`
buckets (`packages/rusa/src/quota/shared-store.ts:644-729`), the closed-loop controller
reported healthy headroom on both short windows. Pacing did not slow down launches, and
multi-provider candidate selection in `selectPoolLane` (`packages/rusa/src/actor/provider-pacer.ts:391`)
continued directing traffic to Kimi until all concurrent actors encountered the 403
rejection simultaneously.

### 2.3 Proposed architecture

Because the provider does not publish monthly telemetry, rusa must track monthly usage
locally. The proposed architecture consists of four cooperating mechanisms:

1. **Configured period definition**: An operator-configured anchor instant and IANA
   timezone in `config.yaml` defining the monthly cycle boundary, evaluated using civil
   calendar arithmetic across daylight-saving transitions and varying month lengths.
2. **Local token accumulation**: Ingesting per-run token usage from `run_token_records`
   (`packages/rusa/src/db/migrations/0010_run_token_records.ts`) into the shared quota
   store, preserving input, output, and cache read splits with cross-instance deduplication.
3. **Limit estimation and confidence rating**: Estimating the monthly token ceiling from
   exhaustion events, expressed with an explicit confidence level and safety margin to
   prevent over-trusting a single data point.
4. **Coordinator integration**: Exposing the synthetic monthly bucket through
   `calculateFreshness`, `getProviderThrottle`, `ProviderPacer`, `selectPoolLane`, and
   the dashboard API as an estimated quota window.

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
- `timezone`: An IANA timezone identifier (e.g. `UTC`, `America/New_York`, etc.) defining the civil
  clock against which the provider's billing cycle is presumed to operate.

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
2. The coordinator queries stored token records spanning $[T_{\text{start}}, \text{now})$.
3. The cumulative usage is materialized in memory and synced to the synthetic observation
   in `SharedQuotaStore`.
No historical accumulators need to be persisted in singleton state tables; the period
is deterministically reconstructed from immutable configuration and durable run logs.

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

In the observed Kimi data for rusa, `cache_read` constitutes **94.4%** of all recorded
tokens (2,530,048 of 2,680,480 raw tokens). If the provider counts cache reads at 1:1,
the monthly ceiling is governed almost entirely by cache reads. If the provider discounts
cache reads by 90% (a 0.1x multiplier), the effective usage is roughly 403,000 tokens.

#### 4.1.2 Storage contract
To remain robust against unannounced provider accounting changes:
1. **Durable storage retains raw splits**: The shared store retains raw integer counts
   for `uncached_input`, `cache_read`, and `output`. Raw values are never pre-multiplied
   before insertion.
2. **Configurable evaluation formula**: Effective tokens are calculated at evaluation
   time using an operator-configurable or calibrated weight tuple:
   $$U = w_{\text{uncached}} \cdot \text{uncachedInput} + w_{\text{cache}} \cdot \text{cacheRead} + w_{\text{output}} \cdot \text{output}$$
   Default weights in v1 are $(1.0, 1.0, 1.0)$ (raw tokens), with support for an
   operator override `quota.providers.kimi.tokenWeights: [1.0, 0.1, 1.0]` once provider
   billing documentation or repeated exhaustions confirm the tariff.

### 4.2 Deduplication across coordinator instances and retries

#### 4.2.1 Deduplication authority
In multi-process or multi-instance rusa deployments sharing one quota coordinator, token
records must be ingested idempotently.
- Every invocation in `packages/rusa/src/actor/actor-mesh.ts:4300-4330` carries a unique
  UUID `runId`.
- Ingestion into the shared store is keyed by `(run_id, provider)`. If multiple instances
  report the completion of a shared task or retry an insertion, the operation uses an
  `INSERT OR IGNORE` transaction, ensuring each run is accounted exactly once.

#### 4.2.2 Failed runs and retries
When an actor run fails (for example, due to a tool failure, linter rejection, or provider
timeout), the LLM tokens emitted during the attempt were still processed and charged by
the provider.
- **Rule**: All completed LLM responses recorded in `wire.jsonl` are counted, regardless
  of whether `actor_runs.success` is `1` or `0`.
- **Exclusion**: Aborted connections where zero wire records were written produce null
  usage (`unattributedTokenUsage`) and add 0 tokens.

#### 4.2.3 Unattributed usage handling
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

As of 2026-09-18, the system has observed exactly **one** exhaustion event:
- **Timestamp**: 2026-09-17 20:56:45Z
- **Error**: HTTP 403 `monthly usage limit for this billing cycle`
- **Observed usage in active cycle** (from the configured anchor through the 2026-09-17 exhaustion):
  - 187 attributed runs
  - `uncached_input`: 140,137
  - `cache_read`: 2,530,048
  - `output`: 10,295
  - Total raw tokens: 2,680,480 (~2.68M tokens)

Because $N = 1$, this observation establishes an initial candidate limit:
$$\hat{L}_{\text{raw}} \approx 2,680,000 \text{ tokens}$$
or $\hat{L}_{\text{discounted}} \approx 403,000 \text{ tokens}$ under a 0.1x cache read discount.

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

Under the initial $N=1$ estimate ($\hat{L} = 2.68\text{M}$, $\alpha = 0.80$):
$$L_{\text{effective}} \approx 2,144,000 \text{ raw tokens}$$

By pacing toward 80% of the single observed ceiling, the controller begins introducing
gradual spacing before the true limit is reached, preventing an abrupt 403 lockout.

### 5.3 Refinement across subsequent cycles

#### 5.3.1 Subsequent exhaustion ($N \ge 2$)
When a subsequent exhaustion event is observed at usage $U_k$:
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
staleness across provider buckets. In staging commit `106a432` (and PR #524), lane
freshness is keyed strictly on the **buckets present in the newest scrape, or the
governing bucket**:
```ts
const bucketAges = Object.values(freshness.buckets);
const ageMs = bucketAges.length > 0 ? Math.max(...bucketAges) : updatedAge;
const stale = ageMs > staleAfterMs;
const hardStale = ageMs > hardStaleAfterMs;
```

#### 6.1.1 The synthetic staleness hazard
For native scraped windows (`five_hour`, `weekly`), `observedAt` represents the instant
a PTY scrape queried the provider CLI. If no scrape occurs for >15 minutes
(`DEFAULT_STALE_AFTER_MS`), the bucket is `stale`; if >1 hour (`DEFAULT_HARD_STALE_AFTER_MS`),
it is `hardStale`, causing `publishedThrottle` (`coordinator-protocol.ts:227-229`) to widen
the interval to `maxIntervalSeconds` (36,000 s).

If a synthetic `kimi:monthly` bucket stamped its `observedAt` only when an actor ran, an
idle system (e.g. overnight with no Kimi runs for 2 hours) would allow the monthly bucket
to age past 1 hour. This would mark Kimi `hardStale` and clamp its interval to 10 hours,
even though nothing was wrong!

#### 6.1.2 Resolution
The synthetic monthly bucket must distinguish **PTY scrape freshness** from **accounting
engine freshness**:
1. `observedAt` for `kimi:monthly` is stamped by the **coordinator tick**
   (`SharedQuotaStore.advancePendingController` or the aggregation loop), not by run
   completion timestamps.
2. During idle periods with no actor runs, token usage remains constant, the calendar
   advances deterministically, and the coordinator tick refreshes `observedAt` to `nowMs`.
3. Consequently, `kimi:monthly` remains fresh as long as the coordinator process itself
   is alive and ticking, avoiding spurious `hardStale` throttling.

### 6.2 Closed-loop pacing and `SharedQuotaStore.getProviderThrottle`

In `packages/rusa/src/quota/shared-store.ts:644-729`, `getProviderThrottle` evaluates all
reasoned observations for a provider and elects the bucket with the largest required
interval as the governing bucket:

```ts
reasoned.sort((a, b) => b.uncappedIntervalSeconds - a.uncappedIntervalSeconds);
const governing = reasoned[0];
```

#### 6.2.1 Synthetic observation generation
Every coordinator tick (or upon run token ingestion), the store computes:
1. $usedTokens$: Cumulative effective tokens in $[T_{\text{start}}, \text{now})$.
2. $percentLeft$:
   $$\text{percentLeft} = \max\left(0, \min\left(100, \left(1 - \frac{usedTokens}{L_{\text{effective}}}\right) \times 100\right)\right)$$
3. $timeRemainingPct$:
   $$\text{timeRemainingPct} = \max\left(0, \min\left(100, \frac{T_{\text{reset}} - \text{nowMs}}{\text{durationMs}} \times 100\right)\right)$$
4. $error$:
   $$\text{error} = \text{percentLeft} - \text{timeRemainingPct}$$
   - When $\text{error} > 0$: Quota remaining exceeds time remaining (consumption is slow;
     no throttling needed).
   - When $\text{error} < 0$: Quota is being burned faster than even pacing (controller
     calculates non-zero `requiredIntervalSeconds`).

This observation is stored in `quota_observations` with `kind: "monthly"`.

#### 6.2.2 PID controller step
The existing controller logic in `advancePendingController` (`shared-store.ts:426-608`)
reasons about `kimi:monthly` using the standard gains:
- `QUOTA_KP_SECONDS_PER_POINT = 120`
- `QUOTA_KD_SECONDS_SQUARED_PER_POINT = 1800`
- `QUOTA_KI_SECONDS_PER_POINT_SECOND = 120 / 3600 = 0.0333`

When monthly consumption surges ahead of the calendar schedule, the PID step widens
`uncappedIntervalSeconds` and `intervalSeconds` for `kimi:monthly`.

#### 6.2.3 Governing election and hard exhaustion
In `getProviderThrottle`:
- If `kimi:monthly` uncapped interval exceeds `five_hour` and `weekly`, `governingBucketKey`
  becomes `kimi:monthly`.
- When $usedTokens \ge L_{\text{effective}}$ or when the provider emits an actual 403
  monthly exhaustion error:
  - `percentLeft = 0`
  - `resetAtIso = T_{\text{reset}}`
  - `getExhaustedUntil` (`shared-store.ts:620-642`) resolves `exhaustedUntil = T_{\text{reset}}`.
  - `pacer.deferUntil(T_{\text{reset}})` defers all non-responsive launches on the Kimi
    lane until the next billing cycle reset.

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
       Monthly limit: ~2.68M tokens (Estimated, Low confidence)
       Used: 1.42M tokens (53%)
       Resets: in 14 days (at the configured anchor)
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
   - When the provider is in a monthly-exhausted state (as observed on 2026-09-17), run an
     instrumented test prompt 5 minutes before the hypothesized reset instant.
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
1. Deploy token accumulation and synthetic observation generation with `gating: false`
   (shadow mode).
2. The coordinator calculates $usedTokens$, $percentLeft$, $error$, and required intervals,
   logging them to the database and exposing them to the dashboard with `estimated: true`.
3. Pacing and `getProviderThrottle` continue to use only scraped `five_hour` and `weekly`
   buckets.
4. Over a full 30-day billing cycle, compare the observed consumption curve against any
   warnings or exhaustions. Verify that the controller's projected exhaustion matches
   reality.

### 7.3 Phase 3: Active closed-loop pacing

1. Enable `kimi:monthly` in `getProviderThrottle`.
2. Verify that when consumption outpaces the calendar schedule, `selectPoolLane` smoothly
   defers Kimi launches and shifts work to Claude or Codex.
3. Verify that if the limit is reached, `pacer.deferUntil(T_{\text{reset}})` holds the lane
   without throwing unhandled exceptions across the actor mesh.

---

## 8. Data-coverage statement

This section lists the exact stored evidence available in existing rusa databases as of
2026-09-18 that would feed the initial monthly estimate.

### 8.1 Inventory of stored observations

| Data Source | Location | Scope / Provider | Record Count | Time Span | Relevant Fields |
|:---|:---|:---|:---|:---|:---|
| `run_token_records` | Instance database (`mesh.db`) | `provider = 'kimi'` | **232 rows** | 2026-08-11 to 2026-09-17 | `uncached_input`, `cache_read`, `output`, `scraped_at`, `run_id` |
| `actor_runs` | Instance database (`mesh.db`) | All actors | 10,000+ rows | Full history | `id`, `started_at`, `ended_at`, `success`, `output` |
| `quota_observations` | Shared coordinator DB (`quota-coordinator.db`) | `provider = 'kimi'`, kinds `five_hour`, `weekly` | **12,781 rows** (6,398 5h, 6,383 weekly) | 2026-08-19 to 2026-09-18 | `observed_at`, `percent_left`, `reset_at_iso`, `interval_seconds` |
| `quota_scrapes` | Shared coordinator DB (`quota-coordinator.db`) | `provider = 'kimi'` | 6,400+ raw captures | 2026-08-19 to 2026-09-18 | `raw_output`, `parsed_state`, `scraped_at` |

### 8.2 Breakdown of Kimi token evidence across periods

- **Total Kimi token records**: 232 rows.
- **Pre-anchor period** (prior to the configured anchor):
  - 45 rows (2026-08-11 up to the configured anchor).
  - All 45 rows have `uncached_input = NULL`, `cache_read = NULL`, `output = NULL`
    (generated prior to wire token accounting instrumentation).
- **Active cycle period** (from the configured anchor through exhaustion 2026-09-17):
  - **187 attributed rows** (all non-null).
  - Cumulative `uncached_input`: **140,137** tokens.
  - Cumulative `cache_read`: **2,530,048** tokens.
  - Cumulative `output`: **10,295** tokens.
  - **Total raw tokens**: **2,680,480** tokens (~2.68M).
- **Exhaustion event**:
  - Run ID on 2026-09-17 20:56:45Z failed with `provider.auth_error: 403 You've reached your monthly usage limit for this billing cycle.`

### 8.3 Data gaps and coverage limitations

1. **Single exhaustion point ($N = 1$)**: The system has witnessed only one billing
   cutoff. The true ceiling cannot be definitively distinguished between 2.5M, 3.0M, or
   a round billing quota without further cycles.
2. **Missing token splits for legacy runs**: The 45 pre-anchor runs lack token counts,
   preventing retroactive verification of the earlier billing cycle.
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

1. **Token weighting policy**: Should the initial implementation assume strict 1:1 raw
   token counting, or should prompt cache reads be discounted (e.g. 0.1x) given their
   94.4% dominance in the workload?
   *Recommendation*: Default to raw 1:1 counting with the low-confidence safety factor
   ($\alpha = 0.80$). This fails closed against quota cliffs.
2. **Storage location for token telemetry**: `run_token_records` is currently an instance
   table in `mesh.db`. Should token events be pushed to the coordinator over its socket
   (`POST /v1/tokens` or similar), or should `quota-coordinator.db` directly host a shared
   token ledger written by actor runs?
   *Tradeoff*: Adding a write endpoint to the coordinator breaks its read-only GET contract
   (design §5.2); having actor instances write directly to `quota-coordinator.db` preserves
   coordinator simplicity but couples actors to SQLite write locks.
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
