import type { InboxStore } from "../actor/inbox-store.js";
import type { ChatClient } from "../chat/types.js";
import type { MeshChatRepository } from "../db/repositories/mesh-chat-repository.js";
import {
  asGitHubIssue,
  parseReference,
  type Reference,
  type ReferenceScheme,
  referenceUrl,
} from "./reference.js";

/**
 * A reference rendered down to what any surface needs to show it: what it is,
 * who said it, when, the text itself, and where to go look.
 *
 * One shape for every source, so the dashboard has one widget rather than a
 * branch per provider, and so an obligation's cited artifacts and an actor's
 * inbox items render identically — they are the same thing seen from two
 * directions (operator, 2026-08-30).
 */
export interface ResolvedReference {
  /** The canonical `<scheme>:<path>` string this resolves. */
  ref: string;
  scheme: ReferenceScheme;
  /** Short human label for the source: a handle, a repo and number, a space. */
  title: string;
  /** The text itself, or null when it could not be read. */
  body: string | null;
  author: string | null;
  /** ISO-8601 when known. */
  timestamp: string | null;
  /** Somewhere to go look, when the scheme projects to one. */
  url: string | null;
  /**
   * Why {@link body} is null, in words a reader can act on. Distinguishes "this
   * source has no text" from "we could not reach it" from "no such thing" —
   * collapsing those into a blank body is how a missing citation comes to look
   * like an empty one.
   */
  unavailable: string | null;
}

export interface ReferenceResolverDeps {
  meshChat?: Pick<MeshChatRepository, "getById">;
  inbox?: Pick<InboxStore, "read">;
  /** Reads a Google Chat message; absent when the chat edge is not configured. */
  chatClient?: Pick<ChatClient, "getMessage">;
  /** Reads issues and pull requests; absent when no tracker is wired. */
  issueClient?: {
    getIssue?: (owner: string, repo: string, number: number) => Promise<unknown>;
  };
}

function unresolved(reference: Reference, title: string, reason: string): ResolvedReference {
  return {
    ref: reference.key,
    scheme: reference.scheme,
    title,
    body: null,
    author: null,
    timestamp: null,
    url: referenceUrl(reference),
    unavailable: reason,
  };
}

/** `[collection, id]` pairs after the scheme's root segments. */
function pairs(reference: Reference, rootSegments: number): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (let i = rootSegments; i + 1 < reference.segments.length; i += 2) {
    out.push([reference.segments[i], reference.segments[i + 1]]);
  }
  return out;
}

function resolveMesh(reference: Reference, deps: ReferenceResolverDeps): ResolvedReference {
  const [first, second] = pairs(reference, 0);

  if (first?.[0] === "messages") {
    const message = deps.meshChat?.getById(first[1]);
    if (!message) return unresolved(reference, "Mesh chat", "message not found");
    return {
      ref: reference.key,
      scheme: reference.scheme,
      title: `${message.senderId} → ${message.recipientId}`,
      body: message.body,
      author: message.senderId,
      timestamp: message.ts,
      url: null,
      unavailable: null,
    };
  }

  if (first?.[0] === "actors" && second?.[0] === "inbox") {
    // The store is keyed by (actor, entry), which is why the actor is a path
    // segment rather than resolver context — a reference has to be readable
    // without the reader already knowing whose inbox it came from.
    if (!deps.inbox) return unresolved(reference, "Inbox entry", "inbox not available");
    const entry = deps.inbox.read(first[1], second[1]);
    if (!entry) return unresolved(reference, "Inbox entry", "entry not found");
    return {
      ref: reference.key,
      scheme: reference.scheme,
      title: entry.source,
      body: JSON.stringify(entry.payload ?? null, null, 2),
      author: first[1],
      timestamp: entry.deliveredAt?.toISOString() ?? null,
      url: null,
      unavailable: null,
    };
  }

  return unresolved(reference, reference.key, "unrecognised mesh resource");
}

