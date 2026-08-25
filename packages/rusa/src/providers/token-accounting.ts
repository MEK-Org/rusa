import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";

export type TokenProvider = "claude" | "codex" | "kimi" | "agy";

/** Observability only. This must never be consulted by provider selection or dispatch. */
export interface RunTokenUsage {
  provider: TokenProvider;
  model: string | null;
  scrapedAt: string;
  uncachedInput: number | null;
  cacheRead: number | null;
  output: number | null;
  reasoning: number | null;
  response: number | null;
}

type Totals = Pick<
  RunTokenUsage,
  "uncachedInput" | "cacheRead" | "output" | "reasoning" | "response"
>;

const emptyTotals = (): Totals => ({
  uncachedInput: 0,
  cacheRead: 0,
  output: 0,
  reasoning: null,
  response: null,
});

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function add(totals: Totals, uncached: unknown, cached: unknown, output: unknown): boolean {
  const u = nonNegativeInteger(uncached);
  const c = nonNegativeInteger(cached);
  const o = nonNegativeInteger(output);
  if (u === null || c === null || o === null) return false;
  totals.uncachedInput = (totals.uncachedInput ?? 0) + u;
  totals.cacheRead = (totals.cacheRead ?? 0) + c;
  totals.output = (totals.output ?? 0) + o;
  return true;
}

export function extractClaudeTokenUsage(
  lines: string[]
): { totals: Totals; model: string | null } | null {
  const totals = emptyTotals();
  let model: string | null = null;
  let found = false;
  for (const line of lines) {
    try {
      const row = JSON.parse(line) as {
        type?: string;
        message?: {
          model?: unknown;
          usage?: {
            input_tokens?: unknown;
            cache_creation_input_tokens?: unknown;
            cache_read_input_tokens?: unknown;
            output_tokens?: unknown;
          };
        };
      };
      if (row.type !== "assistant" || !row.message?.usage) continue;
      const usage = row.message.usage;
      const input = nonNegativeInteger(usage.input_tokens);
      const creation = nonNegativeInteger(usage.cache_creation_input_tokens) ?? 0;
      // Cache creation is deliberately folded into uncached input: the common
      // three-category count shape has no cache-write column.
      if (
        input !== null &&
        add(totals, input + creation, usage.cache_read_input_tokens ?? 0, usage.output_tokens)
      ) {
        found = true;
        if (typeof row.message.model === "string") model = row.message.model;
      }
    } catch {
      // A transcript may contain a partially-written final line.
    }
  }
  return found ? { totals, model } : null;
}

function rowTimestamp(row: Record<string, unknown>): number | null {
  const candidates = [
    row.timestamp,
    row.ts,
    (row.message as Record<string, unknown> | undefined)?.timestamp,
  ];
  for (const value of candidates) {
    if (typeof value === "string") {
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed)) return parsed;
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return value < 10_000_000_000 ? value * 1000 : value;
    }
  }
  return null;
}

export function extractCodexTokenUsage(jsonl: string, runStartedAt: string): Totals | null {
  const start = Date.parse(runStartedAt);
  const totals = emptyTotals();
  let found = false;
  for (const line of jsonl.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as Record<string, unknown>;
      const timestamp = rowTimestamp(row);
      if (timestamp === null || timestamp < start) continue;
      const payload = row.payload as Record<string, unknown> | undefined;
      if (row.type !== "event_msg" || payload?.type !== "token_count") continue;
      const info = payload.info as Record<string, unknown> | undefined;
      const usage = info?.last_token_usage as Record<string, unknown> | undefined;
      if (!usage) continue;
      const input = nonNegativeInteger(usage.input_tokens);
      const cached = nonNegativeInteger(usage.cached_input_tokens);
      if (
        input !== null &&
        cached !== null &&
        input >= cached &&
        add(totals, input - cached, cached, usage.output_tokens)
      ) {
        found = true;
      }
    } catch {
      // Ignore malformed/partial records.
    }
  }
  return found ? totals : null;
}

export function extractKimiTokenUsage(jsonl: string, runStartedAt: string): Totals | null {
  const start = Date.parse(runStartedAt);
  const totals = emptyTotals();
  let found = false;
  for (const line of jsonl.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as Record<string, unknown>;
      const timestamp = rowTimestamp(row);
      if (timestamp === null || timestamp < start) continue;
      const message = row.message as Record<string, unknown> | undefined;
      const payload = message?.payload as Record<string, unknown> | undefined;
      const usage = payload?.token_usage as Record<string, unknown> | undefined;
      if (!usage) continue;
      const other = nonNegativeInteger(usage.input_other);
      const creation = nonNegativeInteger(usage.input_cache_creation);
      if (
        other !== null &&
        creation !== null &&
        add(totals, other + creation, usage.input_cache_read, usage.output)
      ) {
        found = true;
      }
    } catch {
      // Ignore malformed/partial records.
    }
  }
  return found ? totals : null;
}

