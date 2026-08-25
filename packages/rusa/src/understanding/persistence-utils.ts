import { join } from "node:path";
import { type Goal, MemoryLocalStore, SyncClient } from "@thkp-eng/goals-core";
import type { AnyOp, DocumentContentsLogEntry } from "@thkp-eng/goals-types";
import { resolveHome } from "../config/secrets.js";
import type { RusaConfig } from "../config/types.js";
import { buildSeedOps } from "./iu-seed.js";
import { LocalFilePersistenceService } from "./local-file-persistence.js";
import { resolveUnderstandingRootNodeId } from "./root-scope.js";
import { SqliteLocalStore } from "./sqlite-local-store.js";

export async function getUnderstandingSyncClient(
  config: RusaConfig,
  mcHome?: string
): Promise<SyncClient> {
  const resolvedHome = mcHome ?? resolveHome();
  const { baselinePath, opsLogPath } = iuDistillerPaths(resolvedHome);
  const svc = new LocalFilePersistenceService(baselinePath, opsLogPath, async () =>
    buildSeedOps(resolveUnderstandingRootNodeId(config))
  );
  await svc.ensureBaseline();
  const client = new SyncClient(svc, new SqliteLocalStore());
  await client.init();
  return client;
}

export async function resolveInitialBaseline(config: RusaConfig): Promise<AnyOp[]> {
  return buildSeedOps(resolveUnderstandingRootNodeId(config));
}

export async function getLocalUnderstandingWriteClient(
  config: RusaConfig,
  mcHome: string
): Promise<SyncClient> {
  const { baselinePath, opsLogPath } = iuDistillerPaths(mcHome);
  const svc = new LocalFilePersistenceService(baselinePath, opsLogPath, async () =>
    buildSeedOps(resolveUnderstandingRootNodeId(config))
  );
  await svc.ensureBaseline();
  const store = new MemoryLocalStore();
  await store.storeSyncedOps(svc.readAll());
  const client = new SyncClient(svc, store);
  await client.init();
  return client;
}

export function iuDistillerPaths(mcHome: string): { baselinePath: string; opsLogPath: string } {
  const dir = join(mcHome, "iu-distiller");
  return { baselinePath: join(dir, "baseline.jsonl"), opsLogPath: join(dir, "ops.jsonl") };
}

export function iuReportPaths(mcHome: string): {
  reportsDir: string;
  journalDir: string;
  renderedDir: string;
  indexPath: string;
  journalPath: (date: string) => string;
  renderedPath: (date: string) => string;
} {
  const reportsDir = join(mcHome, "iu-distiller", "reports");
  const journalDir = join(reportsDir, "journal");
  const renderedDir = join(reportsDir, "rendered");
  return {
    reportsDir,
    journalDir,
    renderedDir,
    indexPath: join(reportsDir, "index.json"),
    journalPath: (date: string) => join(journalDir, `${date}.jsonl`),
    renderedPath: (date: string) => join(renderedDir, `${date}.md`),
  };
}

export function createUnderstandingOpsReader(mcHome: string): {
  load: (opts: {
    cursor?: string | null;
    limit?: number;
  }) => Promise<{ ops: AnyOp[]; cursor: string | null }>;
} {
  const { baselinePath, opsLogPath } = iuDistillerPaths(mcHome);
  const svc = new LocalFilePersistenceService(baselinePath, opsLogPath, async () => []);
  return { load: (opts) => svc.load(opts) };
}

export function getLocalUnderstandingUnsyncedCount(_mcHome: string): number {
  return 0; // Local mode means everything is inherently "synced" locally
}

export function createUnderstandingStringsResolver(_config: RusaConfig): {
  loadStrings: (ids: string[]) => Promise<Record<string, string>>;
} {
  return {
    loadStrings: async () => ({}),
  };
}

export async function hydrateExternalizedBodies(
  client: SyncClient,
  loadStrings: (ids: string[]) => Promise<Record<string, string>>
): Promise<void> {
  const pending: { entry: DocumentContentsLogEntry; entryId: string }[] = [];
  for (const goal of (client.getGoals() as Map<string, Goal>).values()) {
    const entry = goal.log.find(
      (e): e is DocumentContentsLogEntry => e.type === "documentContents"
    );
    if (entry && !entry.text && typeof entry.id === "string") {
      pending.push({ entry, entryId: entry.id });
    }
  }
  if (pending.length === 0) return;
  const strings = await loadStrings(pending.map((p) => p.entryId));
  for (const { entry, entryId } of pending) {
    const s = strings[entryId];
    if (s) (entry as { text?: string }).text = s;
  }
}
