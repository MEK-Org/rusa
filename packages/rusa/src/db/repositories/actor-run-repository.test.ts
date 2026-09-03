import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { projectActorRunLaunchConfig } from "../../actor/run-accounting.js";
import type { ProviderConfig } from "../../config/types.js";
import { AntigravityProvider } from "../../providers/antigravity.js";
import { ClaudeProvider } from "../../providers/claude.js";
import { CodexProvider } from "../../providers/codex.js";
import { CopilotProvider } from "../../providers/copilot.js";
import { KimiProvider } from "../../providers/kimi.js";
import { providerSupportsEffort } from "../../providers/registry.js";
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
      effortApplicable: true,
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
      effortIsApplicable: true,
    });
  });

  it("records the launch model and effort at start, not completion, so it survives failure", () => {
    const id = runs.start({
      id: "run-failed",
      actorId: "actor-a",
      provider: "claude",
      model: "claude-opus-5",
      effortApplicable: true,
      effort: "max",
    });
    runs.complete(id, { success: false, exitCode: 1, output: "boom" });

    expect(runs.getById(id)).toMatchObject({
      outcome: "completed",
      success: false,
      model: "claude-opus-5",
      effort: "max",
      effortIsApplicable: true,
    });
  });

  it("retains the launch model and effort on an interrupted (abandoned) run", () => {
    const id = runs.start({
      id: "run-interrupted",
      actorId: "actor-a",
      provider: "antigravity",
      model: "gemini-3-pro",
      effortApplicable: true,
      effort: "high",
    });
    runs.abandon(id, "process killed");

    expect(runs.getById(id)).toMatchObject({
      outcome: "abandoned",
      abandonReason: "process killed",
      model: "gemini-3-pro",
      effort: "high",
      effortIsApplicable: true,
    });
  });

  it("records an explicit absent effort for a provider with no effort control, distinguishable from historical omission", () => {
    const withoutControl = runs.start({
      id: "run-kimi",
      actorId: "actor-a",
      provider: "kimi",
      model: "kimi-k3",
      effortApplicable: false,
    });
    expect(runs.getById(withoutControl)).toMatchObject({
      model: "kimi-k3",
      effort: null,
      effortIsApplicable: false,
    });

    // A row that predates this migration has no assessment at all, so it
    // remains readable as omission (null), not an explicit "not applicable"
    // (false). New starts must supply applicability and cannot create this
    // shape.
    db.prepare(
      `INSERT INTO actor_runs (id, actor_id, started_at, provider, model)
       VALUES (?, ?, ?, ?, ?)`
    ).run("run-historical", "actor-a", "2026-08-30T00:00:00.000Z", "kimi", "kimi-k3");
    const omitted = "run-historical";
    expect(runs.getById(omitted)).toMatchObject({
      effort: null,
      effortIsApplicable: null,
    });
  });

  it("requires explicit effort applicability and rejects effort for unsupported providers", () => {
    expect(() =>
      runs.start({ actorId: "actor-a", provider: "kimi", model: "kimi-k3" } as never)
    ).toThrow(/applicability/i);
    expect(() =>
      runs.start({
        actorId: "actor-a",
        provider: "kimi",
        model: "kimi-k3",
        effortApplicable: false,
        effort: "high",
      })
    ).toThrow(/effort.*absent/i);
  });

  it("rejects an empty new-run model", () => {
    expect(() =>
      runs.start({ actorId: "actor-a", provider: "codex", model: "", effortApplicable: true })
    ).toThrow(/model/i);
    expect(() =>
      runs.start({ actorId: "actor-a", provider: "codex", model: "   ", effortApplicable: true })
    ).toThrow(/model/i);
  });

  it("accepts a null model for a provider run with no explicit pin configured", () => {
    const id = runs.start({
      actorId: "actor-a",
      provider: "antigravity",
      model: null,
      effortApplicable: true,
    });
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
      effortApplicable: false,
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
    const id = runs.start({ actorId: "actor-a", model: "test-model", effortApplicable: false });
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
      effortApplicable: false,
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

    // This invokes the projection used by commands/start.ts's onRunStart, so
    // the provider matrix cannot stay green if production launch capture drifts.
    function captureLaunch(
      provider: CodingProvider,
      capabilityName: string,
      actorId: string,
      runId: string
    ): void {
      runs.start({
        id: runId,
        actorId,
        ...projectActorRunLaunchConfig(
          {
            provider: provider.providerName,
            model: provider.model,
            effort: provider.effort,
          },
          provider.providerName,
          providerSupportsEffort(capabilityName)
        ),
      });
    }

    it("captures a non-empty launch model and native effort for every effort-capable provider", () => {
      const providers: Array<{ provider: CodingProvider; capabilityName: string }> = [
        {
          provider: new ClaudeProvider("claude", config, "claude-opus-5", "high"),
          capabilityName: "claude",
        },
        {
          provider: new CodexProvider("codex", config, "gpt-5.6-sol", "medium"),
          capabilityName: "codex",
        },
        {
          provider: new AntigravityProvider(
            "antigravity",
            config,
            "gemini-3-pro",
            undefined,
            "low"
          ),
          capabilityName: "agy",
        },
      ];

      for (const { provider, capabilityName } of providers) {
        const runId = `run-${provider.providerName}`;
        captureLaunch(provider, capabilityName, "actor-a", runId);
        const row = runs.getById(runId);
        expect(row?.provider).toBe(provider.providerName);
        expect(row?.model).toBeTruthy();
        expect(row?.model).toBe(provider.model);
        expect(row?.effortIsApplicable).toBe(true);
        expect(row?.effort).toBe(provider.effort);
      }
    });

    it("captures a non-empty launch model and an explicit absent effort for providers without effort control", () => {
      const providers: Array<{ provider: CodingProvider; capabilityName: string }> = [
        { provider: new KimiProvider("kimi", config, "kimi-k3"), capabilityName: "kimi" },
        { provider: new CopilotProvider("copilot", config, "gpt-5.6"), capabilityName: "copilot" },
      ];

      for (const { provider, capabilityName } of providers) {
        const runId = `run-${provider.providerName}`;
        captureLaunch(provider, capabilityName, "actor-a", runId);
        const row = runs.getById(runId);
        expect(row?.provider).toBe(provider.providerName);
        expect(row?.model).toBeTruthy();
        expect(row?.model).toBe(provider.model);
        expect(row?.effortIsApplicable).toBe(false);
        expect(row?.effort).toBeNull();
      }
    });
  });
});
