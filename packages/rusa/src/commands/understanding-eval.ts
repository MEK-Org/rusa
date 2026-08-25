import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { MemoryLocalStore, SyncClient } from "@thkp-eng/goals-core";
import type { AnyOp, DocumentContentsLogEntry } from "@thkp-eng/goals-types";
import openBrowser from "open";
import { loadConfig, resolveHome } from "../config/index.js";
import { closeDb, getDb, initDb } from "../db/index.js";
import { runDistillation } from "../understanding/distill.js";
import { getUnderstandingSyncClient } from "../understanding/persistence-utils.js";
import { type RetrievedNode, searchNodes } from "../understanding/retrieve.js";
import { DEFAULT_RETRIEVAL_MODEL, searchNodesLlm } from "../understanding/retrieve-llm.js";
import { SqliteLocalStore } from "../understanding/sqlite-local-store.js";

// ---------------------------------------------------------------------------
// Sandbox setup
// ---------------------------------------------------------------------------

interface Sandbox {
  home: string;
  cleanup: () => void;
}

interface RawInputRow {
  id: string;
  platform: string;
  provider_event_id: string;
  repo: string | null;
  issue_number: number | null;
  pr_number: number | null;
  author: string;
  content: string;
  metadata: string | null;
  processed_at: string | null;
  created_at: string;
}

function createSandbox(sourceHome: string): Sandbox {
  const sandboxHome = mkdtempSync(join(tmpdir(), "rusa-eval-"));
  mkdirSync(join(sandboxHome, "data"), { recursive: true });

  const files = ["rusa.db", "rusa.db-shm", "rusa.db-wal"];
  for (const file of files) {
    const src = join(sourceHome, "data", file);
    if (existsSync(src)) {
      copyFileSync(src, join(sandboxHome, "data", file));
    }
  }

  return {
    home: sandboxHome,
    cleanup: () => rmSync(sandboxHome, { recursive: true, force: true }),
  };
}

// ---------------------------------------------------------------------------
// Replay types
// ---------------------------------------------------------------------------

interface ReplayNode {
  id: string;
  title: string;
  contents: string;
  superGoalIds: string[];
}

interface ReplayState {
  nodes: ReplayNode[];
}

interface ReplayRawInput {
  id: string;
  author: string;
  platform: string;
  repo: string | null;
  content: string;
  created_at: string;
}

interface ReplayStep {
  step: number;
  kind: "distillation";
  date: string;
  rawInputs: ReplayRawInput[];
  events: string[];
  modelResponseRaw: string;
  modelReasoning: string;
  modelPrompt?: string;
  /** Full turn-by-turn agentic loop conversation, including tool calls and responses. */
  modelConversation: unknown[];
  stateBefore: ReplayState;
  stateAfter: ReplayState;
  ops: AnyOp[];
  lastHlc?: string;
}

export interface ReplayFile {
  createdAt: string;
  sourceDb: string;
  totalRawInputs: number;
  batchSize: number;
  steps: ReplayStep[];
  rootNodeId?: string;
  /** True while the replay is still running. Viewers should poll while this is set. */
  running?: boolean;
}

// ---------------------------------------------------------------------------
// Replay helpers
// ---------------------------------------------------------------------------

function takeReplayState(syncClient: SyncClient): ReplayState {
  const goals = syncClient.getGoals();
  return {
    nodes: Array.from(goals.values()).map((g) => {
      // goal.log is newest-first (via prependEntry), so the first documentContents
      // entry is the most recently written content for this node.
      const contentsEntry = g.log.find(
        (e): e is DocumentContentsLogEntry => e.type === "documentContents"
      );
      return {
        id: g.id,
        title: g.text,
        contents: contentsEntry?.text ?? "",
        superGoalIds: Array.from(g.superGoalIds),
      };
    }),
  };
}

function resetSandboxForReplay(): void {
  const d = getDb();
  d.prepare(`UPDATE raw_inputs SET processed_at = NULL`).run();
}

