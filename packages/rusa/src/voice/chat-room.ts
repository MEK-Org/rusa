import type { ActorRecord } from "../actor/actor-record.js";
import type { ChatRoomMember } from "../db/repositories/chat-room-repository.js";
import type { ActorRepository } from "../repositories/actor-repository.js";
import type { SupportedVoice } from "./voice-catalog.js";
import type { VoiceConfigDocument } from "./voice-config.js";

/** One participant as every dashboard sees it. Root carries no add provenance. */
export interface ChatRoomParticipant {
  actorId: string;
  addedBy: string | null;
  addedAt: string | null;
}

/** What an add did, including any voice it had to assign to stay distinct. */
export interface ChatRoomAddResult {
  actorId: string;
  added: boolean;
  voice: VoiceConfigDocument;
  /** The colliding voice the actor had before this add, when one was replaced. */
  replacedVoice: VoiceConfigDocument | null;
}

/** The roster store the service needs; `ChatRoomRepository` in production. */
export interface ChatRoomStore {
  list(): ChatRoomMember[];
  has(actorId: string): boolean;
  add(member: ChatRoomMember): boolean;
  remove(actorId: string): boolean;
  transaction<T>(fn: () => T): T;
}

export interface ChatRoomServiceDeps {
  store: ChatRoomStore;
  actors: Pick<ActorRepository, "get" | "patch">;
  /** The configured root actor: always a participant, never stored or removable. */
  rootId: string;
  /** Voices an actor may be assigned, in preference order (the dashboard catalog). */
  voices: () => readonly SupportedVoice[];
  /** The voice an actor without a stored `voiceConfig` speaks with. */
  defaultVoice: VoiceConfigDocument;
  /** True for durable human principals, which are never room participants. */
  isHumanPrincipal: (id: string) => boolean;
  /** Told after an actor actually left the room, e.g. to void its entry invitations (#829). */
  onRemoved?: (actorId: string) => void;
  now?: () => string;
}

/** Aliases a caller might reach for that name no single stable actor. */
const ALIASES = new Set(["root", "parent", "self", "me"]);

function voiceKey(voice: VoiceConfigDocument): string {
  return voice.provider === "google"
    ? `google:${voice.config.voiceName.toLowerCase()}`
    : `elevenlabs:${voice.config.voiceId}`;
}

/**
 * The one mesh-wide voice Chat Room (#663). Membership is mesh state: root is
 * always in the room, and actors join or leave only through the root-held
 * `room-admin` tools, so every dashboard renders the same roster. Adding an
 * actor whose voice another participant already speaks with assigns it the
 * next unused voice through its ordinary per-actor voice setting, so listeners
 * can tell participants apart by ear.
 */
export class ChatRoomService {
  private readonly now: () => string;

  constructor(private readonly deps: ChatRoomServiceDeps) {
    this.now = deps.now ?? (() => new Date().toISOString());
  }

  /** Root first, then live stored participants in the order they were added. */
  participants(): ChatRoomParticipant[] {
    const stored = this.deps.store
      .list()
      .filter((member) => member.actorId !== this.deps.rootId)
      .filter((member) => this.deps.actors.get(member.actorId)?.status === "active");
    return [
      { actorId: this.deps.rootId, addedBy: null, addedAt: null },
      ...stored.map(({ actorId, addedBy, addedAt }) => ({ actorId, addedBy, addedAt })),
    ];
  }

  add(target: string, addedBy: string): ChatRoomAddResult {
    const actor = this.resolveAddable(target);
    return this.deps.store.transaction(() => {
      const current = this.effectiveVoice(actor);
      if (this.deps.store.has(actor.id)) {
        return { actorId: actor.id, added: false, voice: current, replacedVoice: null };
      }
      const taken = new Set(
        this.participants()
          .map((participant) => this.deps.actors.get(participant.actorId))
          .filter((record): record is ActorRecord => record !== undefined)
          .map((record) => voiceKey(this.effectiveVoice(record)))
      );
      let voice = current;
      let replacedVoice: VoiceConfigDocument | null = null;
      if (taken.has(voiceKey(current))) {
        const next = this.deps.voices().find((entry) => !taken.has(voiceKey(entry.voiceConfig)));
        if (!next) {
          throw new Error(
            `cannot add ${actor.id}: its voice is already used in the room and no unused voice is available`
          );
        }
        replacedVoice = current;
        voice = next.voiceConfig;
        this.deps.actors.patch(actor.id, { voiceConfig: voice });
      }
      this.deps.store.add({ actorId: actor.id, addedBy, addedAt: this.now() });
      return { actorId: actor.id, added: true, voice, replacedVoice };
    });
  }

  /** Returns false when the actor was not in the room. Its voice is left as-is. */
  remove(target: string): boolean {
    const id = target.trim();
    if (id === this.deps.rootId) {
      throw new Error("root is always in the Chat Room and cannot be removed");
    }
    if (ALIASES.has(id.toLowerCase())) {
      throw new Error("use an actor id, not an alias");
    }
    const removed = this.deps.store.remove(id);
    if (removed) this.deps.onRemoved?.(id);
    return removed;
  }

  private resolveAddable(target: string): ActorRecord {
    const id = target.trim();
    if (id === this.deps.rootId) {
      throw new Error("root is always in the Chat Room");
    }
    if (ALIASES.has(id.toLowerCase())) {
      throw new Error(`'${id}' is an alias, not a participant; pass the actor's thread id`);
    }
    if (id.startsWith("human:") || this.deps.isHumanPrincipal(id)) {
      throw new Error("human principals listen from the dashboard; only actors can be added");
    }
    const actor = this.deps.actors.get(id);
    if (!actor) throw new Error(`unknown actor: ${id}`);
    if (actor.status !== "active") throw new Error(`actor ${id} is retired`);
    return actor;
  }

  private effectiveVoice(actor: ActorRecord): VoiceConfigDocument {
    return actor.voiceConfig ?? this.deps.defaultVoice;
  }
}
