# Host-owned custom MCP servers

`customMcpServers` adds an operator-configured MCP upstream behind Rusa's
existing per-actor loopback HTTP endpoint. It is for integrations such as Glass
Goals where the host, rather than an agent, owns upstream launch details and
credentials. An entry sets exactly one of:

- `command`: a stdio MCP process Rusa launches privately for each proxied
  session and ends with it; or
- `url`: the loopback Streamable HTTP endpoint of a service the operator runs
  independently. Rusa opens a private MCP session on it for each proxied
  session and never starts, restarts or stops the service, so whatever the
  service keeps in memory (such as a rendered graph) survives across calls,
  sessions and Rusa restarts.

The upstream is independently runnable before it is registered here. It owns
its own authentication configuration and persistent cache; Rusa neither stores
nor forwards that configuration. Registration supplies only an executable and
fixed arguments, or a loopback URL and the name of a host secret holding the
service's bearer token, plus a fixed graph user and an explicit tool policy.

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

A running service is configured the same way, with a URL in place of the
command:

```yaml
customMcpServers:
  glass_goals:
    url: http://127.0.0.1:7319/mcp
    # A basename directly under RUSA_HOME/secrets, holding the bearer token
    # the service was configured with.
    tokenFile: glass-goals-mcp-token
    userId: example-user
    readTools: [read_tool_name]
    writeTools: [write_tool_name]
```

The URL must be plain `http` on `127.0.0.1`, `localhost` or `[::1]`, with no
credentials, query or fragment. Actors can reach loopback ports too, so the
service must require the token: it is the only thing separating Rusa's grant
boundary from a direct connection. Rusa reads the token file when it opens each
upstream session, so a replaced file takes effect at the next session, and the
token never appears in an actor's MCP configuration or tool results.

The configured `userId` is colon-free so Rusa can parse a grant without ever
accepting a graph user from MCP arguments. It is the upstream session's binding
only, and is independent of `understanding.glassGoals.username`, which
configures Rusa's own Integrated Understanding store. Each private stdio
session is launched with fixed `RUSA_MCP_USER_ID` and `RUSA_MCP_SCOPE` (`read`
or `write`) environment values. Each private HTTP session sends the same
values as the `Rusa-Mcp-User-Id` and `Rusa-Mcp-Scope` headers, with
`Authorization: Bearer <token>`, on every request. A change between read and
write closes and replaces that private child or session, so the upstream never
continues with a stale scope; a call in flight on the old one ends with it.
Rusa deliberately does not pass an actor ID or arbitrary configured environment
values. The executable owns any host-local credential lookup; the upstream
server must validate its fixed context and authentication independently. A
service should reject a wrong token (401) or a user it does not serve (403),
keep the scope a session was opened with, and refuse write tools in a `read`
session, as a second check behind Rusa's grant filter.

The proxy lists and forwards only names in `readTools` and `writeTools`; it does
not proxy upstream resources or prompts. It re-reads the actor's active grant
on discovery and every tool call. Revoking a parameterized capability removes
the per-actor endpoint and closes current downstream sessions; the per-call
check also rejects a request racing that teardown. Upstream launch or
connection, calls, and ending an HTTP session are each bounded to 30 seconds,
and cancellation is passed upstream. Closing a downstream session terminates
its private child process, or ends its private HTTP session with `DELETE`
while the service keeps running. Concurrent first calls share one child or
session, and one that exits or fails below the protocol is replaced by the
next call. When a service answers `404` for a session it no longer knows,
typically after it restarted, Rusa opens a fresh session and retries that
request once; the service did not process it, so this is safe for writes. A
call made while the service is down fails with a bounded reason, and the next
call reconnects.

The upstream's stderr is inherited into the Rusa service log. When a granted
actor's discovery or call fails, Rusa logs `custom_mcp_upstream_failed` with
the full error; the actor sees an empty tool list or a bounded reason such as
`custom MCP upstream timed out`.

The upstream child, and the connection to a running service, always live on
the Rusa leader, so a `url` service runs on the leader host. Leader-local actor runs use
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

`src/mcp/custom-http-mcp.test.ts` starts a real synthetic HTTP service
process with a host-secret token. It proves the read/write split and fixed
user/scope headers, no service session for ungranted or wrong-user actors,
rendered-graph reuse across calls, closed client sessions and reconnects,
revocation and scope changes in an established session, cross-actor session
isolation, cancellation reaching the service, transparent recovery after a
service restart and bounded failure while it is down, service-side refusal of
a wrong token or user, refusal of a token file outside the secrets directory,
and a follower-hosted grantee whose revocation ends only its own service
session.

`src/mcp/custom-stdio-mcp.test.ts` starts a real synthetic stdio fixture. It
proves default denial, the read/write tool split, wrong-user rejection,
cross-actor isolation, fixed launch identity without an actor identifier,
revocation after a session was already established, one shared child for
concurrent first calls, relaunch after a child exit, and the logged discovery
failure. Its mesh-boundary case grants and revokes through `ActorMesh`,
rejects malformed grants, serves a follower-hosted grantee through the follower
proxy, and observes the child exit on revocation.
