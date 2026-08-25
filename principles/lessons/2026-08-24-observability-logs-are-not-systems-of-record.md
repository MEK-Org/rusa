# Lesson: Observability Logs Are Not Systems of Record

Date: 2026-08-24

## Prompt

`mesh_events` accumulated content that components read back to *decide behavior*,
not merely to display. The clearest case is #1073: `assemblePortableInjection`
(`packages/rusa/src/commands/start.ts`) queries the event log for an actor's own
`run_end` rows and folds their bodies into the prompt of a **live** worker:

```ts
const { events } = getRepositories().meshEvents.listEventsByActors([id], {
  kinds: ["run_end"],
  limit: portableContextMaxRuns(),
});
```

Those bodies are `result.output` — the provider's whole narration stream,
tail-clamped at `MAX_BODY_CHARS` (40,000). Measured across the live log,
`run_end` is 9,546 events averaging ~11.9KB.

If the event log were truncated, rotated, or lost, this actor would not merely
lose dashboard history — it would wake up with a different prompt and behave
differently. That is the failure mode the rule below exists to prevent.

The framing that resolves it was proposed by Matt on #1073 (2026-07-21) and
ratified by root in the same thread: reason about the system as components, each
of which **owns an authoritative store and emits into the shared logs**. Under
that framing `mesh_events` is an observability projection and the actor inbox is
a coordination projection; neither is a system of record.

## The contract

### 1. The membership test is "do you read it to decide"

If any component reads a store to decide behavior, that store is operational and
must be *someone's* authoritative store. A projection may be lost without
changing what the system does: losing it may cost observability, or a wake that
some other mechanism can recover, but never correctness.

Read from the other end, this is the #1012 reader-legitimacy rule — an
acceptable reader of the observability store is one where absence means *less
observability*, never *wrong behavior*. Same rule, stated as a property of the
store rather than of each reader, which is what makes it checkable at review
time without enumerating readers.

### 2. Projections get schema freedom; contracts live at the authoritative store

Once a store is a projection, its shape may change to serve observability.
Consumers are owed stability only by the authoritative store, plus stable
reference ids in the emitted rows.

This clause is not theoretical. After #1085, spine-participating
`message_sent` / `message_received` rows stopped carrying their own prose;
`toMeshEvent` resolves the body through a `LEFT JOIN mesh_chat` keyed on
`payload.messageId`, and a JOIN miss means the body is genuinely gone rather
than something to rescue from `row.body`. Anything that had treated the log
row's shape as an interface would have silently mis-read. Under this clause that
change was within-rights, and the next one should not be litigated as a
regression.

The corresponding obligation runs the other way: an authoritative store's shape
*is* an interface, and changing it is a migration, not a projection tweak.

### 3. Data-lifecycle policy gets exactly one home

Retention, deletion, and size clamps belong to the authoritative store, not to
each log table that happens to carry a copy. Otherwise every clamp is
renegotiated per table and they drift. `MAX_BODY_CHARS` clamping run output
inside the event log is an instance of policy living in the projection.

## The shape, and the one instance already built

The target shape for a component is: **authoritative store + reference in the
log + emitted events** — never content in the log.

Messages already have it, and are the working template:

| leg | messages (built, #1085 + #1077) | run output (#1073, open) |
|---|---|---|
| authoritative store | `mesh_chat` | none — content lives in `mesh_events.body` |
| reference in the log | `payload.messageId` | n/a |
| body resolution | `LEFT JOIN mesh_chat` in `toMeshEvent` | direct `row.body` read |

Two honest caveats on that template, both visible in the code:

- **The migration is not total.** Body resolution is scoped by `messageId`
  presence, *not* by kind, precisely so the ~1942 legacy pre-#1077 message rows
  whose bodies still live in `mesh_events` are not blanked. "Messages are
  extracted" is true going forward and false for the tail.
- **Extraction moves content, not selection.** Portable context still asks
  `mesh_events` *which* messages and runs exist (`listEventsByActors`,
  `listLedgerSourcesAfter`) even where the body now comes from `mesh_chat`. A
  component that reads the log to decide *what to include* still fails the
  membership test, whatever it does about the bytes. Extracting `run_end` bodies
  to a run store would fix the content dependency and leave the selection
  dependency standing.

## Tradeoffs

| Approach | Pros | Cons |
|---|---|---|
| Content in the event log, read back for behavior | One table; no migration; trivially queryable | Log retention becomes a correctness dependency; lifecycle policy is renegotiated per table; the log's schema is frozen by non-observability consumers |
| Authoritative store + reference in the log | Projection stays free to change; lifecycle policy has one home; loss of the log degrades observability only | A store and a migration per component; a JOIN on the read path; a legacy tail that predates the reference |
| Delete the core-behavior reader instead | No new store at all; smaller prompts; the invariant holds by construction | Only available when the reader has a legitimate substitute; is a behavior change and must be measured, not asserted |

The third column is not a hypothetical. Portable-context v2 already declines to
fold `run_end`: `PORTABLE_CONTEXT_SOURCE_KINDS` is `message_received` +
`run_yielded`, with the reason recorded — a yield note is the distilled outcome
and carries a `complete`/`blocked` discriminator the compactor can act on
(8,491 events, ~536B average), while a `run_end` body is the narration stream.
So before sizing a store for a reader, check whether the reader survives; the
ledger path already decided this one did not.

## Resolution

Adopt the contract as `P-005`. Apply it per component, additively and
reversibly — WAL-consistent footprint measurement, a migration-registry test,
and a verified reverse in the runbook (#1033's shape). No refactor mandate: each
extraction stays independently justified, and the only new requirement is that
every one targets the same shape rather than inventing a per-component one.

Status of the components at the time of writing:

- **mesh chat** — extracted (#1085), reference-in-log (#1077). Template.
- **actor inbox** — coordination projection; the durable wake spine (#1117).
- **actor run system** — still lives inside the log (#1073 content, #1110
  lifecycle facts). The next instance, and the one that will show whether the
  shape holds under a reader that is not a message.

## Principle Impact

- Added: `P-005` in `principles/principles.md`.

## Reviewer Check Mapping

- Does this code read a log/projection table to *decide* something, or only to
  display, audit, or replay it? Deciding means the data belongs in an
  authoritative store.
- If it writes content into a log table, is that content also the system of
  record for someone? If yes, it should be a reference plus an emitted event.
- If it depends on a projection's column shape, is that dependence justified?
  Projections may change shape; only authoritative stores and reference ids owe
  stability.
- Does this add a retention rule or size clamp to a table that is a projection
  of someone else's data? Lifecycle policy belongs at the authoritative store.
