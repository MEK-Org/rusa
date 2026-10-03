# Room entry episodes (phase B)

Issue #829's [approved design](https://github.com/MEK-Org/rusa/issues/829#issuecomment-5948122445) and [incorporated contracts](https://github.com/MEK-Org/rusa/issues/829#issuecomment-5948280029) define a durable notice when a verified human opens the Room. Phase A supplies durable noninterruption. This phase supplies the episode store, producer, maintenance recovery and authenticated API. Selected-entry reply/audio authorization (phase C) and browser navigation/listening integration (phase D) follow separately. Existing browser Room behavior does not call these new endpoints yet. No production or browser acceptance follows from this phase's tests.

## Storage and migration gate

Migration `0054_room_entry_episodes` creates `room_entry_episodes` with scalar identity, principal, entry and end timestamps, plus opaque `document_json`. A partial unique index permits at most one unended episode per principal. There are no SQLite JSON validators: the consumer validates version 1, unique lease/recipient identities and the complete document on both writes and reads. Bounds are 16 current tab leases, 128 UTF-8 bytes per client ID, 1,024 recipients and 512 KiB per document. A rejected candidate rolls back its transaction; no recipient truncation or live-tab eviction occurs.

**Matt's explicit approval of this actual migration remains required before staging merge.** Normal exact-head CI and two distinct skeptic seats remain required. Root owns deployment, database backup/reset and recovery. This document commissions no live operation.

## Authenticated lifecycle

`POST /api/mesh/chat-room/entry` accepts a document-scoped `clientId`, and returns a server episode ID and attachment generation. `.../entry/renew` and `.../entry/leave` require those exact identifiers. The verified request principal and a session-cookie digest supply identity; client-supplied principal/session fields grant no authority. Existing same-origin, CSRF and authentication checks protect these mutations. Auth-disabled Room operation returns `disabled` and emits no automatic notices.

A principal's tabs share an episode and frozen active server roster. Renewal cadence is 30 seconds; leases expire 120 seconds after the last accepted client request. Heartbeat writes alone cannot renew them. A new enter replaces that tab's generation; stale renewal, leave or transport close cannot affect its replacement. Expired tab leases are removed before enforcing the current-tab limit. Last explicit leave ends immediately; missing leave falls back to expiry. Restart preserves identity but projects reconnecting until authenticated renewal. The `detach` service seam lets later transport wiring discard live presence while retaining the reconnect lease. Sign-out or observed non-transient authentication failure invalidates that session's generations; another valid session can keep the episode alive.

## Delivery and recovery

Episode creation commits the recipient snapshot and pending delivery progress first. Inbox appends happen outside that transaction, using `room-entry:<episode-id>:<actor-id>`. The actual inbox row is responsive and its durable interruption policy is `join`; current local/follower execution stays intact. Roster additions do not backfill an existing snapshot. Removal invalidates an invitation permanently, including remove/re-add; a recipient absent at delivery is skipped.

Immediate creation, boot and lifecycle-owned 30-second maintenance attempt pending delivery. Each synchronous pass attempts at most 64 recipients, interleaves episodes, and starts after the last attempted notice on the next pass. Persistent failures therefore cannot starve later recipients or episodes. Append or progress-stamp failure retains pending intent; later successful/idempotent append confirms exactly one notice. The retry cursor is process-local; committed pending intent survives restart. No provider run is retried by this maintenance.

Collection uses the drain guard and a transaction to recheck that the episode has departed, all recipients are terminal and no deterministic notice remains unhandled. Incomplete fanout and unhandled notices remain regardless of age. Unreadable/unsupported stored documents log a diagnostic and project departed; collection retains them for investigation. A fresh enter can replace an unreadable current episode without guessing its state.

Inbox list/selection projects current presence with a text hint. It grants no selected-entry reply or audio authority in this phase. Later reply/audio code must recheck principal, recipient, episode and selected-run scope at every approved boundary; it must not infer authority from a displayed hint or mutate ordinary actor-wide conversation routing.
