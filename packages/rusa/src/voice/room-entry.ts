import { randomUUID } from "node:crypto";
import type { RoomEntryEpisodeRow } from "../db/repositories/room-entry-episode-repository.js";
import {
  INBOX_INTERRUPTION_JOIN,
  ROOM_HUMAN_ENTRY_PAYLOAD_TYPE,
  ROOM_HUMAN_ENTRY_VERSION,
} from "../repositories/inbox-interruption.js";
import type { InboxRepository } from "../repositories/inbox-repository.js";
import {
  isValidRoomClientId,
  parseRoomEntryDocument,
  ROOM_ENTRY_DOCUMENT_VERSION,
  ROOM_ENTRY_LEASE_MS,
  type RoomEntryDocument,
  RoomEntryLimitError,
  type RoomEntryRecipientStatus,
  serializeRoomEntryDocument,
} from "./room-entry-document.js";

/** Inbox source key for Room entry notices. */
export const ROOM_ENTRY_SOURCE = "room:entry";

/** Recipient notice attempts in one drain pass, shared fairly across episodes. */
export const ROOM_ENTRY_DRAIN_BATCH = 64;

/** Interval of the lifecycle-owned delivery drain and collection pass. */
export const ROOM_ENTRY_DRAIN_INTERVAL_MS = 30_000;

/** The deterministic notice id for one recipient of one episode. */
export function roomEntryNoticeId(episodeId: string, actorId: string): string {
  return `room-entry:${episodeId}:${actorId}`;
}

/** The episode store the service needs; `RoomEntryEpisodeRepository` in production. */
export interface RoomEntryEpisodeStore {
  get(id: string): RoomEntryEpisodeRow | null;
  current(principalId: string): RoomEntryEpisodeRow | null;
  list(): RoomEntryEpisodeRow[];
  insert(row: RoomEntryEpisodeRow): void;
  update(id: string, patch: { endedAt: string | null; documentJson: string }): void;
  delete(id: string): boolean;
  transaction<T>(fn: () => T): T;
}

export interface RoomEntryServiceDeps {
  store: RoomEntryEpisodeStore;
  inbox: Pick<InboxRepository, "append" | "read">;
  /** Active Room participants right now: the server roster, never a client list. */
  roster: () => readonly string[];
  /** Cheap current membership; falls back to the roster for small standalone callers. */
  isParticipant?: (actorId: string) => boolean;
  now?: () => number;
  newId?: () => string;
  log?: (message: string) => void;
}

/**
 * Presence of one episode as the reply/audio paths must see it.
 * - `present`: a tab attached in this process holds an unexpired lease.
 * - `reconnecting`: the lease is unexpired but no tab has proven itself live
 *   to this process (socket loss, browser throttling, server restart).
 * - `departed`: ended, expired, or unknown.
 */
export type RoomEntryPresence = "present" | "reconnecting" | "departed";

/** The identity an enter/renew/leave request carries after authentication. */
export interface RoomEntryClient {
  principalId: string;
  clientId: string;
  /** Digest of the session cookie the request authenticated with. */
  sessionKey: string;
}

export type RoomEntryEnterResult =
  | { status: "entered"; episodeId: string; generation: string; created: boolean }
  | { status: "unavailable"; reason: string };

export type RoomEntryRenewResult =
  | { status: "renewed"; episodeId: string; generation: string }
  | { status: "expired" }
  | { status: "stale" };

export type RoomEntryLeaveResult = { status: "left"; ended: boolean } | { status: "stale" };

type Loaded = { row: RoomEntryEpisodeRow; document: RoomEntryDocument };

/**
 * Human entry episodes for the Chat Room and their entry notices (#829).
 *
 * Opening the Room is an explicit, authenticated enter. One episode per human
 * principal is shared across that principal's tabs; each tab holds a lease
 * renewed by authenticated client requests and bound to a server-issued
 * attachment generation, so a delayed leave from an old attachment cannot end
 * its replacement. The last explicit leave ends the episode at once; a
 * missing leave ends it when the last lease expires. An expired episode is
 * never revived: the next enter starts a new one.
 *
 * Creating an episode freezes the Room roster as its recipients and commits
 * their delivery intent with it. Notices are appended afterwards, outside that
 * transaction, under deterministic ids; a recipient is marked delivered only
 * once its row is confirmed durable. {@link drain} retries whatever is still
 * pending, so a failed append — with or without a restart — yields exactly one
 * notice later. {@link collect} removes an episode only once it has departed,
 * its fanout is terminal and none of its notices is unhandled.
 */
