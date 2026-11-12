/**
 * The scopes a `chat-write:<param>` grant can name, parsed in one place so the
 * grant boundary, grant authority and the Chat write tools read a grant the
 * same way (#1311).
 *
 *   chat-write:*                          every space
 *   chat-write:spaces/S   (or legacy S)   the whole space S
 *   chat-write:spaces/S/threads/T         only thread T in space S
 *
 * The thread form is Google's own `thread.name`, so an inbox payload's
 * `threadName` is the grant parameter verbatim.
 */
export type ChatWriteScope =
  | { readonly kind: "all" }
  | { readonly kind: "space"; readonly space: string }
  | { readonly kind: "thread"; readonly space: string; readonly thread: string };

// Google resource ids never contain these; `*` and `:` are grant-grammar
// characters, so an id containing one names no space or thread.
const SPACE_NAME = /^spaces\/[^/\s*:]+$/;
const THREAD_NAME = /^(spaces\/[^/\s*:]+)\/threads\/[^/\s*:]+$/;
const LEGACY_SPACE_ID = /^[^/\s:*]+$/;

/** The space `spaces/S` of a canonical `spaces/S/threads/T`, or undefined. */
export function gchatThreadSpace(threadName: string): string | undefined {
  return THREAD_NAME.exec(threadName)?.[1];
}

/**
 * Parse one `chat-write` grant parameter, or undefined when it names no scope
 * this module accepts. A legacy bare space id normalizes to `spaces/<id>`, as
 * the write server has always read it.
 */
export function parseChatWriteScope(param: string): ChatWriteScope | undefined {
  if (param === "*") return { kind: "all" };
  const threadSpace = gchatThreadSpace(param);
  if (threadSpace) return { kind: "thread", space: threadSpace, thread: param };
  if (SPACE_NAME.test(param)) return { kind: "space", space: param };
  if (LEGACY_SPACE_ID.test(param)) return { kind: "space", space: `spaces/${param}` };
  return undefined;
}

/** The parameter of a `chat-write:<param>` capability, or undefined for anything else. */
export function chatWriteParam(capability: string): string | undefined {
  return capability.startsWith("chat-write:") ? capability.slice("chat-write:".length) : undefined;
}

/**
 * Whether `capabilities` include whole-space write on `space` (`spaces/S`).
 * Deliberately exact: `chat-write:*` is not read as holding a particular space
 * for the narrower-grant rule, which the requested authority does not cover.
 */
export function holdsChatWriteSpace(capabilities: readonly string[], space: string): boolean {
  return capabilities.some((capability) => {
    const param = chatWriteParam(capability);
    if (param === undefined) return false;
    const scope = parseChatWriteScope(param);
    return scope?.kind === "space" && scope.space === space;
  });
}

/** A write server's effective scope: whole spaces (or all) plus individual threads. */
export interface ChatWriteScopes {
  readonly allSpaces: boolean;
  readonly spaces: ReadonlySet<string>;
  readonly threads: ReadonlySet<string>;
}

/** Fold `chat-write` grant parameters into one effective scope; unparseable ones grant nothing. */
export function chatWriteScopes(params: readonly string[]): ChatWriteScopes {
  let allSpaces = false;
  const spaces = new Set<string>();
  const threads = new Set<string>();
  for (const param of params) {
    const scope = parseChatWriteScope(param);
    if (scope?.kind === "all") allSpaces = true;
    else if (scope?.kind === "space") spaces.add(scope.space);
    else if (scope?.kind === "thread") threads.add(scope.thread);
  }
  return { allSpaces, spaces, threads };
}
