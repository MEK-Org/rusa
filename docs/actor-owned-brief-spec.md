# Actor-owned portable brief

**Status:** draft for review, revised to the contract settled in
[#954 (comment)](https://github.com/MEK-Org/rusa/issues/954#issuecomment-6155205270).
The storage change below adds a migration and needs the normal schema gate
before it ships.
**Tracking:** [#954](https://github.com/MEK-Org/rusa/issues/954),
[#961](https://github.com/MEK-Org/rusa/pull/961)

## 1. What changes

An actor in portable-context `brief` mode keeps one document: three fixed
sections (`## WHAT`, `## HOW`, `## DOMAIN`), one cited statement per line. It
replaces the durable-intent section of the actor's prompt.

The actor owns that document. It reads and replaces it during its own runs
through the `brief` MCP server. Nothing rewrites it after a run: the post-run
Gemini rewrite, its retry and failure accounting, and its scheduler hook are
removed. Writes are validated synchronously, and a rejected write tells the
actor why, in the same turn.

The `ledger` mode is unchanged.

Brief is selected like the other portable modes. Any actor that may spawn can
pass `context_mode: "brief"` to `spawn_thread` for its own child, and the
operator can select it through the dashboard spawn API or an actor's configured
context. Spawning adds no new authority check and no root-only path: the
existing spawn authorization, charter, actor isolation and the
`conversation_id` incompatibility of portable modes apply unchanged, and the
default when no mode is given stays `native`. The tool describes the mode as
an actor-maintained WHAT/HOW/DOMAIN brief, every statement citing its source,
injected with the actor's recent journal; `spawn_thread` writes no brief, so a
new child starts from its charter and the brief grows only by its own cited
writes. A multi-entry model pool needs a portable mode, and brief counts as
one, as `ledger` and `tail` do. This follows the architecture owner's
spawn-selection decision
([#954 (comment)](https://github.com/MEK-Org/rusa/issues/954#issuecomment-6157170282)):
offering the mode is separate from authority to deploy brief or run the staging
trial, which stays with the existing rollout owner, and the charter still
governs what the child may do.

## 2. Identity

The `brief` MCP server is mounted per actor (`<actor-id>:brief`) and built with
that actor's id. No tool takes an actor id, so an actor can read and replace
only its own brief. The id the server was built with is also the recorded
writer (`acting_principal`) of every accepted write; the caller cannot supply
it. Workers and the root mount the server when their context is
`{ type: "portable", mode: "brief" }`.

## 3. Tools

### `read`

No arguments. Returns `{ text, generation, updatedAt }` for the caller's brief.
If the actor has just switched to brief mode and has no brief yet, the seed is
stored first (generation 0) and returned.

### `replace`

```
{ text: string, expected_generation: integer >= 0, explanation?: string }
```

| Outcome | Result | Stored state |
| --- | --- | --- |
| `expected_generation` differs from the stored generation | tool error: `stale brief write: expected generation N, current is M; …` | unchanged |
| `text` equals the stored brief, ignoring trailing whitespace | `{ status: "unchanged", generation, updatedAt }` | unchanged: no revision, generation and time kept, explanation discarded |
| `text` fails validation (§4) | tool error listing every problem | unchanged |
| a citation the write introduces cannot be resolved (§4) | tool error naming each citation and its cause, then `The brief is unchanged.` | unchanged |
| the brief changed while citations were being resolved | tool error: `stale brief write for actor <id>: expected generation N, current is M; …` | unchanged; the other write is kept |
| otherwise | `{ status: "updated", generation: N+1, updatedAt }` | brief replaced and one revision appended, together (§5) |

The generation check is a compare-and-set. The handler checks it first so the
actor gets a clear error. Resolving citations is asynchronous, so the store
checks the generation again inside the write transaction, after resolution
finished. A write based on a brief that changed meanwhile is refused rather
than overwriting it. Stale, rejected and no-op writes append nothing.

The explanation is optional. It is trimmed, an empty one is dropped, and it is
capped at 2 KiB. It is shown in the history.

## 4. Validation

An accepted write must:

- be at most 16 KiB (UTF-8). A larger write is refused, never truncated;
- contain `## WHAT`, `## HOW` and `## DOMAIN`, once each and in that order, with
  no other headings and nothing before the first section;
- end every non-blank statement line with at least one structured citation,
  such as `[mesh:messages/<id>]`, `[mesh:actors/<id>/charter]` or
  `[github:OWNER/REPO/issues/<n>]`, with nothing after the first citation but
  more citations;
- name no per-resource state in a statement: commit SHAs, run or message UUIDs,
  review ids, gate tallies (`3/4`), or bare `#123` references without their
  repository. Citations may contain such ids; only the statement text is checked.

### Citations must exist

Every citation is parsed. Each citation the write introduces, meaning one the
previously accepted brief did not carry, is then resolved through the existing
reference resolver (`resolveReference`, the one behind the dashboard's
reference cache), with the server's own access. The cache's short UI deadline
is not used. A write waits up to 15 seconds in total for its new citations;
one not answered by then cannot be checked right now. That bound keeps a
degraded source's client retries from holding the actor's run, and the write
is decided when the deadline passes: a citation that answers afterwards cannot
make the refused write commit. The write is refused, and the brief, generation, time and history stay
as they were, if a new citation:

- points at nothing (`message not found`, `actor not found`, `not found on the
  tracker`);
- cannot be read with the server's access (for example, `tracker not
  configured`);
- cannot be checked right now (the tracker or chat service is unavailable, or
  does not answer within the deadline).

The tool error names each citation and its cause. Citations carried over from
the previous accepted brief were checked when that brief was accepted (the seed
cites only the actor's own charter), so they are not resolved again. An outage
on an old source does not block an edit. A charter citation
(`[mesh:actors/<id>/charter]`) means the actor's current charter.

An existing source with an empty body, such as an issue with no description,
counts as resolved. A Google Chat message with no text (`message has no text`)
is refused, because the resolver returns nothing to show that it exists.

### Whole-document check

The check covers the whole document, not a diff against the previous one. The
actor may consolidate, reword, drop lines, and change which source it cites for
a principle. One representative citation per principle is enough. There is no
byte-identical guard and no per-line supersession bookkeeping. The history
(§5) keeps every accepted change inspectable instead.

## 5. Storage

### Current brief

The current brief lives in the actor's existing portable-context snapshot
(`portable_context_snapshots`, schemaVersion 4) as
`brief: { text, generation, updatedAt } | null`. The ledger fields stay in the
same document untouched, so switching back to ledger mode loses nothing.
`updatedAt` is the time of the last accepted write (the seed time before the
first one).

### History: `portable_brief_revisions` (migration 0062)

```sql
CREATE TABLE portable_brief_revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
  generation INTEGER NOT NULL CHECK (generation > 0),
  acting_principal TEXT NOT NULL CHECK (length(trim(acting_principal)) > 0),
  timestamp TEXT NOT NULL CHECK (length(trim(timestamp)) > 0),
  payload TEXT NOT NULL CHECK (length(trim(payload)) > 0),
  UNIQUE (actor_id, generation)
);
```

`payload` is versioned JSON:
`{ "schemaVersion": 1, "before": string, "after": string, "explanation"?: string }`.
The table follows the pattern of `obligation_history` (0045): append-only,
written only by the repository, with the payload shape owned by a zod schema
that refuses an unreadable row instead of guessing.

This table is the only brief history. The snapshot holds no revision list; the
earlier in-document `revisions` array and its 10-entry cap are gone, and old
fields are stripped when a snapshot is read. There is no second history to keep
in step.

### Atomic write

`commitBrief` runs in one `BEGIN IMMEDIATE` transaction. It rereads the
snapshot, refuses a stale `expectedGeneration`, writes the new snapshot and
inserts the revision. If any step fails, both roll back. `UNIQUE(actor_id,
generation)` backstops the compare-and-set: if two writers both passed the
check, only one can insert generation N+1.

The tests cover:

- two database connections whose writes are interleaved on one thread (both
  read generation N, one commits, the other is refused). This is a
  deterministic interleaving, not truly simultaneous writers; truly concurrent
  writers are serialized by SQLite's `BEGIN IMMEDIATE` lock and the `UNIQUE`
  backstop, which the tests do not race;
- a write that lands while another write's citations are being resolved (the
  later write is refused and the earlier one kept);
- an insert failing after the snapshot write (the snapshot rolls back);
- a reopen after restart.

### Retention

Every accepted write is kept, with no pruning. The dashboard's "latest 10" is a
`LIMIT` on the read; it does not decide retention. Why keep everything:

- rows are bounded: at most 2 × 16 KiB of text plus a 2 KiB explanation;
- only accepted changes append, because no-ops and rejected writes record nothing;
- writes are actor-initiated during runs, not per-message, so they are rare;
- `obligation_history` keeps everything for the same reasons, and an audit
  history that silently drops entries cannot answer "when did this guidance
  change".

If volume ever needs pruning, that is a separate, explicit migration.

`ON DELETE RESTRICT` matches 0045: an actor with brief history cannot be
hard-deleted without dealing with the history first. Actors are retired, not
deleted, in normal operation.

### Migration

0062 creates the table only and writes no snapshots. Existing snapshots need
no rewrite: a v4 snapshot that carries the retired bookkeeping fields is read
forward by stripping them. An actor with no history rows reads as an empty
history.

The snapshot document itself moves from v3 to v4, and this is forward-only. It
affects every portable actor, ledger as well as brief. This build reads a v3
snapshot forward, but the first save (a ledger compaction, or a brief seed or
write) stores v4. A previous build parses only v3, so after a rollback it
refuses to load any actor saved on this build, and that actor's portable context
fails until the build rolls forward again or the snapshot is restored from a
backup.

The number is provisional. 0060 and 0061 are reserved by open pull requests
([#1005](https://github.com/MEK-Org/rusa/pull/1005) and
[#1024](https://github.com/MEK-Org/rusa/pull/1024)); this change does not
depend on either. Migrations apply by name, so a gap on staging is harmless. The
number must be rechecked, and renumbered if taken, before this lands.

## 6. Authority

The charter governs. The brief carries evolving guidance under it and never
overrides it. Writing its own brief grants an actor no authority: WHAT and HOW
carry direction from humans and the actor's ancestors, and DOMAIN statements
are weighed by how reliable their sources are. Both of a parent's existing ways
to direct an actor still work:

1. **Charter change.** The new charter is in force on the next run. The actor
   does not have to rewrite its brief before acting on it. The seed's WHAT line
   cites `[mesh:actors/<id>/charter]`, which resolves to the current charter.
2. **Direction by message.** The parent sends a message. The actor folds the
   durable part into its brief and cites the message
   (`[mesh:messages/<id>]`).

The rendered section says so: "This brief is yours to keep current: when
durable guidance changes, read it and replace it with the `brief` MCP tools.
WHAT and HOW carry direction from humans and your ancestors; weigh DOMAIN
statements by how reliable their sources are. Writing the brief grants you no
authority: the charter governs where the two disagree. When they conflict,
carry out the work to the fullest extent your charter permits, then message
your parent explaining what the charter prevented that the brief implies; root
brings such conflicts to its operator."

That child-side text renders only for brief-mode actors. Every actor's prompt
carries the parent side, because any actor may parent a brief-mode child: when
a child reports work its brief implies but its charter excludes, update the
charter to authorize it or message the child that the exclusion is intentional
([#954 (comment)](https://github.com/MEK-Org/rusa/issues/954#issuecomment-6097740257)),
and keep children's charters current when clarifying their purpose, scope or
authority
([#954 (comment)](https://github.com/MEK-Org/rusa/issues/954#issuecomment-6097703419)).

Consolidation and citation rotation are allowed without a supersession guard.
What keeps them honest is that every accepted write is in the history (§5) with
its before, after and explanation, and that each citation it introduces must
exist (§4).

## 7. Dashboard (Option B)

- The Info tab's Brief header shows the generation and `updated <time>`. The
  history icon and the time both open the history.
- The history lists the latest ten accepted writes, newest first. Each shows
  its generation, time, a `+added −removed` line count and the explanation (or
  "No explanation given.").
- Selecting one opens its detail: the explanation, and the change as a line
  diff from the text it replaced (`before`) to the text it wrote (`after`).
  Back returns to the list.
- On wide screens this is a centred dialog. On narrow screens it is fullscreen.
- No-op writes record nothing, so they never appear and never move the time.

## 8. Not implemented, and known limits

- **No reviewed-through marker.** An earlier draft described a
  "reviewed-through" cursor. It was not built. A cursor like that only helps a
  post-run rewriter skip sources it has already folded; with the actor writing
  its own brief there is no rewriter cursor to advance. An actor that reviews
  its brief and finds nothing to change writes the same text, which is a no-op.
- **There is no HTTP 409.** Staleness is a tool error from `replace`, not an
  HTTP status. The dashboard is read-only for briefs.
- **Citations do not prove support.** A new citation must exist (§4). Whether
  the cited source actually says what the statement claims is not checked; the
  history makes that reviewable.
- **Retired machinery.** The post-run Gemini writer, its scheduler hook,
  retries and failure accounting, the freeze, and the oversized-source handling
  are removed, not disabled.
- **Compaction and a mode switch.** A ledger compaction reads the snapshot,
  waits for the model, then saves. If the actor switched to brief mode and
  committed a brief during that wait, saving the stale copy would roll the
  snapshot behind its history, and every later commit would then fail on
  `UNIQUE`. The compaction now takes the stored brief at save time. Taking it
  and saving it are synchronous, with no await between them. A test commits
  during the fold and checks that the brief survives and the next write lands.
