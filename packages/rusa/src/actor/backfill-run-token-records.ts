import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";

export interface TokenRecordRow {
  id: string;
  run_id: string;
  provider: string;
  model: string | null;
  scraped_at: string;
  created_at: string;
}

export interface ActorRunRow {
  id: string;
  actor_id: string;
  started_at: string;
  ended_at: string | null;
  outcome: string | null;
  success: number | null;
}

export interface DeterministicResolution {
  id: string;
  currentRunId: string;
  targetRunId: string;
  scrapedAt: string;
  actorId: string;
}

export interface AmbiguousResolution {
  tokenRecord: TokenRecordRow;
  candidates: string[];
  reason: string;
}

export interface UnresolvableResolution {
  tokenRecord: TokenRecordRow;
  reason: string;
}

export interface CollidingResolution {
  tokenRecord: TokenRecordRow;
  runId: string;
  competingTokenRecordIds: string[];
  reason: string;
}

export interface BackfillPlan {
  totalRecords: number;
  alreadyCorrect: TokenRecordRow[];
  deterministicallyResolved: DeterministicResolution[];
  ambiguous: AmbiguousResolution[];
  unresolvable: UnresolvableResolution[];
  collisions: CollidingResolution[];
}

export function analyzeTokenRecords(db: Database.Database): BackfillPlan {
  const tokenRecords = db
    .prepare(
      `SELECT id, run_id, provider, model, scraped_at, created_at
       FROM run_token_records
       ORDER BY scraped_at ASC, rowid ASC`
    )
    .all() as TokenRecordRow[];

  const actorRuns = db
    .prepare(
      `SELECT id, actor_id, started_at, ended_at, outcome, success
       FROM actor_runs
       ORDER BY started_at ASC, id ASC`
    )
    .all() as ActorRunRow[];

  const runIdSet = new Set(actorRuns.map((r) => r.id));

  const runsByActor = new Map<string, ActorRunRow[]>();
  for (const run of actorRuns) {
    let list = runsByActor.get(run.actor_id);
    if (!list) {
      list = [];
      runsByActor.set(run.actor_id, list);
    }
    list.push(run);
  }

  const alreadyCorrect: TokenRecordRow[] = [];
  const deterministicallyResolved: DeterministicResolution[] = [];
  const ambiguous: AmbiguousResolution[] = [];
  const unresolvable: UnresolvableResolution[] = [];
  const collisions: CollidingResolution[] = [];

  for (const rtr of tokenRecords) {
    if (runIdSet.has(rtr.run_id)) {
      alreadyCorrect.push(rtr);
      continue;
    }

    const actorRunsForActor = runsByActor.get(rtr.run_id) || [];
    const candidates: ActorRunRow[] = [];
    const recordTime = Date.parse(rtr.scraped_at);

    for (const run of actorRunsForActor) {
      if (run.ended_at) {
        // Canonical timestamp format across actor_runs and run_token_records is
        // ISO-8601 UTC (YYYY-MM-DDTHH:MM:SS.sssZ). We compare epoch milliseconds via
        // Date.parse to guarantee correct temporal containment across any subtle
        // format differences (e.g. whitespace vs 'T' or varying subsecond precision),
        // falling back to lexical comparison if either date is unparseable.
        const startTime = Date.parse(run.started_at);
        const endTime = Date.parse(run.ended_at);
        const contains =
          !Number.isNaN(recordTime) && !Number.isNaN(startTime) && !Number.isNaN(endTime)
            ? startTime <= recordTime && recordTime <= endTime
            : run.started_at <= rtr.scraped_at && rtr.scraped_at <= run.ended_at;
        if (contains) {
          candidates.push(run);
        }
      }
    }

    if (candidates.length === 0) {
      unresolvable.push({
        tokenRecord: rtr,
        reason: "no candidate actor_runs interval contains scraped_at",
      });
    } else if (candidates.length > 1) {
      ambiguous.push({
        tokenRecord: rtr,
        candidates: candidates.map((c) => c.id),
        reason: "multiple candidate actor_runs intervals contain scraped_at",
      });
    } else {
      const candidate = candidates[0];
      deterministicallyResolved.push({
        id: rtr.id,
        currentRunId: rtr.run_id,
        targetRunId: candidate.id,
        scrapedAt: rtr.scraped_at,
        actorId: candidate.actor_id,
      });
    }
  }

  return {
    totalRecords: tokenRecords.length,
    alreadyCorrect,
    deterministicallyResolved,
    ambiguous,
    unresolvable,
    collisions,
  };
}