function getAllRawInputsOrdered(): RawInputRow[] {
  const d = getDb();
  return d
    .prepare(`SELECT * FROM raw_inputs ORDER BY created_at ASC, id ASC`)
    .all() as RawInputRow[];
}

function markBatchUnprocessed(ids: string[]): void {
  const d = getDb();
  const placeholders = ids.map(() => "?").join(", ");
  d.prepare(`UPDATE raw_inputs SET processed_at = NULL WHERE id IN (${placeholders})`).run(...ids);
}

// ---------------------------------------------------------------------------
// Replay server
// ---------------------------------------------------------------------------

function startReplayServer(getReplayFile: () => ReplayFile, port: number): Promise<() => void> {
  return new Promise((resolve, reject) => {
    const server = createServer(async (req, res) => {
      try {
        const replayFile = getReplayFile();

        if (req.method === "GET" && req.url === "/api/replay") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(replayFile));
          return;
        }

        if (req.method === "GET" && req.url?.startsWith("/api/knowledge-state")) {
          const url = new URL(req.url, `http://${req.headers.host}`);
          const lastHlc = url.searchParams.get("lastHlc");

          const allOps: AnyOp[] = [];
          for (const step of replayFile.steps) {
            allOps.push(...step.ops);
            if (step.lastHlc === lastHlc) break;
          }

          const syncClient = new SyncClient(null, new MemoryLocalStore());
          await syncClient.init();
          await syncClient.applyOps(allOps);

          const goals = syncClient.getGoals();
          const goalsPlain: Record<string, unknown> = {};
          for (const [id, goal] of goals) {
            goalsPlain[id] = {
              ...goal,
              superGoalIds: Array.from(goal.superGoalIds),
              superGoalRelationships: Object.fromEntries(goal.superGoalRelationships),
              subGoalIds: Array.from(goal.subGoalIds),
              subGoalRelationships: Object.fromEntries(goal.subGoalRelationships),
            };
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(goalsPlain));
          return;
        }

        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not found");
      } catch (err) {
        console.error("Replay server error:", err);
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "text/plain" });
          res.end(`Internal Server Error: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    });

    server.listen(port, "127.0.0.1", () => {
      resolve(() => {
        server.closeAllConnections();
        server.close();
      });
    });
    server.on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// Exported commands
// ---------------------------------------------------------------------------

export async function runUnderstandingEvalDistill(opts: { keep: boolean }): Promise<void> {
  const sourceHome = resolveHome();
  const config = loadConfig(sourceHome);
  const sandbox = createSandbox(sourceHome);

  try {
    initDb(sandbox.home);
    const syncClient = await getUnderstandingSyncClient(config);
    if (!syncClient) {
      console.error("Sync client not available");
      return;
    }

    const stateBefore = takeReplayState(syncClient);
    console.log(`Nodes before: ${stateBefore.nodes.length}`);

    console.log("\nRunning distillation...");
    const result = await runDistillation(config, syncClient);
    console.log(`  outcome: ${result.outcome}`);
    console.log(`  ${result.runSummary}`);

    const stateAfter = takeReplayState(syncClient);
    console.log(`Nodes after: ${stateAfter.nodes.length}`);

    if (opts.keep) {
      console.log(`\nSandbox retained at: ${sandbox.home}`);
    }
  } finally {
    closeDb();
    if (!opts.keep) {
      sandbox.cleanup();
    }
  }
}

// ---------------------------------------------------------------------------
// Ops helpers
// ---------------------------------------------------------------------------

function collectOps(liveFile: ReplayFile): AnyOp[] {
  const ops = liveFile.steps.flatMap((s) => s.ops);
  ops.sort((a, b) => a.hlcTimestamp.localeCompare(b.hlcTimestamp));
  return ops;
}

function writeOpsFile(opsPath: string, liveFile: ReplayFile): void {
  // debugAddUnsyncedOps in the Dart SyncClient expects List<String> where each
  // element is Op.toJson() output — i.e. each op individually JSON-encoded as a
  // string, not passed as a raw object. Produce that format here.
  const opsAsStrings = collectOps(liveFile).map((op) => JSON.stringify(op));
  writeFileSync(opsPath, JSON.stringify(opsAsStrings, null, 2));
}

// ---------------------------------------------------------------------------
// Interactive prompt
// ---------------------------------------------------------------------------

async function askUser(question: string): Promise<string> {
  if (!process.stdin.isTTY) return "n";
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function runReplay(
  opts: { batchSize: number; keep: boolean; days?: number; batches?: number },
  liveFile: ReplayFile,
  outputPath: string,
  opsOutputPath: string,
  hierarchyOutputPath: string,
  isResume: boolean
): Promise<void> {
  const sourceHome = resolveHome();
  const config = loadConfig(sourceHome);

  const sandbox = createSandbox(sourceHome);
  try {
    initDb(sandbox.home);
    resetSandboxForReplay();

    const allInputs = getAllRawInputsOrdered();
    if (allInputs.length === 0) {
      console.log("No raw inputs found in the database.");
      return;
    }

    liveFile.totalRawInputs = allInputs.length;

    const d = getDb();
    d.prepare(`UPDATE raw_inputs SET processed_at = datetime('now')`).run();

    const byDay = new Map<string, RawInputRow[]>();
    for (const input of allInputs) {
      if (!input.created_at || typeof input.created_at !== "string") continue;
      const day = input.created_at.slice(0, 10);
      const list = byDay.get(day) ?? [];
      list.push(input);
      byDay.set(day, list);
    }

    const allDays = [...byDay.keys()].sort();
    const days = opts.days ? allDays.slice(0, opts.days) : allDays;

    if (days.length === 0) {
      console.log("[replay] Error: No days to replay.");
      return;
    }

    // When resuming, use the original batch size so batches align with existing steps.
    const batchSize = liveFile.batchSize;

    // Reconstruct which inputs and ops were already covered by existing steps.
    const processedIds = new Set(liveFile.steps.flatMap((s) => s.rawInputs.map((r) => r.id)));
    const existingOps = collectOps(liveFile);
    let stepNum = liveFile.steps.length;

    const localStore = new MemoryLocalStore();
    const syncClient = new SyncClient(null, localStore);
    await syncClient.init();
    if (isResume && existingOps.length > 0) {
      await syncClient.applyOps(existingOps);
    }
    if (isResume) {
      if (!liveFile.rootNodeId) {
        throw new Error("Resume failed: replay.json is missing rootNodeId");
      }
      if (!syncClient.getGoals().has(liveFile.rootNodeId)) {
        throw new Error(
          `Resume failed: replay rootNodeId ${liveFile.rootNodeId} not found in reconstructed graph`
        );
      }
    }

    let batchesProcessed = 0;
    const batchLimit = typeof opts.batches === "number" ? opts.batches : null;

    for (const day of days) {
      const dayInputs = byDay.get(day);
      if (!dayInputs) continue;
      for (let i = 0; i < dayInputs.length; i += batchSize) {
        const batch = dayInputs.slice(i, i + batchSize);

        // Skip batches that were fully covered by a previous run.
        if (isResume && batch.every((r) => processedIds.has(r.id))) continue;

        if (batchLimit !== null && batchesProcessed >= batchLimit) {
          return;
        }

        stepNum++;
        process.stdout.write(`    Distill step ${stepNum} (${batch.length} input(s))...`);

        markBatchUnprocessed(batch.map((r) => r.id));
        const stateBefore = takeReplayState(syncClient);

        const opsBefore = localStore.getUnsyncedOps();

        const result = await runDistillation(config, syncClient, {
          preferredRootNodeId: liveFile.rootNodeId ?? null,
        });
        if (result.rootNodeId) {
          liveFile.rootNodeId = result.rootNodeId;
        }

        const opsAfter = localStore.getUnsyncedOps();
        const newOps = opsAfter.slice(opsBefore.length);
        const lastHlc = newOps.length > 0 ? newOps[newOps.length - 1].hlcTimestamp : undefined;
        const stateAfter = takeReplayState(syncClient);

        liveFile.steps.push({
          step: stepNum,
          kind: "distillation",
          date: day,
          rawInputs: batch.map((r) => ({
            id: r.id,
            author: r.author,
            platform: r.platform,
            repo: r.repo,
            content: r.content,
            created_at: r.created_at,
          })),
          events: result.events,
          modelResponseRaw: result.modelResponseRaw ?? "",
          modelReasoning: result.modelReasoning ?? "",
          modelConversation: result.modelConversation ?? [],
          modelPrompt: `Use tool calling for exploration and mutations. Call finish_task(summary?) when done.`,
          stateBefore,
          stateAfter,
          ops: newOps,
          lastHlc,
        });

        console.log(
          ` ${result.outcome} (+${stateAfter.nodes.length - stateBefore.nodes.length} nodes)`
        );

        // Persist after each step so an interrupted run can be resumed.
        writeFileSync(outputPath, JSON.stringify(liveFile, null, 2));
        writeOpsFile(opsOutputPath, liveFile);
        writeHierarchyFile(hierarchyOutputPath, liveFile);

        batchesProcessed++;
      }
    }
  } finally {
    closeDb();
    if (!opts.keep) sandbox.cleanup();
  }
}

function readReplayFile(path: string): ReplayFile {
  return JSON.parse(readFileSync(path, "utf-8")) as ReplayFile;
}

// ---------------------------------------------------------------------------
// Hierarchy output
// ---------------------------------------------------------------------------

function writeHierarchyFile(hierarchyPath: string, liveFile: ReplayFile): void {
  // Build a SyncClient from all ops so we can traverse the final state.
  const allOps = collectOps(liveFile);
  if (allOps.length === 0) {
    writeFileSync(hierarchyPath, "(no ops — hierarchy empty)\n");
    return;
  }

  // Use the stateAfter of the last step as a simple representation.
  const lastStep = liveFile.steps[liveFile.steps.length - 1];
  if (!lastStep) {
    writeFileSync(hierarchyPath, "(no steps)\n");
    return;
  }

  const nodes = lastStep.stateAfter.nodes;
  const byId = new Map(nodes.map((n) => [n.id, n]));

  // Find roots: nodes with no superGoalIds that are present in our node set.
  const roots = nodes.filter(
    (n) => n.superGoalIds.length === 0 || !n.superGoalIds.some((pid) => byId.has(pid))
  );

  // Build child map.
  const childrenOf = new Map<string, string[]>();
  for (const n of nodes) {
    for (const pid of n.superGoalIds) {
      if (!childrenOf.has(pid)) childrenOf.set(pid, []);
      childrenOf.get(pid)?.push(n.id);
    }
  }

  const lines: string[] = [];
  function renderNode(id: string, depth: number): void {
    const n = byId.get(id);
    if (!n) return;
    const indent = "  ".repeat(depth);
    lines.push(`${indent}- ${n.title}`);
    const children = childrenOf.get(id) ?? [];
    for (const cid of children) {
      renderNode(cid, depth + 1);
    }
  }

  for (const root of roots) {
    renderNode(root.id, 0);
  }

  // Orphaned nodes (shouldn't exist but defensive).
  const rendered = new Set<string>();
  function markRendered(id: string): void {
    if (rendered.has(id)) return;
    rendered.add(id);
    for (const cid of childrenOf.get(id) ?? []) markRendered(cid);
  }
  for (const root of roots) markRendered(root.id);
  const orphans = nodes.filter((n) => !rendered.has(n.id));
  if (orphans.length > 0) {
    lines.push("");
    lines.push("(orphaned — no root parent found)");
    for (const o of orphans) lines.push(`  - ${o.title}`);
  }

  writeFileSync(hierarchyPath, `${lines.join("\n")}\n`);
}

export async function runUnderstandingEvalReplay(opts: {
  batchSize: number;
  batches?: number;
  port: number;
  keep: boolean;
  replayFile?: string;
  days?: number;
  browser?: boolean;
}): Promise<void> {
  const sourceHome = resolveHome();
  const sourceDbPath = join(sourceHome, "data", "rusa.db");
  const outputPath = join(process.cwd(), "replay.json");
  const opsOutputPath = join(process.cwd(), "ops.json");
  const hierarchyOutputPath = join(process.cwd(), "hierarchy.txt");
  // opts.browser is true by default (Commander's --no-browser sets it to false).
  const openBrowserFlag = opts.browser !== false;

  // Seed a live file so the server can serve it immediately, before any steps run.
  const liveFile: ReplayFile = {
    createdAt: new Date().toISOString(),
    sourceDb: sourceDbPath,
    totalRawInputs: 0,
    batchSize: opts.batchSize,
    steps: [],
    running: !opts.replayFile,
  };

  // Detect an existing replay file and offer to resume (only for live runs, not --replay-file).
  let isResume = false;
  if (!opts.replayFile && existsSync(outputPath)) {
    let saved: ReplayFile;
    try {
      saved = readReplayFile(outputPath);
    } catch {
      saved = {
        createdAt: "",
        sourceDb: "",
        totalRawInputs: 0,
        batchSize: opts.batchSize,
        steps: [],
      };
    }

    if (saved.steps.length > 0) {
      const answer = await askUser(
        `Found existing replay with ${saved.steps.length} step(s) at ${outputPath}.\nResume from step ${saved.steps.length + 1}? [Y/n] `
      );
      if (answer === "" || answer.toLowerCase() === "y" || answer.toLowerCase() === "yes") {
        Object.assign(liveFile, saved);
        liveFile.running = true;
        isResume = true;
        console.log(`Resuming from step ${saved.steps.length + 1}.`);
      } else {
        console.log("Starting fresh.");
      }
    }
  }

  const stopServer = openBrowserFlag
    ? await startReplayServer(() => liveFile, opts.port)
    : () => {};
  const url = `http://localhost:${opts.port}`;
  if (openBrowserFlag) {
    console.log(`Viewer:     ${url}`);
    await openBrowser(url);
  }

  try {
    if (opts.replayFile) {
      // Load from saved file — overwrite the live file in place.
      const saved = readReplayFile(opts.replayFile);
      Object.assign(liveFile, saved);
    } else {
      await runReplay(opts, liveFile, outputPath, opsOutputPath, hierarchyOutputPath, isResume);
    }
  } finally {
    liveFile.running = false;
    writeFileSync(outputPath, JSON.stringify(liveFile, null, 2));
    writeOpsFile(opsOutputPath, liveFile);
    writeHierarchyFile(hierarchyOutputPath, liveFile);
    console.log(`Replay file:    ${outputPath}`);
    console.log(`Ops file:       ${opsOutputPath}`);
    console.log(`Hierarchy file: ${hierarchyOutputPath}`);
  }

  if (!openBrowserFlag) {
    stopServer();
    return;
  }

  console.log(`Replay complete. Viewer still running at ${url} — press Ctrl+C to exit.`);

  return new Promise<void>((resolve) => {
    process.on("SIGINT", () => {
      stopServer();
      resolve();
    });
    process.on("SIGTERM", () => {
      stopServer();
      resolve();
    });
  });
}

export function runExtractOps(opts: { replayFile: string; output?: string }): void {
  const replayFile = readReplayFile(opts.replayFile);
  const outputPath = opts.output ?? join(process.cwd(), "ops.json");
  writeOpsFile(outputPath, replayFile);
  const ops = collectOps(replayFile);
  console.log(
    `Extracted ${ops.length} op(s) from ${replayFile.steps.length} step(s) → ${outputPath}`
  );
}

// ---------------------------------------------------------------------------
// eval retrieve
// ---------------------------------------------------------------------------

export async function runEvalRetrieve(opts: {
  limit?: number;
  llm?: boolean;
  retrievalModel?: string;
}): Promise<void> {
  const mcHome = resolveHome();
  const config = loadConfig(mcHome);
  initDb(mcHome);

  let rows: RawInputRow[];
  try {
    rows = getDb()
      .prepare(`SELECT * FROM raw_inputs ORDER BY created_at ASC, id ASC`)
      .all() as RawInputRow[];
  } finally {
    closeDb();
  }

  // Dedupe: for inputs with an issue_number, keep one per (repo, issue_number).
  // For the rest, dedupe by exact content.
  const seen = new Map<string, true>();
  const deduped: RawInputRow[] = [];
  for (const row of rows) {
    const key =
      row.issue_number != null
        ? `issue:${row.repo ?? ""}:${row.issue_number}`
        : `content:${row.content.trim()}`;
    if (!seen.has(key)) {
      seen.set(key, true);
      deduped.push(row);
    }
  }

  const limit = opts.limit ?? deduped.length;
  const inputs = deduped.slice(0, limit);

  // Build a SyncClient from local SQLite ops only (no Firestore connection needed).
  initDb(mcHome);
  let syncClient: SyncClient;
  try {
    const localStore = new SqliteLocalStore();
    syncClient = new SyncClient(null, localStore);
    await syncClient.init();
  } finally {
    closeDb();
  }

  const apiKey = opts.llm ? config.geminiApiKey?.trim() : undefined;
  if (opts.llm && !apiKey) {
    console.error("--llm requires a Gemini API key in config (geminiApiKey)");
    process.exit(1);
  }

  const nodeCount = syncClient.getGoals().size;
  console.log(`Knowledge graph: ${nodeCount} nodes`);
  console.log(
    `Raw inputs: ${rows.length} total, ${deduped.length} after dedupe, showing ${inputs.length}`
  );
  const retrievalModel = opts.retrievalModel ?? DEFAULT_RETRIEVAL_MODEL;
  if (opts.llm)
    console.log(
      `LLM retrieval enabled: model=${retrievalModel}, ~${inputs.length * 2} API calls (primary + meta)`
    );
  console.log();

  // Tracks the previous LLM result to simulate the meta-retrieval feedback loop.
  let lastLlmResult: RetrievedNode[] = [];

  for (const row of inputs) {
    console.log("======= INPUT =========================");
    console.log(row.content.trim());

    const keywordNodes = searchNodes(syncClient, row.content);
    console.log("======= KEYWORD NODES =========================");
    if (keywordNodes.length === 0) {
      console.log("  (none)");
    } else {
      for (const node of keywordNodes) {
        console.log(` - ${node.title}`);
      }
    }

    if (opts.llm && apiKey) {
      // Mirror the production pipeline: meta-retrieval first, then primary.
      let metaNodes: RetrievedNode[] = [];
      if (lastLlmResult.length > 0) {
        const metaQuery =
          `The previous knowledge retrieval identified the following relevant areas:\n` +
          lastLlmResult.map((n) => `- ${n.title}`).join("\n") +
          "\n\n" +
          `What guidance exists about retrieval strategy or knowledge organization for these areas?`;
        try {
          metaNodes = await searchNodesLlm(syncClient, metaQuery, apiKey, retrievalModel);
        } catch {
          // non-fatal
        }
      }

      const llmNodes = await searchNodesLlm(
        syncClient,
        row.content,
        apiKey,
        retrievalModel,
        metaNodes
      );
      lastLlmResult = llmNodes;

      console.log("======= LLM NODES =========================");
      if (llmNodes.length === 0) {
        console.log("  (none)");
      } else {
        for (const node of llmNodes) {
          console.log(` - ${node.title}`);
        }
      }
    }

    console.log("=======================================\n");
  }
}
