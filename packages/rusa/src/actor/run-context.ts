/**
 * A host-owned view of one still-active actor run. The host supplies dynamic
 * focus and provider-attempt fields on each read; actor id, run id and start
 * time belong to the lease that created this reader.
 */
export interface ActiveRunContext {
  readonly actorId: string;
  readonly runId: string;
  readonly startedAt: string;
  readonly provider?: string;
  readonly model?: string;
  readonly effort?: string;
  readonly selectedInboxEntryIds: readonly string[];
  readonly primaryObligationId: string | null;
  readonly effectiveResponsive: boolean;
}

/** The only context surface handed to a mesh-managed MCP server. */
export interface BoundRunContextReader {
  /** Undefined means this exact lease is no longer active; it never falls forward. */
  current(): Readonly<ActiveRunContext> | undefined;
}

/** Host-only handle that invalidates the reader during every terminal cleanup path. */
export interface BoundRunContextLease {
  readonly reader: BoundRunContextReader;
  revoke(): void;
}

/**
 * Bind an otherwise dynamic host read to one actor/run pair. A later run of
 * the same actor cannot satisfy this reader after revoke or a mismatched read.
 */
export function bindRunContext(
  actorId: string,
  runId: string,
  readCurrent: () => Readonly<ActiveRunContext> | undefined
): BoundRunContextLease {
  let revoked = false;
  return {
    reader: {
      current: () => {
        if (revoked) return undefined;
        const current = readCurrent();
        if (!current || current.actorId !== actorId || current.runId !== runId) return undefined;
        return current;
      },
    },
    revoke: () => {
      revoked = true;
    },
  };
}
