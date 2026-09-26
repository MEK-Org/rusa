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
export interface JevInboxTextResolverDeps
  extends Pick<ReferenceResolverDeps, "meshChat" | "chatClient" | "slackClient" | "issueClient"> {
  inbox: Pick<InboxRepository, "read">;
}

/**
 * Resolve an inbox row at the host edge just before the opt-in JEV request,
 * through the same `resolveReference` path the dashboard uses to show inbox
 * entries, but not its reference cache: that cache persists entity bodies in
 * mesh.db, and this path keeps source text in memory only. Source text is
 * neither added to `inbox_items` nor returned to the scheduler/audit layer.
 * An entry whose text cannot be read resolves with `text: null` rather than
 * throwing, so one unreadable candidate does not void the whole decision; the
 * client decides what a missing incoming text means.
 *
 * The source clients take no `AbortSignal`, so an expired deadline stops the
 * caller waiting on a read rather than cancelling it. No request is sent after
 * expiry either way.
 */
export function createJevInboxTextResolver(deps: JevInboxTextResolverDeps): ResolveJevInboxEntry {
  return async (actorId, entryId, signal) => {
    signal?.throwIfAborted();
    const resolved = await resolveEntry(actorId, entryId, deps);
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
  if (!entry) {
    return { id: entryId, source: "", type: "", text: null, sender: null, timestamp: null };
  }
  const ref = inboxEntryReference(entry);
  const resolved = ref ? await resolveReference(ref, deps) : null;
  const text = (resolved ? referenceText(resolved) : null) ?? inlineText(entry);
  return {
    id: entry.id,
    source: entry.source,
    type: entry.payload.type,
    ...bounded(text),
    sender: resolved?.author || inlineSender(entry),
    // The source's own time when it has one; otherwise when the row arrived.
    timestamp: resolved?.timestamp || entry.deliveredAt.toISOString(),
  };
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

/** Mesh-generated rows name their sending actor inline, when they have one. */
function inlineSender(entry: InboxEntry): string | null {
  const fromId = entry.payload.fromId;
  return typeof fromId === "string" && fromId ? fromId : null;
}

function bounded(text: string | null): { text: string | null; truncated?: true } {
  if (text === null || text.length <= JEV_MAX_ENTRY_TEXT_CHARS) return { text };
  return { text: text.slice(0, JEV_MAX_ENTRY_TEXT_CHARS), truncated: true };
}
