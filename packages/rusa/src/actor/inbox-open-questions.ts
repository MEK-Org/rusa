import type { ObligationPage } from "../db/repositories/obligation-repository.js";
import type { ObligationArtifact } from "../obligations/obligation.js";
import type { PrincipalRef, UserPrincipal } from "../principals/principal-ref.js";
import { inboxEntryReference } from "../references/inbox-reference.js";
import { parseReference } from "../references/reference.js";
import type { InboxEntry } from "../repositories/inbox-repository.js";
import { VOICE_INBOX_PAYLOAD_TYPE } from "../runtime/run-manager.js";
import type { SelectedInboxEntry } from "./inbox-hints.js";

/** At most this many open questions are listed per sender; the rest are counted. */
export const OPEN_QUESTIONS_LIMIT = 10;

/** One open question this actor filed for the sender. */
export interface InboxOpenQuestion {
  id: string;
  title: string;
  /** The earliest message artifact on the obligation, when one is attached. */
  askRef?: string;
}

/**
 * The open questions the receiving actor filed for the human who sent a
 * selected message (#890), with the reference to close them against. Entries
 * from the same sender share one list; later ones point at the first that
 * returned it.
 */
export type InboxOpenQuestions = {
  principalId: string;
  resolutionRef: string;
  reminder: string;
} & (
  | { questions: InboxOpenQuestion[]; total: number; truncated: boolean }
  | { sameAsEntryId: string }
);

export interface InboxOpenQuestionSources {
  /** The one sender-to-principal seam: a user principal id, or undefined. */
  resolveSenderPrincipal: (entry: InboxEntry) => string | undefined;
  listOpenQuestions: (ownerId: string, creatorId: string, limit: number) => ObligationPage;
  listArtifacts: (obligationId: string) => ObligationArtifact[];
}

const MESH_HUMAN_PAYLOAD_TYPES = new Set(["mesh.message", VOICE_INBOX_PAYLOAD_TYPE]);

/** What the sender seam reads: principals by id, and users by Google account id. */
export interface InboxSenderPrincipals {
  get: (id: string) => PrincipalRef | undefined;
  findUserByGoogleAccountId: (googleAccountId: string) => UserPrincipal | undefined;
}

/**
 * The user principal who sent an inbox entry, or undefined when the sender is
 * not a known user. Only identities the mesh already trusts resolve, and
 * nothing is guessed from display names:
 * - a dashboard or voice message carries the authenticated principal as
 *   `fromId` on a `mesh:<fromId>` source, and that id must name a user row;
 * - a Google Chat message names its sender `users/{id}`, and that id must equal
 *   the Google account id a user's verified dashboard sign-in recorded.
 * Unknown ids, disabled users, and other sources stay unmatched.
 */
export function resolveInboxSenderPrincipal(
  entry: Pick<InboxEntry, "source" | "payload">,
  principals: InboxSenderPrincipals
): string | undefined {
  const { source, payload } = entry;
  if (payload.type === "gchat.message") {
    const sender = payload.senderName;
    if (typeof sender !== "string" || !source.startsWith("gchat:")) return undefined;
    const match = /^users\/([^/]+)$/.exec(sender);
    if (match === null) return undefined;
    const user = principals.findUserByGoogleAccountId(match[1] as string);
    return user === undefined || user.disabledAt !== undefined ? undefined : user.id;
  }
  if (!MESH_HUMAN_PAYLOAD_TYPES.has(String(payload.type))) return undefined;
  const fromId = payload.fromId;
  if (typeof fromId !== "string" || source !== `mesh:${fromId}`) return undefined;
  const principal = principals.get(fromId);
  return principal?.kind === "user" && principal.disabledAt === undefined ? fromId : undefined;
}

function isMessageReference(ref: string): boolean {
  try {
    const { segments } = parseReference(ref);
    return segments.length >= 2 && segments[segments.length - 2] === "messages";
  } catch {
    return false;
  }
}

function askRefOf(artifacts: ObligationArtifact[]): string | undefined {
  return artifacts.find((artifact) => isMessageReference(artifact.ref))?.ref;
}

function reminderFor(resolutionRef: string): string {
  return `If this message answers any of these questions, close each one it answers with set_obligation_status, passing resolution_ref "${resolutionRef}". Leave the others open.`;
}

/**
 * Attach the open questions this actor filed for each selected message's human
 * sender (#890): obligations it created that the sender owns and that are not
 * done or cancelled. An unmatched sender, or a sender with nothing open, leaves
 * the entry unchanged. A failed read is reported on the entry and never fails
 * the selection, which has already committed. Closing a question remains the
 * actor's judgment; nothing here infers an answer.
 */
export function attachOpenQuestions(
  entries: SelectedInboxEntry[],
  actorId: string,
  sources: InboxOpenQuestionSources,
  limit: number = OPEN_QUESTIONS_LIMIT
): SelectedInboxEntry[] {
  const firstEntryByPrincipal = new Map<string, string>();
  return entries.map((entry) => {
    try {
      const principalId = sources.resolveSenderPrincipal(entry);
      if (principalId === undefined) return entry;
      const resolutionRef =
        inboxEntryReference(entry) ?? `mesh:actors/${actorId}/inbox/${entry.id}`;
      const base = { principalId, resolutionRef, reminder: reminderFor(resolutionRef) };
      const first = firstEntryByPrincipal.get(principalId);
      if (first !== undefined) {
        return { ...entry, openQuestions: { ...base, sameAsEntryId: first } };
      }
      const page = sources.listOpenQuestions(principalId, actorId, limit);
      if (page.obligations.length === 0) return entry;
      const questions = page.obligations.map((obligation): InboxOpenQuestion => {
        const askRef = askRefOf(sources.listArtifacts(obligation.id));
        return {
          id: obligation.id,
          title: obligation.title ?? obligation.intent ?? "(untitled)",
          ...(askRef === undefined ? {} : { askRef }),
        };
      });
      // Only a list that was actually returned can be pointed at by later entries.
      firstEntryByPrincipal.set(principalId, entry.id);
      return {
        ...entry,
        openQuestions: { ...base, questions, total: page.total, truncated: page.hasMore },
      };
    } catch (err) {
      return { ...entry, openQuestionsError: err instanceof Error ? err.message : String(err) };
    }
  });
}
