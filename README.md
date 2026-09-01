# rusa

> An autonomous coding colleague — **one identity, many threads**.

rusa is a single, persistent engineering agent that lives alongside your
repositories. You talk to it the way you'd talk to a teammate — over GitHub
(issues, PRs, review comments) and Google Chat — and it triages, reasons, writes
code, and reports back in its own voice. Behind that single identity, work is
**sharded across a self-similar mesh of actor threads** so the system can run
many tasks concurrently without ever blowing a single context window or
serializing everything through one session.

The guiding idea: **identity is singular; execution is sharded.** You always talk
to "rusa," but under the hood a thin *root* actor handles conversation and
triage and delegates heavy or parallel work to *worker* actors — each its own
focused process with its own working memory and tools.

The full rationale and target shape live in
[`devlog/2026-06-15-actor-mesh/design.md`](devlog/2026-06-15-actor-mesh/design.md).

For a guide to running and configuring a local Docker quickstart container, see the [Quick Start Guide](docs/quickstart.md).

---

## Core Architecture

Everything the agent touches is exposed as an **MCP server**, and every thread —
root or worker — is the same `Actor` class differing only in configuration. This
self-similarity is what makes the mesh easy to reason about: there is no special
"orchestrator → worker" machinery, only actors messaging actors.

```
   Humans (GitHub webhooks / Google Chat)        ← the root's "parent"
        │  inbound messages wake the root
        ▼
   ┌──────────────┐   working memory: one continued, compacting session
   │  ROOT actor  │   voice + triage + routing (thin, cheap model by default)
   └──────┬───────┘
          │ mesh MCP: spawn_thread / send_message
   ┌──────┼───────────────┬───────────────────┐
   ▼      ▼               ▼                     ▼
 worker  worker         worker   …            worker   ← each: deep + narrow,
 (charter A)            (charter B)                       its own session + tools
          │ (a worker may spawn its own sub-workers — same primitive)
          ▼
        sub-worker

   Shared, orthogonal to the tree:
     • tracker-MCP (gh) / chat-MCP (gchat)  — the facts, re-derived each wake
     • thread registry (durable)            — the org chart of live actors
     • firehose                             — every actor's raw streamed output
```

### Root Actor

The **root** is the single human-facing identity. It is deliberately *thin and
cheap*: its job is conversation, triage, and routing — not swinging the hammer.

- It **wakes on inbound events** — a GitHub webhook or a Google Chat
  message/@mention — and is told only *why* it woke, never handed the raw
  payload. It re-derives current state from its tools every time.
- It runs a **continued, compacting provider session** as working memory, so it
  keeps situational awareness across wakes without an ever-growing context. The
  session is a *losable cache* — lose it and the root re-derives from the facts
  (tracker/chat) and its long-term library.
- It either **does light work itself** (real `git`/`gh`) or **delegates** to
  worker actors via the mesh MCP, then narrates what's happening.
- An **hourly safety-net sweep** wakes it to catch anything missed between
  events. **Self-authored events are suppressed** so the bot never triggers
  itself into a loop.

The root's behavior is shaped by its **charter** (see
[`root-prompt.ts`](packages/rusa/src/actor/root-prompt.ts)), which an
instance can override via `rootActor.charter` in config.

### Worker Threads

A **worker** is spawned by the root (or by another worker) to own a specific
**charter** — an authored brief, not a GitHub object. Scope is whatever the
parent decides to delegate: "answer this one chat question," or "drive the auth
refactor across these PRs."

Workers are the **same `Actor` loop as the root** — they differ only in
configuration:

- **Their own working-memory session**, tools, and (optionally) coding
  **provider/model** — so the root can route a hard coding task to a stronger
  harness while staying cheap itself.
- They get the **tracker** and their **own mesh endpoint**, but *not* chat — only
  the root talks to humans (conversation flows along tree edges).
- They **report to their parent, not to humans.** Completion is the *parent's*
  judgment: a worker may *propose* it's done, but the parent owns retirement
  (and retiring a thread retires its whole subtree).
