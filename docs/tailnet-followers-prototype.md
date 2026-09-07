# Tailnet follower prototype

Start the leader and follower independently, then choose a registered follower
when spawning an actor. One leader remains authoritative; a follower hosts
multiple actors and stays connected when individual actors are retired.

Both leader and follower host ordinary `Actor` objects inside their single Node
process. Only provider CLI invocations are subprocesses. On the leader,
`FollowerHub` maintains registered `RemoteInstance` objects, each of which owns
its actor channels and command queue. `ActorHandle` is only the compatibility
adapter for the existing mesh interface; it never spawns or kills a process.

```text
Leader Node process                       Follower Node process
  ActorMesh / authoritative state           FollowerInstance
  RemoteInstance ── instance connection ──▶   Actor A → provider CLI subprocess
    actor-addressed handles                 Actor B → provider CLI subprocess
```

The earlier local-process demo, per-actor Node entrypoint, and `--worker-runtime`
mode have been removed. Protocol version 2 requires rebuilding both ends;
old followers are rejected at enrollment. Existing running instances are not
automatically upgraded or restarted.

The follower gateway can be hosted either persistently in `rusa start` (for staging
and production) via `config.yaml`, or in a disposable E2E instance via `rusa am-up`.
The gateway binds only to a specified Tailscale IPv4 address (`100.64.0.0/10`) or
loopback (`127.0.0.1` for local testing); public interfaces and wildcard `0.0.0.0`
are strictly refused.

## Persistent leader configuration (`rusa start`)

In `config.yaml`, configure the `followers:` block:

```yaml
followers:
  bind: 100.x.y.z        # Tailscale IPv4 (100.64.0.0/10) or 127.0.0.1. Refuses 0.0.0.0.
  port: 8290
  tokenFile: /absolute/private/path/enrollment-token
```

Generate the enrollment token if needed:
```sh
node scripts/follower-token.mjs /absolute/private/path/enrollment-token
```

When `rusa start` runs with this configuration, it starts `FollowerHub`, binds to
the configured address and port, and enables remote placement for `POST /api/mesh/actors`
and `spawn_thread`.


## Mac setup

Requires Node 20.19+ and pnpm. Clone the repository with its submodules:

```sh
git clone --recurse-submodules https://github.com/MEK-Org/rusa.git rusa-follower
cd rusa-follower
pnpm install --frozen-lockfile
pnpm --filter rusa run build:follower
```

For an existing clone, pull and run `git submodule update --init --recursive`
before installing. Leader and follower must be built from the same commit —
enrollment rejects a mismatched instance protocol version rather than
negotiating one, so upgrade both ends together. The follower build does not
build Flutter or start any leader services.

Create a separate follower home, then copy the enrollment secret from the leader
using your existing SSH access. All addresses, names and absolute paths below
are placeholders: substitute your own values locally, and do not commit private
infrastructure details or enrollment secrets to the repository.

```sh
mkdir -p /absolute/path/to/follower-home
scp '<ssh-user>@<leader-tailnet-host>:/absolute/private/path/enrollment-token' \
  /absolute/path/to/follower-home/token
chmod 600 /absolute/path/to/follower-home/token
```

You can use your normal SSH host alias instead. The enrollment secret grants
access to this prototype gateway, so keep the token file private.

From the cloned repository, start the follower in the foreground:

```sh
node packages/rusa/build/follower/follower.js \
  --leader 'http://<leader-tailscale-ip>:8290' \
  --id '<follower-name>' \
  --home /absolute/path/to/follower-home \
  --token-file /absolute/path/to/follower-home/token \
  --sandbox none
```

Leave this terminal running. The follower writes its diagnostics through the
application logger, so a `follower_registered` record naming the leader origin
and the follower pid means enrollment succeeded; it does not yet mean an actor
was spawned. No inbound Mac listener, Tailscale Serve configuration, or Mac
Remote Login is needed. Outbound access from the Mac to the leader's TCP port
8290 must be allowed by the tailnet policy.

