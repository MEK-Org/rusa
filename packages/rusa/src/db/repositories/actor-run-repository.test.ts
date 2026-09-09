import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { projectActorRunLaunchConfig } from "../../actor/run-accounting.js";
import type { ProviderConfig } from "../../config/types.js";
import { AntigravityProvider } from "../../providers/antigravity.js";
import { ClaudeProvider } from "../../providers/claude.js";
import { CodexProvider } from "../../providers/codex.js";
import { CopilotProvider } from "../../providers/copilot.js";
import { KimiProvider } from "../../providers/kimi.js";
import type { CodingProvider } from "../../providers/types.js";
import { runMigrations } from "../migrations/runner.js";
import { createActorRunModelConfig } from "./actor-run-model-config.js";
import { ACTOR_RUN_OUTPUT_MAX_CHARS, ActorRunRepository } from "./actor-run-repository.js";
import { MeshChatRepository } from "./mesh-chat-repository.js";

function launch(provider: string, model: string, effort?: string) {
  return createActorRunModelConfig({
    provider,
    model,
    ...(effort === undefined ? {} : { effort }),
  });
}

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
      modelConfig: launch("codex", "gpt-5.5", "high"),
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
      modelConfig: { version: 1, provider: "codex", model: "gpt-5.5", effort: "high" },
    });
  });

  it("records the launch model and effort at start, not completion, so it survives failure", () => {
    const id = runs.start({
      id: "run-failed",
      actorId: "actor-a",
      modelConfig: launch("claude", "claude-opus-5", "max"),
    });
    runs.complete(id, { success: false, exitCode: 1, output: "boom" });

    expect(runs.getById(id)).toMatchObject({
      outcome: "completed",
      success: false,
      modelConfig: { version: 1, provider: "claude", model: "claude-opus-5", effort: "max" },
    });
  });

  it("retains the launch model and effort on an interrupted (abandoned) run", () => {
    const id = runs.start({
      id: "run-interrupted",
      actorId: "actor-a",
      modelConfig: launch("antigravity", "gemini-3-pro", "high"),
    });
    runs.abandon(id, "process killed");

    expect(runs.getById(id)).toMatchObject({
      outcome: "abandoned",
      abandonReason: "process killed",
      modelConfig: { version: 1, provider: "antigravity", model: "gemini-3-pro", effort: "high" },
    });
  });

  it("records a complete model document without effort, distinguishable from historical omission", () => {
    const withoutControl = runs.start({
      id: "run-kimi",
      actorId: "actor-a",
      modelConfig: launch("kimi", "kimi-k3"),
    });
    expect(runs.getById(withoutControl)).toMatchObject({
      modelConfig: { version: 1, provider: "kimi", model: "kimi-k3" },
    });

    // A row that predates this migration has no document at all, while a new
    // Kimi row has a complete document with no optional effort key.
    db.prepare(
      `INSERT INTO actor_runs (id, actor_id, started_at, provider, model)
       VALUES (?, ?, ?, ?, ?)`
    ).run("run-historical", "actor-a", "2026-08-30T00:00:00.000Z", "kimi", "kimi-k3");
    const omitted = "run-historical";
    expect(runs.getById(omitted)).toMatchObject({
      modelConfig: null,
    });
  });

  it("rejects invalid new-run model documents", () => {
    expect(() =>
      runs.start({
        actorId: "actor-a",
        modelConfig: { version: 1, provider: "", model: "kimi-k3" },
      })
    ).toThrow(/provider/i);
    expect(() =>
      runs.start({
        actorId: "actor-a",
        modelConfig: { version: 1, provider: "kimi", model: "kimi-k3", effort: "   " },
      })
    ).toThrow(/effort/i);
    expect(() =>
      runs.start({
        actorId: "actor-a",
        modelConfig: { version: 1, provider: "codex", model: "o3", efort: "high" } as never,
      })
    ).toThrow(/unexpected property/i);
  });

  it("rejects an empty new-run provider or model", () => {
    expect(() =>
      runs.start({
        actorId: "actor-a",
        modelConfig: { version: 1, provider: "", model: "gpt-5.6-sol" },
      })
    ).toThrow(/provider/i);
    expect(() =>
      runs.start({ actorId: "actor-a", modelConfig: { version: 1, provider: "codex", model: "" } })
    ).toThrow(/model/i);
    expect(() =>
      runs.start({
        actorId: "actor-a",
        modelConfig: { version: 1, provider: "codex", model: "   " },
      })
    ).toThrow(/model/i);
  });

  it("rejects an unknown document version and malformed stored documents", () => {
    expect(() =>
      runs.start({
        actorId: "actor-a",
        modelConfig: { version: 2, provider: "codex", model: "gpt-5.6-sol" } as never,
      })
    ).toThrow(/version/i);
    db.prepare(
      `INSERT INTO actor_runs (id, actor_id, started_at, model_config) VALUES (?, ?, ?, ?)`
    ).run("run-invalid", "actor-a", "2026-08-30T00:00:00.000Z", "not-json");
    expect(() => runs.getById("run-invalid")).toThrow(/invalid JSON/i);
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
      modelConfig: launch("fake", "test-model"),
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
    const id = runs.start({
      actorId: "actor-a",
      modelConfig: launch("fake", "test-model"),
    });
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
      modelConfig: launch("fake", "test-model"),
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
    function captureLaunch(provider: CodingProvider, actorId: string, runId: string): void {
      runs.start({
        id: runId,
        actorId,
        modelConfig: projectActorRunLaunchConfig({
          provider: provider.name,
          model: provider.model,
          effort: provider.effort,
        }),
      });
    }

    it("captures a non-empty launch model and native effort for every effort-capable provider", () => {
      const providers: CodingProvider[] = [
        new ClaudeProvider("claude", config, "claude-opus-5", "high"),
        new CodexProvider("codex", config, "gpt-5.6-sol", "medium"),
        new AntigravityProvider("antigravity", config, "gemini-3-pro", undefined, "low"),
      ];

      for (const provider of providers) {
        const runId = `run-${provider.name}`;
        captureLaunch(provider, "actor-a", runId);
        const row = runs.getById(runId);
        expect(row?.provider).toBe(provider.name);
        expect(row?.model).toBeTruthy();
        expect(row?.model).toBe(provider.model);
        expect(row?.modelConfig).toEqual({
          version: 1,
          provider: provider.name,
          model: provider.model,
          effort: provider.effort,
        });
      }
    });

    it("preserves configured provider alias without collapsing to cliCommand or throttle key", () => {
      const aliasProvider = new ClaudeProvider("fast-claude", config, "claude-opus-5", "low");
      const runId = "run-alias";
      captureLaunch(aliasProvider, "actor-a", runId);
      const row = runs.getById(runId);
      expect(row?.provider).toBe("fast-claude");
      expect(row?.modelConfig).toEqual({
        version: 1,
        provider: "fast-claude",
        model: "claude-opus-5",
        effort: "low",
      });
    });

    it("captures a non-empty launch model and an explicit absent effort for providers without effort control", () => {
      const providers: CodingProvider[] = [
        new KimiProvider("kimi", config, "kimi-k3"),
        new CopilotProvider("copilot", config, "gpt-5.6"),
      ];

      for (const provider of providers) {
        const runId = `run-${provider.name}`;
        captureLaunch(provider, "actor-a", runId);
        const row = runs.getById(runId);
        expect(row?.provider).toBe(provider.name);
        expect(row?.model).toBeTruthy();
        expect(row?.model).toBe(provider.model);
        expect(row?.modelConfig).toEqual({
          version: 1,
          provider: provider.name,
          model: provider.model,
        });
      }
    });
  });
});
