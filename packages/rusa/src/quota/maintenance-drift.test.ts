import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { applyBackfill } from "../../scripts/backfill-codex-quota-parses.mjs";
import {
  applyReplay,
  OBSERVATION_COLUMNS,
  snapshotMetadata,
} from "../../scripts/replay-codex-quota-observations.mjs";
import { SharedQuotaStore } from "./shared-store.js";

interface ScrapeRecord {
  id: string;
  provider: string;
  scraped_at: string;
  raw_output: string;
  parsed_state: string | null;
  parse_error: string | null;
}

interface ObservationRecord {
  provider: string;
  kind: string;
  observed_slot: number;
  label: string;
  observed_at: string;
  percent_left: number;
  reset_at_iso: string | null;
  window_ms: number;
  processed: number;
  controller_error: number | null;
  controller_derivative: number | null;
  controller_integral: number | null;
  uncapped_interval_seconds: number | null;
  interval_seconds: number | null;
}

interface CountRecord {
  count: number;
}

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function createTempDb(): { root: string; dbPath: string; store: SharedQuotaStore } {
  const root = mkdtempSync(join(tmpdir(), "rusa-maintenance-drift-"));
  roots.push(root);
  const dbPath = join(root, "quota.db");
  const store = new SharedQuotaStore(dbPath);
  return { root, dbPath, store };
}

