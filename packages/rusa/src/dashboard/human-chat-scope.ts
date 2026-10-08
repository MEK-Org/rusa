import type { IncomingMessage } from "node:http";
import type { MeshEvent } from "../db/repositories/mesh-event-repository.js";
import type { PrincipalRepository } from "../db/repositories/principal-repository.js";
import {
  type OperatorPrincipalSource,
  resolveSoleActiveUser,
} from "../principals/operator-principal.js";
import type { UserPrincipal } from "../principals/principal-ref.js";
import { getDashboardRequestPrincipal } from "./auth.js";

/** Durable identities used to identify the viewer and classify participants. */
export type HumanChatPrincipalSource = OperatorPrincipalSource & Pick<PrincipalRepository, "get">;

/**
 * The durable user a read surface should treat as "me": the authenticated
 * identity, else local mode's sole active user, else null. Read paths never
 * fail on this — they just cannot personalize.
 */
export function viewingUserPrincipalId(
  req: IncomingMessage,
  principals: OperatorPrincipalSource | undefined
): string | null {
  const reqPrincipal = getDashboardRequestPrincipal(req);
  if (reqPrincipal) return reqPrincipal.id;
  const sole = resolveSoleActiveUser(principals);
  return sole.ok ? sole.user.id : null;
}

/**
 * Which human↔actor conversations one dashboard viewer may read (#590).
 *
 * Dashboard mesh chat is a pairwise conversation between an actor and one
 * human principal, so a viewer reads exactly their own side: messages whose
 * human participant is *them*. Every other human principal's conversation with
 * the same actor is private to that person. Actor↔actor traffic involves no
 * human and is shared mesh visibility as before.
 */
export interface HumanChatScope {
  /**
   * The viewer's durable principal, or empty when they cannot be identified.
   */
  readonly viewerIds: ReadonlySet<string>;
  /**
   * Each participant must be the viewer or a known actor/system principal.
   * Other users (including disabled users) and unknown ids stay private.
   */
  canSee(...participants: string[]): boolean;
}

/**
 * The scope for one viewer against one reading of the durable user list. Pure
 * given its inputs, so a fan-out can read `users` once and evaluate many
 * viewers against it (see {@link eventAudience}).
 */
export function humanChatScope(
  req: IncomingMessage,
  users: UserPrincipal[],
  principals?: Pick<HumanChatPrincipalSource, "get">
): HumanChatScope {
  const me = viewingUserPrincipalId(req, { listUsers: () => users });
  const viewerIds = new Set<string>();
  if (me) viewerIds.add(me);
  return {
    viewerIds,
    canSee: (...participants) =>
      participants.every((id) => {
        if (viewerIds.has(id)) return true;
        const kind = principals?.get(id)?.kind;
        return kind === "actor" || kind === "system";
      }),
  };
}

/** Resolve the scope for one request with one read of principal storage. */
export function resolveHumanChatScope(
  req: IncomingMessage,
  principals: HumanChatPrincipalSource | undefined
): HumanChatScope {
  return humanChatScope(req, principals?.listUsers() ?? [], principals);
}

/**
 * A viewer held open across many events (an SSE connection): the request is
 * fixed, the user list is supplied per event so a colleague admitted after the
 * connection opened is honoured from the next frame on.
 */
export type HumanChatViewer = (
  users: UserPrincipal[],
  principals?: Pick<HumanChatPrincipalSource, "get">
) => HumanChatScope;

export function humanChatViewer(req: IncomingMessage): HumanChatViewer {
  return (users, principals) => humanChatScope(req, users, principals);
}

/**
 * The two ends of the message a `message_sent`/`message_received` event is
 * about, read the way {@link MeshEventKind} documents them: `actorId` is the
 * sender of a `message_sent` (payload `to` names the recipient) and the
 * recipient of a `message_received` (payload `from` names the sender).
 * Undefined for every other kind; null for a message event whose ends cannot
 * be read (no subject, no payload, unparseable payload, or a peer that is not
 * a string).
 */
export function messageEventParticipants(
  event: Pick<MeshEvent, "kind" | "actorId" | "payload">
): [string, string] | null | undefined {
  if (event.kind !== "message_sent" && event.kind !== "message_received") return undefined;
  if (!event.actorId || !event.payload) return null;
  let parsed: { to?: unknown; from?: unknown };
  try {
    parsed = JSON.parse(event.payload) as { to?: unknown; from?: unknown };
  } catch {
    return null;
  }
  const peer = event.kind === "message_sent" ? parsed.to : parsed.from;
  return typeof peer === "string" ? [event.actorId, peer] : null;
}

/**
 * Who may receive one live mesh event, decided once for a whole fan-out.
 * Everything but a message event is shared mesh visibility. A message event
 * reaches a viewer when they may read its two ends; one whose ends cannot be
 * read is withheld from every scoped viewer rather than guessed shared. The
 * user list is read at most once per event, however many viewers are attached.
 */
export function eventAudience(
  event: Pick<MeshEvent, "kind" | "actorId" | "payload">,
  principals: HumanChatPrincipalSource | undefined
): (viewer: HumanChatViewer) => boolean {
  const participants = messageEventParticipants(event);
  if (participants === undefined) return () => true;
  if (participants === null) return () => false;
  let users: UserPrincipal[] | undefined;
  return (viewer) => {
    users ??= principals?.listUsers() ?? [];
    return viewer(users, principals).canSee(...participants);
  };
}
