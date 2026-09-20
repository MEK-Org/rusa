# Quota coordinator — operations runbook

Companion to [`quota-coordinator-design.md`](./quota-coordinator-design.md) §9,
covering the operational surface delivered by issue #360: the `systemd --user`
units, the backup/restore procedure, the metric stream and its alert
conditions, and the two rollback drills §9.5 requires before stage 3 of the
rollout in §8.3.

Everything here is runnable. The drill transcripts at the end are the recorded
output of the drill script in this repository, not a worked example.

---

## 1. Units

In the target architecture, the coordinator is provisioned once per **pool** —
the set of instances sharing a quota database — and instances across
environments (such as production and staging) are clients of that single shared
coordinator.

Today, the shipped installer (`packages/rusa/src/commands/install-service.ts`)
installs coordinator units per environment (`rusa install-quota-coordinator --environment <env>`),
deriving unit names from the instance's service basename (`<serviceBasename>-quota-coordinator.service`).
In a multi-environment pool on a shared host, the coordinator is provisioned once
for the pool, and other environments connect to its shared socket as clients rather
than running duplicate coordinators. Decoupling unit installation from instance/environment
basenames into an independent pool-level installer is tracked as a follow-up gap.

The coordinator runs under two `systemd --user` units:

| Unit | Role |
| --- | --- |
| `<serviceBasename>-quota-coordinator.service` | the coordinator itself (`rusa quota-coordinator --home <RUSA_HOME>`) |
| `<serviceBasename>-quota-coordinator-alert.service` | `OnFailure=` companion; notifies through the configured error chat |

```bash
rusa install-quota-coordinator
rusa install-quota-coordinator --no-restart      # write and enable, start later
```

### What the unit carries, and why

The coordinator *scrapes*, so its unit is not a stripped-down copy of the
orchestrator unit (design §9.1). It sets:

- `Environment=PATH=<the resolved user PATH>` — the provider CLIs, `bwrap` and
  `tmux` all have to be findable; systemd's default `/usr/bin:/bin` finds none
  of them.
- `Environment=XDG_RUNTIME_DIR=<runtime dir>` — the tmux socket and the
  coordinator's own listener. Set explicitly because a coordinator that falls
  back to `/tmp` for its socket is one whose clients cannot find it.
- `Environment=RUSA_LOG_FORMAT=json` — the metric series ride the structured
  logger (§3 below), and JSON is what makes a series selectable by field from
  the journal. The unit deliberately does **not** set `RUSA_LOG_LEVEL`: the
  metric records are emitted at `info` under their own event name, so getting
  them costs nothing and no deployment has to run at a level that also turns on
  every other component's debug output.
- `EnvironmentFile=-$RUSA_HOME/.env`, `Restart=on-failure`, `RestartSec=10`,
  `StartLimitIntervalSec=300`/`StartLimitBurst=5`, journal output.

Install-time preflight creates `$RUSA_HOME/workers` (the probe creates
`quota-probe-<provider>/` under it) and fails if it is not writable; missing
`bwrap` or `tmux` is a warning, since a host may install them afterwards.

Instance units declare `After=`/`Wants=` the coordinator unit — never
`Requires=`. Under v1 an instance without the coordinator is degraded (it paces
on its last applied interval), not stopped, and `Requires=` would turn a
coordinator failure into an orchestrator outage. `rusa install-service` writes
the ordering lines only when the coordinator unit already exists on disk, so an
instance with no coordinator does not log a dependency warning on every start.

**Install order does not matter.** The common case is the other one — the
instance was installed months ago, and the coordinator arrives now — so
`rusa install-quota-coordinator` retrofits the two lines into a matching
instance unit it finds on disk, before its `daemon-reload`. It is idempotent
(a unit that already orders after the coordinator is left byte-for-byte alone)
and it does **not** restart the instance: the ordering is a boot-time
relationship, it applies on the instance's next start, and restarting an
orchestrator mid-run to install a `Wants=` would cost more than it buys. The
command reports which of the two happened.

### Checking it

```bash
systemctl --user status <basename>-quota-coordinator.service
journalctl --user -u <basename>-quota-coordinator.service -f
curl --unix-socket "$XDG_RUNTIME_DIR/rusa-quota/coordinator.sock" \
  http://localhost/v1/readyz
```

`/v1/healthz` answers for the process; `/v1/readyz` answers for the data, and
carries the per-provider scrape outcome (`status`, `attempts`, `failures`,
`lastAttemptAt`, `error`). A coordinator whose probes are broken still passes
`healthz` — that asymmetry is the point, and drill 2 rehearses it.

### Runtime manual quota readings

Every `/v1/` path stays GET-only (design §5.2, Criterion 7). The two write
routes therefore live under `/internal/`. The coordinator socket remains the
authorization boundary: these write calls are available only to a process that
can use the mode-`0600` Unix socket. There is no network listener and no
additional bearer token. Every provider starts in `scrape` mode. Switching mode
returns a monotonically increasing `generation`; keep that value with the source
reading and send it back on the observation write. It fences an observation
delayed across a mode transition, and it fences a scrape that was already in
flight when the lane went manual — that scrape writes nothing, even if the lane
has returned to `scrape` mode by the time it lands, because its generation is
gone.

