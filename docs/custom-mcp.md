# Host-owned custom MCP servers

`customMcpServers` adds an operator-configured stdio MCP process behind Rusa's
existing per-actor loopback HTTP endpoint. It is for integrations such as Glass
Goals where the host, rather than an agent, owns upstream launch details and
credentials.

The upstream is independently runnable before it is registered here (for
example, `/opt/glass-goals/bin/mcp-server --stdio`). It owns its own
authentication configuration and persistent cache; Rusa neither stores nor
forwards that configuration. Registration supplies only an executable, fixed
arguments, a fixed graph user, and an explicit tool policy.

An entry configures no actor access. An actor needs a separate durable grant
whose shape is `<capability>:<configured-user-id>:read` or
`<capability>:<configured-user-id>:write`. For example, this synthetic server
is configured but unavailable until a capability administrator grants
`glass_goals:example-user:read` or `glass_goals:example-user:write`. The
mesh refuses any other shape at grant time: a bare `glass_goals`, another
user, or an unknown scope. A write grant includes the read tools, because a
writer has to find what it changes; grant `:read` alone for read-only access.

```yaml
customMcpServers:
  glass_goals:
    command: /opt/glass-goals/bin/mcp-server
    args: ["--stdio"]
    userId: example-user
    # Use the external server's confirmed tool names. Each must appear in one
    # list only, and either list may be empty as long as one is not; the proxy
    # exposes no discovered-but-unlisted tool.
    readTools: [read_tool_name]
    writeTools: [write_tool_name]
```

The configured `userId` is colon-free so Rusa can parse a grant without ever
accepting a graph user from MCP arguments. It is the upstream process's launch
binding only, and is independent of `understanding.glassGoals.username`, which
configures Rusa's own Integrated Understanding store. Each private upstream session is
launched with fixed `RUSA_MCP_USER_ID` and `RUSA_MCP_SCOPE` (`read` or `write`)
environment values. A change between read and write closes and replaces that
private child, so the upstream never continues with a stale launch scope; a
call in flight on the old child ends with it. Rusa
deliberately does not pass an actor ID or arbitrary configured environment
values. The executable owns any host-local credential lookup; the upstream
server must validate its fixed context and authentication independently.

The proxy lists and forwards only names in `readTools` and `writeTools`; it does
not proxy upstream resources or prompts. It re-reads the actor's active grant
on discovery and every tool call. Revoking a parameterized capability removes
the per-actor endpoint and closes current downstream sessions; the per-call
check also rejects a request racing that teardown. Stdio launch and calls are
bounded to 30 seconds, cancellation is passed upstream, and closing a
downstream session terminates its private child process. Concurrent first
calls share one child, and a child that exits on its own is relaunched by the
next call.

The upstream's stderr is inherited into the Rusa service log. When a granted
actor's discovery or call fails, Rusa logs `custom_mcp_upstream_failed` with
the full error; the actor sees an empty tool list or a bounded reason such as
`custom MCP upstream timed out`.

The upstream child always runs on the Rusa leader. Leader-local actor runs use
its loopback endpoint directly; follower-hosted runs use the established
per-actor follower proxy, which forwards only the endpoint URLs in that
actor's current capability snapshot. The proxy forwards by URL regardless of
server name, and the mesh-boundary test below drives a custom server through
it. Rusa does not support an actor-supplied
external MCP URL, raw credentials, a caller-selected graph user, or a shared
mutable actor/scope session.

A custom capability name cannot reuse a built-in MCP server, an always-mounted
worker endpoint, or a capability that has no server of its own (such as
`secret`); Rusa refuses to start with such a configuration rather than let it
shadow an existing endpoint in a provider's MCP map.

`src/mcp/custom-stdio-mcp.test.ts` starts a real synthetic stdio fixture. It
proves default denial, the read/write tool split, wrong-user rejection,
cross-actor isolation, fixed launch identity without an actor identifier,
revocation after a session was already established, one shared child for
concurrent first calls, relaunch after a child exit, and the logged discovery
failure. Its mesh-boundary case grants and revokes through `ActorMesh`,
rejects malformed grants, serves a follower-hosted grantee through the follower
proxy, and observes the child exit on revocation.
