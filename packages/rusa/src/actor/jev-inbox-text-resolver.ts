import { inboxEntryReference } from "../references/inbox-reference.js";
import {
  type ReferenceResolverDeps,
  type ResolvedReferenceWithEntity,
  resolveReference,
} from "../references/resolve.js";
import type { InboxEntry, InboxRepository } from "../repositories/inbox-repository.js";
import type { JevResolvedInboxEntry, ResolveJevInboxEntry } from "./jev-decision-client.js";

/**
 * Per-entry text bound. Uncalibrated placeholder: it keeps one arrival's request
 * size bounded (with the client's candidate cap) until the shadow data shows
 * what a decision actually needs.
 */
export const JEV_MAX_ENTRY_TEXT_CHARS = 4_000;
/**
 * How long a resolved entry is reused. One arrival batch evaluates each
 * incoming entry against the same candidate set; this keeps that to one source
 * read per entry instead of one per arrival. In memory only.
 */
const MEMO_TTL_MS = 30_000;
const MEMO_MAX_ENTRIES = 256;

export interface JevInboxTextResolverDeps
  extends Pick<ReferenceResolverDeps, "meshChat" | "chatClient" | "slackClient" | "issueClient"> {
  inbox: Pick<InboxRepository, "read">;
  now?: () => number;
}

/**
 * Resolve an inbox row at the host edge just before the opt-in JEV request,
 * through the same reference path the dashboard uses to show inbox entries.
 * Source text is neither added to `inbox_items` nor returned to the
 * scheduler/audit layer. An entry whose text cannot be read resolves with
 * `text: null` rather than throwing, so one unreadable candidate does not void
 * the whole decision; the client decides what a missing incoming text means.
 */
export function createJevInboxTextResolver(deps: JevInboxTextResolverDeps): ResolveJevInboxEntry {
  const now = deps.now ?? Date.now;
  const memo = new Map<string, { expiresAt: number; value: Promise<JevResolvedInboxEntry> }>();
  return async (actorId, entryId, signal) => {
    signal?.throwIfAborted();
    const key = `${actorId}\u0000${entryId}`;
    const at = now();
    let hit = memo.get(key);
    if (!hit || hit.expiresAt <= at) {
      for (const [k, v] of memo) if (v.expiresAt <= at) memo.delete(k);
      while (memo.size >= MEMO_MAX_ENTRIES) {
        const oldest = memo.keys().next().value;
        if (oldest === undefined) break;
        memo.delete(oldest);
      }
      hit = { expiresAt: at + MEMO_TTL_MS, value: resolveEntry(actorId, entryId, deps) };
      memo.set(key, hit);
    }
    const resolved = await hit.value;
    signal?.throwIfAborted();
    return resolved;
  };
}

async function resolveEntry(
  actorId: string,
  entryId: string,
  deps: JevInboxTextResolverDeps
): Promise<JevResolvedInboxEntry> {
  const entry = deps.inbox.read(actorId, entryId);
  if (!entry) return { id: entryId, source: "", type: "", text: null };
  const ref = inboxEntryReference(entry);
  const text = (ref ? referenceText(await resolveReference(ref, deps)) : null) ?? inlineText(entry);
  return { id: entry.id, source: entry.source, type: entry.payload.type, ...bounded(text) };
}

function referenceText(resolved: ResolvedReferenceWithEntity): string | null {
  const entity = resolved.entity;
  if (entity?.type === "github_issue" || entity?.type === "github_pull_request") {
    return `${entity.title}\n\n${entity.description}`;
  }
  if (entity?.type === "github_review") {
    return [entity.state, entity.body].filter(Boolean).join("\n\n") || null;
  }
  return resolved.body;
}

/**
 * Mesh-generated rows carry their text inline: obligation attention its
 * `intent`, a mechanical note its `note`, test and local payloads `content`.
 */
function inlineText(entry: InboxEntry): string | null {
  for (const field of ["content", "intent", "note"] as const) {
    const value = entry.payload[field];
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

function bounded(text: string | null): { text: string | null; truncated?: true } {
  if (text === null || text.length <= JEV_MAX_ENTRY_TEXT_CHARS) return { text };
  return { text: text.slice(0, JEV_MAX_ENTRY_TEXT_CHARS), truncated: true };
}