```bash
quota_socket="$XDG_RUNTIME_DIR/rusa-quota/coordinator.sock"

# Stop collection and accept external observations. Record generation from the response.
curl --unix-socket "$quota_socket" -sS -X POST \
  -H 'Content-Type: application/json' \
  http://localhost/internal/quota/reading-mode \
  --data '{"provider":"claude","mode":"manual"}'
# {"provider":"claude","mode":"manual","generation":1,...}

# Submit one real reading. `scrapedAt` is when the source was observed, never
# when this request was sent. The idempotency key is retained durably.
curl --unix-socket "$quota_socket" -sS -X POST \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: claude-usage-2026-09-20T03:30:00Z' \
  http://localhost/internal/quota/observations \
  --data '{
    "provider":"claude",
    "generation":1,
    "observation":{
      "provider":"claude",
      "status":"available",
      "scrapedAt":"2026-09-20T03:30:00.000Z",
      "limits":[{
        "label":"Weekly","kind":"weekly","percentLeft":42,
        "resetAtIso":"2026-09-24T00:00:00.000Z",
        "scope":{"provider":"claude"}}]
    }
  }'
# {"provider":"claude","observedAt":"2026-09-20T03:30:00.000Z","duplicate":false,...}

# Restore native collection. This increments the generation only when it is a
# real transition; wait for a new successful scrape before treating it as fresh.
curl --unix-socket "$quota_socket" -sS -X POST \
  -H 'Content-Type: application/json' \
  http://localhost/internal/quota/reading-mode \
  --data '{"provider":"claude","mode":"scrape"}'
```

`/v1/readyz` shows each configured lane's current
`scrapes.<provider>.readingMode: {mode, generation}`, so a lane left in
`manual` is visible without touching the database.

Responses, in the order the coordinator checks them:

- HTTP 400 names the offending field (`Idempotency-Key`, `generation`,
  `observation.limits[0].percentLeft must be between 0 and 100`, …). A body
  over 64 KiB is refused (a full multi-limit snapshot is a few KiB). A
  `scrapedAt` more than 5 minutes in the future is refused — one observation
  slot of clock skew between the source panel and the coordinator host. A
  `resetAtIso` already in the past is accepted: it is what a panel shows in the
  moments after a window rolls over, and the store treats it as a rollover.
- HTTP 409 `manual_mode_required` in `scrape` mode and `mode_generation_mismatch`
  for an old generation. Authority is checked before replay: replaying an
  already-accepted key after the lane left `manual`, or under a superseded
  generation, gets these codes rather than `duplicate: true`.
- HTTP 409 `idempotency_conflict` when the same key arrives with a different
  body. `duplicate: true` (HTTP 200) means the same key with byte-identical
  content; nothing is written again.
- HTTP 409 `stale_observation` for old, out-of-order, or same-slot readings.

None of the rejections changes `/v1/quota`, `/v1/throttle`, history, or its
reported age. An accepted reading is stored as an ordinary `quota_scrapes`
evidence row whose `raw_output` is `{"source":"manual", "idempotencyKey",
"generation"}`, plus its `quota_observations`
rows, so latest, history, hydration, and pruning need no manual-specific path.
The receipt row keeps only a sha256 fingerprint of the request, never the body,
and ages out with the 30-day raw-evidence retention; a retry after that window
is refused as `stale_observation` because it is older than the latest accepted
reading.

Manual mode suppresses every coordinator scraper for that lane, including
Kimi. It is not a request to use a different Kimi fallback. The accepted
observation enters the normal durable observation and PID-controller path, so
inspect both views after a write:

```bash
curl --unix-socket "$quota_socket" -sS 'http://localhost/v1/quota?provider=claude'
curl --unix-socket "$quota_socket" -sS 'http://localhost/v1/throttle?provider=claude'
```

#### Deploy and rollback order

1. Take the normal coordinator SQLite backup, stop the coordinator, deploy the
   v2 binary, and start it. Its one-way v1→v2 migration only adds
   `quota_provider_reading_modes` and `quota_manual_observation_receipts`; it
   does not copy or backfill quota evidence.
2. Confirm `/v1/readyz` (every lane reports `readingMode.mode: "scrape"`),
   switch one staging provider to `manual`, submit a current reading using the
   returned generation, and verify the two reads above show that exact
   `scrapedAt` and the resulting pacing decision.
3. To roll back the operational mode, POST `scrape`, then wait for a successful
   new provider scrape before relying on automatic collection again. The manual
   receipts remain as idempotency evidence for the raw retention window.
4. Do not run a pre-v2 coordinator binary against this database: its schema
   guard correctly refuses `user_version = 2`. That includes
   `rusa quota-pacing-reset`, which opens the same database — run it from the
   v2 build. A binary rollback therefore requires stopping the coordinator and
   restoring the pre-deploy SQLite backup under the existing restore procedure;
   it intentionally loses manual-mode state and receipts created after that
   backup.

### #499 staging proof and the stage-3 handoff