On macOS, `--sandbox none` runs provider CLIs with the local user's permissions.
Workers are placed under the dedicated follower home's `workers/` directory;
this directory convention is not an OS security boundary. The first transport
check uses the scripted provider and requires no model credentials. Real runs
require the chosen provider CLI installed and authenticated on the Mac.

## Leader setup

From `packages/rusa`, build into a separate directory and create a new secret:

```sh
RUSA_DIST_DIR=build/tailnet-leader pnpm exec tsup
RUSA_DIST_DIR=build/tailnet-leader node scripts/copy-assets.mjs
node scripts/follower-token.mjs /absolute/private/path/enrollment-token
node build/tailnet-leader/commands/e2e.cli.js am-up \
  --root /absolute/path/to/a/new/disposable/leader \
  --root-driver external --port-offset 200 \
  --follower-bind '<leader-tailscale-ip>' --follower-port 8290 \
  --follower-token-file /absolute/private/path/enrollment-token
```

Substitute the leader's own Tailscale IPv4 address. If managing this process
through a service manager, choose a distinct test-only unit name and state
directory. Stop only that test unit; do not stop another mesh's instance.

## Spawn and test

The leader's control API remains loopback-only. On the leader:

```sh
# Staging/production dashboard API (port 8080 by default):
curl -fsS http://127.0.0.1:8080/api/mesh/followers

# Or E2E harness (port offset 200 -> port 8286):
curl -fsS http://127.0.0.1:8286/followers
node scripts/follower-smoke.mjs --target '<follower-name>' --port 8286
```

The smoke test uses the real Actor, provider registry, MCP HTTP transport and
durable mesh messaging with a scripted provider. It verifies two runs in the
same actor/session, two replies to the parent's inbox, and that retiring one
actor leaves the follower and its sibling alive. It retires its test actors.
It also checks that both actors execute in the registered follower's single PID.
Follower workspaces are retained for inspection.

Automated instance and restart tests:

```sh
pnpm exec vitest run src/experimental/remote-instances
```

Tests cover instance registration/versioning, safe bind enforcement (refusing 0.0.0.0
and public IPs), shared PID, actor-local sessions, fresh admission-time prompts,
active retirement, initialization failure, disconnect, automatic reconnect with backoff,
actor re-attachment by ID across synthetic leader restart, and MCP capability routing/revocation —
both mid-life, when a grant leaves the snapshot, and at actor exit.

### Placement API and model-facing tools

Remote placement is fully model-facing and API-accessible:

1. **Model-facing MCP tools**:
   - `list_followers`: Returns the list of currently connected follower nodes and their platform/actor details.
   - `spawn_thread`: Accepts an optional `target: "<follower-name>"` parameter.
2. **Dashboard REST API**:
   - `GET /api/mesh/followers`: Returns `{ followers: [...] }`.
   - `POST /api/mesh/actors`: Accepts optional `target: "<follower-name>"`.
   - `GET /api/mesh/threads`: Thread DTO includes `executionTarget: "<follower-name>" | null`.
3. **Fail-closed placement**:
   - If `target` specifies an unknown or disconnected follower, the request immediately fails with a 400 error (or tool error).
   - Remote placement never silently falls back to local execution.

Example spawn via control API:

```sh
curl -fsS http://127.0.0.1:8080/api/mesh/actors -H 'content-type: application/json' \
  -d '{"target":"<follower-name>","provider":"codex","model":"gpt-5.6-sol","charter":"Perform the bounded task sent in your inbox, report to your parent, and yield."}'
```

Send work to the returned ID with `POST /api/mesh/actors/<id>/chat` or mesh `send_message`. Spawning alone
does not start a run. Omitting `target` keeps execution on the leader.

## What crosses the connection