export class RoomEntryService {
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly log: (message: string) => void;
  /**
   * Generations that have proven themselves live to this process. Leases
   * survive a restart in the episode document, but presence does not: a tab
   * is `reconnecting` until its next authenticated renewal reaches us.
   */
  private readonly attached = new Set<string>();
  /** Known live lease sessions, also hydrated on restart; unknown cookies need no DB scan. */
  private sessionKeys = new Set<string>();
  private draining = false;
  /** Last attempted notice, including failures; the next pass starts after it. */
  private lastDrainAttempt: string | null = null;

  constructor(private readonly deps: RoomEntryServiceDeps) {
    this.now = deps.now ?? Date.now;
    this.newId = deps.newId ?? randomUUID;
    this.log = deps.log ?? (() => {});
    for (const row of deps.store.list()) {
      if (row.endedAt !== null) continue;
      const document = this.parse(row);
      if (!document) continue;
      for (const held of liveLeases(document, this.now())) this.sessionKeys.add(held.sessionKey);
    }
  }

  /**
   * Enter the Room for one tab. Reuses the principal's current episode, or
   * starts a new one with a frozen recipient snapshot. A request that would
   * exceed a bound changes nothing and reports notices unavailable.
   */
  enter(client: RoomEntryClient): RoomEntryEnterResult {
    if (!isValidRoomClientId(client.clientId)) {
      return { status: "unavailable", reason: "invalid client id" };
    }
    const now = this.now();
    let result: RoomEntryEnterResult;
    try {
      result = this.deps.store.transaction(() => {
        const current = this.loadCurrent(client.principalId, now);
        const generation = this.newId();
        const lease = {
          clientId: client.clientId,
          generation,
          sessionKey: client.sessionKey,
          renewedAt: now,
        };
        if (current) {
          const { row, document } = current;
          const next: RoomEntryDocument = {
            ...document,
            leases: [
              ...liveLeases(document, now).filter((held) => held.clientId !== client.clientId),
              lease,
            ],
          };
          this.deps.store.update(row.id, {
            endedAt: null,
            documentJson: serializeRoomEntryDocument(next),
          });
          return { status: "entered", episodeId: row.id, generation, created: false } as const;
        }
        const episodeId = this.newId();
        const recipients = [...new Set(this.deps.roster())].map((actorId) => ({
          actorId,
          status: "pending" as const,
        }));
        const document: RoomEntryDocument = {
          version: ROOM_ENTRY_DOCUMENT_VERSION,
          leases: [lease],
          recipients,
        };
        this.deps.store.insert({
          id: episodeId,
          principalId: client.principalId,
          enteredAt: new Date(now).toISOString(),
          endedAt: null,
          documentJson: serializeRoomEntryDocument(document),
        });
        return { status: "entered", episodeId, generation, created: true } as const;
      });
    } catch (error) {
      if (error instanceof RoomEntryLimitError) {
        return { status: "unavailable", reason: error.message };
      }
      throw error;
    }
    this.pruneAttachments();
    if (result.status === "entered") {
      this.sessionKeys.add(client.sessionKey);
      const replacedPrefix = `${result.episodeId}\u0000${client.clientId}\u0000`;
      for (const key of this.attached) {
        if (key.startsWith(replacedPrefix)) this.attached.delete(key);
      }
      this.attached.add(attachmentKey(result.episodeId, client.clientId, result.generation));
      if (result.created) this.drain();
    }
    return result;
  }

  /** Renew one tab's lease, proving it live. Expired episodes are never revived. */
  renew(client: RoomEntryClient & { episodeId: string; generation: string }): RoomEntryRenewResult {
    const now = this.now();
    const result = this.deps.store.transaction((): RoomEntryRenewResult => {
      const loaded = this.loadOwned(client.episodeId, client.principalId);
      if (!loaded || loaded.row.endedAt !== null) return { status: "expired" };
      if (this.expireIfLapsed(loaded, now)) return { status: "expired" };
      const { row, document } = loaded;
      const live = liveLeases(document, now);
      // A lapsed tab lease is not revived either: the tab enters again.
      const lease = live.find(
        (held) => held.clientId === client.clientId && held.generation === client.generation
      );
      if (!lease) return { status: "stale" };
      const next: RoomEntryDocument = {
        ...document,
        leases: live.map((held) =>
          held === lease ? { ...held, renewedAt: now, sessionKey: client.sessionKey } : held
        ),
      };
      this.deps.store.update(row.id, {
        endedAt: null,
        documentJson: serializeRoomEntryDocument(next),
      });
      return { status: "renewed", episodeId: row.id, generation: lease.generation };
    });
    this.pruneAttachments();
    if (result.status === "renewed") {
      this.sessionKeys.add(client.sessionKey);
      this.attached.add(attachmentKey(result.episodeId, client.clientId, result.generation));
    }
    return result;
  }

