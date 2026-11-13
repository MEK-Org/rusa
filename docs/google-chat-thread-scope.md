# Google Chat thread scope

A Google Chat space can be shared between actors one thread at a time (#1311).
There are two separate relationships, and neither implies the other:

- **Write authority** is a `chat-write` capability. It decides where an actor may post.
- **Routing** is event-source ownership. It decides whose inbox a message lands in.

## Write grants

| Capability                        | Lets the holder                                     |
| --------------------------------- | --------------------------------------------------- |
| `chat-write:*`                    | post in every space                                 |
| `chat-write:spaces/S`             | post anywhere in space `S`, threads included        |
| `chat-write:S`                    | same as `chat-write:spaces/S` (legacy form)         |
| `chat-write:spaces/S/threads/T`   | reply only within thread `T` of space `S`           |

The thread form is Google's own `thread.name`, the `threadName` on a
`gchat.message` inbox payload, so you can use it as the parameter verbatim.
Grants with any other parameter are refused.

**Who may grant a thread.** An actor holding whole-space
`chat-write:spaces/S`, or `chat-write:*` (which already writes every space),
may grant `chat-write:spaces/S/threads/T` to any existing actor. It needs no
`capability-admin` and no ancestry, because the grant is narrower than what
the grantor already holds. The following can only grant a thread under the
ordinary rules, which require `capability-admin` over the grantee:

- a holder of a different space
- a holder of only the thread itself, so a thread grant cannot be re-granted

A space holder cannot use this path to grant the whole space.

**Who may revoke a thread grant.** Revoking uses the ordinary rules: a
`capability-admin` holder over the grantee. Holding the space does not
authorize revoking a thread grant, not even one the same actor issued. #1311
asks for the grant only.

A thread grant outlives its grantor's space write, as any grant outlives its
grantor's authority. If the grantor later loses `chat-write:spaces/S`, the
grantee keeps the thread until the grant is revoked.

**What a thread writer can do.** Each write tool checks the thread the
message would actually land in, after selected-inbox reply routing (#611),
not the arguments as written:

- `send_message` succeeds only when the effective thread is one of the
  writer's threads. That permission alone governs placement, the same in a
  named space, a group chat or a direct message; the tool does not read
  space metadata. The check runs before any inline attachment uploads. A
  send with no thread, which would post top-level, is refused. A selected top-level message routes replies top-level, so use
  `createThread: true` to reply under it when it heads the granted thread.
  The send asks Google to reply or fail (`REPLY_MESSAGE_OR_FAIL`), so it
  never falls back to opening a new thread.
- `react` succeeds only on a message whose `thread.name` is one of the
  writer's threads.
- `upload_attachment` is allowed in the thread's space. An upload posts
  nothing; the reply that attaches it is checked as above.

For every writer, a `threadName` must be a thread of the `spaceName` it is
sent with. A mismatched pair is refused.

## Thread delegation

An in-thread message now routes at `gchat:spaces/S/threads/T` instead of
`gchat:spaces/S`. With no owner for the thread, it bubbles to the space
owner exactly as before. So nothing changes until a space owner delegates a
thread:

```
delegate_event_source(child_thread_id: <actor>, source: "gchat:spaces/S/threads/T")
```

Precedence, most specific live owner first:

1. A live owner of `gchat:spaces/S/threads/T` receives that thread's messages.
2. Otherwise the space owner of `gchat:spaces/S` receives them, as do the
   space's other threads and new top-level messages.
3. Otherwise ownership bubbles further, to a `gchat:spaces` owner.

Direct subscribers of `gchat:spaces/S` still receive in-thread messages, as
they did when chat routed at the space. Delegation requires being the
thread's current effective owner, which the space owner is.
`reclaim_event_source` returns the thread to the space owner.

Delegating a thread grants no write authority, and granting `chat-write` on
a thread routes nothing. Give both when an actor should hear a thread and
answer in it.

## Storage

Grants and event-source rows are free-form strings in the existing tables,
so neither needs a schema change. Both persist and re-resolve after a
restart.
