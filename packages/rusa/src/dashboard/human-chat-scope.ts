import type { IncomingMessage } from "node:http";
import type { MeshEvent } from "../db/repositories/mesh-event-repository.js";
import { HUMAN_OPERATOR } from "../mcp/stamp.js";
import {
  type OperatorPrincipalSource,
  resolveLegacyOperatorAlias,
  resolveSoleActiveUser,
} from "../principals/operator-principal.js";
import type { UserPrincipal } from "../principals/principal-ref.js";
import { getDashboardRequestPrincipal } from "./auth.js";

/** The slice of principal storage a chat scope consults: the durable user list. */
export type HumanChatPrincipalSource = OperatorPrincipalSource;

/**
 * The durable user a read surface should treat as "me": the authenticated
 * identity, else local mode's sole active user, else null. Read paths never
 * fail on this — they just cannot personalize.
 */
export function viewingUserPrincipalId(
  req: IncomingMessage,
  principals: HumanChatPrincipalSource | undefined
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
   * The ids this viewer reads as "me": their durable principal and, when the
   * legacy `human:operator` alias still resolves to them (sole active user, or
   * no durable user at all), that alias for unmigrated history. Empty when the
   * viewer cannot be identified (auth-disabled local mode with several users),
   * in which case every human is "another human" and nothing human-involving
   * is readable.
   */
  readonly viewerIds: ReadonlySet<string>;
  /**
   * Whether the viewer may read a message among these participants: yes
   * unless one of them is a human principal other than the viewer. A human
   * here is the legacy alias or any durable user, enabled or not; a disabled
   * colleague's history stays theirs.
   */
  canSee(...participants: string[]): boolean;
}

/**
 * The scope for one viewer against one reading of the durable user list. Pure
 * given its inputs, so a fan-out can read `users` once and evaluate many
 * viewers against it (see {@link eventAudience}).
 */
export function humanChatScope(req: IncomingMessage, users: UserPrincipal[]): HumanChatScope {
  const principals: HumanChatPrincipalSource = { listUsers: () => users };
  const me = viewingUserPrincipalId(req, principals);
  // `human:operator` names the viewer only while the alias still resolves to
  // them (or to itself, when nothing durable exists yet). With several durable
  // users the alias is ambiguous and belongs to nobody until migrated.
  const alias = resolveLegacyOperatorAlias(HUMAN_OPERATOR, principals);
  const viewerIds = new Set<string>();
  if (me) viewerIds.add(me);
  if (alias.ok && (alias.ownerId === HUMAN_OPERATOR || alias.ownerId === me)) {
    viewerIds.add(HUMAN_OPERATOR);
  }
  const humans = new Set<string>([HUMAN_OPERATOR, ...users.map((u) => u.id)]);
  return {
    viewerIds,
    canSee: (...participants) => participants.every((id) => viewerIds.has(id) || !humans.has(id)),
  };
}

/** Resolve the scope for one request with one read of principal storage. */
export function resolveHumanChatScope(
  req: IncomingMessage,
  principals: HumanChatPrincipalSource | undefined
): HumanChatScope {
  return humanChatScope(req, principals?.listUsers() ?? []);
}

/**
 * A viewer held open across many events (an SSE connection): the request is
 * fixed, the user list is supplied per event so a colleague admitted after the
 * connection opened is honoured from the next frame on.
 */
export type HumanChatViewer = (users: UserPrincipal[]) => HumanChatScope;

export function humanChatViewer(req: IncomingMessage): HumanChatViewer {
  return (users) => humanChatScope(req, users);
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
 * user list is read at most once per event, however many viewers are
 * attached, so a fan-out costs no per-viewer principal lookup while a newly
 * admitted colleague is still honoured on the very next frame.
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
    return viewer(users).canSee(...participants);
  };
}
