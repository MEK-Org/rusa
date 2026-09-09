import type Database from "better-sqlite3";

/** How long an opener will wait for a lock held by another instance. */
export const BUSY_TIMEOUT_MS = 10_000;

/**
 * Block this thread: the databases converted here are opened synchronously, so
 * there is no turn of the event loop to await on.
 */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Widen a legacy rollback-journal database to WAL, waiting out any instance
 * that is doing the same thing at the same moment.
 *
 * `busy_timeout` does not cover this call, which is why it is not enough to
 * raise it. The conversion needs an EXCLUSIVE lock, and when a peer already
 * holds RESERVED — exactly what another opener holds partway through its own
 * conversion — SQLite skips the busy handler to avoid a deadlock and returns
 * SQLITE_BUSY immediately. Measured against a peer in `BEGIN IMMEDIATE`: 1ms,
 * versus the full 10s wait when that peer holds only SHARED. So the opener has
 * to come back and ask again; no timeout value substitutes for that.
 *
 * The wait is jittered because the openers that collide here are by
 * construction running the same code at the same instant, and a fixed backoff
 * would march them into the same collision together.
 *
 * `budgetMs` is the whole cost of converting, not the cost of one attempt: each
 * attempt is handed only what is left of it. That cap is load-bearing, not
 * tidiness. SQLite's busy handler carries its own full `busy_timeout` into
 * every call, so without it a peer that holds RESERVED for most of the budget
 * — fast SQLITE_BUSY, this loop spinning — and then drops to SHARED buys a
 * second full wait inside the next single pragma, and a connection promising a
 * 10s open takes 20s. Capping is what makes the two waits one, and it does so
 * whatever `busy_timeout` the connection arrived with.
 *
 * The connection's own `busy_timeout` is restored before returning. The pragma
 * is a means here, not an intent: a caller that never asked for a 10s timeout
 * would otherwise acquire one — or, on a slow conversion, be left with
 * whatever few milliseconds happened to remain of the budget.
 *
 * Reachable only while a database is still pre-WAL: once converted, this
 * pragma is a no-op that takes no exclusive lock.
 *
 * `budgetMs` is a parameter for the boundary test, which shrinks it so it can
 * assert the bound in milliseconds instead of tens of seconds.
 */
export function widenToWal(db: Database.Database, budgetMs: number = BUSY_TIMEOUT_MS): void {
  // `PRAGMA busy_timeout` answers with the connection's current value. It is
  // typed `unknown`, and a restore that interpolated a non-number would throw
  // out of the `finally` below and bury whatever the conversion actually hit.
  const prior = db.pragma("busy_timeout", { simple: true });
  const priorBusyTimeoutMs = typeof prior === "number" ? prior : BUSY_TIMEOUT_MS;
  const deadline = Date.now() + budgetMs;
  try {
    for (;;) {
      db.pragma(`busy_timeout = ${Math.max(0, deadline - Date.now())}`);
      try {
        db.pragma("journal_mode = WAL");
        return;
      } catch (error) {
        const busy = (error as { code?: string } | null)?.code === "SQLITE_BUSY";
        if (!busy || Date.now() >= deadline) throw error;
        sleepSync(Math.ceil(1 + Math.random() * 25));
      }
    }
  } finally {
    db.pragma(`busy_timeout = ${priorBusyTimeoutMs}`);
  }
}
