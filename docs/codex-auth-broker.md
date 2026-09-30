# Codex host-owned auth broker

`providers.codex.authBroker: true` moves every Codex refresh behind trusted host
code (#782). This page covers the boundary, how to roll it out and back, and how
to reproduce the fixture evidence.

## Boundary

Without the broker, every Codex process a daemon starts shares the canonical
`~/.codex/auth.json`. A sandboxed worker has it bound writable at
`/tmp/auth.json`, so anything that runs in the sandbox can read the refresh
token or overwrite the login (#781).

With the broker on:

- **Only the host holds the canonical refresh token.** Each daemon, and a quota
  coordinator, runs a broker on `127.0.0.1`. Only the broker reads the canonical
  file for refresh, and only the broker writes it.
- **Consumers get access material and a capability.** A run gets a private
  `auth.json` with the canonical access and id tokens. Its `refresh_token` is a
  random per-run capability, and `CODEX_REFRESH_TOKEN_URL_OVERRIDE` points its
  CLI at the broker. This covers sandboxed workers, unsandboxed root runs, and
  the `/status` quota probe and `/model` probe. When Codex refreshes, it sends
  the capability. The broker's reply has no `refresh_token`, so the capability
  stays in place.
- **Sandboxes cannot see the canonical login.** `~/.codex` is shadowed by an
  empty read-only tmpfs, at both its path and its real path. Nothing canonical
  is bound in.
- **Requests are strict.** The broker accepts only `POST /oauth/token` with a
  JSON body made of `grant_type: "refresh_token"`, `refresh_token` and an
  optional `client_id`. It rejects any other field, and a request that names an
  unknown, expired or revoked capability. It builds the upstream request from
  the canonical file, never from the consumer's body. A capability expires with
  its run and is revoked when the run ends.
- **One refresh owner per host.** Every broker takes an exclusive SQLite write
  lock beside the canonical file (`rusa-auth-refresh.lock`) and re-reads the
  canonical file under it. If a consumer's access token is no longer
  canonical's, another owner has already rotated, so the broker serves
  canonical's tokens without calling upstream. The kernel releases the lock if
  its holder dies.
- **At most one rotation a minute.** A login refreshed less than
  `minRotationIntervalMs` ago (60 s by default) is served as is, even to a
  consumer holding canonical's current access token. A replayed capability
  therefore cannot churn the login faster than that. The cost: if upstream
  rejects a freshly issued access token within that minute, the broker hands
  the same token back and the run fails (with the host `codex login` alarm)
  instead of recovering. A 401 after the window rotates and recovers. Both
  cases are real-driver scenarios.
- **A request that outlives its lease gets nothing.** The broker re-checks the
  capability after it has waited for the in-process queue and the host lock.
  A request whose capability was revoked or expired while queued gets
  `401 invalid_grant`, with no upstream call and no access material. A
  rotation already past that check still persists.
- **Rotations are durable before any reply.** A rotation is written to a temp
  file, fsynced, renamed over the canonical file, and the directory is fsynced.
  A consumer that disconnects mid-refresh does not cancel the upstream call or
  the persist.
- **Broker faults fail closed.** If the lease fails, the launch fails with a
  `login required` result and the probe reads unknown. Nothing falls back to
  the shared writable login.
- **Nested E2E instances fail closed.** When `providers.codex.authBroker` is
  enabled, the nested E2E manager binds no Codex login into the instance runtime
  home. Nested Codex workers find no credentials and fail closed, preventing
  unbrokered workers from reading canonical credentials or racing upstream refresh.
- **Redaction.** Logs name events, the broker's own fixed messages, and
  bounded error codes (for example `EACCES` or `SQLITE_BUSY`). A native error's
  message, which names file paths, is never logged. Logs never contain tokens,
  capabilities or file paths.

### Crash gap

One window cannot be closed. If the owner dies after upstream rotated but
before the rename, the new refresh token is lost and the canonical one is
already spent. The broker writes an intent marker before every upstream call.
The next owner that finds the marker logs
`codex_auth_previous_refresh_interrupted`.

When upstream refuses the canonical token, the broker logs
`codex_auth_login_rejected`. It then marks that token dead, so later consumers
fail closed without calling upstream again. Consumers recover once the
canonical file changes, which is what `codex login` on the host does.

## Rollout

1. **Enumerate and drain legacy consumers first.** A process outside the broker
   that refreshes the same login races the broker. Before the first brokered
   rotation on a host:
   - Every daemon and quota coordinator that shares the login, prod and staging
     alike, must be in one of two states: running with `authBroker: true`, or
     stopped (`rusa stop`, or stopping its service). A broker-off daemon that
     keeps running is **not** drained, even with Codex halted:
     - `/halt provider:codex` (or its file, `<home>/HALT`) stops that daemon
       from *starting* Codex runs. In-flight runs finish (`halt-switch.ts`),
       each with the canonical file bound writable.
     - The halt does not gate the daemon's quota service, whose Codex `/status`
       scrape runs on its own schedule, or the `/model` catalog probe, which
       runs at startup and daily (`start.ts`). On a broker-off daemon both
       launch Codex against the canonical login and can refresh it.
     So stop it: halt Codex on that daemon first so no new Codex run starts,
     wait until its in-flight Codex runs have finished (`pgrep -af codex`
     shows none of its workers), then stop it.
   - Find interactive `codex` sessions on the host (`pgrep -a codex`). Close
     them, or accept that they refresh on their own.
   - Nested E2E daemons fail closed for Codex when `authBroker: true` (or on
     configuration read error): the E2E instance manager binds no Codex login,
     preventing nested workers from reading or racing the canonical refresh token.
2. **Canary.** Set `providers.codex.authBroker: true` on staging only and
   restart it. On a host where prod and staging share the same `~/.codex`
   login, prod stays stopped (step 1) for the canary window, at least one
   access-token lifetime (about an hour). No unbrokered process may refresh
   while staging exercises the broker. Over that window:
   - Check for `codex_auth_rotated` and the absence of
     `codex_auth_login_rejected`.
   - Confirm that the `/status` quota probe and the `/model` probe return real
     readings, not unknown, through the broker.

   Record those results before prod changes. They are the rollout gate. Then
   enable `authBroker: true` on prod and restart it.
3. The flag defaults to off until the canary completes.

## Rollback

Rollback means pausing Codex launches, not reverting the flag. With the flag
still on, a broker fault already fails launches closed.

Setting `authBroker: false` restores the writable canonical bind that #781
reported, so it has to be an explicit operator decision. Nothing turns the flag
off automatically. After a refused login, run `codex login` on the host and
consumers recover without a restart.

## Reproducing the fixture evidence

Every test uses fixture credentials and a local stand-in for both the token
endpoint and the Responses API. None of them reads the operator's login.

```bash
cd packages/rusa
# Broker unit tests: strict body, forged/expired/revoked capabilities,
# concurrency, two brokers sharing a login, a second process holding or dying
# with the lock, refused login, interrupted refresh, disconnect mid-refresh,
# a lease revoked or expired while queued, a filesystem failure's log line.
pnpm vitest run src/providers/codex-auth-broker.test.ts

# Real driver: CodexProvider.run under bwrap against each CLI listed
# (colon-separated). Omitted, it uses `codex` on PATH. A missing CLI or bwrap
# shows as a skipped test, which is missing evidence, not a pass.
RUSA_CODEX_DRIVER_BINS=/path/to/codex-0.144.4:/path/to/codex-current \
  pnpm vitest run src/providers/codex-auth-broker.integration.test.ts
```
