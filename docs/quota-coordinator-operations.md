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

`rusa install-quota-coordinator` writes two `systemd --user` units per
environment, named after the instance's service basename:

| Unit | Role |
| --- | --- |
| `<basename>-quota-coordinator.service` | the coordinator itself (`rusa quota-coordinator --home <RUSA_HOME>`) |
| `<basename>-quota-coordinator-alert.service` | `OnFailure=` companion; notifies through the configured error chat |

```bash
# Production; --environment staging installs the staging pair instead.
rusa install-quota-coordinator
rusa install-quota-coordinator --no-restart      # write and enable, start later
```

One coordinator per **pool** — the set of instances sharing a quota database.
It is a separate command from `rusa install-service` for that reason: installing
it implicitly with every instance would start a second collector against the
same providers, which is the duplicate probing the coordinator exists to remove.

### What the unit carries, and why

The coordinator *scrapes*, so its unit is not a stripped-down copy of the
orchestrator unit (design §9.1). It sets:

- `Environment=PATH=<the resolved user PATH>` — the provider CLIs, `bwrap` and
  `tmux` all have to be findable; systemd's default `/usr/bin:/bin` finds none
  of them.
- `Environment=XDG_RUNTIME_DIR=<runtime dir>` — the tmux socket and the
  coordinator's own listener. Set explicitly because a coordinator that falls
  back to `/tmp` for its socket is one whose clients cannot find it.
- `Environment=RUSA_LOG_LEVEL=debug` and `RUSA_LOG_FORMAT=json` — the metric
  series ride the structured logger at debug level (§3 below). At the default
  level the journal carries lifecycle records and no metrics.
- `EnvironmentFile=-$RUSA_HOME/.env`, `Restart=on-failure`, `RestartSec=10`,
  `StartLimitIntervalSec=300`/`StartLimitBurst=5`, journal output.

Install-time preflight creates `$RUSA_HOME/workers` (the probe creates
`quota-probe-<provider>/` under it) and fails if it is not writable; missing
`bwrap` or `tmux` is a warning, since a host may install them afterwards.

Instance units declare `After=`/`Wants=` the coordinator unit — never
`Requires=`. Under v1 an instance without the coordinator is degraded (it paces
on its last applied interval), not stopped, and `Requires=` would turn a
coordinator failure into an orchestrator outage. The ordering lines are written
only when the coordinator unit already exists on disk, so an instance with no
coordinator does not log a dependency warning on every start.

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

- **Cadence:** daily, from the coordinator's own timer. On start it backs up only
  if the newest existing backup is already a day old — otherwise a service that
  restarts five times in five minutes (which the start limit tolerates) would
  evict five of the fourteen daily copies with five copies of the same minute.
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

Three things are checked before anything is replaced, so the procedure cannot be
performed half-way by accident:

- **the coordinator is down** — a listener on the socket makes the restore
  refuse, because restoring under a live coordinator leaves it holding a handle
  to a database that is no longer the one on disk;
- **the backup is whole** — `PRAGMA integrity_check` and the quota schema guard
  run against the backup *before* the live file is touched, so a corrupt or
  newer-schema copy fails while the database it would have replaced is intact;
- **the replaced database is kept** — archived to
  `<db>.pre-restore-<stamp>Z.db` with the same `VACUUM INTO`, and its stale
  `-wal`/`-shm` removed. A drill that cannot be undone is not a drill.

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
it is rather than as a counter silently resetting to zero. Records are emitted
at `debug`, which is why the unit sets `RUSA_LOG_LEVEL=debug`.

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
readers. Nothing outside the temporary directory is read or written. Every check
is asserted, and a failing check fails the run.

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
any provider CLI runs, which is also why the drill consumes no real quota. On a
live deployment the same break surfaces at the first tick past the provider's
TTL (five minutes for most, thirty for codex); revoking the provider CLI's
session is the other way in.

### Recorded transcripts

Run of 2026-09-15 on the branch for issue #360, `--seed-days 30`,
`--tick-seconds 2`, client `hardStaleAfterMs` 4000, node v24.13.1. Scratch paths
are scrubbed to `<scratch>`. All 16 checks passed.