- Each thread carries an optional **budget/lease** (`max_runs`) that bounds its
  subtree, so self-similar spawning can't run away.

Every actor is backed by a durable **thread registry record** (charter, parent,
session handle, status, lease) — the one piece of state that *can't* be
re-derived from the humans' tools, and what lets the root reconstitute "who's
working on what" after a restart. See
[`thread-registry.ts`](packages/rusa/src/actor/thread-registry.ts).

### Concurrency Limiter

Per-actor work is already serialized by each actor's **trigger runner**
(debounce → single-flight → dirty-bit, ported from the proven ccbot loop). The
only thing left to bound is *cross-actor* capacity, and that's the
[`ConcurrencyLimiter`](packages/rusa/src/actor/concurrency-limiter.ts): a
FIFO gate that lets at most `N` provider runs execute at once and queues the
rest, starting them as slots free. Each actor wraps its provider run in this
shared gate, so the whole mesh respects one global concurrency cap regardless of
how many threads are live.

---

## Mesh Communication Primitives

The entire mesh is built on **one primitive: "send a message to a thread."** It
subsumes three things that would otherwise be separate verbs — `dispatch`,
`postComment`, and `report` — into routing. These primitives are exposed to every
actor as the **agent-execution ("mesh") MCP server**
([`agent-exec-mcp.ts`](packages/rusa/src/mcp/agent-exec-mcp.ts)), with one
server instance per actor and that actor's identity *baked in* — so "who is
acting" is the unspoofable endpoint, not a tool argument the model fills in.

| Primitive | What it does |
| --- | --- |
| `spawn_thread(charter, …)` | Create a child actor that owns `charter`, in its own session. Returns its `thread_id`; you become its parent. **Non-blocking** — the child runs asynchronously. `provider`/`model` pick the harness/tier, optional `effort` sets its provider-native reasoning level, and `max_runs` sets a lease. |
| `send_message(thread_id, body)` | Deliver a message to a thread's inbox (parent, child, or an introduced peer). The recipient wakes, sees who it came from, and may reply *later* as a new message. **Always async.** |
| `introduce(holder, target, role?)` | Grant `holder` a handle to `target` so it can message it directly (e.g. let a coder reach a reviewer). The id *is* the capability (object-capability style). |
| `list_threads()` | List the children you've spawned, with charter summaries and status — your org chart for deciding what to follow up on or retire. |
| `retire_thread(thread_id)` | Mark a descendant (and its subtree) done and stop it. You may only retire your own descendants — completion is the parent's judgment. |

**Two rules make the mesh safe:**

1. **Ownership is a tree; messaging is a graph.** The `parentId` edge decides who
   can retire whom and whose budget bounds a subtree. Communication follows
   *handles*, which can reach beyond the parent.
2. **Delegation is asynchronous.** A parent must *never block* waiting on a child
   — it would waste a run and can deadlock the mesh. You fire a message and end
   your turn; the reply arrives as a fresh wake.

---

## Codebase Structure

This is a pnpm workspace. The agent itself lives in `packages/rusa`.

```
rusa/
├── packages/rusa/              # the rusa CLI + runtime
│   └── src/
│       ├── actor/              # the mesh core
│       │   ├── actor.ts                # the Actor unit (inbox + session + tools)
│       │   ├── actor-mesh.ts           # scheduler: spawn / sendMessage / retire
│       │   ├── concurrency-limiter.ts  # cross-actor capacity gate
│       │   ├── thread-registry.ts      # durable per-thread records
│       │   ├── trigger-runner.ts       # per-actor debounce/single-flight loop
│       │   ├── root-prompt.ts          # the default root charter + per-wake prompt
│       │   └── worker-prompt.ts        # worker scaffold + delegation discipline
│       ├── mcp/                # in-process MCP servers over a loopback HTTP endpoint
│       │   ├── agent-exec-mcp.ts       # the mesh primitives (spawn/send/introduce/…)
│       │   ├── tracker-mcp.ts          # GitHub facts (issues / PRs / comments)
│       │   └── chat-mcp.ts             # Google Chat facts
│       ├── chat/               # Google Chat client, OAuth, Pub/Sub + Workspace Events source
│       ├── commands/           # CLI subcommands (start, init, dashboard, e2e, service, …)
│       ├── config/             # config loading + docs
│       ├── db/                 # SQLite schema, migrations, repositories
│       ├── gitops/             # git + the IssueClient (gh) seam
│       ├── providers/          # coding harnesses: claude, codex, antigravity, gemini, copilot, kimi
│       ├── webhook/            # GitHub webhook + dashboard HTTP servers
│       ├── e2e/                # self-contained end-to-end runner (fakes the GitHub edge only)
│       ├── dashboard/          # observability dashboard backend
│       ├── orchestrator/       # retained v2 orchestrator (no longer wired)
│       └── understanding/      # long-term memory / Glass Goals integration
├── devlog/                     # dated design docs & handoffs — one folder per feature
├── principles/                 # engineering principles
└── agent.md / CLAUDE.md        # repo conventions for agents working here
```

