# Compacted memory plus delta (`compacted_memory_delta`)

A default-off experiment for portable-context actors in **ledger** mode
(tracked as #1062 in this repository's tracker). Nothing changes for any
actor until an administrator enrolls it.

## What it changes

Outside the experiment, a ledger actor's prompt carries its compacted ledger
**and** a fixed window of recent inbound messages and run outputs. The ledger
can already have absorbed those messages; it does not absorb completed run
outputs. After every run end, including an
interrupted one, the actor's successor waits for the compactor before it can
start.

An enrolled actor gets two changes:

1. **Delta journal.** Verbatim inbound messages come only from the durable
   sources after the ledger's fold cursor (`lastFoldedSourceId`). Earlier
   messages are represented by the ledger alone. The recent completed runs
   window stays unchanged because those outputs are not folded into the
   ledger. The existing count and byte budgets still apply.
2. **Deferred interruption compaction.** When a run ends interrupted (an
   explicit interrupt or a responsive preemption), the post-run fold is
   skipped and a `portable_context_compaction_deferred` event is recorded. The
   responsive successor starts without waiting on the compactor. The next
   ordinary run end folds everything after the cursor exactly once.

The fold cursor only advances when a fold page is committed to the durable
snapshot store. A compactor failure, a restart, repeated interruptions, or
enrolling and unenrolling never move it, so unconsumed sources are always
still in `mesh_chat` and `actor_runs` for the next fold.

## Activation

Enrollment is per actor and uses the existing experiment tools, which require
the `experiment-admin` capability and are confined to the caller's subtree:

```text
enroll_actor_experiment   { actor_id: <thread id>, experiment: "compacted_memory_delta" }
list_actor_experiments    { actor_id: <thread id> }
```

Enrollment takes effect at the actor's next prompt build and next run end. No
restart, migration or configuration change is involved; the registry entry is
code (`packages/rusa/src/actor/experiments.ts`).

## Rollback

```text
unenroll_actor_experiment { actor_id: <thread id>, experiment: "compacted_memory_delta" }
```

Unenrolling restores the fixed-window journal and synchronous post-run
compaction on the next run. Any delta accumulated while enrolled (including
folds deferred by interruptions) is still after the cursor, so the next run
end folds it as before. There is no state to migrate in either direction and
the snapshot schema version is unchanged.

If the delta read fails or the unfolded tail exceeds its four-page ceiling
(200 sources), the prompt falls back to the fixed recent window for that run
and logs `portable_context_delta_fallback`; the actor still starts with the
newest messages visible. A truncated read retains `journal.truncated: true`,
its fold cursor and source counts in the inject record, with
`journal.mode: window`. The fold cursor is unchanged. A failed read has no
journal accounting.

## Measuring

Nothing here is a savings claim until measured. The signals to compare for an
enrolled actor against its own pre-enrollment runs:

- `run_start` events carry the inject record. `bytes` is the injected prefix
  size; `sections` breaks it down; `journal.mode` is `delta` for a complete
  delta read and `window` for a truncated-tail fallback, with
  `journal.unfoldedSources` and `journal.foldCursor` for provenance. Journal
  accounting is absent outside the experiment or when the delta read fails.
- `portable_context_compacted` events count folds and their size; a deferred
  fold shows up as one `portable_context_compaction_deferred` followed by one
  larger `portable_context_compacted` at the next ordinary run end.
- The interrupt-to-successor gap is the time between the interrupted run's
  `run_end` and its successor's `run_start`.

The unit-level before/after on an identical fixture is printed by
`packages/rusa/src/actor/portable-context-delta.test.ts`.
The fixture contains eight folded messages, two unfolded messages, ten runs
and eight ledger decisions. Observed prefix sizes (bytes, not tokens):

| Journal | Total | Ledger | Messages | Runs |
| --- | --- | --- | --- | --- |
| Window | 9720 | 1005 | 4072 | 4365 |
| Delta | 6488 | 1005 | 840 | 4365 |

All ten run outputs and the ledger section remain unchanged. Only the eight
folded message bodies are omitted from the delta journal. These fixture
measurements do not establish production savings.

The startup integration fixture in `src/commands/start.test.ts` holds the first
fold behind a promise barrier and proves an unenrolled interrupted run cannot
settle before the fold is released. An enrolled interrupted run settles without
calling the compactor, with the cursor unchanged. It also prints run-end elapsed
times with a 300 ms synthetic compactor delay; those measurements describe the
fixture, not a production latency bound, and no host-speed threshold is asserted.
