import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { LoadOpsResp, PersistenceService } from "@thkp-eng/goals-core";
import type { AnyOp } from "@thkp-eng/goals-types";

/**
 * The local-first persistence mode. A drop-in PersistenceService that a normal SyncClient sits on:
 *
 *  - Baseline: a one-time cached start point.
 *  - Writes: every save(ops) appends to a local ops-log file (durable).
 *  - Reads: load/subscribeJSON serve baseline + ops-log, HLC-ordered, restart-safe.
 */
export class LocalFilePersistenceService implements PersistenceService {
  private baselineReady = false;
  private ensuring: Promise<boolean> | null = null;

  constructor(
    private readonly baselinePath: string,
    private readonly opsLogPath: string,
    private readonly seedBaseline: () => Promise<AnyOp[]>
  ) {}

  async ensureBaseline(): Promise<boolean> {
    if (this.baselineReady || existsSync(this.baselinePath)) {
      this.baselineReady = true;
      return true;
    }
    if (!this.ensuring) {
      this.ensuring = (async () => {
        const ops = await this.seedBaseline();
        writeJsonl(this.baselinePath, ops);
        this.baselineReady = true;
        return true;
      })().finally(() => {
        this.ensuring = null;
      });
    }
    return this.ensuring;
  }

  async save(ops: Iterable<AnyOp>): Promise<void> {
    const arr = [...ops];
    if (arr.length === 0) return;
    appendJsonl(this.opsLogPath, arr);
  }

  unsyncedCount(): number {
    return 0;
  }

  async load(options: { cursor?: string | null; limit?: number }): Promise<LoadOpsResp> {
    const after = afterCursor(this.readAll(), options.cursor ?? null);
    const sliced = options.limit ? after.slice(0, options.limit) : after;
    const cursor = sliced.length ? lastHlc(sliced) : (options.cursor ?? null);
    return { ops: sliced, cursor };
  }

  subscribeJSON(
    cursor: string | null,
    callback: (ops: AnyOp[], cursor: string) => void
  ): () => void {
    const ops = afterCursor(this.readAll(), cursor);
    if (ops.length > 0) callback(ops, lastHlc(ops));
    return () => {};
  }

  async loadString(): Promise<string | null> {
    return null;
  }

  async count(options: { cursor?: string | null }): Promise<number> {
    return afterCursor(this.readAll(), options.cursor ?? null).length;
  }

  readAll(): AnyOp[] {
    const merged = [...readJsonl(this.baselinePath), ...readJsonl(this.opsLogPath)];
    return merged.sort((a, b) => a.hlcTimestamp.localeCompare(b.hlcTimestamp));
  }
}

function afterCursor(ops: AnyOp[], cursor: string | null): AnyOp[] {
  return cursor ? ops.filter((o) => o.hlcTimestamp > cursor) : ops;
}

function lastHlc(ops: AnyOp[]): string {
  return ops[ops.length - 1].hlcTimestamp;
}

function readJsonl(path: string): AnyOp[] {
  if (!existsSync(path)) return [];
  const ops: AnyOp[] = [];
  const lines = readFileSync(path, "utf-8").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    try {
      ops.push(JSON.parse(line) as AnyOp);
    } catch {
      console.warn(`[iu] skipping unparseable op line ${i + 1} in ${path}`);
    }
  }
  return ops;
}

function writeJsonl(path: string, ops: AnyOp[]): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, ops.length ? `${ops.map((o) => JSON.stringify(o)).join("\n")}\n` : "");
}

function appendJsonl(path: string, ops: AnyOp[]): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${ops.map((o) => JSON.stringify(o)).join("\n")}\n`);
}