```text
Run: 2026-09-15T21:10:28.428Z · provider codex · seed 30 days · tick 2s · client hardStaleAfterMs 4000 · node v24.13.1
- 2026-09-15T21:10:37.622Z  scratch deployment seeded: 8641 parsed scrapes over 30 day(s), newest 30s old, in 9184 ms

### Drill 1 — service down mid-flight

- 2026-09-15T21:10:37.647Z  seeded database: 8640 scrapes, 8640 observations, 81502208 bytes (db + wal), newest observation 2026-09-15T21:09:58.438Z
- 2026-09-15T21:10:39.184Z  coordinator started; start → /v1/readyz 200: 1537 ms
- 2026-09-15T21:10:39.231Z  PASS  every instance reads a published interval — instance-a: applied 90.26585786268132s, instance-b: applied 90.26585786268132s
- 2026-09-15T21:10:39.231Z  published codex: intervalSeconds=90.26585786268132 updatedAt=2026-09-15T21:09:58.438Z governing=codex:weekly
- 2026-09-15T21:10:41.739Z  collection state after a tick: status=ok attempts=0 failures=0 lastAttemptAt=null (no probe due — newest reading is inside the provider TTL)
- 2026-09-15T21:10:41.908Z  backup (VACUUM INTO, read-only, service up): 167 ms, 80519168 bytes → <scratch>/quota/backups/quota-20260915T211041Z.db
- 2026-09-15T21:10:42.004Z  PASS  backup opens and passes integrity_check — retained: 2
- 2026-09-15T21:10:42.373Z  backup timed 3x on the same database: 167 ms, 162 ms, 172 ms
- 2026-09-15T21:10:42.481Z  coordinator stopped (SIGTERM): exit {"code":0,"signal":null} after 43 ms
- 2026-09-15T21:10:43.489Z  PASS  (a) each instance keeps its last applied interval while the service is down — 1051 ms into the outage, still inside hardStaleAfterMs (4000 ms): instance-a: applied 90.26585786268132s (connect ENOENT <scratch>/coordinator.sock); instance-b: applied 90.26585786268132s (connect ENOENT <scratch>/coordinator.sock)
- 2026-09-15T21:10:43.506Z  PASS  (b) no instance wrote to the quota database during the outage — observations 8640 → 8640, scrapes 8640 → 8640
- 2026-09-15T21:10:43.506Z  PASS  (c) quota_client_service_connected dropped to 0 on every instance and the alert condition fires — instance-a: 4 consecutive zero samples, instance-b: 4 consecutive zero samples
- 2026-09-15T21:10:46.695Z  PASS  (d) past hardStaleAfterMs (4000 ms) each instance widened to maxIntervalSeconds — instance-a: applied 3600s, instance-b: applied 3600s
- 2026-09-15T21:10:47.980Z  coordinator restarted; start → /v1/readyz 200: 1285 ms
- 2026-09-15T21:10:50.699Z  PASS  (e) published values resume from the same rows with no gap in quota_observations — all 8640 pre-stop observation rows present; published intervalSeconds 90.26585786268132 → 90.26585786268132, updatedAt 2026-09-15T21:09:58.438Z → 2026-09-15T21:09:58.438Z
- 2026-09-15T21:10:50.700Z  PASS  instances reconnect and apply the published interval again — instance-a: applied 90.26585786268132s, instance-b: applied 90.26585786268132s

### Restore drill (design §9.2)

- 2026-09-15T21:10:50.726Z  instances stopped (readers idle); coordinator stopped after 26 ms
- 2026-09-15T21:10:51.298Z  restored <scratch>/quota/backups/quota-20260915T211041Z.db over the database in 465 ms; replaced file archived to <scratch>/quota/quota-coordinator.db.pre-restore-20260915T211050Z.db
- 2026-09-15T21:10:51.298Z  PASS  restore replaced the database — ok
- 2026-09-15T21:10:52.975Z  coordinator started on the restored database; start → /v1/readyz 200: 1677 ms
- 2026-09-15T21:10:53.057Z  PASS  readyz and the published throttle match the backed-up state — ready=true cold=false; published 90.26585786268132s; observations 8640
- 2026-09-15T21:10:53.057Z  PASS  instances started against the restored service apply its interval — instance-a: applied 90.26585786268132s, instance-b: applied 90.26585786268132s

### Measured stage-3 window (design Q7)

- 2026-09-15T21:10:53.089Z  database at measurement: 81502208 bytes (db + wal), 8640 scrapes, 8640 observations
- 2026-09-15T21:10:53.090Z  backup (VACUUM INTO, read-only, service up), 3 samples: 167 ms, 162 ms, 172 ms → median 167 ms, slowest 172 ms
- 2026-09-15T21:10:53.090Z  start → /v1/readyz, 3 samples: 1537 ms (cold start), 1285 ms (restart after the outage), 1677 ms (on the restored database) → median 1537 ms, slowest 1677 ms
- 2026-09-15T21:10:53.090Z  window = backup + start-to-readyz: median 1704 ms, slowest observed 1849 ms
- 2026-09-15T21:10:53.358Z  scratch deployment seeded: 289 parsed scrapes over 1 day(s), newest 2700s old, in 190 ms

### Drill 2 — service up, probes failing

- 2026-09-15T21:10:53.361Z  workers directory replaced by a regular file: <scratch>/home/workers
- 2026-09-15T21:10:55.907Z  coordinator started; start → /v1/readyz 200: 2546 ms
- 2026-09-15T21:10:55.924Z  published codex: intervalSeconds=66.58798296265368 updatedAt=2026-09-15T20:25:53.168Z
- 2026-09-15T21:11:00.437Z  PASS  healthz still passes — status 200 ok=true
- 2026-09-15T21:11:00.438Z  PASS  readyz reports the per-provider scrape failure — ready=true codex: status=error attempts=3 failures=3 lastAttemptAt=2026-09-15T21:10:59.885Z error=ENOTDIR: not a directory, mkdir '<scratch>/home/workers/quota-probe-codex' (first attempt seen: 1)
- 2026-09-15T21:11:00.438Z  PASS  quota_service_scrapes_total{outcome="failure"} is rising and the alert condition fires — 3 failure increments in the service's metric records
- 2026-09-15T21:11:06.473Z  PASS  clients keep applying the frozen interval without complaint — instance-a: applied 66.58798296265368s, updatedAt 2026-09-15T20:25:53.168Z; instance-b: applied 66.58798296265368s, updatedAt 2026-09-15T20:25:53.168Z
- 2026-09-15T21:11:06.473Z  PASS  quota_client_service_connected stayed at 1 — this failure is invisible to the connection alert — instance-a: always 1, instance-b: always 1
- 2026-09-15T21:11:06.475Z  database unchanged by the failing probes: 289 scrapes, 289 observations
- 2026-09-15T21:11:06.543Z  coordinator stopped (SIGTERM): exit {"code":0,"signal":null} after 68 ms
```

