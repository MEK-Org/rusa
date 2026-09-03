import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import type { ProviderConfig } from "../../config/types.js";
import { AntigravityProvider } from "../../providers/antigravity.js";
import { ClaudeProvider } from "../../providers/claude.js";
import { CodexProvider } from "../../providers/codex.js";
import { CopilotProvider } from "../../providers/copilot.js";
import { KimiProvider } from "../../providers/kimi.js";
import { providerSupportsEffort } from "../../providers/reasoning-effort.js";
import type { CodingProvider } from "../../providers/types.js";
import { runMigrations } from "../migrations/runner.js";
import { ACTOR_RUN_OUTPUT_MAX_CHARS, ActorRunRepository } from "./actor-run-repository.js";
import { MeshChatRepository } from "./mesh-chat-repository.js";

describe("ActorRunRepository", () => {
  let db: Database.Database;
  let runs: ActorRunRepository;
  let chat: MeshChatRepository;

  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db);
    runs = new ActorRunRepository(db);
    chat = new MeshChatRepository(db);
  });

  it("owns a run from start through yield and completion", () => {
    const id = runs.start({
      id: "run-1",
      actorId: "actor-a",
      startedAt: "2026-08-30T00:00:01.000Z",
      provider: "codex",
      model: "gpt-5.5",
      effortSupported: true,
      effort: "high",
    });
    runs.recordYield(id, "complete", "shipped", "2026-08-30T00:00:02.000Z");
    runs.complete(id, {
      endedAt: "2026-08-30T00:00:03.000Z",
      success: true,
      exitCode: 0,
      output: "final output",
    });

    expect(runs.getById(id)).toMatchObject({
      outcome: "completed",
      success: true,
      output: "final output",
      yieldStatus: "complete",
      yieldNote: "shipped",
      provider: "codex",
      model: "gpt-5.5",
      effort: "high",
      effortIsSet: true,
    });
  });

  it("records the launch model and effort at start, not completion, so it survives failure", () => {
    const id = runs.start({
      id: "run-failed",
      actorId: "actor-a",
      provider: "claude",
      model: "claude-opus-5",
      effortSupported: true,
      effort: "max",
    });
    runs.complete(id, { success: false, exitCode: 1, output: "boom" });

    expect(runs.getById(id)).toMatchObject({
      outcome: "completed",
      success: false,
      model: "claude-opus-5",
      effort: "max",
      effortIsSet: true,
    });
  });

  it("retains the launch model and effort on an interrupted (abandoned) run", () => {
    const id = runs.start({
      id: "run-interrupted",
      actorId: "actor-a",
      provider: "antigravity",
      model: "gemini-3-pro",
      effortSupported: true,
      effort: "high",
    });
    runs.abandon(id, "process killed");

    expect(runs.getById(id)).toMatchObject({
      outcome: "abandoned",
      abandonReason: "process killed",
      model: "gemini-3-pro",
      effort: "high",
      effortIsSet: true,
    });
  });

  it("records an explicit absent effort for a provider with no effort control, distinguishable from omission", () => {
    const withoutControl = runs.start({
      id: "run-kimi",
      actorId: "actor-a",
      provider: "kimi",
      model: "kimi-k3",
      effortSupported: false,
    });
    expect(runs.getById(withoutControl)).toMatchObject({
      model: "kimi-k3",
      effort: null,
      effortIsSet: false,
    });

    // A row that never had effort applicability assessed (e.g. a historical
    // pre-migration row, simulated here by omitting effortSupported) reads as
    // omission (null), not as an explicit "not applicable" (false).
    const omitted = runs.start({
      id: "run-legacy-shaped",
      actorId: "actor-a",
      provider: "kimi",
      model: "kimi-k3",
    });
    expect(runs.getById(omitted)).toMatchObject({
      effort: null,
      effortIsSet: null,
    });
  });

  it("rejects an empty new-run model", () => {
    expect(() => runs.start({ actorId: "actor-a", provider: "codex", model: "" })).toThrow(
      /model/i
    );
    expect(() => runs.start({ actorId: "actor-a", provider: "codex", model: "   " })).toThrow(
      /model/i
    );
  });

  it("accepts a null model for a provider run with no explicit pin configured", () => {
    const id = runs.start({ actorId: "actor-a", provider: "antigravity", model: null });
    expect(runs.getById(id)).toMatchObject({ model: null });
  });

  it("interleaves durable inbound chat and yield notes with a stable source cursor", () => {
    chat.record({
      id: "message-1",
      ts: "2026-08-30T00:00:01.000Z",
      senderId: "root",
      recipientId: "actor-a",
      body: "first",
    });
    const runId = runs.start({
      id: "run-1",
      actorId: "actor-a",
      startedAt: "2026-08-30T00:00:02.000Z",
      model: "test-model",
    });
    runs.recordYield(runId, "blocked", "second", "2026-08-30T00:00:02.000Z");
    runs.complete(runId, {
      endedAt: "2026-08-30T00:00:03.000Z",
      success: true,
      exitCode: 0,
      output: "run output",
    });
    chat.record({
      id: "message-2",
      ts: "2026-08-30T00:00:04.000Z",
      senderId: "root",
      recipientId: "actor-a",
      body: "third",
    });

    const first = runs.listLedgerSourcesAfter("actor-a", null, 2);
    expect(first.sources.map((source) => [source.kind, source.body])).toEqual([
      ["message_received", "first"],
      ["run_yielded", "second"],
    ]);
    expect(first.hasMore).toBe(true);
    expect(
      runs.listLedgerSourcesAfter("actor-a", runId).sources.map((source) => source.body)
    ).toEqual(["third"]);
  });

  it("keeps the useful tail of oversized output", () => {
    const id = runs.start({ actorId: "actor-a", model: "test-model" });
    runs.complete(id, {
      success: true,
      exitCode: 0,
      output: `${"x".repeat(ACTOR_RUN_OUTPUT_MAX_CHARS + 50)}TAIL`,
    });
    const output = runs.getById(id)?.output ?? "";
    expect(output).toContain("earlier chars truncated");
    expect(output.endsWith("TAIL")).toBe(true);
  });

  it("abandons prior-process open runs while retaining their yield source", () => {
    const id = runs.start({
      id: "interrupted-run",
      actorId: "actor-a",
      startedAt: "2026-08-30T00:00:01.000Z",
      model: "test-model",
    });
    runs.recordYield(id, "blocked", "waiting", "2026-08-30T00:00:02.000Z");

    expect(
      runs.abandonOpen("service restarted before run completion", "2026-08-30T00:00:03.000Z")
    ).toBe(1);
    expect(runs.getById(id)).toMatchObject({
      outcome: "abandoned",
      abandonReason: "service restarted before run completion",
      yieldNote: "waiting",
    });
    expect(runs.listLedgerSourcesAfter("actor-a", null).sources).toEqual([
      expect.objectContaining({ id, kind: "run_yielded", body: "waiting" }),
    ]);
  });

  describe("provider launch-config matrix", () => {
    const config: ProviderConfig = {};

    // Mirrors the capture in commands/start.ts's onRunStart: the exact pin and
    // effort actually passed to the provider constructor, read back off the
    // live provider instance at launch time — not a post-hoc result read-back.
    function captureLaunch(provider: CodingProvider, actorId: string, runId: string): void {
      runs.start({
        id: runId,
        actorId,
        provider: provider.providerName,
        model: provider.model ?? null,
        effortSupported: providerSupportsEffort(provider.providerName),
        effort: provider.effort ?? null,
      });
    }

    it("captures a non-empty launch model and native effort for every effort-capable provider", () => {
      const providers: CodingProvider[] = [
        new ClaudeProvider("claude", config, "claude-opus-5", "high"),
        new CodexProvider("codex", config, "gpt-5.6-sol", "medium"),
        new AntigravityProvider("antigravity", config, "gemini-3-pro", undefined, "low"),
      ];

      for (const provider of providers) {
        const runId = `run-${provider.providerName}`;
        captureLaunch(provider, "actor-a", runId);
        const row = runs.getById(runId);
        expect(row?.provider).toBe(provider.providerName);
        expect(row?.model).toBeTruthy();
        expect(row?.model).toBe(provider.model);
        expect(row?.effortIsSet).toBe(true);
        expect(row?.effort).toBe(provider.effort);
      }
    });

    it("captures a non-empty launch model and an explicit absent effort for providers without effort control", () => {
      const providers: CodingProvider[] = [
        new KimiProvider("kimi", config, "kimi-k3"),
        new CopilotProvider("copilot", config, "gpt-5.6"),
      ];

      for (const provider of providers) {
        const runId = `run-${provider.providerName}`;
        captureLaunch(provider, "actor-a", runId);
        const row = runs.getById(runId);
        expect(row?.provider).toBe(provider.providerName);
        expect(row?.model).toBeTruthy();
        expect(row?.model).toBe(provider.model);
        expect(row?.effortIsSet).toBe(false);
        expect(row?.effort).toBeNull();
      }
    });
  });
});
