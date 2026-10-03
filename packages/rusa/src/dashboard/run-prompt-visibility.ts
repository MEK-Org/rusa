import type { HumanChatScope } from "./human-chat-scope.js";

/** Launch-time source requirements, never flattened into a cached list of viewers. */
export interface RunPromptProvenance {
  version: 1;
  complete: true;
  sources: Array<
    | { id: string; classification: "shared" }
    | {
        id: string;
        classification: "human_chat";
        participants: Array<{ id: string; kind: "user" | "actor" | "system" }>;
      }
  >;
}

/** Unknown or unsupported source requirements fail closed for the whole prompt. */
export function parseRunPromptProvenance(value: unknown): RunPromptProvenance | null {
  if (!value || typeof value !== "object") return null;
  const doc = value as Record<string, unknown>;
  if (
    doc.version !== 1 ||
    doc.complete !== true ||
    !Array.isArray(doc.sources) ||
    doc.sources.length === 0
  )
    return null;
  for (const source of doc.sources) {
    if (!source || typeof source !== "object" || typeof source.id !== "string" || !source.id)
      return null;
    if (source.classification === "shared") continue;
    if (
      source.classification !== "human_chat" ||
      !Array.isArray(source.participants) ||
      source.participants.length === 0
    )
      return null;
    if (!source.participants.some((p: { kind?: unknown }) => p?.kind === "user")) return null;
    for (const participant of source.participants) {
      if (
        !participant ||
        typeof participant.id !== "string" ||
        !participant.id ||
        !["user", "actor", "system"].includes(participant.kind)
      )
        return null;
    }
  }
  return value as RunPromptProvenance;
}

/** Preserve private classification while consulting the requesting viewer's current scope. */
export function canReadRunPrompt(
  provenance: RunPromptProvenance | null,
  scope: HumanChatScope
): boolean {
  if (!provenance) return false;
  return provenance.sources.every((source) => {
    if (source.classification === "shared") return true;
    // A deleted/reclassified user cannot fall out of the current human list and become shared.
    // viewerIds is the existing current scope's membership, not a launch-time viewer cache.
    if (source.participants.some((p) => p.kind === "user" && !scope.viewerIds.has(p.id)))
      return false;
    return scope.canSee(...source.participants.map((p) => p.id));
  });
}
