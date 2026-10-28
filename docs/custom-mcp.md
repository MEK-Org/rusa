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
`glass_goals:example-user:read` or `glass_goals:example-user:write`:

```yaml
customMcpServers:
  glass_goals:
    command: /opt/glass-goals/bin/mcp-server
    args: ["--stdio"]
    userId: example-user
    # Use the external server's confirmed tool names. Each must appear in one
    # list only; the proxy exposes no discovered-but-unlisted tool.
    readTools: [read_tool_name]
    writeTools: [write_tool_name]
```

The configured `userId` is colon-free so Rusa can parse a grant without ever
accepting a graph user from MCP arguments. Each private upstream session is
launched with fixed `RUSA_MCP_USER_ID` and `RUSA_MCP_SCOPE` (`read` or `write`)
environment values. A change between read and write closes and replaces that
private child, so the upstream never continues with a stale launch scope. Rusa
deliberately does not pass an actor ID or arbitrary configured environment
values. The executable owns any host-local credential lookup; the upstream
server must validate its fixed context and authentication independently.

The proxy lists and forwards only names in `readTools` and `writeTools`; it does
not proxy upstream resources or prompts. It re-reads the actor's active grant
on discovery and every tool call. Revoking a parameterized capability removes
the per-actor endpoint and closes current downstream sessions; the per-call
check also rejects a request racing that teardown. Stdio launch failures and
calls are bounded to 30 seconds, cancellation is passed upstream, and closing a
downstream session terminates its private child process.

The upstream child always runs on the Rusa leader. Leader-local actor runs use
its loopback endpoint directly; follower-hosted runs use the established
per-actor follower proxy, which forwards only the endpoint URLs in that
actor's current capability snapshot. Rusa does not support an actor-supplied
external MCP URL, raw credentials, a caller-selected graph user, or a shared
mutable actor/scope session.

Custom capability names cannot reuse a built-in MCP server name, preventing an
operator configuration from shadowing Rusa's existing endpoint in a provider's
MCP map.

`src/mcp/custom-stdio-mcp.test.ts` starts a real synthetic stdio fixture. It
proves default denial, the read/write tool split, wrong-user rejection,
cross-actor isolation, fixed launch identity without an actor identifier, and
revocation after a session was already established.
