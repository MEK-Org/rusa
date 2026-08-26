import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { runMigrations } from "../migrations/runner.js";
import { QuotaScrapeRepository } from "./quota-scrape-repository.js";

describe("QuotaScrapeRepository", () => {
  it("keeps exact raw bytes separately from the normalized parse", () => {
    const db = new Database(":memory:");
    runMigrations(db);
    const repo = new QuotaScrapeRepository(db);
    const raw = "line one\r\n\u001b[32mquota\u001b[0m\n";
    const id = repo.recordRaw({
      provider: "codex",
      scrapedAt: "2026-07-23T10:00:00.000Z",
      rawOutput: raw,
    });

    repo.recordParsed(
      id,
      {
        provider: "codex",
        status: "available",
        raw,
        scrapedAt: "2026-07-23T10:00:00.000Z",
        limits: [],
      },
      {
        provider: "codex",
        status: "available",
        scrapedAt: "2026-07-23T10:00:00.000Z",
        limits: [],
        explanations: [],
      }
    );

    const [scrape] = repo.listSince("codex", "2026-07-23T00:00:00.000Z");
    expect(scrape.rawOutput).toBe(raw);
    expect(scrape.parsedState).toMatchObject({
      provider: "codex",
      status: "available",
      scrapedAt: "2026-07-23T10:00:00.000Z",
    });
    expect(scrape.parsedState?.raw).toBeUndefined();
    expect(scrape.inferredParsedState).toMatchObject({
      provider: "codex",
      status: "available",
      scrapedAt: "2026-07-23T10:00:00.000Z",
      explanations: [],
    });
    db.close();
  });

  it("retains the raw scrape when parsing fails", () => {
    const db = new Database(":memory:");
    runMigrations(db);
    const repo = new QuotaScrapeRepository(db);
    const id = repo.recordRaw({
      provider: "agy",
      scrapedAt: "2026-07-23T10:00:00.000Z",
      rawOutput: "unparseable tui",
    });
    repo.recordParseError(id, new Error("format drift"));

    const [scrape] = repo.listSince("agy", "2026-07-23T00:00:00.000Z");
    expect(scrape.rawOutput).toBe("unparseable tui");
    expect(scrape.parsedState).toBeNull();
    expect(scrape.parseError).toContain("format drift");
    db.close();
  });

  it("persists and retrieves explanations and limits on inferred snapshot", () => {
    const db = new Database(":memory:");
    runMigrations(db);
    const repo = new QuotaScrapeRepository(db);
    const raw = "raw status";
    const id = repo.recordRaw({
      provider: "codex",
      scrapedAt: "2026-08-22T10:00:00.000Z",
      rawOutput: raw,
    });

    const rawParsed = {
      provider: "codex",
      status: "available" as const,
      raw,
      scrapedAt: "2026-08-22T10:00:00.000Z",
      limits: [
        {
          label: "Weekly",
          kind: "weekly" as const,
          percentLeft: 93,
          resetAtIso: "2026-08-27T11:31:00.000Z",
        },
      ],
    };

    const inferredParsed = {
      provider: "codex",
      status: "available" as const,
      scrapedAt: "2026-08-22T10:00:00.000Z",
      limits: [
        {
          label: "Weekly",
          kind: "weekly" as const,
          percentLeft: 93,
          resetAtIso: "2026-08-27T11:31:00.000Z",
        },
      ],
      explanations: [
        {
          window: "Weekly",
          field: "resetAtIso",
          rule: "carried_forward_bad_read" as const,
          detail: "carried forward previous unexpired window assessment after bad read",
        },
      ],
    };

    repo.recordParsed(id, rawParsed, inferredParsed);

    const [scrape] = repo.listSince("codex", "2026-08-22T00:00:00.000Z");
    expect(scrape.inferredParsedState?.explanations).toHaveLength(1);
    expect(scrape.inferredParsedState?.explanations?.[0].rule).toBe("carried_forward_bad_read");
    expect(scrape.inferredParsedState?.limits?.[0].percentLeft).toBe(93);
    db.close();
  });
});
