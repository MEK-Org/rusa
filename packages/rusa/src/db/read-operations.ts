import type { Obligation } from "../obligations/obligation.js";
import type { InboxListOptions, InboxRepository } from "../repositories/inbox-repository.js";
import type { ObligationRepository } from "./repositories/obligation-repository.js";
import type { WorkerRequestTiming } from "./worker-pool.js";

/**
 * The repositories a standalone read may use. Every member is a plain SQL read
 * with no in-memory state, so the same call answers identically on the main
 * connection and on a read worker's own connection (#1289).
 */
export interface ReadRepositories {
  readonly obligations: Pick<
    ObligationRepository,
    | "get"
    | "getAncestry"
    | "listPage"
    | "getForest"
    | "getTree"
    | "listChildrenPage"
    | "listCompletionsPage"
    | "listBlockedByPage"
    | "listUnblocksPage"
    | "listHistoryPage"
    | "listArtifacts"
  >;
  readonly inbox: Pick<InboxRepository, "list">;
}

type ObligationPageInput = Parameters<ObligationRepository["listPage"]>[0] & {
  readonly ancestors: boolean;
};

interface ObligationDetailInput {
  readonly id: string;
  readonly limit: number;
  readonly offset: number;
  readonly completionsOffset: number;
  readonly blockedByOffset: number;
  readonly blocksOffset: number;
  readonly historyBefore?: string;
  readonly historyLimit: number;
}

/**
 * Every whole read a caller may hand to a read worker, by name. One operation
 * is one request: a route's several statements travel and run together, inside
 * one read transaction, so the answer is one consistent snapshot as it was when
 * the route ran them back to back on the main thread.
 *
 * Inputs and results cross a thread boundary by structured clone, so both stay
 * plain data.
 */
export const READ_OPERATIONS = {
  obligationPage(repos: ReadRepositories, input: ObligationPageInput) {
    const { ancestors, ...options } = input;
    const page = repos.obligations.listPage(options);
    return ancestors
      ? { ...page, ancestors: pageAncestors(repos.obligations, page.obligations) }
      : page;
  },

  obligationForest(
    repos: ReadRepositories,
    input: {
      readonly limit: number;
      readonly offset: number;
      readonly includeTerminalRoots: boolean;
    }
  ) {
    const page = repos.obligations.listPage({
      rootsOnly: true,
      excludeQuietTerminalRoots: !input.includeTerminalRoots,
      limit: input.limit,
      offset: input.offset,
    });
    const trees = repos.obligations.getForest(
      page.obligations.map((obligation) => obligation.id),
      { excludeQuietTerminalDescendants: !input.includeTerminalRoots }
    );
    return { trees, total: page.total, hasMore: page.hasMore };
  },

  /** Null when the root does not exist; a cycle throws, as `getTree` does. */
  obligationTree(repos: ReadRepositories, input: { readonly id: string }) {
    if (!repos.obligations.get(input.id)) return null;
    return repos.obligations.getTree(input.id);
  },

  /** Null when the obligation does not exist. */
  obligationDetail(repos: ReadRepositories, input: ObligationDetailInput) {
    const { obligations } = repos;
    const obligation = obligations.get(input.id);
    if (!obligation) return null;
    const children = obligations.listChildrenPage(input.id, {
      limit: input.limit,
      offset: input.offset,
    });
    const blockingChildren = obligations.listChildrenPage(input.id, {
      limit: input.limit,
      offset: 0,
      blockingOnly: true,
    });
    const completions = obligations.listCompletionsPage(input.id, {
      limit: input.limit,
      offset: input.completionsOffset,
    });
    const blockedBy = obligations.listBlockedByPage(input.id, {
      limit: input.limit,
      offset: input.blockedByOffset,
    });
    const blocks = obligations.listUnblocksPage(input.id, {
      limit: input.limit,
      offset: input.blocksOffset,
    });
    // The whole chain in one read rather than one read per level (#1323).
    const ancestry = obligations.getAncestry([input.id]);
    const parent = obligation.parentId ? (ancestry.get(obligation.parentId) ?? null) : null;
    const ancestors: Obligation[] = [];
    const seen = new Set([input.id]);
    let ancestor = parent;
    while (ancestor && !seen.has(ancestor.id)) {
      seen.add(ancestor.id);
      ancestors.unshift(ancestor);
      ancestor = ancestor.parentId ? (ancestry.get(ancestor.parentId) ?? null) : null;
    }
    const history = obligations.listHistoryPage(input.id, {
      before: input.historyBefore,
      limit: input.historyLimit,
    });
    const artifacts = obligations.listArtifacts(input.id);
    return {
      obligation,
      parent,
      ancestors,
      history,
      children,
      blockingChildren,
      completions,
      blockedBy,
      blocks,
      artifacts,
    };
  },

  inboxPage(
    repos: ReadRepositories,
    input: { readonly actorId: string; readonly options: InboxListOptions }
  ) {
    return repos.inbox.list(input.actorId, input.options);
  },
} as const;

export type ReadOperations = typeof READ_OPERATIONS;
export type ReadOperationName = keyof ReadOperations;
export type ReadInput<K extends ReadOperationName> = Parameters<ReadOperations[K]>[1];
export type ReadOutput<K extends ReadOperationName> = ReturnType<ReadOperations[K]>;

/**
 * Where one standalone read's time went (#1323), in milliseconds. A read pool
 * reports all three; an in-process read has no queue or crossing, so it reports
 * only `executionMs`. See {@link WorkerRequestTiming} for each field.
 */
export interface ReadTiming {
  readonly queuedMs?: number;
  readonly executionMs?: number;
  readonly transferMs?: number;
}

/** Asynchronous access to the named standalone reads. */
export interface DbReads {
  /**
   * `onTiming`, when given, hears where an answered read's time went just
   * before the promise settles. A read refused before it ran reports nothing.
   */
  read<K extends ReadOperationName>(
    op: K,
    input: ReadInput<K>,
    onTiming?: (timing: ReadTiming) => void
  ): Promise<ReadOutput<K>>;
}

/**
 * Run each read on the caller's thread against the given repositories. The
 * fallback when no read pool is wired (tests, UI-only servers): same operations,
 * same answers, still blocking.
 */
export function inProcessReads(repos: ReadRepositories): DbReads {
  return {
    read: async (op, input, onTiming) => {
      const started = performance.now();
      try {
        return (
          READ_OPERATIONS[op] as (r: ReadRepositories, i: typeof input) => ReadOutput<typeof op>
        )(repos, input);
      } finally {
        onTiming?.({ executionMs: performance.now() - started });
      }
    },
  };
}

/**
 * The ancestors of a page's rows, each once and none that is itself a row.
 * The page's whole distinct ancestry is one read (#1323), however many rows
 * share it, and a cycle ends the walk.
 */
function pageAncestors(
  obligations: Pick<ObligationRepository, "getAncestry">,
  rows: readonly Obligation[]
): Obligation[] {
  const ancestry = obligations.getAncestry(rows.map((row) => row.id));
  const seen = new Set(rows.map((row) => row.id));
  const ancestors: Obligation[] = [];
  for (const row of rows) {
    let parentId = row.parentId;
    while (parentId && !seen.has(parentId)) {
      seen.add(parentId);
      const parent = ancestry.get(parentId);
      if (!parent) break;
      ancestors.push(parent);
      parentId = parent.parentId;
    }
  }
  return ancestors;
}
