import type {
  InboxFocusRepository,
  InboxFocusResolution,
} from "../db/repositories/inbox-focus-repository.js";
import type { MeshChatRepository } from "../db/repositories/mesh-chat-repository.js";
import type { ObligationRepository } from "../db/repositories/obligation-repository.js";
import {
  isTerminalObligationStatus,
  type Obligation,
  type ObligationArtifact,
} from "../obligations/obligation.js";
import { asGitHubIssue, parseReference } from "../references/reference.js";
import type { InboxEntry } from "./inbox-store.js";

const CONTEXT_CHILD_LIMIT = 10;
const CONTEXT_SIBLING_RADIUS = 2;
const CONTEXT_ARTIFACT_LIMIT = 10;
const CONTEXT_INTENT_CHARS = 480;
const CONTEXT_LABEL_CHARS = 160;
const CONTEXT_EXCERPT_CHARS = 240;

export interface InboxFocusObligation
  extends Pick<
    Obligation,
    "id" | "parentId" | "ownerId" | "title" | "status" | "externalRef" | "resolutionRef"
  > {
  intent: string | null;
  intentTruncated: boolean;
}

export interface InboxFocusArtifact
  extends Pick<ObligationArtifact, "id" | "obligationId" | "ref" | "attachedAt"> {
  label: string | null;
  labelTruncated: boolean;
  excerpt: string | null;
  excerptTruncated: boolean;
}

export interface InboxObligationContext {
  obligation: InboxFocusObligation;
  parent: InboxFocusObligation | null;
  grandparent: InboxFocusObligation | null;
  liveChildren: {
    items: InboxFocusObligation[];
    total: number;
    truncated: boolean;
  };
  liveSiblings: {
    items: InboxFocusObligation[];
    total: number;
    truncated: boolean;
  };
  artifacts: {
    items: InboxFocusArtifact[];
    total: number;
    truncated: boolean;
  };
}

export interface ResolvedInboxFocus {
  primaryObligationId: string | null;
  resolution: InboxFocusResolution;
  related: boolean | null;
  diagnostics: string[];
  context: InboxObligationContext | null;
}

function live(obligation: Obligation | null): obligation is Obligation {
  return obligation !== null && !isTerminalObligationStatus(obligation.status);
}

/** Resolve and durably record the obligation one inbox selection advances. */
export class InboxFocusResolver {
  constructor(
    private readonly focus: InboxFocusRepository,
    private readonly obligations: ObligationRepository,
    private readonly meshChat: MeshChatRepository
  ) {}

