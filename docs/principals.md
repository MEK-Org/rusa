# Principals

`principals` stores one identity per row, with kind `actor`, `user`, or `system`.
Identity is an opaque id; principal storage determines its kind. No human alias,
prefix recognition, automatic historical rewrite, or migration command exists.
Already-applied database migrations remain immutable historical artifacts.

`PrincipalRepository` is the identity writer. `SqliteActorRepository.upsert`
records an actor principal in the same transaction as the actor row. An actor's
principal id is its actor id. Retirement preserves its principal and history.
Disabling a user likewise preserves their identity, root association, and history.

## Human identity

Users are keyed by verified Firebase issuer and subject. Email is mutable
admission metadata, not identity. After verification, both ID tokens and session
cookies use the canonical project issuer. The nullable unique `google_account_id`
is recorded from verified Google sign-in claims and links Google Chat senders to
users; display names and email do not provide that link.

Auth-disabled startup with no users creates one implicit durable user with a
reserved internal email (`local-operator@rusa.invalid`). Repeated startup does not
create another user, and disabled users prevent bootstrap. The first admitted,
verified sign-in atomically binds and enriches the sole unbound implicit user,
preserving its id and attributed history. That internal email cannot be admitted.
A matching explicitly provisioned unbound user can also be claimed by verified
email. Bound identities are never reassigned by email.

Local mutations require exactly one active durable user. Missing or ambiguous
identity is an ordinary error, not an inferred sender. Authenticated requests
always use the verified request principal. Interrupt callers explicitly supply
their principal; obligation owners must resolve to a durable user or live actor.

The runtime's single-root invariant is unchanged. Users may share the installation
without having individual roots; claiming an identity does not change topology.

## Mesh messages

`send_message` is the single actor messaging tool. The tool binds the sender to
the calling actor; the caller names the recipient in `thread_id` and optionally
copies `session_id` from the incoming inbox payload. To answer a message, use its
`fromId` and `sessionId`. No tool infers the recipient from the latest human chat.

The same mesh delivery path stores human and agent messages in `mesh_chat` and
emits sent/received events. Actor recipients receive inbox attention; durable
user recipients receive chat/events. Human-origin actor messages are responsive.
Voice memos use this path with their existing voice marker and payload type.
Scheduled messages retain the existing agent-only scheduler.

Each dashboard viewer reads their own human conversations plus traffic between
known actors/system principals. Unknown participants and other users remain
private in chat, event history, live streams, and cited message bodies.

Voice sessions bind a principal and actor. Transfers preserve the principal and
include it directly in the handoff inbox payload. Voice presence, announcements,
audio retrieval, backlog, and acknowledgements are recipient-scoped; leased SSE
streams also match the explicit message session. No accepted-input proof or
recursive handoff chain is needed to name a message recipient.

## System resources

`system:mesh` is the infrastructure attribution principal. `system:events` is an
event-source resource, not a principal. Resource prefixes do not create identity.