describe("Quota maintenance drift guards", () => {
  describe("backfill:codex-quota drift detection", () => {
    it("aborts the entire batch and preserves concurrent parsed_state correction on drift", () => {
      const { dbPath, store } = createTempDb();

      // Insert two Codex scrapes and one unrelated Claude scrape
      const id1 = store.recordRaw({
        provider: "codex",
        scrapedAt: "2026-09-07T10:00:00.000Z",
        rawOutput: "raw-codex-1",
      });
      const id2 = store.recordRaw({
        provider: "codex",
        scrapedAt: "2026-09-07T10:05:00.000Z",
        rawOutput: "raw-codex-2",
      });
      const claudeId = store.recordRaw({
        provider: "claude",
        scrapedAt: "2026-09-07T10:05:00.000Z",
        rawOutput: "raw-claude",
      });

      // Set initial parsed state
      const initialParsedState1 = JSON.stringify({
        status: "available",
        limits: [{ label: "Weekly", kind: "weekly", scope: "provider", percentLeft: 80 }],
      });
      const initialParsedState2 = JSON.stringify({
        status: "available",
        limits: [{ label: "Weekly", kind: "weekly", scope: "provider", percentLeft: 70 }],
      });
      const initialClaudeState = JSON.stringify({
        status: "available",
        limits: [{ label: "session", kind: "session", scope: "provider", percentLeft: 95 }],
      });

      store.db
        .prepare("UPDATE quota_scrapes SET parsed_state = ?, parse_error = NULL WHERE id = ?")
        .run(initialParsedState1, id1);
      store.db
        .prepare("UPDATE quota_scrapes SET parsed_state = ?, parse_error = NULL WHERE id = ?")
        .run(initialParsedState2, id2);
      store.db
        .prepare("UPDATE quota_scrapes SET parsed_state = ?, parse_error = NULL WHERE id = ?")
        .run(initialClaudeState, claudeId);

      // Backfill parse read phase: reads id1 and id2 with their original parsed_state and parse_error
      const replacements = [
        {
          id: id1,
          scrapedAt: "2026-09-07T10:00:00.000Z",
          parsedState: initialParsedState1,
          parseError: null,
          serialized: JSON.stringify({
            status: "available",
            limits: [{ label: "Weekly", kind: "weekly", scope: "provider", percentLeft: 85 }],
          }),
        },
        {
          id: id2,
          scrapedAt: "2026-09-07T10:05:00.000Z",
          parsedState: initialParsedState2,
          parseError: null,
          serialized: JSON.stringify({
            status: "available",
            limits: [{ label: "Weekly", kind: "weekly", scope: "provider", percentLeft: 75 }],
          }),
        },
      ];

      // Concurrent race: intervening process mutates parsed_state for id2 without changing count or timestamp
      const concurrentCorrectedState = JSON.stringify({
        status: "exhausted",
        limits: [{ label: "Weekly", kind: "weekly", scope: "provider", percentLeft: 0 }],
        concurrentCorrection: true,
      });
      store.db
        .prepare("UPDATE quota_scrapes SET parsed_state = ? WHERE id = ?")
        .run(concurrentCorrectedState, id2);

      // Attempt to apply backfill
      const db = new Database(dbPath, { fileMustExist: true });
      try {
        expect(() => {
          applyBackfill(
            db,
            replacements,
            new Date("2026-09-07T09:00:00.000Z"),
            new Date("2026-09-07T11:00:00.000Z")
          );
        }).toThrow(/changed during the backfill/);

        // Assert full batch rollback: id1 was NOT updated to replacement
        const row1 = db
          .prepare("SELECT * FROM quota_scrapes WHERE id = ?")
          .get(id1) as ScrapeRecord;
        expect(row1.parsed_state).toBe(initialParsedState1);

        // Assert byte/value preservation of concurrent correction on id2
        const row2 = db
          .prepare("SELECT * FROM quota_scrapes WHERE id = ?")
          .get(id2) as ScrapeRecord;
        expect(row2.parsed_state).toBe(concurrentCorrectedState);

        // Assert raw scrape evidence and unrelated provider are intact
        expect(row1.raw_output).toBe("raw-codex-1");
        expect(row2.raw_output).toBe("raw-codex-2");
        const claudeRow = db
          .prepare("SELECT * FROM quota_scrapes WHERE id = ?")
          .get(claudeId) as ScrapeRecord;
        expect(claudeRow.parsed_state).toBe(initialClaudeState);
        expect(claudeRow.raw_output).toBe("raw-claude");
      } finally {
        db.close();
        store.close();
      }
    });

    it("aborts the entire batch and preserves concurrent parse_error correction on drift", () => {
      const { dbPath, store } = createTempDb();

      const id1 = store.recordRaw({
        provider: "codex",
        scrapedAt: "2026-09-07T10:00:00.000Z",
        rawOutput: "raw-codex-1",
      });
      const id2 = store.recordRaw({
        provider: "codex",
        scrapedAt: "2026-09-07T10:05:00.000Z",
        rawOutput: "raw-codex-2",
      });

      const initialParsedState1 = null;
      const initialParseError1 = "LLM quota parsing failed: timeout";
      const initialParsedState2 = JSON.stringify({
        status: "available",
        limits: [{ label: "Weekly", kind: "weekly", scope: "provider", percentLeft: 60 }],
      });

      store.db
        .prepare("UPDATE quota_scrapes SET parsed_state = ?, parse_error = ? WHERE id = ?")
        .run(initialParsedState1, initialParseError1, id1);
      store.db
        .prepare("UPDATE quota_scrapes SET parsed_state = ?, parse_error = NULL WHERE id = ?")
        .run(initialParsedState2, id2);

      const replacements = [
        {
          id: id1,
          scrapedAt: "2026-09-07T10:00:00.000Z",
          parsedState: initialParsedState1,
          parseError: initialParseError1,
          serialized: JSON.stringify({
            status: "available",
            limits: [{ label: "Weekly", kind: "weekly", scope: "provider", percentLeft: 90 }],
          }),
        },
        {
          id: id2,
          scrapedAt: "2026-09-07T10:05:00.000Z",
          parsedState: initialParsedState2,
          parseError: null,
          serialized: JSON.stringify({
            status: "available",
            limits: [{ label: "Weekly", kind: "weekly", scope: "provider", percentLeft: 65 }],
          }),
        },
      ];

      // Concurrent race: intervening process corrected parse_error to another value
      const concurrentParseError = "Manual review pending";
      store.db
        .prepare("UPDATE quota_scrapes SET parse_error = ? WHERE id = ?")
        .run(concurrentParseError, id1);

      const db = new Database(dbPath, { fileMustExist: true });
      try {
        expect(() => {
          applyBackfill(
            db,
            replacements,
            new Date("2026-09-07T09:00:00.000Z"),
            new Date("2026-09-07T11:00:00.000Z")
          );
        }).toThrow(/changed during the backfill/);

        // Check full batch rollback and value preservation
        const row1 = db
          .prepare("SELECT * FROM quota_scrapes WHERE id = ?")
          .get(id1) as ScrapeRecord;
        expect(row1.parse_error).toBe(concurrentParseError);
        expect(row1.parsed_state).toBeNull();

        const row2 = db
          .prepare("SELECT * FROM quota_scrapes WHERE id = ?")
          .get(id2) as ScrapeRecord;
        expect(row2.parsed_state).toBe(initialParsedState2);
      } finally {
        db.close();
        store.close();
      }
    });

    it("applies atomically when no drift occurs (no-drift apply and idempotency)", () => {
      const { dbPath, store } = createTempDb();

      const id1 = store.recordRaw({
        provider: "codex",
        scrapedAt: "2026-09-07T10:00:00.000Z",
        rawOutput: "raw-codex-1",
      });
      const initialParsedState1 = JSON.stringify({
        status: "available",
        limits: [{ label: "Weekly", kind: "weekly", scope: "provider", percentLeft: 50 }],
      });
      store.db
        .prepare("UPDATE quota_scrapes SET parsed_state = ?, parse_error = NULL WHERE id = ?")
        .run(initialParsedState1, id1);

      const replacementState = JSON.stringify({
        status: "available",
        limits: [{ label: "Weekly", kind: "weekly", scope: "provider", percentLeft: 55 }],
      });
      const replacements = [
        {
          id: id1,
          scrapedAt: "2026-09-07T10:00:00.000Z",
          parsedState: initialParsedState1,
          parseError: null,
          serialized: replacementState,
        },
      ];

      const db = new Database(dbPath, { fileMustExist: true });
      try {
        // Normal apply succeeds
        applyBackfill(
          db,
          replacements,
          new Date("2026-09-07T09:00:00.000Z"),
          new Date("2026-09-07T11:00:00.000Z")
        );
        const row1 = db
          .prepare("SELECT * FROM quota_scrapes WHERE id = ?")
          .get(id1) as ScrapeRecord;
        expect(row1.parsed_state).toBe(replacementState);
        expect(row1.parse_error).toBeNull();
      } finally {
        db.close();
        store.close();
      }
    });
  });

  describe("replay:codex-observations drift detection", () => {
    it("aborts before deletion when in-place scrape correction (source drift) occurs", () => {
      const { dbPath, store } = createTempDb();

      const since = "2026-09-07T10:00:00.000Z";

      // Setup Codex scrapes and observations
      const scrapeId1 = store.recordRaw({
        provider: "codex",
        scrapedAt: "2026-09-07T10:00:00.000Z",
        rawOutput: "codex-1",
      });
      const scrapeId2 = store.recordRaw({
        provider: "codex",
        scrapedAt: "2026-09-07T10:05:00.000Z",
        rawOutput: "codex-2",
      });
      // Claude scrape (unrelated provider)
      store.recordRaw({
        provider: "claude",
        scrapedAt: "2026-09-07T10:05:00.000Z",
        rawOutput: "claude-1",
      });

      const parsedState1 = {
        provider: "codex",
        status: "available" as const,
        scrapedAt: "2026-09-07T10:00:00.000Z",
        limits: [
          {
            label: "Weekly",
            kind: "weekly" as const,
            scope: "provider" as const,
            percentLeft: 80,
            resetAtIso: "2026-09-14T00:00:00.000Z",
          },
        ],
      };
      const parsedState2 = {
        provider: "codex",
        status: "available" as const,
        scrapedAt: "2026-09-07T10:05:00.000Z",
        limits: [
          {
            label: "Weekly",
            kind: "weekly" as const,
            scope: "provider" as const,
            percentLeft: 79,
            resetAtIso: "2026-09-14T00:00:00.000Z",
          },
        ],
      };
      store.recordParsed(scrapeId1, parsedState1, parsedState1);
      store.recordParsed(scrapeId2, parsedState2, parsedState2);

      // Record Claude observation
      store.db
        .prepare(`
        INSERT INTO quota_observations (${OBSERVATION_COLUMNS.join(", ")})
        VALUES ('claude', 'weekly', 100, 'Claude Weekly', '2026-09-07T10:05:00.000Z', 90, '2026-09-14T00:00:00.000Z', 604800000, 1, 0, 0, 0, 300, 300)
      `)
        .run();

      // Snapshot metadata before replay
      const snapshot = snapshotMetadata(dbPath, since);
      expect(snapshot.scrapes.length).toBe(2);
      expect(snapshot.observations.length).toBe(2);

      // Rebuilt candidate observations
      const rebuilt = (snapshot.observations as ObservationRecord[]).map((obs) => ({
        ...obs,
        percent_left: obs.percent_left - 1,
      }));

      // Concurrent race: in-place scrape correction changes parsed_state of scrapeId1
      // row count and max timestamp stay identical!
      const correctedScrapeState = JSON.stringify({
        ...parsedState1,
        status: "exhausted",
        limits: [{ ...parsedState1.limits[0], percentLeft: 0 }],
      });
      store.db
        .prepare("UPDATE quota_scrapes SET parsed_state = ? WHERE id = ?")
        .run(correctedScrapeState, scrapeId1);

      try {
        // Attempt applyReplay - must abort before deletion
        expect(() => {
          applyReplay(dbPath, since, snapshot, rebuilt);
        }).toThrow(/changed during replay/);

        // Assert no observations were deleted or replaced
        const obsCount = (
          store.db
            .prepare("SELECT COUNT(*) AS count FROM quota_observations WHERE provider = 'codex'")
            .get() as CountRecord
        ).count;
        expect(obsCount).toBe(2);

        // Assert concurrent scrape correction is preserved
        const scrapeRow = store.db
          .prepare("SELECT parsed_state FROM quota_scrapes WHERE id = ?")
          .get(scrapeId1) as ScrapeRecord;
        expect(scrapeRow.parsed_state).toBe(correctedScrapeState);

        // Assert unrelated provider is intact
        const claudeCount = (
          store.db
            .prepare("SELECT COUNT(*) AS count FROM quota_observations WHERE provider = 'claude'")
            .get() as CountRecord
        ).count;
        expect(claudeCount).toBe(1);
      } finally {
        store.close();
      }
    });

    it("aborts before deletion when concurrent replay with different controller values (target drift) occurs", () => {
      const { dbPath, store } = createTempDb();

      const since = "2026-09-07T10:00:00.000Z";

      const scrapeId1 = store.recordRaw({
        provider: "codex",
        scrapedAt: "2026-09-07T10:00:00.000Z",
        rawOutput: "codex-1",
      });
      const parsedState1 = {
        provider: "codex",
        status: "available" as const,
        scrapedAt: "2026-09-07T10:00:00.000Z",
        limits: [
          {
            label: "Weekly",
            kind: "weekly" as const,
            scope: "provider" as const,
            percentLeft: 80,
            resetAtIso: "2026-09-14T00:00:00.000Z",
          },
        ],
      };
      store.recordParsed(scrapeId1, parsedState1, parsedState1);

      // Snapshot metadata before replay
      const snapshot = snapshotMetadata(dbPath, since);
      expect(snapshot.observations.length).toBe(1);

      const rebuilt = (snapshot.observations as ObservationRecord[]).map((obs) => ({
        ...obs,
        percent_left: 75,
      }));

      // Concurrent race: another replay or process modified controller values in-place
      // row counts and max timestamps stay exactly the same!
      store.db
        .prepare(
          "UPDATE quota_observations SET controller_error = 999.0, interval_seconds = 1234 WHERE provider = 'codex'"
        )
        .run();

      try {
        // Attempt applyReplay - must abort before deletion
        expect(() => {
          applyReplay(dbPath, since, snapshot, rebuilt);
        }).toThrow(/changed during replay/);

        // Assert controller values were preserved and not overwritten by rebuilt
        const obs = store.db
          .prepare("SELECT * FROM quota_observations WHERE provider = 'codex'")
          .get() as ObservationRecord;
        expect(obs.controller_error).toBe(999.0);
        expect(obs.interval_seconds).toBe(1234);
        expect(obs.percent_left).toBe(80); // Not changed to rebuilt's 75!
      } finally {
        store.close();
      }
    });

    it("replaces observations when no drift occurs (no-drift apply)", () => {
      const { dbPath, store } = createTempDb();

      const since = "2026-09-07T10:00:00.000Z";

      const scrapeId1 = store.recordRaw({
        provider: "codex",
        scrapedAt: "2026-09-07T10:00:00.000Z",
        rawOutput: "codex-1",
      });
      const parsedState1 = {
        provider: "codex",
        status: "available" as const,
        scrapedAt: "2026-09-07T10:00:00.000Z",
        limits: [
          {
            label: "Weekly",
            kind: "weekly" as const,
            scope: "provider" as const,
            percentLeft: 80,
            resetAtIso: "2026-09-14T00:00:00.000Z",
          },
        ],
      };
      store.recordParsed(scrapeId1, parsedState1, parsedState1);

      const snapshot = snapshotMetadata(dbPath, since);
      const rebuilt = (snapshot.observations as ObservationRecord[]).map((obs) => ({
        ...obs,
        percent_left: 77,
        processed: 1,
      }));

      try {
        // Apply succeeds with no drift
        applyReplay(dbPath, since, snapshot, rebuilt);

        const obs = store.db
          .prepare("SELECT * FROM quota_observations WHERE provider = 'codex'")
          .get() as ObservationRecord;
        expect(obs.percent_left).toBe(77);
      } finally {
        store.close();
      }
    });
  });
});
