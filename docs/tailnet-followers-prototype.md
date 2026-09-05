# Tailnet follower prototype

Start the leader and follower independently, then choose a registered follower
when spawning an actor. One leader remains authoritative; a follower hosts
multiple actors and stays connected when individual actors are retired.

The leader runs a disposable E2E instance with its own directory, ports and
database. Its GitHub/chat endpoints are fakes. Never stop another mesh's E2E
instance to run this experiment. `--port-offset 200` uses ports 8283–8286,
and the follower gateway uses 8290. The gateway binds only to a specified
Tailscale address (or loopback for testing), not the public interface.

## Mac setup

Requires Node 20.19+ and pnpm. Clone the prototype branch with its submodule:

```sh
git clone --recurse-submodules --branch codex/tailnet-followers \
  https://github.com/MEK-Org/rusa.git rusa-follower-prototype
cd rusa-follower-prototype
pnpm install --frozen-lockfile
pnpm --filter rusa run build:follower
```

For an existing clone, fetch/check out the branch and run
`git submodule update --init --recursive` before installing. The follower build
does not build Flutter or start any leader services.

Create a separate follower home, then copy the enrollment secret from the leader
using your existing SSH access. For the development host:

```sh
mkdir -p "$HOME/.rusa-follower-prototype"
scp siliconfamiliar_ismattkelleraliv@metacoder.tail4ab4ae.ts.net:/home/siliconfamiliar_ismattkelleraliv/.rusa-tailnet-prototype/enrollment-token \
  "$HOME/.rusa-follower-prototype/token"
chmod 600 "$HOME/.rusa-follower-prototype/token"
```

Use your normal SSH host alias if this SSH spelling is not configured for your
account. The enrollment secret is never committed to the repository. It grants
access to this prototype gateway, so keep the token file private.

From the cloned repository, start the follower in the foreground:

```sh
node packages/rusa/build/follower/follower.js \
  --leader http://100.124.251.63:8290 \
  --id mac-air \
  --home "$HOME/.rusa-follower-prototype" \
  --token-file "$HOME/.rusa-follower-prototype/token" \
  --sandbox none
```

Leave this terminal running. `Follower mac-air registered` means enrollment
succeeded; it does not yet mean an actor was spawned. No inbound Mac listener,
Tailscale Serve configuration, or Mac Remote Login is needed. Outbound access
from the Mac to the leader's TCP port 8290 must be allowed by the tailnet policy.

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
  --root-driver external --worker-runtime process --port-offset 200 \
  --follower-bind 100.124.251.63 --follower-port 8290 \
  --follower-token-file /absolute/private/path/enrollment-token
```

Substitute the leader's own Tailscale IPv4 address. The development host's
running instance is managed by the distinct user unit
`rusa-tailnet-prototype.service` and lives under
`~/.rusa-tailnet-prototype/leader-20260905`. Only that unit belongs to this test.

## Spawn and test

The leader's control API remains loopback-only. On the leader:

```sh
curl -fsS http://127.0.0.1:8286/followers
node scripts/follower-smoke.mjs --target mac-air --port 8286
```

The smoke test uses the real Actor, provider registry, MCP HTTP transport and
durable mesh messaging with a scripted provider. It verifies two runs in the
same actor/session, two replies to the parent's inbox, and that retiring one
actor leaves the follower and its sibling alive. It retires its test actors.
Follower workspaces are retained for inspection.

For real work, use the existing control API and add `target`:

```sh
curl -fsS http://127.0.0.1:8286/actors -H 'content-type: application/json' \
  -d '{"target":"mac-air","provider":"claude","model":"claude-sonnet-5","charter":"Perform the bounded task sent in your inbox, report to your parent, and yield."}'
```

Send work to the returned ID with `POST /actors/<id>/messages`. Spawning alone
does not start a run. Omitting `target` keeps execution on the leader. This
prototype exposes placement through the E2E controller; the model-facing
`spawn_thread` tool does not yet offer the target field.

## What crosses the connection

The follower authenticates with a secret, receives a registration session, and
long-polls the leader for actor commands. It forwards actor events over HTTP.
Each actor still runs the original `Actor` class in its own child process.
The child uses locally installed provider adapters and credentials; leader
working-directory and module paths are replaced with follower-local paths.

The leader keeps records, inboxes, prompt assembly, admission, accounting and
MCP servers. Per-actor unguessable gateway URLs forward only assigned leader
MCP endpoints, preserving streaming and session headers. Those capabilities
are revoked when the actor exits. Control enrollment secrets are not included
in actor tool URLs. Tailscale provides the encrypted network connection;
the HTTP gateway is not intended for the public internet.

## Limits

This is a connectivity/lifecycle prototype, not durable federation. Placement
and follower sessions are in memory. Start a fresh leader rather than resuming
these instances. A connection failure stops the follower generation; automatic
reconnect, command replay, actor migration and exactly-once effects are deferred.
The leader expires unresponsive followers after 45 seconds. Provider process-tree
cleanup after an abrupt crash still needs validation beyond this experiment.

Local files stay on the follower. Media/file transfer, leader-local repository
URL rewrites, host-job tools, Understanding mounts, provider/model changes and
interrupt/preemption are not portable yet. Start with local file tasks and the
ordinary inbox/mesh tools. Desktop capture/control and macOS permissions remain
separate work. The leader may send provider configuration, but provider secrets
and account authentication should be provisioned locally on the follower.