  select(input: {
    runId: string;
    actorId: string;
    entries: InboxEntry[];
    explicitObligationId?: string;
  }): ResolvedInboxFocus {
    const diagnostics: string[] = [];
    const candidatesByEntry = new Map<string, string[]>();
    const obligationBackedEntries = new Set<string>();

    for (const entry of input.entries) {
      const ids = new Set<string>();
      for (const id of this.focus.listEntryObligationIds(input.actorId, entry.id)) {
        if (live(this.obligations.get(id))) ids.add(id);
      }
      if (
        entry.payload.type === "obligation.ready_head" ||
        entry.payload.type === "obligation.prerequisite_cancelled"
      ) {
        const id = entry.payload.obligationId;
        if (typeof id === "string" && live(this.obligations.get(id))) {
          ids.add(id);
          obligationBackedEntries.add(entry.id);
        }
      }
      const githubRef = this.githubWorkRef(entry.source);
      if (githubRef) {
        const linked = this.obligations.findLiveObligationByExternalRef(githubRef);
        if (linked) ids.add(linked.id);
        obligationBackedEntries.add(entry.id);
      }
      candidatesByEntry.set(entry.id, [...ids]);
    }

    const candidates = [...new Set([...candidatesByEntry.values()].flat())];
    let primary: Obligation | null = null;
    let resolution: InboxFocusResolution;

    if (input.explicitObligationId !== undefined) {
      const explicit = this.obligations.get(input.explicitObligationId);
      if (!live(explicit)) {
        throw new Error(`live obligation not found: ${input.explicitObligationId}`);
      }
      primary = explicit;
      resolution = "explicit";
    } else if (candidates.length === 0) {
      resolution = "none";
    } else {
      const narrowest = candidates.filter((candidate) =>
        candidates.every((other) => this.isAncestorOrSelf(other, candidate))
      );
      if (narrowest.length === 1) {
        primary = this.obligations.require(narrowest[0]);
        resolution = "inferred";
      } else {
        resolution = "ambiguous";
        diagnostics.push(
          `selection resolves to unrelated obligations: ${candidates.sort().join(", ")}; supply obligation_id to choose the primary focus`
        );
      }
    }

    const associations = new Map<string, readonly string[]>();
    if (resolution === "explicit" && primary) {
      for (const entry of input.entries) {
        if (!obligationBackedEntries.has(entry.id)) associations.set(entry.id, [primary.id]);
      }
    }

    // Relatedness is per entry, not per association. A general entry may
    // deliberately bear on unrelated obligations; it is related to the chosen
    // focus when any of its durable associations is on that focus's chain.
    const unrelatedEntries =
      primary === null
        ? []
        : input.entries.flatMap((entry) => {
            const ids = new Set(candidatesByEntry.get(entry.id) ?? []);
            for (const id of associations.get(entry.id) ?? []) ids.add(id);
            if (ids.size === 0 || [...ids].some((id) => this.related(primary.id, id))) return [];
            return [{ entryId: entry.id, obligationIds: [...ids].sort() }];
          });
    const related = primary === null ? null : unrelatedEntries.length === 0;
    if (primary && unrelatedEntries.length > 0) {
      const details = unrelatedEntries
        .map(({ entryId, obligationIds }) => `${entryId} (${obligationIds.join(", ")})`)
        .join("; ");
      diagnostics.push(
        `selected entries bound only to obligations outside ${primary.id}'s ancestor/descendant chain: ${details}`
      );
    }

    this.focus.recordSelection({
      runId: input.runId,
      actorId: input.actorId,
      entryIds: input.entries.map((entry) => entry.id),
      primaryObligationId: primary?.id ?? null,
      resolution,
      diagnostics,
      associations,
    });

    return {
      primaryObligationId: primary?.id ?? null,
      resolution,
      related,
      diagnostics,
      context: primary ? this.contextFor(primary, input.actorId) : null,
    };
  }

  private related(left: string, right: string): boolean {
    return this.isAncestorOrSelf(left, right) || this.isAncestorOrSelf(right, left);
  }

  /** Exact issue/PR reference emitted by the shared GitHub inbox grammar. */
  private githubWorkRef(source: string): string | null {
    try {
      const parsed = parseReference(source);
      return asGitHubIssue(parsed) ? parsed.key : null;
    } catch {
      return null;
    }
  }

  private isAncestorOrSelf(ancestorId: string, descendantId: string): boolean {
    let current = this.obligations.get(descendantId);
    const seen = new Set<string>();
    while (current) {
      if (current.id === ancestorId) return true;
      if (seen.has(current.id)) return false;
      seen.add(current.id);
      current = current.parentId ? this.obligations.get(current.parentId) : null;
    }
    return false;
  }

