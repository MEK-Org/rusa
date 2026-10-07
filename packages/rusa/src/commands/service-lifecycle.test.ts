import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { actorInbox } from "../db/migrations/0003_actor_inbox.js";
import { actorInboxSeen } from "../db/migrations/0012_actor_inbox_seen.js";
import { actorInboxHandledNote } from "../db/migrations/0015_actor_inbox_handled_note.js";
import { SqliteInboxRepository } from "../db/repositories/sqlite-inbox-repository.js";
import type { InboxEntry } from "../repositories/inbox-repository.js";
import {
  appendServiceBootWakes,
  recordAndAnnounceRequestedRestart,
  resolveRequestedRestartDestination,
  ServiceLifecycleStore,
} from "./service-lifecycle.js";

function entry(id: string, payload: Record<string, unknown>): InboxEntry {
  return {
    id,
    actorId: "root",
    source: "gchat:spaces/SPACE",
    deliveredAt: new Date("2026-10-07T10:00:00.000Z"),
    seenAt: null,
    handledAt: null,
    handledNote: null,
    payload: { ...payload, type: "gchat.message" },
  };
}

describe("service lifecycle evidence", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function store() {
    const dir = mkdtempSync(join(tmpdir(), "rusa-service-lifecycle-"));
    dirs.push(dir);
    let tick = 0;
    return new ServiceLifecycleStore(join(dir, "service-lifecycle.json"), () => {
      tick++;
      return `2026-10-07T10:00:0${tick}.000Z`;
    });
  }

  function inbox() {
    const db = new Database(":memory:");
    actorInbox.up(db);
    actorInboxSeen.up(db);
    actorInboxHandledNote.up(db);
    return new SqliteInboxRepository(db, () => new Date("2026-10-07T10:00:00.000Z"));
  }

  it("keeps a selected top-level or threaded Chat route, and refuses to guess a mixed route", () => {
    expect(
      resolveRequestedRestartDestination([
        entry("top", {
          spaceName: "spaces/SPACE",
          messageName: "spaces/SPACE/messages/HEAD",
          threadName: "spaces/SPACE/threads/HEAD",
        }),
      ])
    ).toEqual({ kind: "gchat", spaceName: "spaces/SPACE", entryId: "top" });

    expect(
      resolveRequestedRestartDestination([
        entry("reply", {
          spaceName: "SPACE",
          messageName: "spaces/SPACE/messages/REPLY",
          threadName: "spaces/SPACE/threads/HEAD",
        }),
      ])
    ).toEqual({
      kind: "gchat",
      spaceName: "spaces/SPACE",
      threadName: "spaces/SPACE/threads/HEAD",
      entryId: "reply",
    });

    expect(
      resolveRequestedRestartDestination([
        entry("a", { spaceName: "spaces/A", messageName: "spaces/A/messages/A" }),
        entry("b", { spaceName: "spaces/B", messageName: "spaces/B/messages/B" }),
      ])
    ).toBeUndefined();
    expect(
      resolveRequestedRestartDestination([
        entry("chat", { spaceName: "spaces/A", messageName: "spaces/A/messages/A" }),
        {
          ...entry("github", {}),
          source: "github:MEK-Org/rusa/issues/950",
          payload: { type: "issues.opened" },
        },
      ])
    ).toBeUndefined();
    expect(
      resolveRequestedRestartDestination([
        entry("uncertain-thread", {
          spaceName: "spaces/SPACE",
          threadName: "spaces/SPACE/threads/HEAD",
        }),
      ])
    ).toBeUndefined();
  });

  it("keeps requested intent and clean completion as independent evidence for the next boot", () => {
    const lifecycle = store();
    const intent = lifecycle.recordRequestedRestart({
      targetSha: "a".repeat(40),
      branch: "staging",
      subject: "synthetic update",
      origin: { kind: "gchat", spaceName: "spaces/SPACE", entryId: "input" },
    });
    lifecycle.recordAnnouncement(intent.id, "delivered");
    lifecycle.recordCleanShutdown("deploy", intent.id);

    const [wake] = lifecycle.beginBoot();
    expect(wake).toMatchObject({
      prior: "requested_clean",
      requestedRestart: { id: intent.id, targetSha: "a".repeat(40) },
      cleanShutdown: { reason: "deploy", transitionId: intent.id },
    });
    lifecycle.acknowledgeBootWake(wake?.bootId ?? "missing");

    const [laterBoot] = lifecycle.beginBoot();
    expect(laterBoot).toMatchObject({ prior: "unknown" });
  });

  it("does not call an interrupted shutdown clean, or let it explain a later boot after consumption", () => {
    const lifecycle = store();
    lifecycle.recordRequestedRestart({
      targetSha: "b".repeat(40),
      branch: "staging",
      subject: "interrupted update",
    });

    const [interrupted] = lifecycle.beginBoot();
    expect(interrupted).toMatchObject({ prior: "requested_without_matching_clean_shutdown" });
    lifecycle.acknowledgeBootWake(interrupted?.bootId ?? "missing");

    const [laterBoot] = lifecycle.beginBoot();
    expect(laterBoot).toMatchObject({ prior: "unknown" });
  });

  it("reports a clean unrequested stop without calling it a requested restart", () => {
    const lifecycle = store();
    lifecycle.recordCleanShutdown("signal");

    const [wake] = lifecycle.beginBoot();

    expect(wake).toMatchObject({
      prior: "clean_without_requested_restart",
      cleanShutdown: { reason: "signal" },
    });
    expect(wake?.requestedRestart).toBeUndefined();
  });

  it("recovers an interrupted inbox delivery through SQLite without duplicating its first boot", () => {
    const lifecycle = store();
    const durableInbox = inbox();
    const warnings: string[] = [];
    const interruptedLifecycle = {
      beginBoot: () => lifecycle.beginBoot(),
      acknowledgeBootWake: () => {
        throw new Error("simulated process interruption before acknowledgement");
      },
    };

    appendServiceBootWakes({
      lifecycle: interruptedLifecycle,
      inboxStore: durableInbox,
      rootId: "root",
      onLifecycleError: (event) => warnings.push(event),
    });
    const afterInterruptedAppend = durableInbox.list("root").entries;
    expect(afterInterruptedAppend).toHaveLength(1);
    expect(warnings).toEqual(["service_boot_wake_acknowledgement_failed"]);

    const restarted = new ServiceLifecycleStore(
      lifecycle.filePath,
      () => "2026-10-07T10:00:11.000Z"
    );
    appendServiceBootWakes({
      lifecycle: restarted,
      inboxStore: durableInbox,
      rootId: "root",
      onLifecycleError: (event) => warnings.push(event),
    });

    const recovered = durableInbox.list("root").entries;
    expect(recovered).toHaveLength(2);
    expect(recovered.map((wake) => wake.id)).toContain(afterInterruptedAppend[0]?.id);
    expect(new Set(recovered.map((wake) => wake.id)).size).toBe(2);
    expect(restarted.read()).toMatchObject({ kind: "ok", document: { pendingBootWakes: [] } });
  });

  it("archives malformed evidence, recovers future transitions, and still appends an unknown root wake", () => {
    const lifecycle = store();
    const durableInbox = inbox();
    writeFileSync(lifecycle.filePath, "{ bad json", "utf8");

    expect(lifecycle.read()).toMatchObject({ kind: "invalid" });
    appendServiceBootWakes({
      lifecycle,
      inboxStore: durableInbox,
      rootId: "root",
      onLifecycleError: () => {},
    });
    expect(durableInbox.list("root").entries).toMatchObject([
      {
        source: "system:service-lifecycle",
        payload: {
          type: "service.boot",
          priority: "responsive",
          prior: "unknown",
          lifecycleError: expect.any(String),
        },
      },
    ]);
    expect(lifecycle.read()).toMatchObject({ kind: "ok" });
    const archived = readdirSync(join(lifecycle.filePath, "..")).find((name) =>
      name.endsWith(".invalid")
    );
    expect(archived).toBeTruthy();
    expect(readFileSync(join(lifecycle.filePath, "..", archived ?? "missing"), "utf8")).toBe(
      "{ bad json"
    );

    expect(() =>
      lifecycle.recordRequestedRestart({
        targetSha: "c".repeat(40),
        branch: "staging",
        subject: "recovered update",
      })
    ).not.toThrow();
  });

  it("uses the actual restart callback path to announce exactly in the selected thread", async () => {
    const lifecycle = store();
    const sent: Array<{ space: string; text: string; thread?: string }> = [];

    const transitionId = await recordAndAnnounceRequestedRestart({
      lifecycle,
      entries: [
        entry("reply", {
          spaceName: "spaces/SPACE",
          messageName: "spaces/SPACE/messages/REPLY",
          threadName: "spaces/SPACE/threads/HEAD",
        }),
      ],
      chatClient: {
        async send(space, text, options) {
          sent.push({ space, text, thread: options?.threadName });
          return { name: "spaces/SPACE/messages/sent" };
        },
      },
      targetSha: "d".repeat(40),
      branch: "staging",
      subject: "synthetic update",
      onWarning: () => {},
    });

    expect(transitionId).toEqual(expect.any(String));
    expect(sent).toEqual([
      {
        space: "spaces/SPACE",
        text: "↪ Restart requested here → ddddddd (synthetic update) — draining + restarting",
        thread: "spaces/SPACE/threads/HEAD",
      },
    ]);
    expect(lifecycle.read()).toMatchObject({
      kind: "ok",
      document: { requestedRestart: { announcement: { outcome: "delivered" } } },
    });
  });

  it("keeps a delivered announcement honest when receipt persistence fails", async () => {
    const lifecycle = store();
    const warnings: Array<{ event: string; fields: Record<string, unknown> }> = [];
    vi.spyOn(lifecycle, "recordAnnouncement").mockImplementation(() => {
      throw new Error("disk full after send");
    });

    await recordAndAnnounceRequestedRestart({
      lifecycle,
      entries: [
        entry("top", { spaceName: "spaces/SPACE", messageName: "spaces/SPACE/messages/HEAD" }),
      ],
      chatClient: {
        async send() {
          return { name: "spaces/SPACE/messages/sent" };
        },
      },
      targetSha: "e".repeat(40),
      branch: "staging",
      subject: "synthetic update",
      onWarning: (event, fields) => warnings.push({ event, fields }),
    });

    expect(warnings).toMatchObject([
      { event: "service_restart_announcement_record_failed", fields: { outcome: "delivered" } },
    ]);
    expect(warnings.map((warning) => warning.event)).not.toContain(
      "service_restart_announcement_failed"
    );
  });

  it("bounds a pending restart announcement before returning to the committed update", async () => {
    vi.useFakeTimers();
    try {
      const lifecycle = store();
      const announcement = recordAndAnnounceRequestedRestart({
        lifecycle,
        entries: [
          entry("top", { spaceName: "spaces/SPACE", messageName: "spaces/SPACE/messages/HEAD" }),
        ],
        chatClient: {
          async send() {
            return new Promise(() => {});
          },
        },
        targetSha: "f".repeat(40),
        branch: "staging",
        subject: "synthetic update",
        timeoutMs: 1,
        onWarning: () => {},
      });

      await vi.advanceTimersByTimeAsync(1);
      await expect(announcement).resolves.toEqual(expect.any(String));
      expect(lifecycle.read()).toMatchObject({
        kind: "ok",
        document: { requestedRestart: { announcement: { outcome: "failed" } } },
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
