# Actors in another process: prototype

For the follow-on instance-registration and Tailscale experiment, see
[Tailnet follower prototype](tailnet-followers-prototype.md). This page describes
the original one-child-process adapter and its local smoke test.

The real `Actor` loop and its provider adapter can run in a separate local Node
process. The coordinator keeps actor records, durable inboxes, MCP servers,
prompt assembly, provider pacing, and concurrency admission. A `ProcessActor`
implements the mesh runtime contract and exchanges data over Node IPC.

This is an opt-in E2E experiment. Normal service startup is unchanged.

## Try it with the existing E2E runner

From the repository root:

```sh
pnpm e2e am-up --root-driver external --worker-runtime process --port-offset 100
```

This is the usual disposable E2E instance: real configured providers, fake
GitHub/chat, a local scratch repository, and the real mesh/MCP/inbox stack.
Every worker uses a separate actor process; the external root is controlled
through the existing HTTP API. The offset puts the dashboard on 8183, tracker
on 8184, chat control on 8185, and root control on 8186. It permits an experiment
alongside another E2E instance using the defaults. On resume, use the same
offset; the dashboard port is persisted in the instance configuration.

Copy the printed `E2E_ROOT` and run, from `packages/rusa`:

```sh
node scripts/process-actor-smoke.mjs \
  --root /absolute/path/from/E2E_ROOT \
  --port 8186 --provider claude --model claude-sonnet-5
```

Use a provider/model configured and available on your machine. The smoke test
performs two real provider runs. It verifies different coordinator/actor PIDs,
a file created on the first run and updated on the second, unchanged actor PID
and provider session ID, and a worker reply in the parent's durable inbox.
It saves the final file and a JSON report under `E2E_ROOT/process-actor-smoke/`
before retiring its worker. Retirement removes the worker's original workspace.
The default deadline is four minutes across both runs; use `--timeout-ms` to
adjust it. A timeout leaves an active worker available for inspection.

To drive a larger scenario, use the existing `POST /actors` and
`POST /actors/:id/messages` APIs with the same runtime flag. Creating an actor
alone does not wake it: deliver its first message explicitly. `GET /actors/:id`
includes execution PIDs, and `/actors/:id/context` exposes recent run events.

Stop the instance and preserve its database, transcripts, and smoke evidence:

```sh
pnpm e2e am-down --root /absolute/path/from/E2E_ROOT --preserve
```

## Fast local checks

From `packages/rusa`:

```sh
pnpm run prototype:process-actors
pnpm exec vitest run src/experimental/process-actors/process-actor.test.ts
```

The standalone demo uses the real Actor and ActorMesh with a scripted provider
and ephemeral coordinator state. It requires neither provider credentials nor
an E2E service. The tests exercise messages, session reuse, fresh admission-time
prompts, shared concurrency, startup failure, crash cleanup, and retirement.

## Boundary being explored

- `start.ts` accepts an E2E-only worker factory, after building the normal actor
  options and actor-scoped MCP endpoints.
- `e2e-adapter.ts` preserves the normal hooks and reconstructs the configured
  provider inside the child. The provider's existing Linux sandbox still applies.
- `process-actor.ts` receives wake/yield requests and holds a central scheduling
  slot until the child releases it or exits. Run results are acknowledged only
  after the coordinator's completion hooks finish.
- `child.ts` owns the Actor/TriggerRunner, provider execution, and local session
  use. It obtains a fresh prompt and MCP configuration after admission.
- Production MCP tools remain in the coordinator. On this machine their
  loopback URLs work unchanged from the child process.

The experiment demonstrates **execution can move without moving mesh
authority**. It does not yet establish a remote-node protocol. IPC carries
trusted data and the child shares the host filesystem and credential layout.
One actor per child keeps the experiment easy to inspect; a future node runner
could host multiple actors.

Deliberately deferred: node registration/placement, authentication over the
network, reconnect/replay, automatic restart, file transfer, desktop tooling,
and macOS isolation. Live provider/model changes, queued-run promotion/cancel,
and synchronous interrupt/preemption are not supported by this adapter. Its
state getters are last-reported state, not cross-process synchronous reads.
Provider process-tree cleanup on an abrupt actor-host crash needs separate
validation before relying on this beyond a disposable experiment.

Initial real-run validation used Claude `claude-sonnet-5`: coordinator PID
1062214, actor PID 1063482, two successful wakes sharing provider session
`1ffbec19-1c1f-4749-9685-33074f1800f7`, verified file edits, a parent inbox reply,
and worker retirement. No remote machine was involved.
