# Run outcomes dashboard design (#664)

Status: review artifact only. This proposal and its screenshot describe a
possible replacement for routine yield-status reporting; they do not change the
running dashboard or actor lifecycle.

## Source grounding

This design starts from `staging` commit `fc2fefff63181434f701ce043cb980a94303bab5`:

- `packages/rusa/flutter_dashboard/lib/widgets/overview_tab.dart` already
  renders queued actors and chooses `selectedObligation` before
  `selectedInboxItem` for active focus, but its activity section is currently
  **Recent Yields**.
- `packages/rusa/flutter_dashboard/lib/models.dart` carries selected obligation
  and inbox-item projections; `lib/store.dart` refreshes `run_yielded` events
  and clears run-scoped focus at lifecycle boundaries.
- `packages/rusa/src/db/repositories/actor-run-repository.ts` stores run focus
  and terminal rows. `src/actor/actor.ts`, `src/actor/actor-mesh.ts`, and
  `src/experimental/remote-instances/actor-handle.ts` provide the existing
  local and remote terminal boundaries. A follower's `result` message is the
  observed remote CLI result; a lost follower channel is a separate leader-side
  transport observation, not evidence that the provider CLI died.
- At this baseline `ActorHandle.fail()` terminates an already-open remote run
  with a synthetic unsuccessful result after a connection/startup failure. That
  is the current leader-side accounting behavior being described, not a new
  provider-death classification. The lease/heartbeat assessment in
  [#656](https://github.com/MEK-Org/rusa/issues/656) is held separately; this
  design does not change or endorse that transport behavior.
- [#610](https://github.com/MEK-Org/rusa/issues/610) asks the queue to prefer an
  obligation card when the inbox source has an unambiguous obligation link.
- [#664](https://github.com/MEK-Org/rusa/issues/664) and its
  [runtime-design comment](https://github.com/MEK-Org/rusa/issues/664#issuecomment-5804130967)
  define the desired separation of provider result, inbox handling, and
  obligation movement. The
  [recovery amendment](https://github.com/MEK-Org/rusa/issues/664#issuecomment-5804479746)
  supplies the selected-versus-deferred and retry-exhaustion cases below.

## Proposed surface

The mock-up preserves one work card (title, source reference, obligation id)
through three places:

1. **Queued** — show it as upcoming work, not as proof that it has already been
   selected. Prefer the obligation card only for an unambiguous association, as
   #610 requests. Its snapshot shows the queue-stage checkpoint (why it is
   waiting and what is next), not a later approval-wait checkpoint. A
   separately labelled deferred entry remains in Queue.
2. **Selected** — open the same card in the actor's work focus and list the
   selected inbox items separately from unselected backlog. Drill-through goes
   to Inbox, Events, and Work. Its snapshot instead says that work was selected
   for this run and names the next run-stage action.
3. **Recent activity** — answer "what have the actors completed recently?" by
   replacing the yield-note feed with handled work cards, newest first:
   - Header: **Recent Activity** with a concise subtitle. The search bar and
     status filter dropdown are removed per operator guidance.
   - Column layout: `[Time] [Actor] [ Handled card [Optional "(+ N more)"]]`.
   - Handled card: presents the handled source reference, item summary, and
     the green resolution explanation container (matching the "Handled Inbox Items"
     presentation in the actor inbox panel with "Handled: <time>" and
     "Addressed: <resolution note>").
   - Multi-item handling: coalesced inbox items or review threads display an
     explicit `(+ N more)` badge.
   - Completions focus: routine non-zero exits and transient run execution errors
     do not appear as activity completions in this panel; it is dedicated to
     actual completed/handled work.
   - Obligation changes: the list is one newest-first feed with two card kinds
     in the same `[Time] [Actor] [card]` row. Besides the handled card, an
     **obligation card** reports a terminal `done`/`cancelled` transition with
     the obligation's `terminal_note` and `resolution_ref`. Its source is the
     existing `obligation_history` stream: rows whose payload `after.status` is
     terminal (matched on the payload, because a combined mutation is recorded
     under its primary `mutation_kind`), attributed through `acting_principal`.
     `id` is strictly monotonic, so a bounded page reads `ORDER BY id DESC`
     without a new index or schema change. When the same run handled an inbox
     item and moved its linked obligation, the transition stays the label under
     that handled card; only unmatched transitions get their own row. The
     screenshot illustrates the handled case.

Recent Activity is not where unresolved work is discovered. Selected work that
a run leaves unhandled stays visible on the surfaces that own it:

- **Selected / Work focus**: the item remains under "Selected work this run"
  after the run ends, with its retry count. After bounded retries are exhausted
  it carries a **Needs attention** badge until a meaningful change or explicit
  operator action clears it.
- **Queue**: the same card shows the Needs attention badge instead of an
  ordinary queued checkpoint.
- **Actor tree / overview row**: the owning actor carries the badge, so the
  case is discoverable without opening the actor.

The screenshot illustrates this completed work flow:

- Actor `kestrel-coder` handled the #664 feedback item with resolution explanation
  "Packaged design proposal and repeatable Flutter render harness into PR #665;
  awaiting operator review", with `(+ 1 more)` indicating coalesced items.
- Actor `heron-reviewer` handled PR #661 review feedback with resolution
  explanation "Verified socket-boundary outage regression and removed unsupported
  cache retention; posted APPROVE", with `(+ 2 more)` for inline threads.
- Actor `amber-owl` handled the stage-2 withdrawal decision on mesh chat with
  resolution explanation "Completed stage-3 handoff confirmed; cancelled child
  obligation 0fb4ecd9 and closed PR #666".

## Runtime direction for a later implementation

Use the existing run id and terminal compare-and-set. A local provider return
or thrown provider error settles through the current actor result path. A remote
provider result is observed only when the follower sends its result through the
leader's actor handle. A lost remote channel must be labelled as contact loss
with an unknown provider outcome; the current code's leader-side terminal
accounting for an already-open run remains visible as such while #656 is
assessed. In every case, record one terminal outcome and never infer obligation
completion from an ordinary successful CLI return.

After terminal settlement, reconcile only that run's selected inbox ids against
durable handled state. Unhandled selected work remains pending and may receive a
bounded, durable retry. Exhaustion projects Needs attention and requires a
meaningful change or explicit operator action; unrelated inbox work cannot
refill that budget. Delegation uses the child or transferred owner; dependency
waiting uses its durable edge. Neither needs a routine `complete` or `blocked`
yield label.

The implementation test matrix should cover local success, local throw,
interruption, duplicate remote completion, remote contact loss, and restart.
Each case should demonstrate exactly one terminal record/event, preserve the
separate handled-inbox and obligation-transition outcomes, and prove that a
transport-loss display never claims a provider CLI failure without an observed
CLI result.

## Review artifact

Run from `packages/rusa/flutter_dashboard`:

```sh
flutter test test/design_664_mockup_test.dart
```

It writes `screenshots/664_run_outcomes_mock.png`. The test is intentionally a
design-only harness: it uses existing dashboard widgets for the visual language
and small labelled proposed elements for the not-yet-implemented activity rows.
Font loading, avatar image stubbing, and capture come from
`test/screenshot_support.dart`, shared with `test/screenshots_test.dart`. The
selected panel is a mid-run snapshot (14:07:03); the Recent Activity row for
the same item is the later handled state (14:21:37).

## Scope boundary

No runtime implementation, database/schema change, or migration is included in
this design slice. Existing production yield behavior remains active pending
review and a separately approved implementation.
