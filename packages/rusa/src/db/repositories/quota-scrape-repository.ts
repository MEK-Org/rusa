import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { ProviderQuotaSnapshot } from "../../mcp/quota-mcp.js";

export interface QuotaScrape {
  id: string;
  provider: string;
  scrapedAt: string;
  rawOutput: string;
  parsedState: ProviderQuotaSnapshot | null;
  inferredParsedState: ProviderQuotaSnapshot | null;
  parseError: string | null;
}

export class QuotaScrapeRepository {
  constructor(private readonly db: Database.Database) {}

  recordRaw(opts: { provider: string; scrapedAt: string; rawOutput: string }): string {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO quota_scrapes (id, provider, scraped_at, raw_output)
         VALUES (?, ?, ?, ?)`
      )
      .run(id, opts.provider, opts.scrapedAt, opts.rawOutput);
    return id;
  }

  recordParsed(
    id: string,
    rawParsed: ProviderQuotaSnapshot,
    inferredParsed: ProviderQuotaSnapshot
  ): void {
    // raw_output is the byte-for-byte source of truth. Avoid storing a second,
    // JSON-escaped copy inside the normalized parse.
    const { raw: _raw1, ...rawState } = rawParsed;
    const { raw: _raw2, ...inferredState } = inferredParsed;
    this.db
      .prepare(
        "UPDATE quota_scrapes SET parsed_state = ?, inferred_parsed_state = ?, parse_error = NULL WHERE id = ?"
      )
      .run(JSON.stringify(rawState), JSON.stringify(inferredState), id);
  }

  recordParseError(id: string, error: unknown): void {
    this.db
      .prepare("UPDATE quota_scrapes SET parse_error = ? WHERE id = ?")
      .run(error instanceof Error ? (error.stack ?? error.message) : String(error), id);
  }

  listSince(provider: string, sinceIso: string): QuotaScrape[] {
    const rows = this.db
      .prepare(
        `SELECT id, provider, scraped_at, raw_output, parsed_state, inferred_parsed_state, parse_error
         FROM quota_scrapes
         WHERE provider = ? AND scraped_at >= ?
         ORDER BY scraped_at ASC, rowid ASC`
      )
      .all(provider, sinceIso) as Array<{
      id: string;
      provider: string;
      scraped_at: string;
      raw_output: string;
      parsed_state: string | null;
      inferred_parsed_state: string | null;
      parse_error: string | null;
    }>;
    return rows.map((row) => ({
      id: row.id,
      provider: row.provider,
      scrapedAt: row.scraped_at,
      rawOutput: row.raw_output,
      parsedState: row.parsed_state
        ? (JSON.parse(row.parsed_state) as ProviderQuotaSnapshot)
        : null,
      inferredParsedState: row.inferred_parsed_state
        ? (JSON.parse(row.inferred_parsed_state) as ProviderQuotaSnapshot)
        : null,
      parseError: row.parse_error,
    }));
  }
}