function findFile(root: string, predicate: (path: string) => boolean): string | undefined {
  let newest: { path: string; mtimeMs: number } | undefined;
  const walk = (dir: string): void => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const path = join(dir, name);
      try {
        const stat = statSync(path);
        if (stat.isDirectory()) walk(path);
        else if (predicate(path) && (!newest || stat.mtimeMs > newest.mtimeMs)) {
          newest = { path, mtimeMs: stat.mtimeMs };
        }
      } catch {
        // Racy session-store changes degrade to unattributed accounting.
      }
    }
  };
  walk(root);
  return newest?.path;
}

export function extractCodexTokenUsageFromStore(
  sessionsDir: string,
  sessionId: string,
  runStartedAt: string
): Totals | null {
  const path = findFile(
    sessionsDir,
    (candidate) => candidate.endsWith(".jsonl") && candidate.includes(sessionId)
  );
  if (!path) return null;
  try {
    return extractCodexTokenUsage(readFileSync(path, "utf8"), runStartedAt);
  } catch {
    return null;
  }
}

export function extractKimiTokenUsageFromStore(
  storeDir: string,
  sessionId: string,
  runStartedAt: string
): Totals | null {
  const path = findFile(
    join(storeDir, "sessions"),
    (candidate) => candidate.endsWith("wire.jsonl") && candidate.includes(sessionId)
  );
  if (!path) return null;
  try {
    return extractKimiTokenUsage(readFileSync(path, "utf8"), runStartedAt);
  } catch {
    return null;
  }
}

type ProtoField = { number: number; wire: number; value: number | Buffer };

function fields(buffer: Buffer): ProtoField[] {
  const result: ProtoField[] = [];
  let offset = 0;
  const varint = (): number | null => {
    let value = 0;
    let shift = 0;
    while (offset < buffer.length && shift < 53) {
      const byte = buffer[offset++];
      value += (byte & 0x7f) * 2 ** shift;
      if ((byte & 0x80) === 0) return value;
      shift += 7;
    }
    return null;
  };
  while (offset < buffer.length) {
    const key = varint();
    if (key === null) break;
    const number = Math.floor(key / 8);
    const wire = key & 7;
    if (wire === 0) {
      const value = varint();
      if (value === null) break;
      result.push({ number, wire, value });
    } else if (wire === 2) {
      const length = varint();
      if (length === null || offset + length > buffer.length) break;
      result.push({ number, wire, value: buffer.subarray(offset, offset + length) });
      offset += length;
    } else if (wire === 1) offset += 8;
    else if (wire === 5) offset += 4;
    else break;
  }
  return result;
}

function protoValues(buffer: Buffer, path: number[]): Array<number | Buffer> {
  let current: Array<number | Buffer> = [buffer];
  for (const number of path) {
    current = current.flatMap((value) =>
      Buffer.isBuffer(value)
        ? fields(value)
            .filter((field) => field.number === number)
            .map((field) => field.value)
        : []
    );
  }
  return current;
}

export function extractAgyTokenUsage(
  rows: Buffer[]
): { totals: Totals; model: string | null } | null {
  const totals = emptyTotals();
  totals.reasoning = 0;
  totals.response = 0;
  let model: string | null = null;
  let found = false;
  for (const row of rows) {
    const uncached = protoValues(row, [1, 4, 2])[0];
    const cached = protoValues(row, [1, 4, 5])[0];
    const output = protoValues(row, [1, 4, 3])[0];
    const reasoning = protoValues(row, [1, 4, 9])[0];
    const response = protoValues(row, [1, 4, 10])[0];
    if (
      typeof uncached === "number" &&
      typeof cached === "number" &&
      typeof output === "number" &&
      typeof reasoning === "number" &&
      typeof response === "number" &&
      reasoning + response === output &&
      add(totals, uncached, cached, output)
    ) {
      totals.reasoning = (totals.reasoning ?? 0) + reasoning;
      totals.response = (totals.response ?? 0) + response;
      found = true;
    }
    const encodedModel = protoValues(row, [1, 21])[0];
    if (Buffer.isBuffer(encodedModel)) model = encodedModel.toString("utf8");
  }
  return found ? { totals, model } : null;
}

export function agyGenerationCursor(dbPath: string): number | undefined {
  try {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      return (
        (db.prepare("SELECT max(idx) AS idx FROM gen_metadata").get() as { idx: number | null })
          .idx ?? -1
      );
    } finally {
      db.close();
    }
  } catch {
    return undefined;
  }
}

export function extractAgyTokenUsageFromDb(
  dbPath: string,
  afterIdx: number
): { totals: Totals; model: string | null } | null {
  try {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      const rows = db
        .prepare("SELECT data FROM gen_metadata WHERE idx > ? ORDER BY idx")
        .all(afterIdx) as Array<{ data: Buffer }>;
      return extractAgyTokenUsage(rows.map((row) => row.data));
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

export function unattributedTokenUsage(
  provider: TokenProvider,
  model: string | null
): RunTokenUsage {
  return {
    provider,
    model,
    scrapedAt: new Date().toISOString(),
    uncachedInput: null,
    cacheRead: null,
    output: null,
    reasoning: null,
    response: null,
  };
}

export function attributedTokenUsage(
  provider: TokenProvider,
  model: string | null,
  totals: Totals
): RunTokenUsage {
  return { provider, model, scrapedAt: new Date().toISOString(), ...totals };
}