The boot path worth reading first is
[`commands/start.ts`](packages/rusa/src/commands/start.ts): it wires the
MCP servers, builds the `ActorMesh`, creates the root, attaches the inbound edges
(webhook + chat), and starts the lifecycle/sweep loop.

### The MCP boundary & the e2e seam

Because **everything the agent touches is an MCP server**, the difference between
production and end-to-end testing is *just which MCP implementations you wire* —
real `gh`/Chat versus fakes. The self-contained runner (`src/e2e`, `pnpm e2e up`)
boots a complete disposable instance against a throwaway repo and a local bare
git "remote," swapping **only the GitHub edge** so everything above it is the real
production code. See
[`devlog/2026-06-07-self-contained-runner/`](devlog/2026-06-07-self-contained-runner/).

---

## Development & Workflows

### Common commands

Run from the repo root (pnpm workspace):

```bash
pnpm install          # install workspace dependencies
pnpm build            # build all packages
pnpm test             # run the test suites
pnpm typecheck        # type-check all packages
pnpm lint             # Biome lint
pnpm format           # Biome format (write)
```

The rusa CLI itself lives in `packages/rusa`:

```bash
pnpm cli <args>                       # build + run the CLI against a test home
# inside packages/rusa:
rusa start                            # boot as the root actor over the live edge
rusa init                             # interactive instance setup
pnpm e2e up                           # boot a disposable end-to-end instance
```

> **Prerequisite:** worker/coding runs are sandboxed with **bubblewrap**
> (`apt install bubblewrap`); `rusa start` fails fast if the host can't
> sandbox.

### Design docs & devlogs

This repo is built *by* agents, so the working conventions live in
[`agent.md`](agent.md) and are worth following:

> **When working on a sizeable feature, always create a new folder under
> `devlog/` and create a `design.md` file.**

Each feature gets a dated folder under [`devlog/`](devlog/) (e.g.
`2026-06-15-actor-mesh/`) holding its `design.md` — the rationale, target shape,
open questions, and build order — alongside any handoff notes. Reading the most
recent devlogs is the fastest way to understand *why* the system looks the way it
does and where it's heading. Notable recent ones:

- [`2026-06-15-actor-mesh/`](devlog/2026-06-15-actor-mesh/) — the actor-mesh
  architecture this README describes.
- [`2026-06-09-v2-rebuild/`](devlog/2026-06-09-v2-rebuild/) — the clean
  thread-model core the mesh was layered onto.
- [`2026-06-07-self-contained-runner/`](devlog/2026-06-07-self-contained-runner/)
  — the agent-drivable end-to-end runner.

### Memory model

The system keeps three tiers of memory, deliberately separated:

| Tier | Mechanism | Persistence |
| --- | --- | --- |
| **Working memory** | each actor's continued, compacting session | a *losable cache* |
| **Long-term memory** | the understanding library (durable judgment & decisions) | durable, authoritative |
| **Facts** | tracker-MCP / chat-MCP (issues, PRs, chat) | not ours — re-derived each wake |

Sessions are reconstructable; the only state rusa durably *owns* is its
long-term library plus the thread registry (the org chart of live actors).