### Measured stage-3 write-quiesce window (design Q7)

Design §13.3 Q7 asks for the window to be re-stated with a measurement attached
once the drill exists. From the run above, against a **81,502,208-byte database
(8,640 scrapes, 8,640 observations — the 30-day retention bound)**:

| Step | Samples | Median | Slowest |
| --- | --- | --- | --- |
| backup (`VACUUM INTO`, read-only, service up) | 167 ms, 162 ms, 172 ms | 167 ms | 172 ms |
| start → `/v1/readyz` 200 | 1,537 ms (cold), 1,285 ms (after the outage), 1,677 ms (restored db) | 1,537 ms | 1,677 ms |
| **window = backup + start-to-readyz** | | **1,704 ms** | **1,849 ms** |

Three samples of each, because one `VACUUM INTO` measures page-cache warmth as
much as it measures database size — the same backup of the same data took
1,131 ms in an earlier run of this drill on a cold cache — and because starts
vary by a few hundred milliseconds run to run. Read the slowest column as the
number to plan with, and the cold-cache figure as the reason to take the
mandatory stage-3 backup rather than assume the last daily one is representative.

The remaining stage-3 steps — stopping the instances, a rename, a `mkdir`, a
config edit, the process starts — are fixed cost and do not grow with the data,
so the backup remains the only step worth measuring. Restore, for the same
database, took 465 ms plus a 1,677 ms start.

These are numbers from a scratch deployment on one host, not a production
promise; re-run the drill on the target host before stage 3 and use its numbers.