  /**
   * Transport close loses live attachment, retaining only the reconnect lease.
   * The future Room attachment uses this seam; an old generation cannot close
   * its replacement. Only authenticated renewal makes it present again.
   */
  detach(client: {
    principalId: string;
    episodeId: string;
    clientId: string;
    generation: string;
  }): void {
    const loaded = this.loadOwned(client.episodeId, client.principalId);
    if (
      !loaded?.document.leases.some(
        (held) => held.clientId === client.clientId && held.generation === client.generation
      )
    )
      return;
    this.attached.delete(attachmentKey(client.episodeId, client.clientId, client.generation));
  }

  /** Release one tab's lease; the last explicit leave ends the episode at once. */
  leave(client: {
    principalId: string;
    episodeId: string;
    clientId: string;
    generation: string;
  }): RoomEntryLeaveResult {
    const now = this.now();
    const result = this.deps.store.transaction((): RoomEntryLeaveResult => {
      const loaded = this.loadOwned(client.episodeId, client.principalId);
      if (!loaded || loaded.row.endedAt !== null) return { status: "stale" };
      if (this.expireIfLapsed(loaded, now)) return { status: "stale" };
      const { row, document } = loaded;
      const live = liveLeases(document, now);
      const remaining = live.filter(
        (held) => !(held.clientId === client.clientId && held.generation === client.generation)
      );
      if (remaining.length === live.length) return { status: "stale" };
      const ended = remaining.length === 0;
      this.deps.store.update(row.id, {
        endedAt: ended ? new Date(now).toISOString() : null,
        documentJson: serializeRoomEntryDocument({ ...document, leases: remaining }),
      });
      return { status: "left", ended };
    });
    this.pruneAttachments();
    if (result.status === "left") {
      this.attached.delete(attachmentKey(client.episodeId, client.clientId, client.generation));
    }
    return result;
  }

  /**
   * A signed-out or revoked session loses every lease it renewed, at once and
   * without reconnect grace. Another independently authenticated tab of the
   * same principal keeps the episode alive; if none remains, it departs.
   */
  invalidateSession(sessionKey: string): void {
    if (!this.sessionKeys.has(sessionKey)) return;
    const now = this.now();
    this.deps.store.transaction(() => {
      for (const row of this.deps.store.list()) {
        if (row.endedAt !== null) continue;
        const document = this.parse(row);
        if (!document) continue;
        if (!document.leases.some((held) => held.sessionKey === sessionKey)) continue;
        for (const held of document.leases) {
          if (held.sessionKey === sessionKey) {
            this.attached.delete(attachmentKey(row.id, held.clientId, held.generation));
          }
        }
        const remaining = liveLeases(document, now).filter(
          (held) => held.sessionKey !== sessionKey
        );
        this.deps.store.update(row.id, {
          endedAt: remaining.length === 0 ? new Date(now).toISOString() : null,
          documentJson: serializeRoomEntryDocument({ ...document, leases: remaining }),
        });
      }
    });
    this.sessionKeys.delete(sessionKey);
    this.pruneAttachments();
  }

  /**
   * An actor left the Room: every invitation it holds in an open episode is
   * void for good, even if it is re-added before that episode ends.
   */
  invalidateRecipient(actorId: string): void {
    this.deps.store.transaction(() => {
      for (const row of this.deps.store.list()) {
        if (row.endedAt !== null) continue;
        this.setRecipientStatus(row, actorId, "invalidated");
      }
    });
  }

  /** Current presence of an episode; missing or unreadable state is departed. */
  presence(episodeId: string): RoomEntryPresence {
    const row = this.deps.store.get(episodeId);
    if (!row || row.endedAt !== null) return "departed";
    const document = this.parse(row);
    if (!document) return "departed";
    const live = liveLeases(document, this.now());
    if (live.length === 0) return "departed";
    return live.some((held) =>
      this.attached.has(attachmentKey(row.id, held.clientId, held.generation))
    )
      ? "present"
      : "reconnecting";
  }

  /** Presence for a stored notice, requiring its principal and frozen recipient invitation. */
  noticePresence(episodeId: string, actorId: string, principalId: string): RoomEntryPresence {
    const loaded = this.loadOwned(episodeId, principalId);
    const recipient = loaded?.document.recipients.find((held) => held.actorId === actorId);
    if (recipient?.status !== "pending" && recipient?.status !== "delivered") return "departed";
    return this.presence(episodeId);
  }

