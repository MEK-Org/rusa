# Obligation history compatibility

The obligation-detail history uses the existing `obligation_history` table;
there is no DDL or migration. The upgraded reader accepts existing version-1
rows and version-2 checkpoint rows. A version-2 checkpoint payload captures
before/after standing text with the row's acting principal and timestamp, in
the same transaction as the standing write. Existing rows remain intact.

Pre-change binaries have a strict version-1 payload and state decoder. They
reject version-2 rows, and changing only the version number cannot help because
they also reject the checkpoint field. Once the upgraded writer records a
checkpoint, rolling back to a pre-change binary breaks two readers:

- the per-obligation history of any obligation with a version-2 row; and
- the cross-obligation recent-activity reader (`listTerminalHistory`, behind
  `/api/mesh/recent-activity`). A done or cancelled transition clears the
  obligation's standing in the same update, so a terminal transition on any
  obligation that had standing records a version-2 row. That reader selects
  terminal rows across all obligations and fails on such a row.

The recovery position is to keep a binary whose reader understands both
versions. Audit rows are preserved: do not remove or rewrite them (including
by editing their JSON payloads) to make an older binary accept the database.
Root owns rollout and recovery decisions. This limitation is a payload-reader
boundary, not a database-schema migration.

The detail trail projects artifact attachment timestamps and creation times of
**current children** from their existing records. A current-child entry is not
proof that the child was added to this parent at that time: reparenting changes
its membership, and its displayed title and owner are current metadata. The
child's own recorded reparent trail carries historical parent changes.

History updates and recurring completions have separate pagination controls.
The visible entries are sorted together; neither stream's current page proves
that the combined timeline contains every intervening event. A standing update
absent from a page with more history available is described as not loaded. Only
an exhausted trail can establish that earlier standing text was not recorded.
