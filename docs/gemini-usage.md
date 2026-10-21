# Gemini API usage by purpose

Rusa writes a versioned `gemini_usage` event at `info` when an observable
application request completes or fails. Collection is continuous; the
`gemini-usage-report` CLI aggregates retained JSONL exports when you ask for a
time window. It does not run a periodic consumer, call Gemini, open a database,
or keep a second store of totals.

## Run a report

Export JSON logs from each participating instance and quota coordinator.
Choose the unit names that your installation actually uses. For a journal-backed
installation, for example:

```sh
journalctl --user -u rusa --since '2026-10-14 12:00:00 UTC' --until '2026-10-14 13:00:00 UTC' -o cat > instance.jsonl
journalctl --user -u rusa-quota-coordinator --since '2026-10-14 12:00:00 UTC' --until '2026-10-14 13:00:00 UTC' -o cat > coordinator.jsonl
rusa gemini-usage-report instance.jsonl coordinator.jsonl --from 2026-10-14T12:00:00Z --to 2026-10-14T13:00:00Z
```

`--from` is inclusive, `--to` exclusive, and both must have an explicit UTC `Z`.
Filtering uses the request's completion/failure time, not its start time.
For the past N hours, choose those UTC bounds at invocation. Add `--json` for
structured output. Use `-` as a source to read stdin. JSON records can coexist
with older console lines: non-JSON lines are skipped and counted in coverage.
File-backed installs can supply retained `$RUSA_HOME/logs/rusa.log` and rotated
files directly. [Logging and rotation](logging.md) describes their storage.

Every supplied source gets separate available log and usage bounds. The report
names observed instance/process identities, purposes with no observations,
duplicate counts and malformed/oversized/unsupported usage rows. Add an explicit
known gap with `--gap 'coordinator export starts after restart'`. Repeat or supply
multiple notes for missing instances or known rotation/truncation. Observed
earliest/latest timestamps do **not** establish continuous retention between
them. A seven-day window cannot recover seven days of deleted logs. Collection
starts with this release; earlier consumption is unknown. An `info` event is
suppressed by `warn`, `error` or `silent` logging, and a `pretty` log cannot be
consumed as JSONL. Export processes running with JSON logging at `info` or `debug`.

Overlapping copies are deduplicated by opaque attempt id. Conflicting copies of
an id fail the report instead of silently selecting a count. Input is streamed,
individual lines are limited to 64 KiB, and exact deduplication is capped at one
million selected attempts; narrow the window if that cap is reached.

## What the numbers mean

Records contain only `version`, UTC `occurredAt`, opaque `instanceId`, random
process-boot `processId`, PID, unique `attemptId`, stable `purpose`, nullable
`actorId` and `runId`, requested and returned model, API outcome, usage
completeness, stream partial flag and counts.
Instance identity is a hash of the host and resolved instance home; the home and
hostname are not written. The start and coordinator entrypoints reuse their
logger for level/format and redaction; standalone in-repository callers use the
normal logger defaults. `model` is the API's `modelVersion` when returned,
otherwise the requested model; `requestedModel` preserves the requested alias.

`actorId` and `runId` are recorded only when the caller already has them in
scope; a non-null run id always has a non-null actor id. Absent attribution is
represented as `null`, including in legacy v1 records that predate these
fields. Under each purpose/model group, the report
breaks out actor calls (including an explicit interrupted-call count), measured
completed-call input/output sums and input-per-call max/p50/p90
(using nearest-rank percentiles);
the explicit `unattributed` bucket holds null actor ids. JSON includes each
actor's distinct non-null run ids, while the text report omits them. These are
mesh-internal identifiers: exports remain operator-private and must not be
posted publicly without redaction.

The API's [usage metadata](https://ai.google.dev/api/generate-content#UsageMetadata)
and [token counting guide](https://ai.google.dev/gemini-api/docs/generate-content/tokens)
define these fields:

| Recorded count | Provider field | Interpretation |
| --- | --- | --- |
| `input` | `promptTokenCount` | Returned prompt/input count; includes cached input |
| `response` | `candidatesTokenCount` | Returned generated response count |
| `thinking` | `thoughtsTokenCount` | Returned thinking count |
| `cachedInput` | `cachedContentTokenCount` | Cached-input breakdown; do not add it to input |
| `toolInput` | `toolUsePromptTokenCount` | Tool-use prompt breakdown; shown separately, not added to totals |
| `total` | `totalTokenCount` | Provider-reported total, kept as returned |

The report derives `output` **per attempt** as response + thinking only when both
are known. It never fills absent thinking with zero or reconstructs absent
components from `total`. Each field has a nullable measured sum, measured-sample
count and missing-sample count. A true zero remains a measurement; no samples
means `unknown`. Sort order uses measured reported total (input when absent),
not a sum of overlapping breakdowns. Counts are nonnegative safe integers.

An API `response` is recorded **before** application validation: malformed
generated JSON, truncation, rejected extraction or missing audio still consumed
the counts Gemini returned. `error` means the observable request failed;
`cancelled` means a speech consumer ended iteration early. Raw error messages,
prompts, output, media, request bodies and credentials are never copied into the
usage event. A recorder failure preserves the original API result/error.

Usage is `complete` when input, response and total are present for a completed
request, `partial` when counts exist but one is missing or a stream is
interrupted, and `missing` when no valid counts were returned. Optional counts
can still be unknown on a `complete` record. Streams keep the **last cumulative
snapshot**, never sum chunks. Interrupted snapshots are displayed separately
from completed-request totals. An unconsumed stream or process death before
termination cannot produce a completed usage record; source coverage is required.

Every application retry, stronger-model fallback and agentic loop turn has a new
attempt id. SDK-internal retries that provide no separate response metadata are
a blind spot. Actor CLI run accounting, arbitrary external API scripts and
account-wide billed-dollar reconciliation remain separate.

## Instrumented purposes

The active SDK/REST inventory for this implementation, after the commitment-polarity
removal in [#1060](https://github.com/MEK-Org/rusa/pull/1060), is:

| Stable purpose | Production call site |
| --- | --- |
| `portable_compaction` | `src/actor/portable-context-compactor.ts`, inside `withGeminiRetry` |
| `quota_parse` | `src/mcp/quota-mcp.ts`, each parser attempt and model fallback |
| `model_catalog_parse` | `src/providers/model-catalog.ts` |
| `kimi_screen_classification` | `src/providers/kimi-usage-scrape.ts` |
| `exhaustion_classification` | `src/providers/exhaustion-classifier.ts` |
| `understanding_distillation` | `src/understanding/distill.ts`, every tool-loop turn |
| `understanding_retrieval` | `src/understanding/retrieve-llm.ts`, every tool-loop turn |
| `avatar_generation` | `src/avatar/avatars.ts`, REST response before image validation |
| `speech_transcription` | `src/voice/gemini-speech.ts`, REST response before transcript validation |
| `speech_synthesis` | `src/voice/gemini-speech.ts`, REST and streamed responses |

Paths are relative to `packages/rusa`. No schema or dashboard change is needed.
Credential redaction remains intact: numeric usage lives under
`counts.input/response/thinking/cachedInput/toolInput/total`, while fields whose
names contain `token` remain redacted. The synthetic tests exercise the actual
logger → JSONL → built CLI report path in two real processes, overlapping
exports, all ten active purpose fixtures, retries, rejected validation, missing and
partial metadata, streaming completion/cancellation/errors, time bounds and
known history gaps. Call-site suites check their existing behavior unchanged.