  /** Whether an actor still holds a valid invitation from this episode. */
  isEligibleRecipient(episodeId: string, actorId: string): boolean {
    const row = this.deps.store.get(episodeId);
    const document = row ? this.parse(row) : null;
    const recipient = document?.recipients.find((held) => held.actorId === actorId);
    return recipient?.status === "delivered" || recipient?.status === "pending";
  }

  /**
   * Append every pending notice that can be appended, at most
   * {@link ROOM_ENTRY_DRAIN_BATCH} attempts per pass, taking one recipient
   * from each pending episode in turn so a large snapshot cannot starve the
   * rest. Failures are contained; their intent stays pending for a later pass.
   * One pass runs at a time.
   */
  drain(): void {
    if (this.draining) return;
    this.draining = true;
    try {
      const queues = this.deps.store
        .list()
        .map((row) => ({ row, document: this.parse(row) }))
        .filter((item): item is Loaded => item.document !== null);
      // Keep terminal recipients in the frozen order: a successful last attempt
      // must retain its cursor position on the next pass. Only pending rows consume
      // an attempt; interleaving episodes still prevents large-roster starvation.
      const candidates: Array<{ row: RoomEntryEpisodeRow; actorId: string; pending: boolean }> = [];
      const maxRecipients = Math.max(
        0,
        ...queues.map(({ document }) => document.recipients.length)
      );
      for (let index = 0; index < maxRecipients; index += 1) {
        for (const { row, document } of queues) {
          const recipient = document.recipients[index];
          if (recipient)
            candidates.push({
              row,
              actorId: recipient.actorId,
              pending: recipient.status === "pending",
            });
        }
      }
      const previous = candidates.findIndex(
        ({ row, actorId }) => roomEntryNoticeId(row.id, actorId) === this.lastDrainAttempt
      );
      let attempted = 0;
      for (
        let offset = 0;
        offset < candidates.length && attempted < ROOM_ENTRY_DRAIN_BATCH;
        offset += 1
      ) {
        const { row, actorId, pending } = candidates[(previous + 1 + offset) % candidates.length];
        if (!pending) continue;
        attempted += 1;
        this.lastDrainAttempt = roomEntryNoticeId(row.id, actorId);
        this.deliver(row, actorId);
      }
    } finally {
      this.draining = false;
    }
  }

  /**
   * Remove episodes that no longer carry anything: departed, every recipient
   * terminal and no notice still unhandled. Lapsed episodes are ended first.
   * Runs under the same guard as {@link drain}, so it never sees a recipient
   * between append and its completion stamp, and rechecks inside the
   * transaction that deletes.
   */
  collect(): number {
    if (this.draining) return 0;
    this.draining = true;
    let removed = 0;
    try {
      const now = this.now();
      const liveSessions = new Set<string>();
      for (const candidate of this.deps.store.list()) {
        const deleted = this.deps.store.transaction(() => {
          const row = this.deps.store.get(candidate.id);
          if (!row) return false;
          const document = this.parse(row);
          if (!document) return false;
          if (row.endedAt === null) {
            for (const held of liveLeases(document, now)) liveSessions.add(held.sessionKey);
          }
          if (row.endedAt === null && !this.expireIfLapsed({ row, document }, now)) return false;
          if (document.recipients.some((recipient) => recipient.status === "pending")) return false;
          const unhandled = document.recipients.some((recipient) => {
            const notice = this.deps.inbox.read(
              recipient.actorId,
              roomEntryNoticeId(row.id, recipient.actorId)
            );
            return notice !== null && notice.handledAt === null;
          });
          if (unhandled) return false;
          return this.deps.store.delete(row.id);
        });
        if (deleted) {
          for (const key of this.attached) {
            if (key.startsWith(`${candidate.id}\u0000`)) this.attached.delete(key);
          }
          removed += 1;
        }
      }
      this.sessionKeys = liveSessions;
    } finally {
      this.draining = false;
      this.pruneAttachments();
    }
    return removed;
  }

  /** Drop process-local generations independently of durable notice/audit retention. */
  private pruneAttachments(): void {
    const now = this.now();
    const liveByEpisode = new Map<string, Set<string>>();
    for (const key of this.attached) {
      const episodeId = key.split("\u0000", 1)[0];
      let live = liveByEpisode.get(episodeId);
      if (!live) {
        const row = this.deps.store.get(episodeId);
        const document = row && row.endedAt === null ? this.parse(row) : null;
        live = new Set(
          document
            ? liveLeases(document, now).map((held) =>
                attachmentKey(episodeId, held.clientId, held.generation)
              )
            : []
        );
        liveByEpisode.set(episodeId, live);
      }
      if (!live.has(key)) this.attached.delete(key);
    }
  }

