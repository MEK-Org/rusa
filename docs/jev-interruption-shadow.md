# JEV responsive-interruption shadow mode

This optional, host-owned policy observes whether a newly arrived responsive
inbox item would interrupt an actor's current work. It is shadow-only: normal
responsive preemption and hard cancellation controls remain authoritative.

## Enable

1. Put the TypeSafe credential in a regular file directly inside
   `$RUSA_HOME/secrets/`. Keep the filename and value out of source control.
2. Add its basename to `$RUSA_HOME/config.yaml`:

   ```yaml
   jevApiKeyFile: your-jev-credential-file
   ```

3. Restart `rusa`.

At boot, rusa validates the file with the same containment rule used for host
secrets. It reads the credential only in the daemon. `$RUSA_HOME/secrets` is
masked in every sandbox, so this file, like any host secret, reaches a worker
only if root explicitly grants `secret:<filename>` (#542); nothing in the
classifier needs such a grant.

With this explicit opt-in, the client resolves the text of the arriving item
immediately before calling TypeSafe, and then, only if that text is readable,
the text of its current candidates. It reads through the same reference
resolver the dashboard uses for inbox entries, but not the dashboard's
reference cache, which persists bodies in `mesh.db`. Obligation attention and
mechanical notes contribute their inline intent or note. The text is held in
memory for that one decision; it is not added to the durable inbox, the shadow
audit, or any cache.

**What is sent.** Every inbox item kind the actor holds can be sent, including
mesh messages: a person's own conversation with the actor, which the dashboard
hides from other viewers. Google Chat, Slack and GitHub items, obligation
attention and mechanical notes are sent too. Enabling the setting sends all of
these to TypeSafe for the actors that receive responsive items.

Each decision is bounded: at most 20 candidates are read and sent (the number
left out is sent as `omittedCandidates`), and each entry's text is cut at 4,000
characters. Both numbers, the 0.5 interrupt-probability threshold, and the 5-second
decision deadline are uncalibrated placeholders that the shadow data is meant
to calibrate. The deadline covers source reads and the request: expiry cancels
the request, but a source read in progress runs to completion unobserved,
because the source clients take no cancellation signal. Nothing is sent after
expiry.

The client uses the official `@typesafe-ai/sdk`, pinned to an exact version,
and follows the [TypeSafe System One API](https://docs.typesafe.ai/api). It
posts `https://api.typesafe.ai/v1/systemone` with a Bearer credential. The API
root is set explicitly, so a `TYPESAFE_BASE_URL` in the daemon's environment
cannot redirect the credential. The request carries model `jev-latest`, the
resolved incoming and candidate entries (id, inbox source, payload type, text)
as `state`, and one [Noul](https://docs.typesafe.ai/primitives/noul) question
named `interruption`: “Should we interrupt the current work for the arriving
item?” A Noul returns the probability of yes, with no separate confidence
score. The client accepts only a finite number in [0, 1] from a `noul` answer.

The policy interrupts at `interruptProbability >= 0.5`; a lower value queues
with reason `below_threshold`. This threshold is an initial setting to
calibrate from observations, not a translation of the old choice confidence.
The shadow audit retains the original `interruptProbability`, threshold,
policy `outcome`, stable inbox IDs, candidate source, and baseline scheduler
behavior. It does not retain message bodies, TypeSafe responses, credentials,
or request-error bodies. Historical audit rows retain their old
`verdict`/`confidence` fields; new rows use `interruptProbability` instead.
No stored rows or database schema are migrated.

Google Chat predictions use the same threshold-applied outcome: `✅` for
would interrupt, `❌` for would queue. Failed evaluations post no prediction.

## Failure behavior

If the credential file is absent, invalid, unreadable, or empty, the policy is
unavailable. A candidate whose text cannot be read is still sent, by type, with
null text. A GitHub comment or review event without a usable id counts as
unreadable rather than falling back to the issue or PR body. If the arriving
item's own text cannot be read, the observation is
recorded as `input_unavailable` and nothing is sent. If transport, response
parsing, or the timeout fails, that observation records `outcome: "interrupt"`
with the corresponding fallback reason (`timeout`, `client_error`, `invalid_probability`)
and posts no prediction reaction. No retry is attempted, because a retry would
resend inbox text. The baseline interruption stands.

## Active mode

By default, JEV runs in shadow mode (`jevMode: shadow`), observing arrivals without
altering scheduler dispatch. Setting `jevMode: active` enables active interruption
suppression:

```yaml
jevApiKeyFile: your-jev-credential-file
jevMode: active
```

### Active queue policy behavior

- **Eligibility:** Active JEV is called *only* when an otherwise-interrupting
  responsive arrival reaches an actor that is actively running and currently
  holds a live, unhandled selection (`inbox.select`) in that run.
- **Immediate baseline interrupt (no JEV call):** If the actor is idle or queued,
  if the actor has no selected work (empty selection or pending-only), or if all
  selected entries have already been marked handled, JEV is not evaluated and
  the baseline interrupt proceeds immediately.
- **Hard operator controls:** `operator.run_now` and direct `interrupt` (Stop)
  are hard control paths that bypass JEV evaluation and immediately preempt.
  In a concurrent batch of arriving rows, any interrupting row wins.
- **Threshold & suppression:** A timely valid decision strictly below the 0.5
  threshold (`outcome: "queue"`, `reason: "below_threshold"`) suppresses
  preemption of the active turn. The arrival remains durable in the inbox and
  is scheduled as a responsive follow-up when the current turn finishes.
- **Invalidation:** Suppression is strictly tied to the originating run and its
  selection. If the actor changes its selection (including re-selecting the same
  entries — ABA), marks its selected work handled, or if the run ends or Stop is
  called, suppression is invalidated and preemption occurs immediately if the actor
  is still running.
- **Failures & deadlines:** Timeouts (5-second decision deadline), transport
  errors, or unreadable inputs preserve baseline preemption.

## Roll back

- To revert from active mode to shadow observation: change `jevMode: shadow` (or
  remove `jevMode`) and restart `rusa`.
- To disable JEV entirely: remove `jevApiKeyFile` from `config.yaml` and restart
  `rusa`. This removes the classifier and its chat reactions; it does not require
  a database or schema migration. The credential file may be removed separately.