The shipped coordinator has no probe-off switch, and the shipped client has no
compare-only mode: configuring its socket selects the normal client path and
applies the coordinator publication. The probe-off stage and compare-only stage
in the design are still follow-up work ([#502](https://github.com/MEK-Org/rusa/issues/502)
and [#503](https://github.com/MEK-Org/rusa/issues/503)); neither was executed by
#499.

Instead, #499 used a separate staging coordinator with a fresh staging database
and its normal probe loop to prove probing outside the instance, then restarted
the staging instance on the ordinary production client path and observed it
connect (`/api/health` reported `quota_client_service_connected: 1`;
[#499 comment 5695348753](https://github.com/MEK-Org/rusa/issues/499#issuecomment-5695348753)).
That record does not include an observation of launches being paced from the
publication under traffic; the paced-launch check is the post-flip
verification in step 7 below, not recorded staging history. Before the
synchronized stage-3 flip, verify that `/v1/readyz` reports `ready: true` and
that each configured provider lane in `scrapes[provider]` has `status: "ok"`.
The pre-flip gate requires all four quota lanes (`claude`, `codex`, `agy`, and
`kimi`) to report successful (`ok`) scrapes. Treat an `unknown`, absent, or
unrecorded provider (or any provider reporting `error` or `pending`) as a
failed gate, not as a healthy provider. The recorded staging result establishes
a successful `claude` scrape only; it makes no health claim for the other three.
(Note: while `kimi` is unsupported for dashboard UI header ring probing due to
auth-mutation concerns in `config/types.ts:188`, the coordinator's collection loop
includes `kimi` in `QUOTA_THROTTLE_PROVIDERS` via `QuotaService` /
`scrapeKimiUsage`; if kimi is unconfigured or failing, the gate does not pass.)

The stage-3 handoff takes one of two shapes; pick by the state found at the
bless boundary:

- **No coordinator database exists yet** (the service-owned target path is
  absent): run the designed flip, `rusa quota-coordinator --relocate`.
  `relocateQuotaDatabase` (`packages/rusa/src/quota/relocate.ts`) checkpoints
  and atomically renames the stopped legacy `quota.db` into service ownership,
  keeping controller memory byte-for-byte, and creates the path fence itself.
  Its rollback is the inverse by hand: stop the service, `rmdir` the fence,
  rename the file back (design §8.2, §8.3).
- **A coordinator is already serving a copied database** (the shape the
  2026-09-16 production rollout executed): that database stays authoritative.
  Accept divergence between legacy production and the coordinator database; do
  not reconcile or replace it from legacy production. `--relocate` is not run
  here because `relocateQuotaDatabase` refuses when both files exist (`both ...
  exist; decide which is authoritative before the flip`) — a safety interlock,
  not a prohibition. Instead, old instances are quiesced, the legacy database
  is backed up and archived, and the path fence is created directly at the
  legacy path, as in the procedure below.

Provenance for the second shape: the operator (repository maintainer) set the
sequence in operator chat on 2026-09-16 — bring the shared coordinator up from
a clone of the shared quota database, point staging at it, confirm health, then
switch production (`gchat:spaces/hPHAPyAAAAE/messages/8MFfz0Uu4EQ.8MFfz0Uu4EQ`)
— and ruled that divergence between the old and new databases is accepted and
the legacy history is not reconciled once the shared coordinator is up
(`gchat:spaces/hPHAPyAAAAE/messages/Z5DKKROCBtM.Z5DKKROCBtM`). The rollout
reports in the same space record the pool coordinator running from that seeded
copy with staging switched to it
(`gchat:spaces/hPHAPyAAAAE/messages/Fv6ZIvPB9Ew.Fv6ZIvPB9Ew`) and production
switched with the legacy database backed up, archived and fenced
(`gchat:spaces/hPHAPyAAAAE/messages/eBoU0jHVVNk.eBoU0jHVVNk`). The ids are
opaque outside the operator space; this section and
[#501](https://github.com/MEK-Org/rusa/issues/501) are the public record.

#### Final handoff procedure (copied-database shape)

1. **Stop and fence old instance writers:** Stop production instances to ensure
   no new transactions are written to the legacy SQLite database.
2. **Take the legacy backup:** Take a self-contained backup of the stopped
   legacy database using the shipped command:
   ```bash
   rusa quota-backup --database /path/to/legacy/quota.db
   ```
   `backupQuotaDatabase()` runs `VACUUM INTO` on a read-only connection,
   renames the result into place and reports its size; it does not run
   `PRAGMA integrity_check` or the schema guard. Those checks
   (`assertRestorableDatabase`) run inside `rusa quota-restore` before it
   writes anything, so a damaged backup fails the restore rather than being
   restored. There is no shipped pre-handoff verification command; an operator
   who wants the integrity check before archiving the legacy file in step 4 can
   open the backup read-only with the `sqlite3` CLI, if present, and run
   `PRAGMA integrity_check` by hand.
3. **Preserve coordinator DB:** Leave the live coordinator database untouched.
   The copied DB already serving the shared coordinator remains authoritative.
   Do not reconcile or replace it from legacy production.
4. **Archive legacy database:** Move the legacy `quota.db` plus any associated
   `-wal` and `-shm` files into a recoverable archive location.
5. **Create the path fence:** Create the exact empty mode-0700 directory at the
   legacy path:
   ```bash
   mkdir -m 0700 /path/to/legacy/quota.db
   ```
   Any legacy instance process attempting to open the legacy path fails
   immediately with `EISDIR`/`SQLITE_CANTOPEN`.
6. **Switch production config:** Switch production instance configuration to
   the already-running shared socket (`quota.coordinator.socketPath`), clearing
   or omitting `quota.databasePath` for instances.
7. **Verify client operation:** Verify that `/v1/readyz` passes for all
   configured providers, check published throttle values on `/v1/throttle`, and
   verify client launch pacing under real traffic.
8. **Repoint staging to the shared coordinator and remove temporary staging unit:**
   Repoint staging configuration (`config.yaml`) to the shared production
   coordinator socket (`quota.coordinator.socketPath`).
   To remove the temporary staging coordinator service and revert the staging
   instance's unit ordering:
   a. Stop and disable the temporary staging coordinator and alert units:
      ```bash
      systemctl --user stop <staging-basename>-quota-coordinator.service <staging-basename>-quota-coordinator-alert.service
      systemctl --user disable <staging-basename>-quota-coordinator.service <staging-basename>-quota-coordinator-alert.service
      ```
   b. Remove the staging coordinator unit files from `~/.config/systemd/user/`:
      ```bash
      rm -f ~/.config/systemd/user/<staging-basename>-quota-coordinator.service \
            ~/.config/systemd/user/<staging-basename>-quota-coordinator-alert.service
      ```
   c. Remove the `After=` and `Wants=` coordinator ordering lines from the staging
      instance unit (`~/.config/systemd/user/<staging-basename>.service`):
      Remove `After=<staging-basename>-quota-coordinator.service` and
      `Wants=<staging-basename>-quota-coordinator.service` (or re-run
      `rusa install-service --environment staging --no-restart`).
   d. Reload the systemd user daemon:
      ```bash
      systemctl --user daemon-reload
      systemctl --user reset-failed
      ```
   e. Restart the staging instance to begin consuming the shared production coordinator socket:
      ```bash
      systemctl --user restart <staging-basename>.service
      ```
   The end state is one coordinator per pool, with staging instances connecting
   to the shared pool socket as clients.

#### Rollback procedure

If the flip must be rolled back:
1. **Preserve coordinator DB:** Leave the live coordinator database untouched.
2. **Stop production client:** Stop production instances (`systemctl --user stop <basename>.service`).
3. **Stop the shared coordinator:** Stop the shared coordinator unit:
   ```bash
   systemctl --user stop <basename>-quota-coordinator.service
   ```
   This ensures the coordinator socket is no longer listening. A staging
   instance still pointed at this socket does not resume in-process scraping —
   v1 has no local fallback source. Its client keeps each provider's last
   applied interval, and once `hardStaleAfterMs` (default 1 hour) has passed
   since the last successful read it widens that lane to `maxIntervalSeconds`
   (default 3600) on its own (`getLastAppliedInterval`,
   `packages/rusa/src/quota/coordinator-client.ts`; design §5.7 rules 0 and
   2). Stop staging instead if reverting staging concurrently.
4. **Remove path fence:** Remove the empty directory path fence at the legacy
   database path:
   ```bash
   rmdir /path/to/legacy/quota.db
   ```
5. **Restore legacy database:** Restore the legacy database from the backup
   taken in handoff step 2:
   ```bash
   rusa quota-restore --database /path/to/legacy/quota.db --from /path/to/backup.db
   ```
   *Note:* Restoring via `rusa quota-restore` is preferred over moving the
   archived files back because `quota-restore` is where the backup is verified:
   it runs `PRAGMA integrity_check` and the schema guard on the backup
   (`assertRestorableDatabase`) before writing, and explicitly checks that the coordinator
   socket is stopped or unreachable (`isCoordinatorListening` returns false),
   ensuring no active coordinator writer conflicts with the restore. The
   coordinator database is preserved untouched for post-mortem inspection,
   accepting permanent divergence between the coordinator DB and the restored
   legacy DB.
6. **Restore legacy config:** Restore legacy instance configuration (re-enabling
   `quota.databasePath` and clearing `quota.coordinator.socketPath`).
7. **Restart production:** Restart production instances (`systemctl --user start <basename>.service`)
   and verify local in-process scraping and pacing resume.
8. **Coordinator lifecycle after rollback:**
   If staging is to continue using the shared coordinator, restart the coordinator
   unit (`systemctl --user start <basename>-quota-coordinator.service`); its database
   was preserved untouched. If the entire pool is reverting to pre-coordinator
   operation, leave the coordinator unit stopped and disabled.

### Configuration

```yaml
quota:
  coordinator:
    databasePath: data/quota-coordinator.db   # relative paths resolve under RUSA_HOME
    socketPath: /run/user/1000/rusa-quota/coordinator.sock
    backupDir: data/quota-backups             # optional; default is <db dir>/backups
    backupRetention: 14                       # optional; positive integer, default 14
```

---

## 2. Backup and restore

The coordinator is the database's only writer, which is what makes backup
correct for the first time (design §9.2). Backups are taken with SQLite's
`VACUUM INTO` over a **read-only** connection — never a file copy: the database
is WAL-mode, and copying the `.db` without its `-wal` produces a database that
opens, answers queries, and is missing every transaction still in the log.

A backup taken this way is one self-contained file with no `-wal` of its own, so
it can be moved or archived as a single object. The vacuum writes
`quota-<YYYYMMDDTHHMMSS>Z.db.partial` and renames it into place on success, so an
interrupted backup leaves nothing retention would count as one of the copies.

- **Cadence:** daily, and the deadline belongs to the backup directory rather
  than to the process. On start the coordinator backs up only if the newest
  existing backup is already a day old — otherwise a service that restarts five
  times in five minutes (which the start limit tolerates) would evict five of
  the fourteen daily copies with five copies of the same minute. When it is not
  due, the first timer is set for the **age remaining**, not a fresh full day: a
  restart with a 23-hour-old backup schedules one in an hour, not in
  twenty-five, so a restart cannot open a 47-hour gap and a restart loop cannot
  postpone the backup indefinitely. After that first backup the timer settles
  into the daily cadence.
- **Where it runs:** on the coordinator's event loop, on purpose. `VACUUM INTO`
  is synchronous, so for its duration the listener answers nothing — 205–390 ms
  against the 30-day database in the drill below, against a 5-second client
  request timeout. Once a day, bounded by a retention-bound database, the pause
  is cheaper than a second process holding the database open to hide it.
  `rusa quota-backup` runs in its own process and does not pause the service at
  all.
- **At boot:** if a backup is due at start, it is taken *before* the socket is
  announced ready — so the copy is of the database as it was before this process
  wrote anything to it, which is the copy an operator restoring after a bad
  deploy wants. It is also why the first `start → /v1/readyz` in the drill below
  is slower than the restarts.
- **Retention:** 14 copies, pruned after each backup. Only files matching the
  backup name pattern are considered, so an ad-hoc copy parked in the same
  directory is not deleted out from under the operator.
- **Unchanged:** the 30-day retention for raw scrapes and observations, and the
  rule that the newest reasoned observation per `(provider, kind)` is never
  pruned (design §9.4). v1 adds no table.

### Commands

```bash
rusa quota-backup                 # take one now; safe against a running coordinator
rusa quota-backup --list          # what retention currently holds, newest last
rusa quota-restore                # restore the newest backup
rusa quota-restore --from /path/to/quota-20260915T205722Z.db
```

`rusa quota-backup` is the same code path the daily timer runs, exposed as a
command because §8.3 stage 3 requires one mandatory backup immediately before
the flip — a step performed on demand, not one that can wait for a timer.

### Restore procedure (design §9.2)

1. Stop the instances.
2. Stop the coordinator:
   `systemctl --user stop <basename>-quota-coordinator.service`.
3. `rusa quota-restore` (optionally `--from`).
4. Start the coordinator:
   `systemctl --user start <basename>-quota-coordinator.service`.
5. Check `/v1/readyz` and the published throttle on `/v1/throttle`.
6. Start the instances.

The order of operations is what makes this safe to run in the state an operator
actually restores in — a coordinator down, and quite possibly a live database
that is the reason for the restore:

- **the coordinator is down** — a listener on the socket makes the restore
  refuse, because restoring under a live coordinator leaves it holding a handle
  to a database that is no longer the one on disk;
- **the backup is whole** — `PRAGMA integrity_check` and the quota schema guard
  run against the backup *before* the live file is touched, so a corrupt or
  newer-schema copy fails while the database it would have replaced is intact;
- **the restored copy is built beside the live file, not over it** — the vacuum
  writes `<db>.restore-partial`, which is then checked the same way the backup
  was (a full disk can leave a truncated file that still exists), and only then
  installed with a single `rename`. A failure anywhere up to that point — no
  space, no permission, a bad copy — leaves the configured database exactly as
  it was. The configured path never passes through "absent";
- **the replaced database is kept, even when it cannot be opened** — archived to
  `<db>.pre-restore-<stamp>Z.db` with the same `VACUUM INTO`, and its stale
  `-wal`/`-shm` removed. If that open or vacuum fails — a corrupt live file
  being the likeliest reason anyone is restoring — the raw `.db`, `-wal` and
  `-shm` are renamed aside under the same archive name instead, so the bytes
  survive and the restore proceeds rather than being blocked by the very file it
  exists to replace. The result reports which happened (`archivedBy`:
  `vacuum` or `rename`). A drill that cannot be undone is not a drill.

### Pacing reset

```bash
rusa quota-pacing-reset --provider codex   # safe against a running coordinator
```

When a provider's usage is reset out of band — a purchased top-up, a support
reset, a plan change — the controller's memory describes a budget that no
longer exists: the integral has accumulated a standing error against the old
window and the commanded period was tuned to it. `rusa quota-pacing-reset`
clears that memory for **one** provider and nothing else:

- **cleared:** the derivative filter state, the integral area, and the current
  period on every reasoned observation for the provider. The published
  `intervalSeconds` drops to `0` at once, and the next observation is reasoned
  as a cold start — proportional term alone, period smoothed up from zero;
- **kept:** the observations themselves (percent left, reset instants), their
  `controllerError` history, the proportional gain (a constant), and every
  other provider's learned state.

The reset covers **every window kind** on that provider's lane (weekly, five
hourly, and so on). Pacing is applied per lane and the widest window governs
it, so resetting a single kind would leave another kind's stale period in
charge and the reset would not be one.

It runs in its own process like `rusa quota-backup`, so the coordinator stays
up. The write is a `BEGIN IMMEDIATE` transaction, taking its lock up front
rather than upgrading partway, so it cannot deadlock against the collection
loop; in WAL mode with the connection's busy timeout, whichever process arrives
second waits rather than failing, so neither side sees `SQLITE_BUSY` under
ordinary contention. The coordinator reads the published throttle from the file
on every request, so each instance picks the reset up on its next throttle poll.
The update is durable — restarting the coordinator afterwards cannot bring the
old memory back.

The command reports what it did through the ordinary log stream, which renders
as a readable line on a terminal and as JSON when redirected. The counts are
rows across every window kind on the lane, so a provider that reports a weekly
and a five-hour window shows twice the observations of one that reports only
a weekly window:

```
INFO  quota-pacing-reset quota_pacing_reset databasePath=... provider=codex clearedDecisions=26 observations=26
```

The record is logged at `info`, the same as `quota-backup`'s. A shell running
with `RUSA_LOG_LEVEL` (or `logging.level`) at `warn` or above sees only the
exit code; run it at `info` to see the counts.

The command is built for an operator, but "operator" includes an actor with a
shell: an actor asked to reset a provider's pacing may run this on request, the
same way it runs `rusa quota-backup` — the guard is the provider name, not who
types it.

#### What it costs: the provider's retained period history

`interval_seconds` is the column the controller looks itself up by — it reads
the newest row that has one. Clearing only the newest would therefore promote
the row before it and make an *older* period current again, which is the exact
failure the reset exists to prevent. So every retained decision for the
provider is cleared, and the cost is that the provider's past periods go null:
`listHistorySince` reports `intervalSeconds: null` for its earlier points and
dashboard period charts lose that provider's pre-reset line.

That cost is accepted deliberately. Keeping the history would need a reset
marker the lookup could read past — a new column or table, and so a schema
migration. The request in #521 asks only for the zeroing; the no-migration
boundary comes from its triage, which commissioned the change as a focused,
no-schema reset. Zeroing the newest row in place instead of nulling it — which
would keep every older period — was rejected because `0` is a period the
controller genuinely commands when a lane is ahead of pace, so a zeroed row is
indistinguishable from a real decision made at that instant; `NULL` is the one
value the controller never writes, which is what lets the published status say
"reset, no decision yet" (`governingBucketKey: null`). Writing a synthetic
zero-period row was rejected for the same reason. The loss is also bounded:
observations are retained for thirty days, so the missing pre-reset line is
at most thirty days of a series that ages out on that schedule anyway. What
survives is the evidence and the policy signal — every observation, and every
`controllerError`, which is what those dashboards chart as pace error.

#### An exhausted provider stays gated

The reset clears pacing policy. It does **not** assert that quota came back.

If the newest observation says the provider is exhausted, that observation is
evidence and is preserved, so the lane stays deferred until its recorded reset
instant even though the period is now zero. Releasing it would mean acting on
an operator's word that the budget refilled, and launching work at a provider
that may still be refusing it. A fresh scrape showing real headroom is what
clears the gate, normally within one collection cycle.

If the intent is "the usage reset already happened, stop waiting", let the next
scrape land — it will both clear the gate and give the controller its first
honest observation to pace from.

---

## 3. Metrics and alerts

There is no metrics backend in this repository. The ten series of design §9.3
are emitted through the structured logger landed for #177, as records with a
stable event name (`quota_metric`) and `metric`/`type`/`value` fields plus the
series' labels — so a series is selectable by field from the journal today, and
an exporter added later can read the same records without migrating a second
emission path.

```bash
journalctl --user -u <basename>-quota-coordinator.service -o cat \
  | jq 'select(.metric == "quota_service_scrapes_total")'
```

Counter records carry the **increment** in `value`, not a running total: the
record stream is the series, so a reader sums, and a restart shows up as the gap
it is rather than as a counter silently resetting to zero.

Records are emitted at **`info`**, the default level, under the distinct event
name `quota_metric` — so no unit has to run at `debug` to have metrics, and an
operator who does not want them filters on the name
(`jq 'select(.msg != "quota_metric")'`) rather than losing every other
component's debug output to get them. The volume is a few records per provider
per tick at the shipped five-minute cadence; the drill transcripts below report
the rate each drill actually observed, at the much faster tick the drill runs.

| Metric | Type | Labels | Emitted by |
| --- | --- | --- | --- |
| `quota_service_scrapes_total` | counter | `provider`, `outcome` | service |
| `quota_service_scrape_seconds` | histogram | `provider` | service |
| `quota_service_parses_total` | counter | `provider`, `outcome` | service |
| `quota_service_observations_total` | counter | `provider`, `result` | service |
| `quota_service_controller_steps_total` | counter | `provider` | service |
| `quota_service_published_interval_seconds` | gauge | `provider` | service |
| `quota_service_snapshot_age_seconds` | gauge | `provider` | service |
| `quota_service_reads_total` | counter | `path`, `status` | service |
| `quota_client_service_connected` | gauge | `source` | instance |
| `quota_client_applied_interval_seconds` | gauge | `source`, `provider` | instance |

The last two are emitted by the instance, never by the service: a service cannot
count the clients it cannot see, so a service-side "degraded clients" gauge
would read zero in exactly the partial failure that matters (§5.7).

The two published-value gauges are emitted **once per provider per controller
step**, from the collection loop — not per client read. A gauge sampled on the
read path would be a function of how often clients happened to ask: a pool of
twenty instances polling would emit the same unchanged interval hundreds of
times an hour, and a pool that went quiet would emit nothing while the
controller kept moving. How often clients read is `quota_service_reads_total`,
which is a counter and already carries that rate.

Alert on:

| Condition | Why |
| --- | --- |
| `quota_service_scrapes_total{outcome="failure"}` rising, per provider | under A5 this is the pool's only sensor; when it fails everything downstream keeps serving a frozen value and nothing else complains |
| `quota_service_snapshot_age_seconds` past `hardStaleAfterMs` | the published value has stopped tracking reality |
| `quota_client_service_connected = 0` on any instance for more than a few ticks | v1 does not stop that instance launching, which is why it needs an alert rather than a failure |
| published vs. applied interval diverging for more than two ticks on any instance | criterion 12b, checked in production across more instances than a fixture provisions |

The two drills below exercise the first and third of these end to end.

---

## 4. Rollback drills (design §9.5)

Both drills are runnable against a scratch deployment:

```bash
pnpm --filter rusa exec tsup                       # the drill runs the real CLI from dist/
pnpm --filter rusa run drill:quota-rollback -- --transcript /tmp/quota-drill.md
pnpm --filter rusa run drill:quota-rollback -- --drill probes-failing
pnpm --filter rusa run drill:quota-rollback -- --help
```

`packages/rusa/scripts/quota-rollback-drill.mjs` builds a fresh temporary
`RUSA_HOME` with its own database, socket, backup directory and workers
directory, seeds 30 days of five-minute scrapes so the backup is measured
against a retention-bound database rather than an empty one, starts the real
coordinator process, and drives it through real `QuotaCoordinatorClient`
readers. Every check is asserted, and a failing check fails the run.

**No provider CLI runs, and no provider account is touched — enforced, not
assumed.** The coordinator child is spawned with a constructed environment
(this process's own is not inherited) whose `PATH` contains only a directory of
stub shims and whose `HOME`/`XDG_*` point inside the scratch directory. So
`codex`, `claude`, `agy`, `antigravity`, `kimi`, `bash`, `tmux` and `bwrap` all
resolve to a shim that records the attempt and exits 127, and a probe that went
looking for `~/.codex/auth.json` finds an empty home rather than the invoking
user's credentials. Both drills assert the shim log is empty, so a drill that
did reach a CLI fails rather than passing quietly.

What that is *not* is a sandbox: the coordinator is an ordinary child process,
and code under test that wrote to an absolute path outside the scratch directory
would not be stopped. The guarantee is over what the drill and its configuration
point at, plus the two doors — `PATH` and `HOME` — through which a probe would
otherwise reach the real provider CLIs and the real credentials.

Each drill gets its own scratch deployment. The two want opposite probe
conditions — drill 1 seeds a reading 30 seconds old so boot hydration keeps
every provider inside its TTL and no probe is due, drill 2 seeds one 45 minutes
old so the first tick probes for real — and fresh readers mean one drill's
client metric samples cannot satisfy the other's alert assertion.

### Drill 1 — the service goes down mid-flight

Checks (a)–(e) of §9.5, then the §9.2 restore drill, then the Q7 measurement.

### Drill 2 — the service stays up and its probes fail

The failure v1 makes *quiet*. The drill points `workersDir` at a regular file,
so the probe fails when it tries to create `quota-probe-<provider>/` — before
any provider CLI runs. The drill asserts the failure it gets is that one (the
readiness error contains `ENOTDIR`) and not some other error that happens to
look like it, and asserts separately that the stub log stayed empty. On a
live deployment the same break surfaces at the first tick past the provider's
TTL (five minutes for most, thirty for codex); revoking the provider CLI's
session is the other way in.

### Recorded transcripts

Run of 2026-09-15 on the branch for issue #360, `--seed-days 30`,
`--tick-seconds 2`, client `hardStaleAfterMs` 4000, node v24.13.1. Scratch paths
are scrubbed to `<scratch>`. All 19 checks passed.

```text
Run: 2026-09-15T22:42:39.619Z · provider codex · seed 30 days · tick 2s · client hardStaleAfterMs 4000 · node v24.13.1
- 2026-09-15T22:42:52.971Z  scratch deployment seeded: 8641 parsed scrapes over 30 day(s), newest 30s old, in 13343 ms

### Drill 1 — service down mid-flight

- 2026-09-15T22:42:53.002Z  seeded database: 8640 scrapes, 8640 observations, 81498112 bytes (db + wal), newest observation 2026-09-15T22:42:09.628Z
- 2026-09-15T22:42:55.681Z  coordinator started; start → /v1/readyz 200: 2678 ms (this first boot includes the boot backup: the backup directory is empty, so one is due, and it is taken before readiness is announced)
- 2026-09-15T22:42:55.727Z  PASS  every instance reads a published interval — instance-a: applied 101.10862125538453s, instance-b: applied 101.10862125538453s
- 2026-09-15T22:42:55.727Z  published codex: intervalSeconds=101.10862125538453 updatedAt=2026-09-15T22:42:09.628Z governing=codex:weekly
- 2026-09-15T22:42:58.233Z  collection state after a tick: status=ok attempts=0 failures=0 lastAttemptAt=null (no probe due — newest reading is inside the provider TTL)
- 2026-09-15T22:42:58.624Z  backup (VACUUM INTO, read-only, service up): 390 ms, 80519168 bytes → <scratch>/quota/backups/quota-20260915T224258Z.db
- 2026-09-15T22:42:58.920Z  PASS  backup opens and passes integrity_check — retained: 2
- 2026-09-15T22:42:59.503Z  backup timed 3x on the same database: 390 ms, 335 ms, 205 ms
- 2026-09-15T22:42:59.648Z  coordinator stopped (SIGTERM): exit {"code":0,"signal":null} after 41 ms
- 2026-09-15T22:43:00.655Z  PASS  (a) each instance keeps its last applied interval while the service is down — 1048 ms into the outage, still inside hardStaleAfterMs (4000 ms): instance-a: applied 101.10862125538453s (connect ENOENT <scratch>/coordinator.sock); instance-b: applied 101.10862125538453s (connect ENOENT <scratch>/coordinator.sock)
- 2026-09-15T22:43:00.699Z  PASS  (b) no instance wrote to the quota database during the outage — observations 8640 → 8640, scrapes 8640 → 8640
- 2026-09-15T22:43:00.700Z  PASS  (c) quota_client_service_connected dropped to 0 on every instance and the alert condition fires — instance-a: 4 consecutive zero samples, instance-b: 4 consecutive zero samples
- 2026-09-15T22:43:03.863Z  PASS  (d) past hardStaleAfterMs (4000 ms) each instance widened to maxIntervalSeconds — instance-a: applied 3600s, instance-b: applied 3600s
- 2026-09-15T22:43:07.250Z  coordinator restarted; start → /v1/readyz 200: 3387 ms
- 2026-09-15T22:43:12.618Z  PASS  (e) published values resume from the same rows with no gap in quota_observations — all 8640 pre-stop observation rows present; published intervalSeconds 101.10862125538453 → 101.10862125538453, updatedAt 2026-09-15T22:42:09.628Z → 2026-09-15T22:42:09.628Z
- 2026-09-15T22:43:12.620Z  PASS  instances reconnect and apply the published interval again — instance-a: applied 101.10862125538453s, instance-b: applied 101.10862125538453s

### Restore drill (design §9.2)

- 2026-09-15T22:43:12.654Z  instances stopped (readers idle); coordinator stopped after 34 ms
- 2026-09-15T22:43:14.120Z  restored <scratch>/quota/backups/quota-20260915T224258Z.db over the database in 1304 ms; replaced file archived to <scratch>/quota/quota-coordinator.db.pre-restore-20260915T224312Z.db
- 2026-09-15T22:43:14.120Z  PASS  restore replaced the database — ok
- 2026-09-15T22:43:18.000Z  coordinator started on the restored database; start → /v1/readyz 200: 3880 ms
- 2026-09-15T22:43:18.208Z  PASS  readyz and the published throttle match the backed-up state — ready=true cold=false; published 101.10862125538453s; observations 8640
- 2026-09-15T22:43:18.210Z  PASS  instances started against the restored service apply its interval — instance-a: applied 101.10862125538453s, instance-b: applied 101.10862125538453s
- 2026-09-15T22:43:18.278Z  PASS  no provider CLI was reached: the stub PATH recorded nothing — stub invocation log empty
- 2026-09-15T22:43:18.278Z  27 quota_metric records over 25 s of drill (≈64.0/min at a 2s tick, against the shipped 300s default): quota_service_reads_total 13, quota_service_published_interval_seconds 7, quota_service_snapshot_age_seconds 7

### Measured stage-3 window (design Q7)

- 2026-09-15T22:43:18.278Z  database at measurement: 81498112 bytes (db + wal), 8640 scrapes, 8640 observations
- 2026-09-15T22:43:18.278Z  backup (VACUUM INTO, read-only, service up), 3 samples: 390 ms, 335 ms, 205 ms → median 335 ms, slowest 390 ms
- 2026-09-15T22:43:18.278Z  start → /v1/readyz, 3 samples: 2678 ms (cold start), 3387 ms (restart after the outage), 3880 ms (on the restored database) → median 3387 ms, slowest 3880 ms
- 2026-09-15T22:43:18.278Z  window = backup + start-to-readyz: median 3722 ms, slowest observed 4270 ms
- 2026-09-15T22:43:18.986Z  scratch deployment seeded: 289 parsed scrapes over 1 day(s), newest 2700s old, in 519 ms

### Drill 2 — service up, probes failing

- 2026-09-15T22:43:18.990Z  workers directory replaced by a regular file: <scratch>/home/workers
- 2026-09-15T22:43:21.794Z  coordinator started; start → /v1/readyz 200: 2804 ms
- 2026-09-15T22:43:21.808Z  published codex: intervalSeconds=56.492146878330274 updatedAt=2026-09-15T21:58:18.468Z
- 2026-09-15T22:43:26.328Z  PASS  healthz still passes — status 200 ok=true
- 2026-09-15T22:43:26.328Z  PASS  readyz reports the per-provider scrape failure — ready=true codex: status=error attempts=3 failures=3 lastAttemptAt=2026-09-15T22:43:25.771Z error=ENOTDIR: not a directory, mkdir '<scratch>/home/workers/quota-probe-codex' (first attempt seen: 1)
- 2026-09-15T22:43:26.328Z  PASS  the probe failed where it was broken — creating its working directory — and not somewhere else — error=ENOTDIR: not a directory, mkdir '<scratch>/home/workers/quota-probe-codex'
- 2026-09-15T22:43:26.329Z  PASS  quota_service_scrapes_total{outcome="failure"} is rising and the alert condition fires — 3 failure increments in the service's metric records
- 2026-09-15T22:43:32.359Z  PASS  clients keep applying the frozen interval without complaint — instance-a: applied 56.492146878330274s, updatedAt 2026-09-15T21:58:18.468Z; instance-b: applied 56.492146878330274s, updatedAt 2026-09-15T21:58:18.468Z
- 2026-09-15T22:43:32.359Z  PASS  quota_client_service_connected stayed at 1 — this failure is invisible to the connection alert — instance-a: always 1, instance-b: always 1
- 2026-09-15T22:43:32.362Z  database unchanged by the failing probes: 289 scrapes, 289 observations
- 2026-09-15T22:43:32.362Z  PASS  no provider CLI was reached: the probe failed before it could spawn one — stub invocation log empty
- 2026-09-15T22:43:32.362Z  36 quota_metric records over 13 s of drill (≈161.5/min at a 2s tick, against the shipped 300s default): quota_service_reads_total 12, quota_service_scrape_seconds 6, quota_service_scrapes_total 6, quota_service_published_interval_seconds 6, quota_service_snapshot_age_seconds 6
- 2026-09-15T22:43:32.447Z  coordinator stopped (SIGTERM): exit {"code":0,"signal":null} after 85 ms
```

### Measured stage-3 write-quiesce window (design Q7)

Design §13.3 Q7 asks for the window to be re-stated with a measurement attached
once the drill exists. From the run above, against an **81,498,112-byte database
(8,640 scrapes, 8,640 observations — the 30-day retention bound)**:

| Step | Samples | Median | Slowest |
| --- | --- | --- | --- |
| backup (`VACUUM INTO`, read-only, service up) | 390 ms, 335 ms, 205 ms | 335 ms | 390 ms |
| start → `/v1/readyz` 200 | 2,678 ms (cold start, includes the boot backup), 3,387 ms (after the outage), 3,880 ms (restored db) | 3,387 ms | 3,880 ms |
| **window = backup + start-to-readyz** | | **3,722 ms** | **4,270 ms** |

Three samples of each, because one `VACUUM INTO` measures page-cache warmth as
much as it measures database size — the three samples above fall from 390 ms to
205 ms as the cache warms — and because starts vary run to run. Read the slowest
column as the number to plan with, and the cold figure as the reason to take the
mandatory stage-3 backup rather than assume the last daily one is
representative. These numbers come from a shared, contended host; an earlier run
of the same drill on the same branch measured the same backup at 167 ms median
and starts around 1.5 s, which is the spread to expect between hosts and not a
change in behaviour.

The remaining stage-3 steps — stopping the instances, a rename, a `mkdir`, a
config edit, the process starts — are fixed cost and do not grow with the data,
so the backup remains the only step worth measuring. Restore of the same
database took 1,304 ms plus the 3,880 ms start that followed it.

These are numbers from a scratch deployment on one host, not a production
promise; re-run the drill on the target host before stage 3 and use its numbers.
