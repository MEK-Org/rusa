import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { InboxEntry } from "../repositories/inbox-repository.js";
import { resolveRequestedRestartDestination, ServiceLifecycleStore } from "./service-lifecycle.js";

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

  it("does not let a requested but interrupted transition explain a later boot after it is consumed", () => {
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

  it("recovers a wake whose process died after persistence and deduplicates its inbox identity", () => {
    const lifecycle = store();
    const [first] = lifecycle.beginBoot();
    const pending = lifecycle.beginBoot();

    expect(pending.map((wake) => wake.bootId)).toEqual([first?.bootId, pending[1]?.bootId]);
    expect(new Set(pending.map((wake) => `service-boot:${wake.bootId}`)).size).toBe(2);

    for (const wake of pending) lifecycle.acknowledgeBootWake(wake.bootId);
    expect(lifecycle.read()).toMatchObject({ kind: "ok", document: { pendingBootWakes: [] } });
  });

  it("does not overwrite malformed evidence with an invented absence", () => {
    const lifecycle = store();
    writeFileSync(lifecycle.filePath, "{ bad json", "utf8");

    expect(lifecycle.read()).toMatchObject({ kind: "invalid" });
    expect(() => lifecycle.beginBoot()).toThrow("service lifecycle state is invalid");
  });
});
