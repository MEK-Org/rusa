import type { IncomingMessage } from "node:http";
import type { MeshEvent } from "../db/repositories/mesh-event-repository.js";
import type { PrincipalRepository } from "../db/repositories/principal-repository.js";
import { HUMAN_OPERATOR } from "../mcp/stamp.js";
import {
  resolveLegacyOperatorAlias,
  resolveSoleActiveUser,
} from "../principals/operator-principal.js";
import { getDashboardRequestPrincipal } from "./auth.js";

/** The slice of principal storage a chat scope consults. */
export type HumanChatPrincipalSource = Pick<PrincipalRepository, "getUser" | "listUsers">;

/** The two ends of one mesh_chat row, however a surface came by them. */
export interface ChatParticipants {
  senderId: string;
  recipientId: string;
}

/**
 * Which human↔actor conversations one dashboard request may read (#590).
 *
 * Dashboard mesh chat is a pairwise conversation between an actor and one
 * human principal, so a viewer reads exactly their own side: messages whose
 * human participant is *them*. Every other human principal's conversation with
 * the same actor is private to that person. Actor↔actor traffic involves no
 * human and is shared mesh visibility as before.
 *
 * Membership is evaluated at call time against principal storage rather than
 * snapshotted: a long-lived SSE connection must not keep leaking a colleague
 * admitted after it opened.
 */
export interface HumanChatScope {
  /**
   * The ids this viewer reads as "me": their durable principal and, when the
   * legacy `human:operator` alias still resolves to them (sole active user, or
   * no durable user at all), that alias for unmigrated history. Empty when the
   * viewer cannot be identified (auth-disabled local mode with several users).
   */
  viewerIds(): ReadonlySet<string>;
  /** A human principal id that is not the viewer. */
  isOtherHuman(id: string): boolean;
  /**
   * Every known human principal id that is not the viewer — the legacy alias
   * and each durable user, enabled or not — for a query that has to exclude
   * them up front rather than test rows one at a time.
   */
  otherHumanIds(): string[];
  /** Whether the viewer may read a message with these two ends. */
  canSee(participants: ChatParticipants): boolean;
}

/**
 * Resolve the scope for one request: the authenticated identity, else local
 * mode's sole active user, else nobody. Read paths never fail on this — a
 * request that cannot be paired with a human simply reads no human-involving
 * messages.
 */
export function resolveHumanChatScope(
  req: IncomingMessage,
  principals: HumanChatPrincipalSource | undefined
): HumanChatScope {
  const viewer = (): string | null => {
    const reqPrincipal = getDashboardRequestPrincipal(req);
    if (reqPrincipal) return reqPrincipal.id;
    const sole = resolveSoleActiveUser(principals);
    return sole.ok ? sole.user.id : null;
  };
  // `human:operator` names the viewer only while the alias still resolves to
  // them (or to itself, when nothing durable exists yet). With several durable
  // users the alias is ambiguous and belongs to nobody until migrated.
  const aliasIsViewer = (me: string | null): boolean => {
    const alias = resolveLegacyOperatorAlias(HUMAN_OPERATOR, principals);
    if (!alias.ok) return false;
    return alias.ownerId === HUMAN_OPERATOR ? true : alias.ownerId === me;
  };
  const viewerIds = (): ReadonlySet<string> => {
    const me = viewer();
    const ids = new Set<string>();
    if (me) ids.add(me);
    if (aliasIsViewer(me)) ids.add(HUMAN_OPERATOR);
    return ids;
  };
  const isHuman = (id: string): boolean =>
    id === HUMAN_OPERATOR || principals?.getUser(id) !== undefined;
  const isOtherHuman = (id: string): boolean => isHuman(id) && !viewerIds().has(id);
  const otherHumanIds = (): string[] => {
    const mine = viewerIds();
    const all = [HUMAN_OPERATOR, ...(principals?.listUsers() ?? []).map((u) => u.id)];
    return all.filter((id) => !mine.has(id));
  };
  return {
    viewerIds,
    isOtherHuman,
    otherHumanIds,
    canSee: ({ senderId, recipientId }) => !isOtherHuman(senderId) && !isOtherHuman(recipientId),
  };
}

/**
 * The two ends of the message a `message_sent`/`message_received` event is
 * about, read the way {@link MeshEventKind} documents them: `actorId` is the
 * sender of a `message_sent` (payload `to` names the recipient) and the
 * recipient of a `message_received` (payload `from` names the sender). Null
 * for every other kind and for a message event with no readable peer.
 */
export function messageEventParticipants(
  event: Pick<MeshEvent, "kind" | "actorId" | "payload">
): ChatParticipants | null {
  if (event.kind !== "message_sent" && event.kind !== "message_received") return null;
  if (!event.actorId || !event.payload) return null;
  let parsed: { to?: unknown; from?: unknown };
  try {
    parsed = JSON.parse(event.payload) as { to?: unknown; from?: unknown };
  } catch {
    return null;
  }
  if (event.kind === "message_sent") {
    return typeof parsed.to === "string"
      ? { senderId: event.actorId, recipientId: parsed.to }
      : null;
  }
  return typeof parsed.from === "string"
    ? { senderId: parsed.from, recipientId: event.actorId }
    : null;
}

/**
 * Whether a mesh event may reach this viewer. Everything but a message event
 * is shared mesh visibility; a message event is readable when its two ends
 * are, and a message event whose ends cannot be read at all is treated as
 * shared (legacy rows without a payload carry no human pairing to protect).
 */
export function eventVisibleTo(
  scope: HumanChatScope,
  event: Pick<MeshEvent, "kind" | "actorId" | "payload">
): boolean {
  const participants = messageEventParticipants(event);
  return participants === null || scope.canSee(participants);
}