  private contextFor(obligation: Obligation, actorId: string): InboxObligationContext {
    const parent = obligation.parentId ? this.obligations.get(obligation.parentId) : null;
    const grandparent = parent?.parentId ? this.obligations.get(parent.parentId) : null;
    const allChildren = this.obligations.listChildren(obligation.id).filter(live);
    const allSiblings = parent
      ? this.obligations.listChildren(parent.id).filter((candidate) => live(candidate))
      : [];
    const siblingIndex = allSiblings.findIndex((candidate) => candidate.id === obligation.id);
    const siblingStart = Math.max(0, siblingIndex - CONTEXT_SIBLING_RADIUS);
    const siblingEnd =
      siblingIndex < 0
        ? 0
        : Math.min(allSiblings.length, siblingIndex + CONTEXT_SIBLING_RADIUS + 1);
    const artifacts = this.contextArtifacts(obligation);

    return {
      obligation: this.projectObligation(obligation),
      parent: parent ? this.projectObligation(parent) : null,
      grandparent: grandparent ? this.projectObligation(grandparent) : null,
      liveChildren: {
        items: allChildren
          .slice(0, CONTEXT_CHILD_LIMIT)
          .map((child) => this.projectObligation(child)),
        total: allChildren.length,
        truncated: allChildren.length > CONTEXT_CHILD_LIMIT,
      },
      liveSiblings: {
        items: allSiblings
          .slice(siblingStart, siblingEnd)
          .map((sibling) => this.projectObligation(sibling)),
        total: allSiblings.length,
        truncated: siblingStart > 0 || siblingEnd < allSiblings.length,
      },
      artifacts: {
        items: artifacts.items.map((artifact) => this.hydrateArtifact(artifact, actorId)),
        total: artifacts.total,
        truncated: artifacts.truncated,
      },
    };
  }

  /** Keep the newest bounded window while never dropping cited resolution evidence. */
  private contextArtifacts(obligation: Obligation): {
    items: ObligationArtifact[];
    total: number;
    truncated: boolean;
  } {
    const all = this.obligations.listArtifacts(obligation.id);
    let items = all.slice(-CONTEXT_ARTIFACT_LIMIT);
    const resolution = obligation.resolutionRef
      ? all.find((artifact) => artifact.ref === obligation.resolutionRef)
      : undefined;
    if (resolution && !items.some((artifact) => artifact.id === resolution.id)) {
      items = [resolution, ...items.slice(-(CONTEXT_ARTIFACT_LIMIT - 1))].sort(
        (left, right) =>
          left.attachedAt.localeCompare(right.attachedAt) || left.id.localeCompare(right.id)
      );
    }
    return { items, total: all.length, truncated: all.length > items.length };
  }

  private projectObligation(obligation: Obligation): InboxFocusObligation {
    const intent = obligation.intent;
    return {
      id: obligation.id,
      parentId: obligation.parentId,
      ownerId: obligation.ownerId,
      title: obligation.title,
      status: obligation.status,
      externalRef: obligation.externalRef,
      resolutionRef: obligation.resolutionRef,
      intent: intent?.slice(0, CONTEXT_INTENT_CHARS) ?? null,
      intentTruncated: (intent?.length ?? 0) > CONTEXT_INTENT_CHARS,
    };
  }

  private hydrateArtifact(artifact: ObligationArtifact, actorId: string): InboxFocusArtifact {
    const label = artifact.label;
    const projected = {
      id: artifact.id,
      obligationId: artifact.obligationId,
      ref: artifact.ref,
      attachedAt: artifact.attachedAt,
      label: label?.slice(0, CONTEXT_LABEL_CHARS) ?? null,
      labelTruncated: (label?.length ?? 0) > CONTEXT_LABEL_CHARS,
    };
    const match = /^mesh:messages\/([^/]+)$/.exec(artifact.ref);
    if (!match) return { ...projected, excerpt: null, excerptTruncated: false };
    const message = this.meshChat.getById(match[1]);
    if (!message || (message.senderId !== actorId && message.recipientId !== actorId)) {
      return { ...projected, excerpt: null, excerptTruncated: false };
    }
    const body = message.body.replace(/\s+/g, " ").trim();
    return {
      ...projected,
      excerpt: body.slice(0, CONTEXT_EXCERPT_CHARS),
      excerptTruncated: body.length > CONTEXT_EXCERPT_CHARS,
    };
  }
}
