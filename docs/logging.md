# Logging

Rusa has one structured application logger, in
`packages/rusa/src/observability/logger.ts`. It is backed by
[Pino](https://getpino.io): service execution writes one JSON object per line,
so a record can be selected by field instead of matched by prose.

Actor output is a different stream and is not logged. What an actor *says* goes
to the run transcript in `mesh_events` and to the dashboard's live-output SSE —
followable from a terminal with `rusa logs --actor <id>`; the logger carries
what the mesh *did*. See "Reading actor output" for why the two never share a
stream.

## Getting a logger

Domain code takes a `Logger` and never constructs one, so a test can pass a
recorder and a caller with nothing to log to can pass `nullLogger`:

```ts
import type { Logger } from "../observability/logger.js";

export function startThing(deps: { logger: Logger }) {
  const log = deps.logger.child({ component: "thing" });
  log.info("thing_started", { port: 8080 });
}
```

The composition root — `rusa start` — builds the real one and hands it down.

## Computer-use admission records

The instance owning the computer-use lock writes `computer_use_wait` when a
provider-admitted run waits behind a holder, and again when its blocker changes.
`holderActorId` identifies the holder at that transition. `computer_use_acquired`
ends that wait and reports total `waitedMs` from entering the lock gate; it also
marks immediate acquisition with `waited: false`. Cancelled or closed queued
waits end with `computer_use_wait_ended`, an `outcome` of `cancelled` or `closed`,
and elapsed time. The follower inherits its existing logger's `id`, destination
and secret scrubbing; the leader does not manufacture follower lock records.

These records contain identifiers, flags and elapsed time, without prompts or
tool arguments. They are transition breadcrumbs, not a durable current-state
view: logging can be filtered or fail, and diagnostics cannot block admission.
Acquisition precedes provider execution; `run_start` or `remote_run_start`
confirms execution. A missing lock record does not establish provider pacing or
follower receipt. Before an observed lock transition, the admission reason
remains unknown from these records alone.

## Levels

| Level   | Use it for                                                         |
| ------- | ------------------------------------------------------------------ |
| `debug` | Diagnostic detail, and recoveries that are genuinely routine.       |
| `info`  | Lifecycle transitions: started, ready, listening, run began/ended.  |
| `warn`  | Degraded but continuing: a preflight failed, a run hit its cap.     |
| `error` | A failed operation that needs someone to look.                      |

The level is `info` unless configured:

```yaml
observability:
  logging:
    level: debug
```

`RUSA_LOG_LEVEL` overrides the configured value for one run. A bad value in
config fails boot; a bad value in the environment falls back to `info`.

## Format

The same records render two ways. `auto` — the default — picks `pretty` when
stdout is a terminal and `json` otherwise, so running `rusa start` by hand reads
as text while the service under systemd stays machine-parseable:

```yaml
observability:
  logging:
    format: auto # auto | json | pretty
```

`RUSA_LOG_FORMAT` overrides it for one run, which is how you get JSON out of an
interactive shell (`RUSA_LOG_FORMAT=json rusa start`) or readable lines out of a
pipe. See "Reading the log" before piping that JSON into a strict reader.

This is a choice of *presentation*, not a second stream: an event is written
once either way. Prose printed beside a record it duplicates is the thing this
logger exists to remove — if a lifecycle event should be readable, it is
readable because of this setting, not because someone also `console.log`ged it.

Rendering happens in-process rather than through a Pino transport. A transport
runs on a worker thread, and `rusa start` leaves through `process.exit()`, which
would drop whatever the worker had not yet flushed.

## Conventions

**A stable event, then fields.** The first argument is an identifier that does
not vary — snake_case, no interpolation. Everything that varies is a field.

```ts
log.info("run_start", { actorId, runId, provider, model }); // yes
log.info(`run ${runId} started on ${provider}`); // no
```

**Context belongs on a child logger.** Bind `component` at minimum, and
whatever identifies the unit of work — actor id, run id, provider, repository,
request/delivery id — so every record from that unit carries it without the
call site repeating itself.

```ts
const runLog = actorRunLog.child({ actorId, runId });
runLog.info("run_start", { provider });
runLog.error("run_end", { success: false, exitCode });
```

A key bound twice appears in the record once, and the closer binding wins:
a call's own field beats every bound layer, an inner child beats an outer one,
and a child beats the root. So the `actor-run` child of a logger rooted at
`component: start` writes `"component":"actor-run"` and nothing else — the
record has no repeated key. That lets strict readers accept it and leaves no
ambiguity for lenient ones to resolve by accident. Everything the closer layer
did not name is inherited unchanged.

`level`, `time`, and `msg` belong to Pino: the logger generates the first two,
and the event argument supplies `msg`. If application context or a call field
uses one of those names, it is dropped rather than colliding with Pino's record
key. Use a distinct application field instead.

Rebinding is for narrowing the unit of work, not for renaming a field. If two
layers mean different things, give them different names (`component` and
`step`) rather than letting the inner one silently replace the outer.

**Errors go in `err`.** Pass the `Error` itself. It is serialized to name,
message, stack, and the whole `cause` chain. Never `String(err)`, which throws
the stack away, and never interpolate it into the event name.

```ts
log.error("webhook_event_failed", { event, err });
```

**Record intentionally caught failures.** An empty `catch` is a decision nobody
can observe. Keep the control flow and add the record at the level that matches
what actually happened — a best-effort fan-out that dropped is `debug`, a
degraded-but-continuing path is `warn`.

```ts
try {
  sink.deliver(chunk);
} catch (err) {
  log.debug("actor_output_sink_failed", { sink: sink.name, err });
}
```

**Never log a secret, and never rely only on that rule.** Bearer and auth
headers, provider credentials, raw prompts, whole chat bodies, and unbounded
tool or provider output do not belong in a record. On top of the rule, the
logger drops any field whose *name* looks credential-bearing, and scrubs every
configured secret *value* out of every string it writes — including out of an
error message or a stack frame down the `cause` chain. Register a new
credential source in `observability/log-secrets.ts` when you add one.

Value scrubbing has one bound: a credential under
`MIN_SCRUBBABLE_SECRET_LENGTH` (3) characters is left alone, because a one- or
two-character value occurs inside ordinary words and scrubbing it would replace
most of every record. A configured credential that short is not silently
unprotected — `rusa start` records `secret_not_scrubbable` naming the config key
and its length, never its value, so an operator finds out at boot rather than
from a leaked stack frame.

**One bounded record per event.** A large payload belongs in an artifact, with
a safe reference in the record. Field *names* stay low-cardinality —
`{ actorId }`, never a field named after the actor.

That bound is yours, not the logger's. The logger bounds the shapes that would
otherwise not terminate — recursion stops at depth 8, a `cause` chain at 5
links, and a cycle becomes `[circular]` — but it does not cap how *wide* or how
*long* a value is. A 50 MB string or a million-element array handed to
`log.info` is scrubbed and written in full, on a synchronous destination, which
stalls the process for as long as that write takes. Log the count and the
identifier, not the collection.

**Tests assert event and field pairs**, never rendered prose or timestamps.
Write to an in-memory stream, parse the lines, and assert on the object.

## Console output

Direct `console.*` is for commands whose printed output *is* their contract with
the person who ran them — `rusa init`, `rusa quickstart`, `rusa report`. Those
files are named in `packages/rusa/console-budget.json` under `allowlist`.

Everything else is diagnostics and goes through the logger.
`console-budget.test.ts` enforces this mechanically: every other production file
has a budget of the console calls it had when the gate landed, and that number
may only ever fall. Adding a new diagnostic to a budgeted file fails the test,
which prints the number to lower once you migrate one instead.

There is a large pre-existing backlog. It is burned down module by module, by
whoever is already touching a module for another reason — not in one sweep.

## Reading the log

`rusa start` runs as a service, so its stdout is journald's stream and the
records are JSON:

```console
$ journalctl --user -u rusa -o cat | jq -Rc 'fromjson? // empty | select(.component == "actor-run")'
```

Actor output no longer needs the tolerant raw-input guard: it has its own stream
(see below). `start.ts` still has a pre-existing console-output backlog, however,
so service-originated status lines can share the stream until that separate
migration completes. Keep the guard for now; it discards those non-record lines
without treating actor prose as a possible record.

Run by hand in a terminal, the same records arrive as readable lines with no
extra tooling:

```console
$ rusa start
16:04:11.235 INFO  start service_starting version=0.1.0 home=/srv/rusa
16:04:11.402 INFO  start database_ready home=/srv/rusa
```

`RUSA_LOG_FORMAT` gets you the other one either way: `RUSA_LOG_FORMAT=json rusa
start | jq` for JSON in a terminal, `RUSA_LOG_FORMAT=pretty` for readable lines
out of a pipe.

## Service log file rotation

An instance that `install-service` set up without the journal sends its
output to `$RUSA_HOME/logs/rusa.log` through `append:`. That file is
bounded by a per-instance systemd timer, which `install-service` writes and
enables alongside the service:

- `rusa-logrotate.timer` and `rusa-logrotate.service`, or
  `rusa-staging-logrotate.*` for staging.
- The timer fires hourly, and `Persistent=true` catches up a run missed while
  the host was down.
- The oneshot runs the standalone `scripts/rotate-log.mjs` against that
  instance's own log. The unit passes the log's absolute path as an argument,
  so nothing in the instance's `.env` can point it at a different file. It only
  ever touches `rusa.log` and `rusa.log.<n>`, so rotation never reaches another
  instance's files.

Each run checks the file against a size bound:

- Under the bound, nothing happens.
- At or over the bound, the active file is copied to `rusa.log.1`. Older
  generations shift up, and anything past the retention count is deleted.
- The active file is then truncated in place. The service keeps its
  `append:` descriptor and goes on writing at the new end of the file, with no
  restart.
- The cost is the usual copy-then-truncate one: a line written in the instant
  between the copy and the truncate is lost.
- Rotated files keep the active log's permissions.

Defaults and overrides. Set these in the instance's `$RUSA_HOME/.env`; the
next timer run picks them up:

| Variable | Default | Meaning |
| --- | --- | --- |
| `RUSA_LOG_ROTATE_MAX_BYTES` | `52428800` (50 MiB) | Rotate once the active file reaches this many bytes; at least `1` |
| `RUSA_LOG_ROTATE_KEEP` | `5` | Rotated generations to keep, `0` to `100`; `0` truncates without keeping a copy |
| `RUSA_LOG_ROTATE` | on | `off` makes each run a no-op |

A malformed or out-of-range value logs a warning and falls back to its default;
it does not disable rotation.

How much disk this uses. The bound is checked once an hour, not enforced on
every write, so it is a trigger rather than a cap:

- When a run finds the file at or over the bound, the copy takes the whole
  file as it is at that moment. A file that was just under the bound at the
  previous run can grow by a full hour's output before it is checked again.
  So the active file, and every generation, can each be up to the bound plus
  one hour's output.
- During a run the new `rusa.log.1` and the not-yet-truncated active file
  exist side by side, after the oldest generation has been deleted.
- Together, the log and its generations stay under
  `(RUSA_LOG_ROTATE_KEEP + 1) × (RUSA_LOG_ROTATE_MAX_BYTES + one hour's output)`.
  With the defaults that is 6 × (50 MiB + one hour's output): close to
  300 MiB while an hour's output is small next to 50 MiB, and growing with the
  hourly output rate beyond that.

This is a limitation, not a hard cap. A burst inflates the generation for each
hour it spans, and output sustained at or above the bound per hour inflates
every retained generation. "An hour" is the gap between two runs, which systemd
can stretch by up to a minute (its default timer accuracy). When output that
heavy is expected, log to the journal instead, which enforces its own size
limits.

Opting out with `RUSA_LOG_ROTATE=off` lasts across reinstalls, because
`install-service` rewrites and re-enables the timer every time. Two other paths:

- `systemctl --user disable --now rusa-logrotate.timer` stops rotation only
  until the next install.
- `rusa uninstall-service` removes both rotation units. It leaves any rotated
  files in place.

The production self-deploy logs to the journal, which rotates itself. Its timer
is installed anyway and only bounds a `rusa.log` left behind by an earlier
file-logging install.

## Reading actor output

The service log and the actor stream are separate on purpose, and they are read
different ways. `journalctl --user -u rusa` is the mesh describing what it did;
its logger records are JSON, while the existing service-console backlog remains
visible as non-record lines until it is migrated.

An actor's words never reach it. That is the point rather than an omission —
actor output is arbitrary text, so an actor that prints a source file containing
a log line, or that runs `journalctl` and echoes the result, would inject
records indistinguishable from the service's own. Grepping harder does not fix
it, because the reflection carries the original prefix. Keeping the two streams
apart does.

The only durable destination is the transcript written for a completed run; the
other destination is a separate live tail:

- **The transcript.** When a run reaches `run_end`, its boundary records the
  output in `mesh_events`; `rusa report` reads it back as a timeline. An
  abandoned run has no completed transcript.
- **The live-output stream.** The dashboard subscribes over SSE while the run is
  in flight, with at most 500 recent chunks per actor held in memory for replay.
  Older chunks are dropped, and the buffer is cleared when the service stops;
  it is not an archive.

`rusa logs --actor <id>` follows that same live-output stream from a terminal:

```console
$ rusa logs --actor worker-7
```

It prints the actor's prose and nothing else — no heartbeats, no mesh events, no
other actor's run — so it pipes and redirects cleanly, and shows the same bytes
a dashboard tab is rendering off the same stream. It is a live tail with only
that bounded recent replay; use `rusa report` for a completed run's durable
transcript. It reaches the running service's dashboard port over loopback, so
the service has to be up; without `--actor`, `rusa logs` still tails the service
log.

## MCP HTTP request timelines

The MCP HTTP host uses the `mcp-http` component for request-path diagnostics.
Every request event carries one generated `requestId`, a safe `server` label, a
bounded `sessionId`, `sessionResolvedAtArrival`, and `elapsedMs`.

The `server` label is fixed when a mount is registered, never inferred from the
name's shape. A mounted actor capability is named `<actor-id>:<capability>` and
logs only the capability (`inbox`); a bare mount is an actor's own mesh server
and logs the constant `mesh`; a host service registered under a code-controlled
name declares that name as its label. Actor ids and capability URL tokens are
never recorded, whatever their shape.

`sessionResolvedAtArrival` is captured before the body is read, so it answers
whether the client presented a live session even if parsing or dispatch then
stalls. It keeps that arrival-time value on every later record for the request —
a successful `initialize` reports `false`, because no session existed on arrival.
The full session header stays routing-only; only its bounded form is logged.
After a JSON body is safely parsed, records may add bounded `rpcMethod` and, for
`tools/call`, `toolName`.

The phases are `mcp_request_arrived`, `mcp_request_body_read`, session
connect/create/close, `mcp_transport_dispatch`, and `mcp_transport_returned`.
`mcp_transport_returned` only says the SDK handler returned. HTTP completion is
separate: `mcp_http_response_finished` records Node's local writable completion;
`mcp_http_response_closed` records a premature close. Both include `statusCode`,
`headersSent`, and `writableFinished`. Nothing here observes client receipt:
`writableFinished` is this host finishing its own writable side, and no field
should be read as an acknowledgement that a client got the response. GET SSE
streams in particular keep a transport dispatch active while their HTTP response
stays deliberately open.

These records intentionally omit capability URLs/tokens, authorization and
credential headers, arguments, results, raw request bodies, and raw errors.