async function resolveGchat(
  reference: Reference,
  deps: ReferenceResolverDeps
): Promise<ResolvedReference> {
  const [space, message] = pairs(reference, 0);
  if (space?.[0] !== "spaces" || message?.[0] !== "messages") {
    return unresolved(reference, reference.key, "unrecognised chat resource");
  }
  if (!deps.chatClient) return unresolved(reference, reference.key, "chat edge not configured");

  // Google's own resource name is exactly this path, so it round-trips with no
  // mapping — which is why the grammar carries chat paths verbatim.
  const resourceName = reference.segments.join("/");
  const found = await deps.chatClient.getMessage(resourceName);
  const text = found.text ?? found.formattedText ?? null;
  const author = found.sender?.displayName ?? found.sender?.name ?? null;
  return {
    ref: reference.key,
    scheme: reference.scheme,
    title: author ?? resourceName,
    body: text,
    author,
    timestamp: found.createTime ?? null,
    url: null,
    unavailable: text ? null : "message has no text",
  };
}

async function resolveGitHub(
  reference: Reference,
  deps: ReferenceResolverDeps
): Promise<ResolvedReference> {
  const issue = asGitHubIssue(reference);
  const url = referenceUrl(reference);

  if (!issue) {
    // A sub-resource — a comment or a review. Unlike the previous grammar, the
    // reference names its parent, so there is always something useful to say
    // and somewhere to go, even before the tracker can fetch the body.
    const [owner, repo, collection, number, subCollection, subId] = reference.segments;
    if (subCollection && subId) {
      return {
        ...unresolved(
          reference,
          `${owner}/${repo} ${collection}/${number} — ${subCollection} ${subId}`,
          "sub-resource bodies are not fetched yet"
        ),
        url,
      };
    }
    return { ...unresolved(reference, reference.key, "unrecognised GitHub resource"), url };
  }

  if (!deps.issueClient?.getIssue) {
    return { ...unresolved(reference, reference.key, "tracker not configured"), url };
  }
  const found = (await deps.issueClient.getIssue(issue.owner, issue.repo, issue.number)) as {
    title?: string;
    body?: string;
    user?: { login?: string };
    createdAt?: string;
  } | null;
  if (!found) {
    return { ...unresolved(reference, reference.key, "not found on the tracker"), url };
  }
  const label = `${issue.owner}/${issue.repo}#${issue.number}`;
  return {
    ref: reference.key,
    scheme: reference.scheme,
    title: found.title ? `${label} — ${found.title}` : label,
    body: found.body ?? null,
    author: found.user?.login ?? null,
    timestamp: found.createdAt ?? null,
    url,
    unavailable: found.body ? null : "no body on the issue",
  };
}

/**
 * Resolve one reference to displayable content.
 *
 * Never throws and never rejects: a citation that cannot be read is still worth
 * showing as a citation, and a resolver that threw would take the whole panel
 * down with it. Failures come back as {@link ResolvedReference.unavailable}.
 */
export async function resolveReference(
  ref: string,
  deps: ReferenceResolverDeps
): Promise<ResolvedReference> {
  let reference: Reference;
  try {
    reference = parseReference(ref);
  } catch (err) {
    return {
      ref,
      scheme: "mesh",
      title: ref,
      body: null,
      author: null,
      timestamp: null,
      url: null,
      unavailable: err instanceof Error ? err.message : String(err),
    };
  }

  try {
    switch (reference.scheme) {
      case "mesh":
        return resolveMesh(reference, deps);
      case "gchat":
        return await resolveGchat(reference, deps);
      case "github":
        return await resolveGitHub(reference, deps);
      default:
        return unresolved(reference, reference.key, "unsupported reference scheme");
    }
  } catch (err) {
    return unresolved(reference, reference.key, err instanceof Error ? err.message : String(err));
  }
}

/** Resolve many references concurrently, preserving input order. */
export async function resolveReferences(
  refs: readonly string[],
  deps: ReferenceResolverDeps
): Promise<ResolvedReference[]> {
  return Promise.all(refs.map((ref) => resolveReference(ref, deps)));
}
