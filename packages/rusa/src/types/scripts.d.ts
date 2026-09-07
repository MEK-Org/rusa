declare module "*backfill-codex-quota-parses.mjs" {
  import type Database from "better-sqlite3";
  export function applyBackfill(
    writable: Database.Database,
    replacements: {
      id: string;
      scrapedAt: string;
      parsedState: string | null;
      parseError: string | null;
      serialized: string;
    }[],
    since?: Date | string,
    through?: Date | string
  ): void;
}

declare module "*replay-codex-quota-observations.mjs" {
  export const OBSERVATION_COLUMNS: readonly string[];
  export function snapshotMetadata(
    databasePath: string,
    since: string
  ): {
    scrapes: unknown[];
    observations: unknown[];
    totalCodexScrapes: number;
    totalCodexObservations: number;
    latestScrapeAt: string | null;
    latestObservationAt: string | null;
  };
  export function applyReplay(
    databasePath: string,
    since: string,
    snapshot: {
      scrapes?: unknown[];
      observations?: unknown[];
      totalCodexScrapes: number;
      totalCodexObservations: number;
      latestScrapeAt: string | null;
      latestObservationAt: string | null;
    },
    rebuilt: unknown[]
  ): void;
}
