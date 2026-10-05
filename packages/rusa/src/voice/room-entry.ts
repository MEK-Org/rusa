import { randomUUID } from "node:crypto";
import {
  INBOX_INTERRUPTION_JOIN,
  ROOM_HUMAN_ENTRY_PAYLOAD_TYPE,
  ROOM_HUMAN_ENTRY_VERSION,
} from "../repositories/inbox-interruption.js";
import type { InboxAppendInput, InboxRepository } from "../repositories/inbox-repository.js";

/** Inbox source key for Room entry notices. */
export const ROOM_ENTRY_SOURCE = "room:entry";

/** In-memory cooldown before another join notification is sent for the same human principal. */
export const ROOM_ENTRY_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes

/** The deterministic notice id for one recipient of one entry notification. */
export function roomEntryNoticeId(episodeId: string, actorId: string): string {
  return `room-entry:${episodeId}:${actorId}`;
}

/** The identity an enter request carries after authentication. */
export interface RoomEntryClient {
  principalId: string;
  clientId?: string;
  sessionKey?: string;
}

export type RoomEntryEnterResult =
  | { status: "entered"; notified: true; episodeId: string }
  | { status: "entered"; notified: false; reason: "cooldown"; remainingMs: number };

export interface RoomEntryServiceDeps {
  inbox: Pick<InboxRepository, "append">;
  /** Active Room participants right now: the server roster, never a client list. */
  roster: () => readonly string[];
  cooldownMs?: number;
  now?: () => number;
  log?: (message: string) => void;
}

/**
 * In-memory Chat Room entry notifier (#829).
 *
 * When an authorized human enters the Room, sends one noninterrupting
 * inbox notice to active chat room actors, with a 5-minute in-memory
 * cooldown per principal. No database persistence or migrations required.
 */
export class RoomEntryService {
  private readonly lastNotifiedAt = new Map<string, number>();
  private readonly cooldownMs: number;
  private readonly now: () => number;

  constructor(private readonly deps: RoomEntryServiceDeps) {
    this.cooldownMs = deps.cooldownMs ?? ROOM_ENTRY_COOLDOWN_MS;
    this.now = deps.now ?? (() => Date.now());
  }

  enter(client: RoomEntryClient): RoomEntryEnterResult {
    const now = this.now();
    const last = this.lastNotifiedAt.get(client.principalId);
    if (last !== undefined && now - last < this.cooldownMs) {
      const remainingMs = Math.max(0, this.cooldownMs - (now - last));
      return { status: "entered", notified: false, reason: "cooldown", remainingMs };
    }

    this.lastNotifiedAt.set(client.principalId, now);
    const episodeId = randomUUID();
    const enteredAt = new Date(now).toISOString();
    const participants = this.deps.roster();

    const inputs: InboxAppendInput[] = participants.map((actorId) => ({
      id: roomEntryNoticeId(episodeId, actorId),
      actorId,
      source: ROOM_ENTRY_SOURCE,
      payload: {
        type: ROOM_HUMAN_ENTRY_PAYLOAD_TYPE,
        version: ROOM_HUMAN_ENTRY_VERSION,
        priority: "responsive",
        interruption: INBOX_INTERRUPTION_JOIN,
        episodeId,
        principalId: client.principalId,
        enteredAt,
      },
    }));

    if (inputs.length > 0) {
      try {
        this.deps.inbox.append(inputs);
      } catch (err) {
        this.deps.log?.(`failed to append room entry notices: ${String(err)}`);
      }
    }

    return { status: "entered", notified: true, episodeId };
  }

  renew?(_client: RoomEntryClient): { status: "ok" } {
    return { status: "ok" };
  }

  leave?(_client: RoomEntryClient): { status: "ok" } {
    return { status: "ok" };
  }

  /** Reset in-memory cooldown state. */
  reset(): void {
    this.lastNotifiedAt.clear();
  }
}
