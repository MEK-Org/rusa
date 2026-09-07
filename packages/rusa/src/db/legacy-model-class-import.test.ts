import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import type { RusaConfig } from "../config/types.js";
import {
  applyModelClassConfigCutover,
  MODEL_CLASSES_CONFIG_CUTOVER_SOURCE,
  planModelClassConfigCutover,
} from "./legacy-model-class-import.js";
import { runMigrations } from "./migrations/runner.js";
import { Repositories } from "./repositories/index.js";

function config(
  modelClasses?: Record<string, Array<{ provider: string; model: string }>>
): RusaConfig {
  return {
    providers: { claude: { cliCommand: "claude" }, codex: { cliCommand: "codex" } },
    ...(modelClasses ? { modelClasses } : {}),
  } as unknown as RusaConfig;
}

describe("model-class config cutover", () => {
  it("imports config once, then preserves a runtime edit across a simulated restart", () => {
    const db = new Database(":memory:");
    runMigrations(db);
    const repositories = new Repositories(db);
    const legacyConfig = config({ review: [{ provider: "claude", model: "claude-opus-4-8" }] });

    const first = applyModelClassConfigCutover(
      planModelClassConfigCutover({ config: legacyConfig, repositories }),
      { db, repositories, now: () => "2026-09-07T10:00:00.000Z" }
    );
    expect(first).toEqual({ importedDefinitions: 1, ignoredStaleConfig: false });
    repositories.modelClasses.upsert(
      "review",
      [{ provider: "codex", model: "gpt-5.6-sol" }],
      "2026-09-07T10:01:00.000Z"
    );

    const restart = applyModelClassConfigCutover(
      planModelClassConfigCutover({ config: legacyConfig, repositories }),
      { db, repositories, now: () => "2026-09-07T10:02:00.000Z" }
    );
    expect(restart).toEqual({ importedDefinitions: 0, ignoredStaleConfig: true });
    expect(repositories.modelClasses.get("review")?.modelConfig).toEqual([
      { provider: "codex", model: "gpt-5.6-sol" },
    ]);
    expect(repositories.legacyImportReceipts.has(MODEL_CLASSES_CONFIG_CUTOVER_SOURCE)).toBe(true);
    db.close();
  });

  it("records an empty first cutover, so later-added config never becomes authority", () => {
    const db = new Database(":memory:");
    runMigrations(db);
    const repositories = new Repositories(db);
    applyModelClassConfigCutover(planModelClassConfigCutover({ config: config(), repositories }), {
      db,
      repositories,
      now: () => "2026-09-07T10:00:00.000Z",
    });
    const laterConfig = config({ review: [{ provider: "claude", model: "claude-opus-4-8" }] });
    const result = applyModelClassConfigCutover(
      planModelClassConfigCutover({ config: laterConfig, repositories }),
      { db, repositories }
    );
    expect(result.ignoredStaleConfig).toBe(true);
    expect(repositories.modelClasses.list()).toEqual([]);

    // A receipt means even malformed restored legacy data is not authoritative
    // and must not prevent a database-backed restart.
    const malformed = config();
    (malformed as unknown as { modelClasses?: unknown }).modelClasses = ["not-a-mapping"];
    expect(() =>
      applyModelClassConfigCutover(
        planModelClassConfigCutover({ config: malformed, repositories }),
        {
          db,
          repositories,
        }
      )
    ).not.toThrow();
    db.close();
  });

  it("refuses an unreceipted mix rather than guessing which definitions win", () => {
    const db = new Database(":memory:");
    runMigrations(db);
    const repositories = new Repositories(db);
    repositories.modelClasses.upsert(
      "review",
      [{ provider: "codex", model: "gpt-5.6-sol" }],
      "2026-09-07T10:00:00.000Z"
    );
    expect(() =>
      planModelClassConfigCutover({
        config: config({ review: [{ provider: "claude", model: "claude-opus-4-8" }] }),
        repositories,
      })
    ).toThrow(/refusing to let config.yaml overwrite runtime state/);
    db.close();
  });
});
