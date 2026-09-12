# Multi-user authorization work — draft, not ready for review

This is implementation groundwork above PR #436 (durable request identities),
which is above PR #434 (single-user Firebase authentication). It is not a switch
to admit additional users. The operator asked this session to proceed with
multi-user work; older actor-authored proposals are context, not authority for
new product or migration decisions.

## Implemented in this slice

`TenantAuthorization` derives identity only from the server-bound request context,
then re-reads the durable user and root association. It never treats request-body
ownership, email, a guessed ID, `human:operator`, or the literal `root` as authority.

The domain checks cover a user's root and descendants, explicit actor selections,
owned objects, and both endpoints of a reparent operation. Unknown/foreign targets
have the same generic denial. Unbound/disabled/deleted users and malformed root
bindings fail closed. Ancestry loops and dangling parents terminate with denial.
Topology and user status are re-read rather than cached in a long-lived scope.

Tests use a two-root repository fixture with real server request-context binding.
They do not remove the database's single-root constraint or claim that two-user
runtime behavior has already been demonstrated.

**No live route invokes this policy yet.** Turning on multi-user admission now
would still expose global data, because today's dispatcher and runtime retain
single-operator assumptions. The single-user compatibility path stays unchanged.

## Route integration inventory

| Surface | Required enforcement before multi-user activation |
| --- | --- |
| Actor lists, charter, avatars | Scope collections before pagination; authorize every object lookup and asset key. |
| Spawn, chat, interrupt, run, voice config, reparent | Bind attribution server-side; check targets and destinations; route through the caller's root control service. |
| Inbox | Check owning actor and each selected message/entry, not only the URL filter. |
| Obligations and forests | Check owner, parent, dependencies, reassignment targets, and nested payload references; prevent cross-tenant forest expansion. |
| Events and chat history | Scope unfiltered queries and embedded cross-actor references before pagination; explicit filters only narrow authority. |
| Mesh SSE | Derive a server-side actor set even when no filter is supplied; filter every event; never translate an empty set to all actors. Revalidate ownership/status while connected. |
| Voice backlog, streams, audio, acknowledgement, TTS | Scope persisted audio IDs and messages, stream subscriptions, voice actors, and actions through the same tenant. |
| Quota, understanding reports/ops, control options, followers, branding | Classify tenant versus instance-wide data before exposing it. Authenticated does not mean instance administrator. |
| GitHub/chat subscriptions and machine endpoints | Keep machine authentication separate; explicitly assign inbound sources to the intended root rather than a process-global default. |

Concrete dispatcher inventory: `packages/rusa/src/dashboard/api.ts`,
`packages/rusa/src/webhook/server.ts`, and their voice/quota/understanding delegates.
Existing `RootControlService` already checks a selected root's descendants for
some actions, but its default root and process-level wiring are not tenant selection.

The current `actors_single_root_idx` in migration `0034_actor_runtime_state`
permits only one parentless actor. `ActorMesh` also retains a configured root ID
and compatibility resolution of literal `root`. Those are distinct runtime/schema
work, not solved by a request authorization helper.

## Remaining implementation sequence

1. Settle multi-user admission and instance-administration decisions with the operator.
2. Wire tenant context and scoped queries across the inventory while still rejecting
   additional users. Add HTTP, nested-object, and streaming isolation tests at each edge.
3. Add an explicit owner/root binding and manual historical cutover workflow with
   dry-run inventory, backup requirements, and consistency checks. Never auto-claim
   history on first login or infer a user from `human:operator` strings.
4. Generalize root construction, provider/runtime ownership, subscriptions, and
   schema constraints. Prove two real roots with distinct workspaces and data.
5. Enable whitelist-controlled provisioning only after full negative/positive
   two-user end-to-end coverage. Preserve the supported single-user configuration.

Scope checks must be adjacent to repository reads/mutations. Do not authorize an
actor, await unrelated work, then assume its parent/owner is unchanged. Mutation
authorization and ownership transitions need transaction-level coordination.
These helpers alone do not implement that transaction boundary or action-specific
capabilities; they must not be advertised as complete route authorization.

## Decisions still requiring confirmation

- Whether the configured instance owner has global administrative privileges or
  every browser user is limited to their own root. The isolation helper grants
  no implicit administrator bypass.
- Multi-user configuration shape, including backward-compatible handling of
  `auth.email`; the key names from older proposals are not silently adopted here.
- The exact owner/root mapping and timing for manual historical migration. No
  existing installation's data is rewritten by this work.

Until those decisions and the route/runtime gates are complete, this remains a
draft implementation branch, not a deployable multi-user mode.
