import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { ModelEntry } from "../../providers/model-catalog.js";

export interface ModelScrape {
  id: string;
  provider: string;
  scrapedAt: string;
  rawOutput: string;
  parsedModels: ModelEntry[] | null;
  parseError: string | null;
}

export class ModelScrapeRepository {
  constructor(private readonly db: Database.Database) {}

  recordRaw(opts: { provider: string; scrapedAt: string; rawOutput: string }): string {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO model_scrapes (id, provider, scraped_at, raw_output)
         VALUES (?, ?, ?, ?)`
      )
      .run(id, opts.provider, opts.scrapedAt, opts.rawOutput);
    return id;
  }

  recordParsed(id: string, models: readonly ModelEntry[]): void {
    this.db
      .prepare("UPDATE model_scrapes SET parsed_models = ?, parse_error = NULL WHERE id = ?")
      .run(JSON.stringify(models), id);
  }

  recordParseError(id: string, error: unknown): void {
    this.db
      .prepare("UPDATE model_scrapes SET parse_error = ? WHERE id = ?")
      .run(error instanceof Error ? (error.stack ?? error.message) : String(error), id);
  }

  getLatestForProvider(provider: string): ModelScrape | null {
    const row = this.db
      .prepare(
        `SELECT id, provider, scraped_at, raw_output, parsed_models, parse_error
         FROM model_scrapes
         WHERE provider = ?
         ORDER BY scraped_at DESC, rowid DESC
         LIMIT 1`
      )
      .get(provider) as
      | {
          id: string;
          provider: string;
          scraped_at: string;
          raw_output: string;
          parsed_models: string | null;
          parse_error: string | null;
        }
      | undefined;

    if (!row) return null;
    return {
      id: row.id,
      provider: row.provider,
      scrapedAt: row.scraped_at,
      rawOutput: row.raw_output,
      parsedModels: row.parsed_models ? (JSON.parse(row.parsed_models) as ModelEntry[]) : null,
      parseError: row.parse_error,
    };
  }

  getLatestParsedForProvider(provider: string): ModelScrape | null {
    const row = this.db
      .prepare(
        `SELECT id, provider, scraped_at, raw_output, parsed_models, parse_error
         FROM model_scrapes
         WHERE provider = ? AND parsed_models IS NOT NULL
         ORDER BY scraped_at DESC, rowid DESC
         LIMIT 1`
      )
      .get(provider) as
      | {
          id: string;
          provider: string;
          scraped_at: string;
          raw_output: string;
          parsed_models: string | null;
          parse_error: string | null;
        }
      | undefined;

    if (!row) return null;
    return {
      id: row.id,
      provider: row.provider,
      scrapedAt: row.scraped_at,
      rawOutput: row.raw_output,
      parsedModels: row.parsed_models ? (JSON.parse(row.parsed_models) as ModelEntry[]) : null,
      parseError: row.parse_error,
    };
  }

  listLatestForEachProvider(): Map<string, ModelEntry[]> {
    const rows = this.db
      .prepare(
        `SELECT provider, parsed_models, scraped_at
         FROM model_scrapes
         WHERE parsed_models IS NOT NULL
         ORDER BY scraped_at DESC, rowid DESC`
      )
      .all() as Array<{
      provider: string;
      parsed_models: string;
      scraped_at: string;
    }>;

    const result = new Map<string, ModelEntry[]>();
    for (const row of rows) {
      if (!result.has(row.provider)) {
        try {
          const entries = JSON.parse(row.parsed_models) as ModelEntry[];
          if (Array.isArray(entries)) {
            result.set(row.provider, entries);
          }
        } catch {
          // Ignore invalid JSON rows
        }
      }
    }
    return result;
  }

  listSince(provider: string, sinceIso: string): ModelScrape[] {
    const rows = this.db
      .prepare(
        `SELECT id, provider, scraped_at, raw_output, parsed_models, parse_error
         FROM model_scrapes
         WHERE provider = ? AND scraped_at >= ?
         ORDER BY scraped_at ASC, rowid ASC`
      )
      .all(provider, sinceIso) as Array<{
      id: string;
      provider: string;
      scraped_at: string;
      raw_output: string;
      parsed_models: string | null;
      parse_error: string | null;
    }>;

    return rows.map((row) => ({
      id: row.id,
      provider: row.provider,
      scrapedAt: row.scraped_at,
      rawOutput: row.raw_output,
      parsedModels: row.parsed_models ? (JSON.parse(row.parsed_models) as ModelEntry[]) : null,
      parseError: row.parse_error,
    }));
  }
}