The follower authenticates with a secret, receives a registration session, and
long-polls the leader for actor commands. It forwards actor events over HTTP.
Each actor runs the original `Actor` class inside the follower process, using
locally installed provider adapters and credentials. The follower assigns each
actor a local workspace without changing process-wide cwd or per-actor environment.
Provider factories are local code, never module paths supplied over the network.

The leader keeps records, inboxes, prompt assembly, admission, accounting and
MCP servers. Per-actor unguessable gateway URLs forward only assigned leader
MCP endpoints, preserving streaming and session headers. The URL set is
reconciled against the actor's capabilities on every refresh, so a grant the
leader withdraws stops resolving while the actor is still running, not only
when it exits; exit revokes whatever is left. Control enrollment secrets are
not included in actor tool URLs. Tailscale provides the encrypted network
connection; the HTTP gateway is not intended for the public internet.

`/mcp/<key>` is deliberately the one gateway path that does not check the
enrollment bearer token: the 256-bit random path segment is itself the
capability, and the gateway strips any inbound `authorization` header before
proxying to the leader. That is the tradeoff this prototype accepts. It keeps
the follower from ever holding the control secret — a compromised follower
process can reach only the MCP endpoints currently assigned to its own actors —
at the cost of putting a bearer capability in a URL, where request logs, proxies
and process listings can capture it. The gateway therefore never logs request
paths, and the routing table is in memory only.

## Reconnect and durability across leader restarts

1. **Durable placement**: `executionTarget` is persisted on the `ActorRecord` in `mesh.db`'s
   application-owned `context_config` JSON document. The reader accepts the previous strict
   v1 document and this build writes strict v2 documents; this is not a SQL migration and does
   not add a database JSON validator.
2. **Client-side backoff reconnect**: If the leader restarts or transient network interruptions occur, the follower does not exit; it initiates an exponential backoff reconnect loop calling `/register`.
3. **Re-attachment and capability re-issuance**: When the leader restarts and the follower re-enrolls, the leader re-attaches placed actors by ID and re-issues fresh bearer capability URLs. Unhandled inbox items trigger recovery wakes.

Before enabling placement, take the normal `mesh.db` backup for the deploy. Once a v2 document
has been written, do not roll the database back to a pre-v2 binary: that binary strictly rejects
the newer document. Roll forward with a fix, or restore the pre-rollout database snapshot as a
coordinated service rollback. There is no SQL migration to reverse.

## Provider and computer-use support

- **Codex computer use**: Downstream of the 2026-09-06 live follower validation test on macOS against an E2E leader, where Codex's native computer-use MCP (screen/accessibility state, mouse, keyboard) drove Notes.app end-to-end without macOS permission prompts. Rusa does not provide a custom desktop automation harness or macOS sandboxing; execution relies on the provider's native host capabilities.
- **Claude computer use**: Strictly excluded and out of scope for #301 per the 2026-09-06 operator scope ruling. Headless Claude Code sessions lack a computer-use tool in this environment; no PTY harness or desktop automation tooling is provided or attempted.

## Limits

Leader run accounting is exactly-once for admitted runs: a dropped connection fails
exactly one durable run when it interrupts a run the leader had admitted, and
books nothing when the follower was idle or never finished starting. The work
that run was performing is not resumed or replayed, so effects the provider
already committed are not exactly-once.

The leader expires unresponsive followers after 45 seconds. Provider process-tree
cleanup after an abrupt crash still needs validation beyond this experiment.
There is deliberately no per-actor Node crash isolation, matching the leader.
Retirement interrupts/closes only that Actor; instance shutdown closes all actors.

Local files stay on the follower. Media/file transfer, leader-local repository
URL rewrites, host-job tools, Understanding mounts, provider/model changes and
interrupt/preemption are not portable yet. Start with local file tasks and the
ordinary inbox/mesh tools. Desktop capture/control and macOS permissions remain
separate work. The leader may send provider configuration, but provider secrets
and account authentication should be provisioned locally on the follower.
