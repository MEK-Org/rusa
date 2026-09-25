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
secrets. It reads the credential only in the daemon; it is never mounted into a
worker sandbox. With this explicit opt-in, the client resolves the full text of
the arriving item and its current candidates immediately before calling
TypeSafe. It does not add that text to the durable inbox or shadow audit.

The client follows the [TypeSafe System One API](https://docs.typesafe.ai/api):
it posts `https://api.typesafe.ai/v1/systemone` with a Bearer credential, model
`jev-latest`, the resolved incoming/candidate source text as `state`, and one
`choice` question named `interruption`. The choices are `interrupt` and
`queue`; it accepts only a `choice` answer with those probabilities and a
numeric confidence.

The shadow audit retains stable inbox IDs, candidate source, verdict/confidence,
and baseline scheduler behavior; it does not retain message bodies, TypeSafe
responses, credentials, or request-error bodies. Google Chat predictions react
on the arriving message with `✅` (would interrupt) or `❌` (would queue).

## Failure behavior

If the credential file is absent, invalid, unreadable, or empty, the policy is
unavailable. If source resolution, transport, response parsing, or the timeout
fails, that observation safely queues and posts no prediction reaction. No
retry is attempted, because a retry would resend inbox text. The existing
responsive scheduler still runs exactly as before in every case.

## Roll back

Remove `jevApiKeyFile` from `config.yaml` and restart `rusa`. This removes the
observer and its chat reactions; it does not require a database or schema
migration, and it leaves the normal scheduler unchanged. The credential file
may be removed separately once the service has restarted without the setting.
