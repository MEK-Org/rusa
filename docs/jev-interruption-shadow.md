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
characters. Both numbers, the 0.8 interrupt threshold, and the 5-second
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
as `state`, and one `choice` question named `interruption`. The choices are
`interrupt` and `queue`; it accepts an answer only if it selects one of those
and carries a numeric confidence.

The shadow audit retains stable inbox IDs, candidate source, verdict/confidence,
and baseline scheduler behavior; it does not retain message bodies, TypeSafe
responses, credentials, or request-error bodies. Google Chat predictions react
on the arriving message with `✅` (would interrupt) or `❌` (would queue).

## Failure behavior

If the credential file is absent, invalid, unreadable, or empty, the policy is
unavailable. A candidate whose text cannot be read is still sent, by type, with
null text. A GitHub comment or review event without a usable id counts as
unreadable rather than falling back to the issue or PR body. If the arriving
item's own text cannot be read, the observation is
recorded as `input_unavailable` and nothing is sent. If transport, response
parsing, or the timeout fails, that observation safely queues and posts no
prediction reaction. No
retry is attempted, because a retry would resend inbox text. The existing
responsive scheduler still runs exactly as before in every case.

## Roll back

Remove `jevApiKeyFile` from `config.yaml` and restart `rusa`. This removes the
observer and its chat reactions; it does not require a database or schema
migration, and it leaves the normal scheduler unchanged. The credential file
may be removed separately once the service has restarted without the setting.
