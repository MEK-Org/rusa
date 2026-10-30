# Host-owned custom MCP services

`customMcpServers` connects an independently running MCP service behind
Rusa's existing per-actor MCP endpoint. The service owns its graph context,
authentication and persistent cache. It stays running when an actor disconnects;
Rusa neither starts it nor shuts it down. This follows the quota coordinator's
HTTP-over-Unix-socket transport pattern.

An entry grants no actor access, including the default actor. An actor needs a
separate durable `<capability>:<configured-user-id>:read` or `:write` grant.
A write grant includes read tools. The existing capability administrator grants
and revokes these permissions. Bare capabilities, wrong users and unknown scopes
are rejected at grant time and cannot mount an endpoint.

```yaml
customMcpServers:
  glass_goals:
    socketPath: /run/example-graph/service.sock
    tokenFile: example-graph-token
    userId: example-user
    readTools: [read_tool_name]
    writeTools: [write_tool_name]
```

`socketPath` is an absolute Unix socket path on the Rusa leader. The operator
starts the service beforehand in a private directory (0700), with a private
socket (0600). `tokenFile` is a plain filename under `RUSA_HOME/secrets`; the host
reads it for every request using the existing containment checks, so replacing
it rotates authentication without restarting actor sessions. Never grant this
host authentication secret to actors. The service must require bearer
authentication, independently validate the configured user and its allowed
scope, and keep its own backing-store credentials private.

The configured `userId` is a fixed visible-ASCII, colon-free identity, independent
of `understanding.glassGoals.username`. No actor identifier is sent upstream,
and tool arguments cannot select graph identity or authority. The service binds
its graph context by trusted project/backend/authenticated user. It validates
scope separately for every request, allowing authorized reader and writer
clients to reuse graph context without sharing mutable authorization state.

## Service contract

The service is an ordinary MCP server speaking the official protocol revision
`2026-07-28` over stateless Streamable HTTP, as served by the TypeScript SDK's
`@modelcontextprotocol/server` 2.x `createMcpHandler`. Rusa is a pinned
`@modelcontextprotocol/client` 2.x client: it never falls back to the 2025
`initialize` handshake, so a legacy-only server is refused, not negotiated with.

| Request | Response |
| --- | --- |
| `POST /mcp` on the socket, `server/discover` | the server's identity, revisions and capabilities |
| `POST /mcp`, `tools/list` | the tools the request's scope allows, with `readOnlyHint` annotations |
| `POST /mcp`, `tools/call` | the MCP `CallToolResult` for one tool |

Every request is a plain JSON-RPC request answered with plain JSON on the same
exchange (no session, SSE stream or `mcp-session-id`); `Host` is `localhost`.
All requests carry `Authorization: Bearer <host-token>`,
`rusa-mcp-user-id: <configured-user>` and `rusa-mcp-scope: read|write`. Each
Rusa exchange opens its own connection: a `server/discover` probe for the
pinned revision followed by the one request. Discovery carries the actor's
current effective scope; each tool call carries only the scope its configured
classification requires. The service lists only the tools the request's scope
allows (`write` includes `read`) and knows no other tool at that scope; Rusa's
`readTools` / `writeTools` classification then decides what an actor sees and
calls.

The service refuses an invalid token or unknown user with HTTP 401
`invalid_token` and a call beyond the granted scope with HTTP 403
`insufficient_scope`, the SDK's bearer challenge responses. Rusa makes no
step-up or re-authorization attempt: a refusal surfaces to the actor as a
generic `custom MCP upstream refused` tool error, or empty discovery, with the
status code but none of the challenge detail in Rusa's log.

The trusted service owns the safety of valid tool results, including `isError`
domain errors: it must return caller-safe messages and replace internal exceptions
with generic errors, excluding host tokens, paths and backing-store details.
Rusa preserves those valid results; it cannot distinguish a useful domain error
from an unsafe exception encoded as one. HTTP, transport, JSON, negotiation and
result-schema failures return a generic unavailable error to the actor. Rusa
excludes their upstream bodies, arguments and authentication from its failure
logs; SDK error messages quote response text and are never logged.

Rusa limits tool arguments and request bodies to 1 MiB and responses to
16 MiB, with a 30-second deadline per exchange. Requests exceeding those bounds
fail without being sent. Cancelling an MCP call or closing its downstream
session aborts only its HTTP exchange; it leaves the service and warm graph
context alive. A later request opens a fresh connection. No request is
automatically retried, including a write whose connection failed after its
outcome became uncertain.

The proxy exposes only explicitly classified `readTools` / `writeTools` and
rechecks current actor grants during discovery and every invocation. It does
not forward upstream resources, prompts, subscriptions or notifications.
Revocation removes the per-actor endpoint and closes downstream sessions; an
invocation racing teardown is also checked. A scope change affects subsequent
requests; requests already admitted retain their own authority and may finish.
A later request does not cancel them. Cancellation or revocation cannot undo a
write already committed by the service. A service can never shadow a built-in
MCP server, worker endpoint or reserved capability.

Leader-local actors use the existing per-actor MCP endpoint. Follower actors use
the established authenticated follower proxy; the service and its credentials
remain on the leader. All provider adapters consume the same generated MCP map,
so none needs an external endpoint or credential. An absent service fails with
empty discovery or a bounded tool error and is attempted anew on the next call.
Windows named pipes, remote service URLs and actor-owned service startup are
not supported by this configuration. The former `command`, `args`, `cwd` and
`env` stdio fields are rejected; update that configuration to the service fields.
The earlier bespoke `/v1/tools` HTTP JSON contract is no longer spoken.

`src/mcp/custom-http-mcp.test.ts` exercises a real synthetic Unix-socket MCP
service, built on the official server SDK with legacy requests rejected,
through the configured factory, per-actor MCP sessions, mesh grants and
follower proxy. It covers denied/wrong-user access, read/write and cross-actor
scope isolation, invocation-time revocation, upstream scope refusal, graph
context reuse across calls and client reconnects, service restart,
authentication rotation, cancellation, deadlines, size bounds and redacted
errors, and asserts that no exchange ever used the legacy handshake. Actual
Glass Goals executable composition is validated separately with synthetic
graphs; these tests do not authorize personal graph access, live configuration
or deployment.
