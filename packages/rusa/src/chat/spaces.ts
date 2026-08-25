import type { ChatClient, ChatSpace } from "./types.js";

/** Page size for the membership walk; the Chat API caps `spaces.list` at 1000. */
const SPACES_PAGE_SIZE = 100;

/** Bound on the page chain, so a pathological token loop cannot hang a run. */
const MAX_SPACES_PAGES = 50;

/**
 * The result of enumerating the spaces this identity belongs to.
 *
 * `complete` is the whole point of the shape. An empty `spaces` is ambiguous on
 * its own — it means "this identity is in no spaces" when the walk finished and
 * "we do not know what it is in" when the walk failed — and those call for
 * opposite reports. Callers must key on `complete`, never on `spaces.length`.
 */
export interface ChatSpaceMembership {
  spaces: ChatSpace[];
  /** True only when the page chain was walked to its end. */
  complete: boolean;
  /** Why the walk stopped short. Present exactly when `complete` is false. */
  error?: string;
}

/**
 * Walk `spaces.list` to exhaustion and return the spaces this identity is a
 * member of .
 *
 * This replaces the hand-maintained `understanding.chatSpaces` allowlist. Operator's
 * ruling: the distiller processes **every space the bot is a member of**
 * and applies judgment per message — membership is the scope, and what belongs
 * in a durable node is a per-message decision, not a per-space one. An allowlist
 * could only ever be an assertion about the world; this is a measurement of it.
 *
 * Failure is reported, never swallowed into an empty list: a caller that saw
 * `[]` from a failed walk would report "chat was not in the read set" for a run
 * that simply could not look.
 */
export async function listAllChatSpaces(client: ChatClient): Promise<ChatSpaceMembership> {
  const spaces: ChatSpace[] = [];
  const seen = new Set<string>();
  let pageToken: string | undefined;
  try {
    for (let page = 0; page < MAX_SPACES_PAGES; page++) {
      const result = await client.listSpaces({
        pageSize: SPACES_PAGE_SIZE,
        ...(pageToken ? { pageToken } : {}),
      });
      for (const space of result.spaces) {
        if (!space.name || seen.has(space.name)) continue;
        seen.add(space.name);
        spaces.push(space);
      }
      pageToken = result.nextPageToken;
      if (!pageToken) return { spaces, complete: true };
    }
    return {
      spaces,
      complete: false,
      error: `stopped after ${MAX_SPACES_PAGES} pages with more spaces remaining`,
    };
  } catch (err) {
    return { spaces: [], complete: false, error: err instanceof Error ? err.message : String(err) };
  }
}
