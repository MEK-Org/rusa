import type { InboxEntry, InboxRepository } from "../repositories/inbox-repository.js";

export interface HumanReplyBinding {
  principalId: string;
  sessionId: string;
  leaseBound: boolean;
  textSessionId?: string;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("human input binding is missing or unprovable; ask for fresh input");
  }
  return value as Record<string, unknown>;
}

function string(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("human input reference is incomplete; ask for fresh input");
  }
  return value;
}

function binding(entry: InboxEntry): HumanReplyBinding {
  const value = object(entry.payload.replyBinding);
  if (typeof value.leaseBound !== "boolean") {
    throw new Error("human input lease binding is unprovable; ask for fresh input");
  }
  return {
    principalId: string(value.principalId),
    sessionId: string(value.sessionId),
    leaseBound: value.leaseBound,
  };
}

function direct(entry: InboxEntry): HumanReplyBinding {
  if (!["human.message", "human.voice"].includes(entry.payload.type)) {
    throw new Error("reply reference must prove an accepted human input");
  }
  const value = binding(entry);
  string(entry.payload.messageId);
  const principalId = string(entry.payload.fromId);
  const sessionId = string(entry.payload.sessionId);
  if (
    entry.source !== `mesh:${principalId}` ||
    value.principalId !== principalId ||
    (!value.leaseBound && value.sessionId !== sessionId)
  ) {
    throw new Error("human input has conflicting provenance; ask for fresh input");
  }
  return {
    ...value,
    ...(entry.payload.type === "human.message" ? { textSessionId: sessionId } : {}),
  };
}

/** Reads immutable delivery proof; selection and rendered/history text confer no authority. */
export function readAcceptedHumanInput(
  store: InboxRepository,
  actorId: string,
  entryId: string,
  ancestors: readonly string[] = []
): { binding: HumanReplyBinding } {
  const entry = store.read(actorId, entryId);
  if (ancestors.includes(entryId) || ancestors.length >= 100) {
    throw new Error("voice handoff source reference is cyclic or too deep; ask for fresh input");
  }
  if (!entry) {
    throw new Error("reply input_ref must name your own accepted human input entry");
  }
  if (entry.payload.type !== "voice.transfer") {
    return { binding: direct(entry) };
  }
  const origin = object(entry.payload.replyInput);
  const originActor = string(origin.actorId);
  const originId = string(origin.entryId);
  const sourceActor = string(entry.payload.fromId);
  const value = binding(entry);
  if (
    !value.leaseBound ||
    originActor !== sourceActor ||
    entry.source !== `voice:transfer:${sourceActor}` ||
    entry.payload.sessionId !== value.sessionId
  ) {
    throw new Error("voice handoff has conflicting input provenance; ask for fresh input");
  }
  // Prior handling does not erase source acceptance proof. Every hop is still
  // actor-scoped and checked; the caller's own reference to a handled input
  // remains valid for delayed task completion.
  const accepted = readAcceptedHumanInput(store, originActor, originId, [...ancestors, entryId]);
  if (
    accepted.binding.principalId !== value.principalId ||
    accepted.binding.sessionId !== value.sessionId ||
    accepted.binding.leaseBound !== value.leaseBound
  ) {
    throw new Error("voice handoff conflicts with its accepted source input");
  }
  return {
    binding: {
      principalId: value.principalId,
      sessionId: value.sessionId,
      leaseBound: value.leaseBound,
    },
  };
}
