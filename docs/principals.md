# Principals

Durable identity storage for actors, admitted users, and the mesh's own writes.
This document states what is stored, what deliberately has **not** changed yet,
and the exact list of code that still decides identity by reading a string —
the work the next slice has to do.

## What exists

`principals` is the supertype: one row per identity, carrying its `kind`
(`actor`, `user`, `system`). An actor's principal id **is** its actor id, so
every id already written into an attribution column keeps resolving as itself.
`users` is the subtype for admitted people, keyed by verified Firebase issuer +
subject, with email as mutable admission metadata.

`PrincipalRepository` (`src/db/repositories/principal-repository.ts`) is the
only writer. `SqliteActorRepository.upsert` records an actor's principal inside
the same transaction as the actor row, so spawn and legacy import both get it
without either having to remember. `PrincipalRef`
(`src/principals/principal-ref.ts`) is the typed value a caller gets back — it
exists only because a row does.

Lifecycle, against the actor lifecycle as it actually is:

- **Retirement** is a `retired_at` timestamp on `actors`. The principal is
  untouched: a retired actor's attributed history stays attributable.
- **Deletion** of an actor is refused (`ON DELETE RESTRICT`) while a principal
  names it, and while any user holds it as their root. Nothing deletes actors
  today; this fixes the answer before something starts asking.
- **Disabling a user** is a `disabled_at` timestamp. The root actor, the bound
  identity and all history are preserved.

## The boundary this slice stops at

Nothing here changes who anything is attributed to, and nothing here
authenticates. Specifically:

- **`human:operator` gets no principal row, and no alias table exists.** The
  historical references to it are migrated by hand, as a deployment operation,
  before an upgraded instance serves traffic. This slice must not decide who
  they belong to, and there is no runtime reinterpretation of the literal.
- **No attribution column has a foreign key to `principals`.** One would refuse
  every legacy row still holding `human:operator`. Those keys are added after
  the manual cutover, not before.
- **No user is created by interpreting an owner string.** `createUser` mints its
  own opaque id and offers no way to choose one, so an arbitrary string found in
  an attribution column cannot become a user.
- **The single-root invariant stands.** `actors_single_root_idx` still permits
  one parentless actor, so at most one user can hold a root until the multi-root
  runtime slice lifts it. `users.root_actor_id` is nullable for that reason,
  among others.
- **No Firebase, session, network or route authorization code lands here.**
  `last_authenticated_at` has a storage-level writer and no caller yet.

## Consumers the next slice must switch

Each of these decides identity today by reading a string, and each has to move
onto `PrincipalRef`. This is the reason the storage exists. The list was derived
by grepping for `HUMAN_OPERATOR`, `MESH_SYSTEM`, `isHumanOperator`,
`isSystemActor` and the bare `human:operator` literal across `packages/rusa/src`
and dropping the hits that are prose — a prompt string, JSDoc, and comments in
`worker-prompt.ts`, `providers/types.ts`, `voice/wiring.ts` and
`webhook/server.ts`. Re-run that grep before trusting it; it is accurate as of
this branch, not permanently.

**The id space itself**

- `src/obligations/obligation.ts` — `EntityId` is documented as "an actor UUID,
  `root`, `human:*`, or `system:*`", deliberately an id without a kind. That
  decision is what the principal supertype supersedes.
- `src/mcp/stamp.ts` — `HUMAN_OPERATOR`, `MESH_SYSTEM`, `isHumanOperator` and
  `isSystemActor` are the prefix tests every other consumer calls.

**Prefix tests on a caller's identity**

- `src/actor/actor-mesh.ts` — human-origin message handling, and the
  system-author suppression rule in `deliverEvent`.
- `src/mcp/agent-exec-mcp.ts` — the human-operator branch on `selfId`.
- `src/actor/inbox-hints.ts` — human-origin hinting on `fromId`.
- `src/actor/failure-sink.ts` — `isHumanOperatorCancelled`.

**Writers of the literal**

- `src/dashboard/api.ts` and `src/commands/e2e-actor-mesh.ts` — `creatorId:
  HUMAN_OPERATOR` on obligation creation.
- `src/actor/actor-mesh.ts` — `fromId = HUMAN_OPERATOR` for operator-originated
  messages, and `MESH_SYSTEM` for dropped-delivery notices.
- `src/actor/actor.ts` — `interrupt(by = "human:operator")` defaults the
  interrupt's attribution to the literal, so an unattributed interrupt silently
  becomes an operator-attributed one. A `PrincipalRef` parameter with no default
  would make the caller say who it was.

**A parallel principal vocabulary**

- `src/actor/root-control.ts` — `RootControlPrincipal` is
  `"root-llm" | "human:operator" | "e2e-controller"`, a hand-rolled union naming
  who may drive the root. It is the closest thing in the tree to a typed
  principal and it overlaps this one only at `human:operator`; the other two are
  control-plane callers, not identities. Worth folding in deliberately rather
  than by coincidence of a shared string.

**Readers that compare against it**

- `src/obligations/owner.ts` — `resolveObligationOwner` admits the single
  canonical operator id or a live actor; this is the one write boundary every
  owner passes through, and the natural place to accept a `PrincipalRef`.
- `src/db/repositories/sqlite-actor-repository.ts` — derives `humanUnlocked` and
  `lastChatSessionId` from chat rows whose sender is the operator literal.
- `src/voice/voice-service.ts` — announcements are gated on the recipient being
  the operator.
- `src/commands/chat.ts` — its own local copy of the literal, for the CLI
  transcript's "you" label.

**Attribution columns holding these ids**

`obligations.owner_id` and `obligations.creator_id`; `mesh_chat.sender_id` and
`recipient_id`; `mesh_events.actor_id`; `actor_inbox_entries.actor_id`;
`capability_grants.granted_by`.

Completing this list is what completes the identity half of authenticated
multi-user mode. Finishing the storage does not finish it.