export function applyTokenRecordsBackfill(
  db: Database.Database,
  plan: BackfillPlan
): { updated: number } {
  if (plan.deterministicallyResolved.length === 0) {
    return { updated: 0 };
  }

  const update = db.prepare(`
    UPDATE run_token_records
    SET run_id = ?
    WHERE id = ? AND run_id = ?
  `);

  let updated = 0;
  db.transaction(() => {
    for (const item of plan.deterministicallyResolved) {
      const result = update.run(item.targetRunId, item.id, item.currentRunId);
      if (result.changes !== 1) {
        throw new Error(
          `failed to update token record ${item.id}: expected 1 row changed, got ${result.changes}`
        );
      }
      updated += result.changes;
    }
  })();

  return { updated };
}

export async function backupDatabase(databasePath: string, backupDir?: string): Promise<string> {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.(\d{3})Z$/, "$1Z");
  const destination = join(
    backupDir ?? join(dirname(databasePath), "backups"),
    `mesh-before-token-run-id-backfill-${stamp}.db`
  );
  await mkdir(dirname(destination), { recursive: true });
  const source = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    await source.backup(destination);
  } finally {
    source.close();
  }
  const backup = new Database(destination, { readonly: true, fileMustExist: true });
  try {
    backup.prepare("PRAGMA quick_check").run();
  } finally {
    backup.close();
  }
  return destination;
}

export function generateReport(plan: BackfillPlan, applied: boolean): string {
  return [
    "# Token Records Backfill Report",
    "",
    `- Execution Time: ${new Date().toISOString()}`,
    `- Status: ${applied ? "APPLIED" : "DRY RUN"}`,
    `- Total Token Records: ${plan.totalRecords}`,
    `- Already Correct (actor_runs.id): ${plan.alreadyCorrect.length}`,
    `- Deterministically Resolved: ${plan.deterministicallyResolved.length}`,
    `- Ambiguous (Skipped): ${plan.ambiguous.length}`,
    `- Unresolvable (Skipped): ${plan.unresolvable.length}`,
    `- Collisions (Skipped): ${plan.collisions.length}`,
    "",
    "## Deterministic Resolution Criteria",
    "",
    "A legacy row is only updated when `actor_runs.started_at <= rtr.scraped_at <= actor_runs.ended_at` for exactly ONE run of that actor.",
    "Zero guessing is performed. Any row matching zero runs or multiple overlapping runs is skipped.",
    "",
    ...(plan.ambiguous.length > 0
      ? [
          "## Ambiguous Rows (Not Updated)",
          "",
          ...plan.ambiguous.map(
            (a) =>
              `- Token Record ${a.tokenRecord.id} (actor ${a.tokenRecord.run_id}): matched runs [${a.candidates.join(", ")}]`
          ),
          "",
        ]
      : []),
    ...(plan.unresolvable.length > 0
      ? [
          "## Unresolvable Rows (Not Updated)",
          "",
          ...plan.unresolvable.map(
            (u) =>
              `- Token Record ${u.tokenRecord.id} (actor ${u.tokenRecord.run_id}, scraped ${u.tokenRecord.scraped_at}): ${u.reason}`
          ),
          "",
        ]
      : []),
    ...(plan.collisions.length > 0
      ? [
          "## Colliding Rows (Not Updated)",
          "",
          ...plan.collisions.map(
            (c) =>
              `- Token Record ${c.tokenRecord.id}: competing tokens [${c.competingTokenRecordIds.join(", ")}] for run ${c.runId}`
          ),
          "",
        ]
      : []),
  ].join("\n");
}
