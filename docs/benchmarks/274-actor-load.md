# #274 synthetic actor-load benchmark

This disposable in-memory SQLite benchmark measures the newest
`human:operator` lookup used while `SqliteActorRepository.list()` builds the
actor list. It compares the retired per-actor lookup with the correction: one
ordered query that retains the first (newest) row per recipient in memory. It
also reports the hypothetical recipient index separately, so it is a measured
alternative rather than a claim that schema work was necessary.

The fixture values below are deliberately synthetic; none came from the reported
phone. They establish the query shape, not a production distribution or SLO.

From the repository root, run the reported 1,000-actor / 100,000-row, three-sweep
workload with:

```sh
node packages/rusa/scripts/bench-274-actor-load.mjs
```

It emits the dataset, `EXPLAIN QUERY PLAN` output, each sweep duration, matched
actor count, materialized human-row count, and median for the retired per-actor
query, the batched correction, and the hypothetical recipient index. Timings are
local-machine observations, not an SLO.

The latest local run of the default fixture produced median 7,516.1 ms
per-actor, 41.2 ms batched, and 31.4 ms indexed sweeps. The literal zero-human
stress command below produced 7,832.4 ms, 12.3 ms, and 35.7 ms respectively.
These are individual local-machine observations, not stable product timings.
The batched query retains the same newest `(ts, id)` row for each recipient
while avoiding the actor-by-chat scan. Its trade-off is that it materializes
every historical `human:operator` row: 20,000 rows per sweep in the default
fixture, versus no rows in the zero-human case. Recipient/history skew and a
production data distribution still need measurement before a new index is
proposed.

To exercise the real in-process `/api/mesh/threads` handler, its JSON
serialization, and the `SqliteActorRepository` correction against disposable
1,000-actor/100,000-row default and zero-human fixtures, run:

```sh
RUSA_BENCH_274=1 pnpm --filter rusa exec vitest run src/dashboard/actor-load.benchmark.test.ts
```

That harness intentionally has no TCP listener, network shaping, browser, or
Flutter runtime. It records handler wall time and uncompressed response bytes;
it cannot measure transfer, mobile CPU, decoding/state work, or hierarchy
rendering. Its latest run measured a 65.9 ms median across three default
route-handler samples and 25.3 ms across three zero-human samples; both
responses were 580,851 uncompressed bytes. These are isolated request-path
observations, not mobile timings or an SLO.

The default is deliberately uniform: every actor has 100 inbound rows, 20 from
`human:operator`. That prevents missing-human rows from accidentally measuring a
different workload and makes the result-preservation check meaningful. To inspect
the no-human case, run:

```sh
HUMAN_MESSAGES_PER_ACTOR=0 node packages/rusa/scripts/bench-274-actor-load.mjs
```

The retired per-actor query still scans the whole table once per actor even when
no matching row exists. The batched query makes one table scan and returns no
rows. This is a stress case for the old plan, not a claim that every deployed
mesh has no human messages.

The uniform fixture is not a claim about production distribution. In particular,
a much larger historical volume of operator messages increases the correction's
materialized result and client-independent server memory. Any index or pagination
change should be justified by a benchmark with observed volume/skew rather than
inferred from this synthetic sweep.

## Client-source CPU fixture

`packages/rusa/flutter_dashboard/tool/bench_274_actor_load.dart` is a second,
separate disposable fixture. It imports the dashboard's real
`ThreadsSnapshot.fromJson`, `DashboardStore.refreshThreads`, and
`DashboardStore.flattenedVisible` code, but supplies a synthetic snapshot and
a no-op stream. It neither opens a listener nor reads a mesh database.

Run it from the dashboard directory with the Dart binary bundled with the
already-installed Flutter SDK (using that binary directly avoids the Flutter
wrapper updating a shared SDK cache):

```sh
cd packages/rusa/flutter_dashboard
/path/to/flutter/bin/cache/dart-sdk/bin/dart format --output=none --set-exit-if-changed tool/bench_274_actor_load.dart
/path/to/flutter/bin/cache/dart-sdk/bin/dart run tool/bench_274_actor_load.dart
```

The source fixture is exactly 1,000 actors: one root and 999 direct children.
Its JSON is 438,640 UTF-8 bytes and it reports seven sweeps each for parse,
state replacement, two `flattenedVisible` calls, and the visible-row
child-presence scan used by `ActorTree`. These are local CPU timings; they do
not include HTTP, compression, transfer, a device CPU, widget layout, or
rasterization.

The 438,640-byte client fixture is intentionally not the 580,851-byte route
fixture above. The client fixture directly constructs the DTO input needed for
the parser/store/tree measurement, including its varied synthetic previews. The
route harness instead serializes the actual route's full server DTO shape,
including generated handles and fields that serialize as `null` or empty
collections, from a separate concise-charter database seed. The two byte counts
therefore describe different payloads; do not combine their timings or treat
either as a production transfer measurement.

## Inconclusive browser attempt

An earlier disposable headless-browser attempt reported SwiftShader and timed
out during its initial warm-up before observing a threads response. It is not a
client timing: its SSE framing used literal backslash-n sequences and its timeout
waited for a later request, so it could not attribute the timeout to rendering
or another stage. The script and its run instructions are intentionally not
published. The source CPU fixture above is the only successful client-side
measurement here; browser/device transfer, Flutter update, layout, and
rasterization remain unmeasured.