  /** Deliver one recipient's notice and stamp it; never throws. */
  private deliver(row: RoomEntryEpisodeRow, actorId: string): void {
    try {
      if (!(this.deps.isParticipant?.(actorId) ?? this.deps.roster().includes(actorId))) {
        // Removed or retired since the snapshot: its invitation is void.
        this.deps.store.transaction(() => this.setRecipientStatus(row, actorId, "skipped"));
        return;
      }
      const id = roomEntryNoticeId(row.id, actorId);
      const inserted = this.deps.inbox.append([
        {
          id,
          actorId,
          source: ROOM_ENTRY_SOURCE,
          payload: {
            type: ROOM_HUMAN_ENTRY_PAYLOAD_TYPE,
            version: ROOM_HUMAN_ENTRY_VERSION,
            priority: "responsive",
            interruption: INBOX_INTERRUPTION_JOIN,
            episodeId: row.id,
            principalId: row.principalId,
            enteredAt: row.enteredAt,
          },
        },
      ]);
      if (inserted.length === 0 && this.deps.inbox.read(actorId, id) === null) {
        throw new Error("append neither inserted nor found the notice");
      }
      this.deps.store.transaction(() => this.setRecipientStatus(row, actorId, "delivered"));
    } catch (error) {
      this.log(
        `room entry notice ${row.id} for ${actorId} still pending: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  /**
   * Re-read and move one recipient forward. `invalidated` is final; a stamp
   * never moves a recipient back to pending.
   */
  private setRecipientStatus(
    candidate: RoomEntryEpisodeRow,
    actorId: string,
    status: Exclude<RoomEntryRecipientStatus, "pending">
  ): void {
    const row = this.deps.store.get(candidate.id);
    if (!row) return;
    const document = this.parse(row);
    if (!document) return;
    let changed = false;
    const recipients = document.recipients.map((recipient) => {
      if (recipient.actorId !== actorId || recipient.status === "invalidated") return recipient;
      if (recipient.status === status) return recipient;
      if (status !== "invalidated" && recipient.status !== "pending") return recipient;
      changed = true;
      return { ...recipient, status };
    });
    if (!changed) return;
    this.deps.store.update(row.id, {
      endedAt: row.endedAt,
      documentJson: serializeRoomEntryDocument({ ...document, recipients }),
    });
  }

  /** The principal's current episode, ending it first if its leases lapsed. */
  private loadCurrent(principalId: string, now: number): Loaded | null {
    const row = this.deps.store.current(principalId);
    if (!row) return null;
    const document = this.parse(row);
    if (!document) {
      // Unreadable state cannot hold presence; end it so a fresh enter can begin.
      this.deps.store.update(row.id, {
        endedAt: new Date(now).toISOString(),
        documentJson: row.documentJson,
      });
      return null;
    }
    return this.expireIfLapsed({ row, document }, now) ? null : { row, document };
  }

  private loadOwned(episodeId: string, principalId: string): Loaded | null {
    const row = this.deps.store.get(episodeId);
    if (!row || row.principalId !== principalId) return null;
    const document = this.parse(row);
    return document ? { row, document } : null;
  }

  /** End an open episode whose every lease has lapsed. Returns whether it had. */
  private expireIfLapsed({ row, document }: Loaded, now: number): boolean {
    if (row.endedAt !== null) return true;
    if (liveLeases(document, now).length > 0) return false;
    const lastRenewal = Math.max(0, ...document.leases.map((held) => held.renewedAt));
    const endedAt = document.leases.length > 0 ? lastRenewal + ROOM_ENTRY_LEASE_MS : now;
    this.deps.store.update(row.id, {
      endedAt: new Date(Math.min(endedAt, now)).toISOString(),
      documentJson: serializeRoomEntryDocument({ ...document, leases: [] }),
    });
    return true;
  }

  private parse(row: RoomEntryEpisodeRow): RoomEntryDocument | null {
    try {
      return parseRoomEntryDocument(row.documentJson);
    } catch (error) {
      this.log(
        `room entry episode ${row.id} unreadable: ${error instanceof Error ? error.message : String(error)}`
      );
      return null;
    }
  }
}

/** Leases whose deadline is still ahead of `now`. */
function liveLeases(document: RoomEntryDocument, now: number) {
  return document.leases.filter((held) => held.renewedAt + ROOM_ENTRY_LEASE_MS > now);
}

function attachmentKey(episodeId: string, clientId: string, generation: string): string {
  return `${episodeId}\u0000${clientId}\u0000${generation}`;
}
