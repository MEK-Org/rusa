# Execution boundaries: terminal claims and selection recovery

This note records the **current** ownership of one run's terminal result and
of the one-recovery opportunity for selected inbox work (#174, #1176). It is a
characterization, not a redesign: each statement below is pinned by a test in
`packages/rusa/src/commands/start.test.ts`, in the
`execution boundary characterization (#1176)` block, which boots `runStart`
over a temporary SQLite home and fakes only the provider (local) or the
follower wire (remote).

## Owners

| Question | Current owner |
| --- | --- |
| Who claims a run's terminal result? | The executor. Local: `Actor` sets `runEndReported` before it emits `onEnd`, whether for a result or via `reportAbandonedRun` (`coalesced`, `start-cancelled`, `unreported`). Follower: `ActorHandle` opens `runOpen`/`startedRunId` on `runStart` and clears them before it emits, in `endRun` (result) or `endQueuedRun` (abandoned). |
| Who records the claim durably? | The `runStart` accounting listener (`addRunLifecycleListeners` in `start.ts`). `createRunAccounting` keeps an in-memory claim per actor (`activeRunIds`): `begin` opens the `actor_runs` row and the claim, `complete` and `abandon` write the terminal row and only then drop the claim. Boot runs `actorRuns.abandonOpen("service restarted before run completion")` before any actor starts. |
| Who computes recovery eligibility? | `ActorMesh.finishInboxRun`, from the mesh's own lifecycle listener (the first listener in `lifecycleFor`), on a result terminal only. An entry selected in this run and still unhandled after a successful return is eligible if fewer than one prior successful return selected it. |
| Which durable records retain eligibility? | `actor_runs`: `focus_entry_ids_json` (written by `inbox.select` through the open run's row), plus `outcome` and `success`. `ActorRunRepository.completedFocusEntryCounts` counts only `outcome = 'completed' AND success = 1` rows and excludes the current run. The original inbox row is never rewritten or copied; it stays unhandled. |
| Who schedules the recovery opportunity? | `finishInboxRun` calls `ActorMesh.dispatch`, which goes through `RunManager.dispatch` to `Actor.requestRun` locally or to a follower `wake` command via `ActorHandle`. |
| Who reports exhaustion? | `finishInboxRun` → `escalateExhaustedInboxWorkToParent`, which delivers one `[inbox recovery exhausted]` notice to an active parent. The configured root has no parent and returns early, so its exhausted work produces no notice. |

## Order within one terminal

For one `onEnd`, the mesh listener runs first: `finishInboxRun` then
`accountRun` for a result, or `abandonInboxRun` (and `applyPendingTarget` when
started) for an abandonment, then `clearSelection`. Configured lifecycle
listeners follow, then the `runStart` listeners (run material, accounting,
events). Each listener's failure is contained and logged as
`[mesh] lifecycle onEnd listener failed: …`; it does not stop the others.

So eligibility is computed **before** the terminal row is written. That is safe
only because `completedFocusEntryCounts` excludes the current run.

## Cases and their pins

| Case | Local `Actor` | Follower `ActorHandle` |
| --- | --- | --- |
| Selected and unhandled after a successful return: one recovery, then exhaustion | yes | yes |
| One run identity from queued through the durable row | yes | — |
| Configured root: one recovery, exhaustion, no parent notice | yes | — |
| Unselected work neither gains nor spends recovery | yes | — |
| Mixed selection keeps a separate budget for each entry | yes | — |
| Failed provider return: no recovery | yes | — |
| Pre-start abandonment: no row, no provider call, no budget | yes | yes |
| Started abandonment: an `abandoned` row, outside the budget, no recovery | — | yes |
| Halt: dispatch refused before admission, no row, no budget | yes | — |
| Restart after normal exhaustion keeps exhaustion | yes | yes |
| Terminal accounting-write failure (below) | yes | yes |
| Restart after that failure | yes | yes |

## Current behavior after a terminal accounting-write failure

This is **current behavior, not a contract**. The tests mark it as such so a
later repair is free to change it. It is a product defect, tracked separately
from #1176. #1176 only characterizes it.

If `runs().complete` throws for one run's result, `createRunAccounting` keeps
that run's in-memory claim and its row stays open (no outcome). This is
deliberate: the claim is meant to keep the row recoverable. The mesh listener
has already run, so the first run's recovery is dispatched normally. Then, for
each later run:

1. `runAccounting.begin` throws because a claim is open. The listener failure is
   contained, the run still executes, and it has no row of its own.
2. `inbox.select` resolves the open claim, so the selection is recorded on the
   **first** run's row.
3. `finishInboxRun` counts no completed successful return for the entry, so it
   dispatches again and never reports exhaustion.
4. `runAccounting.complete` fails `assertActive` for the new run id.

In the local fixture, four provider turns are scripted. Three select the entry
and succeed, the fourth returns a failure, and only the first terminal write
fails. All four turns ran: two successful returns past the one permitted
recovery. The scripted failure ended the loop. The fixture leaves one open row
holding the focus, an empty budget, the entry unhandled, no exhaustion notice
and four `run_end` events. The follower fixture plays three successful selecting
runs after the failure and sees one more `wake` after each, with the same one
open row and no budget. The loop is bounded here only by the scripted provider
and the follower wire. These tests do not show that it would run forever.

A restart clears this. Boot's `abandonOpen` marks the stranded row `abandoned`,
which the budget does not count. The entry therefore gets its full budget back:
one run, one recovery, then exhaustion and one parent notice. This is pinned
separately for local and follower paths.

## Local and follower differences

The two paths differ only in who claims the terminal (`Actor` versus
`ActorHandle`) and in how a dispatch reaches the executor (`requestRun` versus a
`wake` command). Eligibility, durable budget, accounting and boot recovery are
the same leader-side listeners on both paths, so the accounting-write behavior
above is identical on both.
