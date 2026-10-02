# Codex host-owned auth broker

`providers.codex.authBroker: true` moves every Codex refresh behind trusted host
code (#782). This page covers the boundary, a dedicated Codex home, when the
CLI refreshes, how to roll the broker out and back, and how to reproduce the
fixture evidence.

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
- **Sandboxes cannot see the canonical login.** `~/.codex`, and a configured
  `providers.codex.home`, are shadowed by an empty read-only tmpfs on the
  real path, which also covers a symlinked path into it. The shadow is
  mounted after the sandbox's writable binds, so it holds even when the
  configured home sits inside the actor's own workspace. Nothing canonical is
  bound in.
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
  A configured `providers.codex.home` is also shadowed at its own path inside
  the instance, and the instance's generated config omits the key.
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

## Dedicated Codex home

`providers.codex.home` names the directory that holds the Codex login, in place
of `~/.codex`:

```yaml
providers:
  codex:
    cliCommand: codex
    authBroker: true
    home: /absolute/path/to/codex-home
```

It must be an absolute path; the loader normalizes it and rejects anything
else, and rejects the key on any other provider. Unset, everything uses
`~/.codex` exactly as before.

One resolver (`providers/codex-home.ts`) answers "where is the login" for the
whole process. The daemon and the quota coordinator set it at boot, and every
host-side consumer reads it:

- the broker (its canonical file, refresh lock and intent marker);
- worker launch (`codex.ts`): the config merged into a sandboxed run, the login
  a brokered run seeds from, the login a broker-off sandbox binds, and
  `CODEX_HOME` for a broker-off unsandboxed run;
- the `/status` quota probe and the `/model` probe, and the models cache the
  catalog reads;
- the actor sandbox, the host-job sandbox and the E2E instance, which hide it.

The actor sandbox hides the configured home with the broker on or off, after
its writable binds, so it stays hidden even beneath an actor directory, the
pnpm store or provider state. With the broker off, the sandbox still binds the
home's `auth.json` writable at `/tmp/auth.json`, so the CLI's refreshes persist
to it; nothing else in the directory is readable or writable. With the key
unset, a broker-off sandbox leaves `~/.codex` as before.

Setting the key does not create a login. That is one device login into the
directory (`CODEX_HOME=<dir> codex login`), an operator step. Whether a second
device login on the same account leaves the first session valid is not settled
from source; if it does not, the existing login stops working at that moment.

Activate in this order: log in first, then set the key, then restart. A sandbox
only hides a directory that exists when it starts. A host job (up to 48 hours by
default) or an actor run started while the key names a directory that does not
exist yet sees whatever the login later writes there.

## When the CLI refreshes

A ChatGPT-login access token lives 240 hours (ten days), not an hour. The CLI
refreshes it (`should_refresh_proactively` in `codex-rs/login/src/auth/manager.rs`,
the same in 0.144.4 and 0.159.3):

- when the access token's expiry can be parsed: within 5 minutes of that expiry
  (`CHATGPT_ACCESS_TOKEN_REFRESH_WINDOW_MINUTES = 5`), and at no other time;
- only when the expiry cannot be parsed: when `last_refresh` is more than 8 days
  old (`TOKEN_REFRESH_INTERVAL = 8`);
- after a 401 from the backend: it reloads the file, then refreshes.

So a natural brokered rotation happens about ten days after a login, at the
token's expiry minus five minutes.

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
   restart it. The canary window lasts until at least one natural rotation,
   which is the token's expiry minus five minutes: up to ten days after the
   login (see [When the CLI refreshes](#when-the-cli-refreshes)). No unbrokered
   process may refresh that login over the window. On a host where prod and
   staging share one login, that would stop prod for up to ten days, so give
   the canary its own login with `providers.codex.home` instead; only the
   processes on that directory need draining. The canary plan and what a
   dedicated login cannot prove about production are on #782. Over the window:
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

# Dedicated Codex home: the resolver and its defaults, config validation,
# the sandbox, host-job and E2E hides, the E2E projection (with real bwrap
# probes, including a symlinked home), the broker-off sandbox under real bwrap
# (hidden beneath the actor's writable root, /tmp/auth.json still persisting, a
# missing home still launching), the /status probe's refresh persisting to the
# configured home, and the /model probe's CODEX_HOME.
pnpm vitest run src/providers/codex-home.test.ts src/config/loader.test.ts \
  src/providers/sandbox.test.ts src/providers/sandbox-codex-auth.integration.test.ts \
  src/actor/host-job-runner.test.ts \
  src/actor/e2e-instance-manager.test.ts src/e2e/provision.test.ts \
  src/providers/codex-status-scrape-auth.integration.test.ts \
  src/providers/model-scrape.test.ts

# Real driver: CodexProvider.run under bwrap against each CLI listed
# (colon-separated). Omitted, it uses `codex` on PATH. A missing CLI or bwrap
# shows as a skipped test, which is missing evidence, not a pass. It includes
# the dedicated-home cases: a hostile child with the configured home inside
# its own workspace, and rotations persisting to the configured home with a
# decoy default home left untouched.
RUSA_CODEX_DRIVER_BINS=/path/to/codex-0.144.4:/path/to/codex-current \
  pnpm vitest run src/providers/codex-auth-broker.integration.test.ts
```
