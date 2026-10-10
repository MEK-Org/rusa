# Actor-Owned Portable Brief Specification

**Status:** Approved Architecture Draft  
**Scope:** Rusa portable context (`brief` mode)  
**Tracking Issue:** [#954](https://github.com/MEK-Org/rusa/issues/954)  
**PR:** [#961](https://github.com/MEK-Org/rusa/pull/961)  
**Governing Authority:**
- Mesh Root Architecture Ruling (`mesh:messages/4e8bf997-061d-4754-a4c4-53ddfbe96a30`)
- Parent Steward Charter (`mesh:messages/dd33fde2-dd4f-498b-8981-7b817f8cf454`)
- Operator/Architect Selection (`gchat:spaces/AAQAvOIVSGw/messages/suAqm9IGozs.suAqm9IGozs`, Matt Option B)
- Parent Steward Directive (`mesh:messages/5724cbab-042d-4f1e-af0f-37cb47b2aa2c`)

---

## 1. Overview and Rationale

The portable context `brief` mode enables an actor to maintain a compact, persistent synthesis of its identity, responsibilities, domain models, and operational principles across stateless run boundaries.

Previously, brief updates were performed by an automated background Gemini LLM rewriter after each run (`GeminiBriefRewriter`). While automated, this model introduced several structural drawbacks:
1. **External Dependency:** Required an active `geminiApiKey` even for non-Gemini actors and offline test setups.
2. **Artificial Supersession Constraints:** Post-run diffing struggled to distinguish consolidation or rotation from unauthorized deletion of prior guidance.
3. **Complex Failure Accounting:** Post-run rewrite errors triggered retry loops, frozen brief states, and parent attention notifications that cluttered queues without giving the actor itself actionable feedback.

Under this specification, brief updates are **actor-owned**. The actor itself inspects and refines its brief during active runs using dedicated MCP tools (`brief:read`, `brief:replace`). Updates are validated strictly and synchronously at write time.

---

## 2. Security, Caller Identity, and Scoping

To prevent lateral tampering across actor boundaries:
- **No Spoofable Actor ID:** Neither `brief:read` nor `brief:replace` accepts an `actor_id` or `thread_id` argument in its tool schema.
- **Strict Caller Binding:** The MCP server instance is bound immutably to the caller actor's ID (`BriefMcpDeps.actorId`) upon server construction. All operations read from and write to the caller's own slot in `PortableContextStore`.
- **Worker and Root Support:** Both worker actors and the root actor mount the brief MCP server when configured with `context: { type: "portable", mode: "brief" }`.

---

## 3. Tool Specifications

### 3.1 `brief:read`

Reads the caller actor's current brief state and governing charter.

- **Parameters:** None (`{}`).
- **Return Type:**
  ```json
  {
    "text": "string (markdown content of current brief)",
    "generation": 1,
    "updatedAt": "2026-10-10T13:30:00.000Z",
    "charter": "string (the actor's active governing charter)",
    "revisions": [
      {
        "generation": 0,
        "text": "...",
        "updatedAt": "2026-10-10T13:00:00.000Z",
        "explanation": "Initial seed"
      }
    ]
  }
  ```

### 3.2 `brief:replace`

Validates and replaces the caller actor's entire brief text.

- **Parameters:**
  - `text` (string, required): The complete replacement brief in Markdown format.
  - `explanation` (string, optional): An explanatory note describing why the brief was updated (recorded in revision history).
- **Return Type:**
  - **Success:**
    ```json
    {
      "status": "updated",
      "generation": 2,
      "updatedAt": "2026-10-10T13:35:00.000Z",
      "previousGeneration": 1
    }
    ```
  - **No-Op (Unchanged Text):**
    ```json
    {
      "status": "unchanged",
      "generation": 1,
      "updatedAt": "2026-10-10T13:30:00.000Z",
      "text": "..."
    }
    ```
  - **Validation Error:** Returns a formatted MCP tool error with a descriptive error message explaining why the write was rejected.

---

## 4. Content Invariants & Write-Time Validation

Every proposed update submitted to `brief:replace` is subjected to strict synchronous validation before being written to persistent storage.

### 4.1 Maximum Size Cap
The total text length of the brief must not exceed **16 KiB** (16,384 bytes UTF-8). Rejection occurs immediately if the size exceeds this threshold.

### 4.2 Structural Headings
The brief must follow a structured Markdown layout with the following required sections:
- `## WHAT`: High-level responsibilities and deliverables.
- `## HOW`: Operational workflows, tools, and practices.
- `## DOMAIN`: Domain-specific invariants, architecture constraints, and data definitions.

Alternatively, the equivalent document-level headings (`# WHO I AM`, `# WHAT I DO`, `# HOW I WORK`, `# PRINCIPLES`) are recognized and accepted.

### 4.3 Exclusion of Transient State
Briefs must capture durable principles, not transient task progress. Updates containing ephemeral status markers are rejected:
- References to specific unhandled inbox items (`inbox entry`, `selected item`, `unhandled item`).
- Intermediate task loops or progress tallies (`task 1/4`, `in-progress test run`, gate tallies like `gate 2/2`).
- Scratchpad dumps or ephemeral command outputs.

### 4.4 Citation Requirements
Operational principles and prescriptive behavioral rules declared under `WHAT` and `HOW` must carry concrete citations referencing their authoritative origin:
- Citations must reference verifiable artifacts: Git commits (`commit <sha>`), GitHub issues/PRs (`#123`, `pulls/123`), mesh messages (`mesh:messages/<uuid>`), or human directions (`Matt <id>`, `chat:<space>/<msg>`).
- Synthesized, unattributed, or vague rules are rejected.

### 4.5 Consolidation, Citation Rotation, and No-Ops
- **Consolidation:** An actor may synthesize multiple related rules into a more concise principle, provided the synthesized rule retains valid citation backing.
- **Citation Rotation:** When newer commits, issues, or parent directives supersede older examples, the actor may freely rotate or refresh citations.
- **No-Op Detection:** Submitting unchanged text is detected as a no-op; it succeeds safely without bumping the `generation` counter, mutating `updatedAt`, or creating a new revision entry.

---

## 5. Failure Semantics: Atomic Last-Good

Write-time validation enforces **atomic last-good preservation**:
- If validation fails for any reason (size cap, missing section, missing citation, transient state), the storage layer is **not touched**.
- The existing, previously validated brief remains active and unaltered.
- The failure reason is returned directly to the calling actor via the tool error response, enabling the actor to correct and retry within the same turn.

---

## 6. Authority Accounting & The Two Parent Pathways

The brief captures the actor's working memory, but the actor's scope of authority is governed strictly by its parent steward and the mesh root. The architecture establishes two distinct pathways:

```
+-------------------------------------------------------------------------+
|                              Mesh Parent                                |
+-------------------------------------------------------------------------+
       |                                                 |
       | Path 1: Charter Update                          | Path 2: Exclusion Message
       v                                                 v
+-------------------------------+             +---------------------------+
| New Charter Bound to Actor    |             | Mesh Message with         |
| Authorizes action immediately |             | Intentional Exclusions    |
| No brief rewrite required     |             | & Refined Principles      |
+-------------------------------+             +---------------------------+
       |                                                 |
       v                                                 v
+-------------------------------------------------------------------------+
|                             Calling Actor                               |
|          Reads charter via brief:read; refines brief:replace            |
+-------------------------------------------------------------------------+
```

### Path 1: Charter Governance (Scope Evolution)
The actor's charter is its foundational legal authority. When a parent updates an actor's charter to assign new repos, PRs, or goals:
- The actor is immediately authorized to act on that charter.
- A brief rewrite is **not required** as a prerequisite for executing charter-authorized work.
- `brief:read` provides the latest charter string alongside the brief so the actor can check for scope updates on wake.

### Path 2: Intentional Exclusion & Refinement Directives
When a parent or root architect communicates design boundaries, intentional exclusions, or principle changes via mesh messages:
- The actor incorporates those decisions into its brief under `## PRINCIPLES` or `## HOW`.
- The actor cites the parent message (`mesh:messages/<id>`) as the authoritative origin of the exclusion.

---

## 7. Storage Architecture & Single Authoritative History Model

Following operator selection (`gchat:.../suAqm9IGozs.suAqm9IGozs`, Matt Option B) and parent steward guidance (`mesh:messages/5724cbab-042d-4f1e-af0f-37cb47b2aa2c`, `mesh:messages/bc2d762d-5c7d-4f8f-b650-0e052d02d969`), brief revision history is architected around a **single authoritative history model** aligned with Rusa's existing `obligation_history` architecture (`0045_obligation_history`).

There is strictly **one** authoritative history store in any deployment phase—never dual authority or synchronization splits:
- **Target Production Model:** `portable_brief_history` table is the sole authoritative history store. Active snapshot `state.brief` retains only current state; the "latest 10" UI view is a query against the history table.
- **Experimental / Staging PR Model:** To avoid premature SQLite schema migrations (DDL) during evaluation, an explicit zero-DDL choice stores the single authoritative history inside `portable_context_snapshots.snapshot.brief.revisions` as a ring buffer (capped at 10). Upon migrating to dedicated DDL, this buffer is superseded by `portable_brief_history`.

### 7.1 Target Production Schema: `portable_brief_history` Table
When migrating to dedicated SQL storage, the schema matches the proven `obligation_history` pattern:

```sql
CREATE TABLE IF NOT EXISTS portable_brief_history (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id         TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
  generation       INTEGER NOT NULL,
  timestamp        TEXT NOT NULL CHECK (length(trim(timestamp)) > 0),
  explanation      TEXT,
  payload          TEXT NOT NULL CHECK (length(trim(payload)) > 0)
);

CREATE INDEX IF NOT EXISTS idx_portable_brief_history_actor
  ON portable_brief_history(actor_id);
```

- **Monotonic Integer ID:** Guarantees strict insertion ordering even for multiple mutations within the same millisecond.
- **RESTRICT Deletion:** Audit trail cannot be deleted by cascading actor row deletion.
- **Payload Versioning:** Validated by consuming Zod schemas in application code, avoiding rigid SQLite JSON check constraints.
- **View-Only Latest 10:** The UI queries `SELECT * FROM portable_brief_history WHERE actor_id = ? ORDER BY id DESC LIMIT 10`. The active snapshot `state.brief` does not duplicate this buffer.
- **Payload Structure:**
  ```json
  {
    "schemaVersion": 1,
    "generation": 2,
    "explanation": "Consolidated platform testing into general principle",
    "before": {
      "text": "...",
      "generation": 1
    },
    "after": {
      "text": "...",
      "generation": 2
    }
  }
  ```

### 7.2 Zero-DDL Implementation (Staging / PR Phase)
During active experimental evaluation in PR #961, an explicit zero-DDL choice keeps the authoritative history inside `portable_context_snapshots.snapshot.brief.revisions`:
```typescript
export const portableBriefRevisionSchema = z.object({
  generation: z.number().int().nonnegative(),
  updatedAt: z.string().min(1),
  explanation: z.string().optional(),
  text: z.string(),
});

export const portableBriefSchema = z.object({
  text: z.string(),
  generation: z.number().int().nonnegative(),
  updatedAt: z.string().min(1),
  model: z.string().nullable().default(null),
  citationAuthorities: z.record(z.string(), portableBriefAuthoritySchema).default({}),
  revisions: z.array(portableBriefRevisionSchema).optional(),
});
```
This zero-DDL approach allows immediate local testing, verification, and UI prototyping without database migrations, while remaining 100% structurally compatible with upgrading to `portable_brief_history`.

### 7.3 Mutation Semantics & Lifecycle
Brief mutations fall into three distinct categories:
1. **Accepted Update (`brief:replace` with modified text):**
   - Increments `generation` by 1.
   - Updates `updatedAt` to current ISO-8601 timestamp.
   - Records a new revision in the authoritative history (generation, timestamp, optional explanation, new text).
2. **Reviewed-Through (`brief:reviewed` / confirmation without content modification):**
   - Marks the brief reviewed through the current generation (`reviewedThroughGeneration`).
   - Does **not** increment `generation` and does **not** append a revision entry to history.
3. **No-Op Protection:**
   - If submitted text is identical to the current active brief, the call is treated as a no-op: rejected or cleanly ignored without bumping `generation`, modifying `updatedAt`, or creating noisy history records.

### 7.4 Concurrency, Validation & Integrity Rules
- **CAS / Stale-Write Validation:**
  Every `brief:replace` call requires `expectedGeneration`. If `expectedGeneration !== currentBrief.generation`, the write fails with a stale-write conflict (`409 Conflict`), preventing lost updates and concurrent overwrite races.
- **Own-Actor Validation:**
  Only the actor itself (or parent steward with explicit authority) can mutate its brief. Calls to `brief:replace` validate caller identity (`callerActorId === targetActorId`), rejecting cross-actor tampering.
- **Explanation Optionality:**
  The `explanation` field is optional (`string | undefined` / nullable). Actors provide concise summaries for deliberate structural refinements (e.g. "Added domain principles"), but automated initial seeds or trivial edits may omit it.
- **Atomic Persistence & Race Protection:**
  Active snapshot serialization and history persistence execute within a single transaction boundary, ensuring generation counters, active brief text, and history records cannot drift or expose torn states.

---

## 8. User Interface Specification (Option B)

Per operator selection (`suAqm9IGozs.suAqm9IGozs`), the UI provides clear, inspectable brief history:

1. **Info Card Integration:**
   - On the actor detail view, the brief card displays:
     - The current brief generation counter and last update timestamp.
     - A clickable **History Icon** (`Icons.history`).
2. **Latest 10 Revisions Popover / Modal:**
   - Clicking the history icon opens a popover listing up to the 10 most recent accepted revisions.
   - Each revision entry shows:
     - `Gen <N>` badge.
     - Relative and ISO timestamp (`2 hours ago`, `2026-10-10 13:35 UTC`).
     - Optional actor explanation (`explanation`).
3. **Before / After Diff Detail:**
   - Selecting a revision displays a side-by-side or unified Markdown diff comparing that revision against the previous generation (`before` vs. `after`).
4. **Responsive Mobile Layout:**
   - On compact screens / mobile viewports, the popover adapts to a full-screen bottom sheet / modal.
5. **No-Op Protection:**
   - Unchanged writes do not generate revision entries or shift timestamps, ensuring the history stream remains noise-free.

---

## 9. Rollout and Operational Constraints

- **Design Permission vs. Migration Approval:** Matt's Option B selection represents approved design direction. Dedicated table migration requires steward/root scheduling before shipping to production.
- **Remote Branch Frozen:** PR [#961](https://github.com/MEK-Org/rusa/pull/961) remote branch remains frozen at `763c05c2` while timing and scope reconciliation completes.
- **Review Commissioning:** Reviewer dispatch and merge gates remain on hold until authorized by parent steward.
