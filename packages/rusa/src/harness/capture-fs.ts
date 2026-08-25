import { type Dirent, lstatSync, readdirSync, readFileSync, statSync } from "node:fs";

/**
 * Re-exported so a capture module can name a directory entry without importing the
 * filesystem module itself — which is what lets the source guard reject an fs import
 * outright instead of having to tell a type import from a value one.
 */
export type { Dirent };

/**
 * The single filesystem-read policy for everything that captures an A/B artifact.
 *
 * PR ISSUE_NUM spent four review rounds fixing one bug five times: a failed read answering
 * "absent". `readdir` returning silently, a live scan paired with a durable tree, a symlink
 * matching neither `isDirectory()` nor `isFile()`, `existsSync` reporting an EACCES target
 * as missing, `stat` failing with EACCES where the catch assumed ENOENT. Every one produced
 * an empty result that a caller consumed as a MEASUREMENT — and an empty measured set is
 * what the `c-no-new-deps` score, the withdrawal timeline and the added/removed claims all
 * read as a clean pass. Two of the five were introduced by the previous round's fix.
 *
 * So the policy is stated once, here, and enforced by construction rather than by
 * remembering it at each call site:
 *
 * > **Only `ENOENT` means absent. Every other outcome means the capture is INCOMPLETE.**
 *
 * EACCES, ELOOP, ENOTDIR, a symlink surprise, a race with a concurrent teardown, an errno
 * nobody enumerated — none of them are evidence that a thing is not there, so none of them
 * may be reported as such. The cost of the strict reading is an omitted score; the cost of
 * the loose one is a fabricated finding, which is what this arc exists to prevent.
 *
 * Mechanics that make it stick:
 *  - every read returns a {@link Probe} and NEVER throws, so a `try`/`catch` with a default
 *    is not something a call site can write;
 *  - a probe's three outcomes are NOT observable — {@link Probe.match} is the only way to
 *    look inside one, and its handler object requires all three, so forgetting `unknown` is
 *    a type error rather than a latent green-by-absence;
 *  - this module is the only door to the filesystem on the capture path (see the import
 *    guard in `workdir-capture.test.ts`), so a new read cannot bypass the policy by
 *    accident.
 */
type ProbeState<T> =
  /** The read succeeded. */
  | { outcome: "ok"; value: T }
  /** `ENOENT` — proven not there. The ONLY outcome that is a measurement. */
  | { outcome: "absent" }
  /** Anything else. Says nothing about what is there; the capture must admit the hole. */
  | { outcome: "unknown"; code: string };

/** What {@link Probe.match} requires. All three, always — that is the whole mechanism. */
export interface ProbeHandlers<T, R> {
  ok: (value: T) => R;
  absent: () => R;
  unknown: (code: string) => R;
}

/**
 * The outcome of one filesystem read, which cannot be inspected except exhaustively.
 *
 * The first cut of this exported the three-way union directly, and a reviewer collapsed it
 * back to two states in four lines with no cast and no type error:
 *
 * ```ts
 * probe.outcome === "ok" ? probe.value : null   // absent and unknown, silently merged
 * ```
 *
 * A union whose tags are public is a convention, not an enforcement — every caller MAY
 * discriminate it exhaustively and nothing makes them. So the state is a `#private` field:
 * `.outcome` does not exist on this type, there is no cast that reaches it, and
 * {@link match} — which demands a handler for all three outcomes — is the only way to learn
 * anything about the read. Collapsing outcomes is still allowed, but only by NAMING the
 * outcome you are collapsing, which is the difference between a decision and an oversight.
 */
export class Probe<T> {
  readonly #state: ProbeState<T>;

  private constructor(state: ProbeState<T>) {
    this.#state = state;
  }

  /**
   * Run a read under the policy. Never throws: every failure becomes `absent` (ENOENT only)
   * or `unknown` (everything else). The private constructor makes this the sole way to get
   * a probe, so there is no path to one whose state skipped the ENOENT test.
   */
  static run<T>(read: () => T): Probe<T> {
    try {
      return new Probe<T>({ outcome: "ok", value: read() });
    } catch (err) {
      // An error with no `code` at all is the least-known outcome there is, so it takes the
      // conservative branch like every other non-ENOENT failure.
      const code = (err as NodeJS.ErrnoException | undefined)?.code ?? "UNKNOWN";
      return new Probe<T>(code === "ENOENT" ? { outcome: "absent" } : { outcome: "unknown", code });
    }
  }

  /**
   * Consume the probe. All three handlers are required: the type checker, not the reviewer,
   * is what stops `unknown` from silently taking the `absent` path.
   */
  match<R>(handlers: ProbeHandlers<T, R>): R {
    switch (this.#state.outcome) {
      case "ok":
        return handlers.ok(this.#state.value);
      case "absent":
        return handlers.absent();
      case "unknown":
        return handlers.unknown(this.#state.code);
    }
  }
}

/** List a directory's entries with their types. `absent` only when the directory is gone. */
export function listEntries(path: string): Probe<Dirent[]> {
  return Probe.run(() => readdirSync(path, { withFileTypes: true }));
}

/**
 * Whether the path resolves to a directory — FOLLOWS symlinks, so `absent` here means the
 * link is dangling, not that the link is missing. Callers deciding whether something hides
 * a subtree must treat `unknown` as "it might", because an unreadable target is usually
 * exactly the subtree they cannot see.
 */
export function targetIsDirectory(path: string): Probe<boolean> {
  return Probe.run(() => statSync(path).isDirectory());
}

/**
 * Whether a directory ENTRY exists, WITHOUT following it — `lstat`, never `existsSync`.
 * `existsSync` resolves the link and returns false when resolution fails with EACCES, which
 * is indistinguishable from "no such entry"; that is finding four of PR ISSUE_NUM.
 */
export function entryPresent(path: string): Probe<true> {
  return Probe.run(() => {
    lstatSync(path);
    return true as const;
  });
}

/** A file's size in bytes (follows symlinks). */
export function fileSize(path: string): Probe<number> {
  return Probe.run(() => statSync(path).size);
}

/** A file's contents as UTF-8. */
export function readText(path: string): Probe<string> {
  return Probe.run(() => readFileSync(path, "utf8"));
}
