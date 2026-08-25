import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { runMigrations } from "../migrations/runner.js";
import { ModelScrapeRepository } from "./model-scrape-repository.js";

describe("ModelScrapeRepository", () => {
  it("keeps exact raw bytes separately from the normalized parsed models", () => {
    const db = new Database(":memory:");
    runMigrations(db);
    const repo = new ModelScrapeRepository(db);
    const raw = "Select model\r\n\u001b[32m1. gpt-5.6-sol (current)\u001b[0m\n";
    const id = repo.recordRaw({
      provider: "codex",
      scrapedAt: "2026-08-18T10:00:00.000Z",
      rawOutput: raw,
    });

    repo.recordParsed(id, [
      { displayLabel: "gpt-5.6-sol", identifier: "gpt-5.6-sol" },
      { displayLabel: "gpt-5.6-terra", identifier: "gpt-5.6-terra" },
    ]);

    const [scrape] = repo.listSince("codex", "2026-08-18T00:00:00.000Z");
    expect(scrape.rawOutput).toBe(raw);
    expect(scrape.parsedModels).toEqual([
      { displayLabel: "gpt-5.6-sol", identifier: "gpt-5.6-sol" },
      { displayLabel: "gpt-5.6-terra", identifier: "gpt-5.6-terra" },
    ]);
    expect(scrape.parseError).toBeNull();
    db.close();
  });

  it("retains the raw scrape when parsing fails", () => {
    const db = new Database(":memory:");
    runMigrations(db);
    const repo = new ModelScrapeRepository(db);
    const id = repo.recordRaw({
      provider: "claude",
      scrapedAt: "2026-08-18T10:00:00.000Z",
      rawOutput: "unparseable screen output",
    });
    repo.recordParseError(id, new Error("LLM parse failure"));

    const [scrape] = repo.listSince("claude", "2026-08-18T00:00:00.000Z");
    expect(scrape.rawOutput).toBe("unparseable screen output");
    expect(scrape.parsedModels).toBeNull();
    expect(scrape.parseError).toContain("LLM parse failure");
    db.close();
  });

  it("retrieves the latest scrape for a provider", () => {
    const db = new Database(":memory:");
    runMigrations(db);
    const repo = new ModelScrapeRepository(db);

    const id1 = repo.recordRaw({
      provider: "agy",
      scrapedAt: "2026-08-18T08:00:00.000Z",
      rawOutput: "screen 1",
    });
    repo.recordParsed(id1, [{ displayLabel: "Gemini 3.0 Pro", identifier: "gemini-3.0-pro" }]);

    const id2 = repo.recordRaw({
      provider: "agy",
      scrapedAt: "2026-08-18T12:00:00.000Z",
      rawOutput: "screen 2",
    });
    repo.recordParsed(id2, [
      { displayLabel: "Gemini 3.1 Pro (High)", identifier: "gemini-3.1-pro" },
    ]);

    const latest = repo.getLatestForProvider("agy");
    expect(latest).not.toBeNull();
    expect(latest?.rawOutput).toBe("screen 2");
    expect(latest?.parsedModels).toEqual([
      { displayLabel: "Gemini 3.1 Pro (High)", identifier: "gemini-3.1-pro" },
    ]);
    db.close();
  });

  it("lists latest models for each provider on startup", () => {
    const db = new Database(":memory:");
    runMigrations(db);
    const repo = new ModelScrapeRepository(db);

    // Old scrape for codex
    const c1 = repo.recordRaw({
      provider: "codex",
      scrapedAt: "2026-08-18T08:00:00.000Z",
      rawOutput: "old codex",
    });
    repo.recordParsed(c1, [{ displayLabel: "gpt-5.4", identifier: "gpt-5.4" }]);

    // Newer scrape for codex
    const c2 = repo.recordRaw({
      provider: "codex",
      scrapedAt: "2026-08-18T11:00:00.000Z",
      rawOutput: "new codex",
    });
    repo.recordParsed(c2, [{ displayLabel: "gpt-5.6-sol", identifier: "gpt-5.6-sol" }]);

    // Scrape for claude
    const cl1 = repo.recordRaw({
      provider: "claude",
      scrapedAt: "2026-08-18T09:00:00.000Z",
      rawOutput: "claude screen",
    });
    repo.recordParsed(cl1, [
      { displayLabel: "Opus", identifier: "claude-opus-4-8" },
      { displayLabel: "Sonnet", identifier: "claude-sonnet-5" },
    ]);

    // Failed scrape for kimi (no parsed models)
    const k1 = repo.recordRaw({
      provider: "kimi",
      scrapedAt: "2026-08-18T10:00:00.000Z",
      rawOutput: "failed kimi",
    });
    repo.recordParseError(k1, "auth error");

    const latestMap = repo.listLatestForEachProvider();
    expect(latestMap.size).toBe(2);
    expect(latestMap.get("codex")).toEqual([
      { displayLabel: "gpt-5.6-sol", identifier: "gpt-5.6-sol" },
    ]);
    expect(latestMap.get("claude")).toEqual([
      { displayLabel: "Opus", identifier: "claude-opus-4-8" },
      { displayLabel: "Sonnet", identifier: "claude-sonnet-5" },
    ]);
    expect(latestMap.has("kimi")).toBe(false);

    db.close();
  });
});
