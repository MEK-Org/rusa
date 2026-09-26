import { githubInboxEventReference } from "../github/inbox-notification.js";
import type { InboxEntry, InboxPayload } from "../repositories/inbox-repository.js";
import { parseReference } from "./reference.js";

/**
 * The `gchat:spaces/S/messages/M` reference a Google Chat inbox entry is
 * about, or undefined when its payload names no message in its source space.
 *
 * A chat event's `source` is the containing space (routing granularity), so
 * resolving that would show the wrong entity; the message itself is the
 * payload's `messageName`, which is Google's resource name and so already
 * the reference path.
 */
export function gchatInboxMessageReference(
  source: string,
  payload: InboxPayload
): string | undefined {
  if (payload.type !== "gchat.message" || typeof payload.messageName !== "string") {
    return undefined;
  }
  try {
    const reference = parseReference(`gchat:${payload.messageName}`);
    const sourceReference = parseReference(source);
    const [messageCollection, messageSpace, messageKind] = reference.segments;
    const [sourceCollection, sourceSpace] = sourceReference.segments;
    // This is the exact Google message resource form, not the cache's broader
    // internal entity classifier. The source must be the message's containing
    // space: an inbox payload cannot use this rendering path to name a message
    // in a different space.
    return reference.scheme === "gchat" &&
      reference.segments.length === 4 &&
      messageCollection === "spaces" &&
      messageKind === "messages" &&
      sourceReference.scheme === "gchat" &&
      sourceReference.segments.length === 2 &&
      sourceCollection === "spaces" &&
      messageSpace === sourceSpace
      ? reference.key
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The reference holding the text an inbox entry is about, or undefined when the
 * entry names none. Inbox rows store pointers rather than bodies, so this is
 * the JEV client's mapping from a row to something {@link resolveReference}
 * can read. (The dashboard's inbox page keeps its own mapping, which also
 * resolves the event and falls back to the issue/PR where this names nothing;
 * only the Chat case is shared.) It names a mesh message id, the exact GitHub comment or review (or, for other GitHub
 * events, the issue/PR itself), the Chat message in its source space, or a Slack message.
 */
export function inboxEntryReference(
  entry: Pick<InboxEntry, "source" | "payload">
): string | undefined {
  const { source, payload } = entry;
  if (typeof payload.messageId === "string") return `mesh:messages/${payload.messageId}`;
  if (source.startsWith("github:")) {
    // A comment or review event is about its own text. Without a usable id the
    // issue/PR body would be different text, so such an event names nothing.
    return (
      githubInboxEventReference(source, payload) ??
      (/^(issue_comment|pull_request_review_comment|pull_request_review)\./.test(payload.type)
        ? undefined
        : source)
    );
  }
  if (payload.type === "gchat.message") return gchatInboxMessageReference(source, payload);
  if (payload.type === "slack.message" && typeof payload.messageRef === "string") {
    return payload.messageRef;
  }
  return undefined;
}
