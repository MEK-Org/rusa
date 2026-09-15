// The two quota coordinator rollback drills, runnable against a scratch
// deployment. See docs/quota-coordinator-operations.md for the procedure each
// one rehearses and for the transcripts of the last run.
//
//   service-down    the coordinator goes away mid-flight and comes back; also
//                   the backup/restore drill and the measurement site for the
//                   stage-3 write-quiesce window (backup + start-to-readyz).
//   probes-failing  the coordinator stays up and its probes break; the failure
//                   the design calls quiet, because nothing downstream stops.
//
// Everything runs under a fresh temporary directory: its own RUSA_HOME, its own
// database, socket, backup directory and workers directory. Nothing outside
// that directory is read or written except the coordinator's own provider
// probe, which runs exactly as it would under the installed unit.
//
// Usage:
//   pnpm --filter rusa run drill:quota-rollback -- [--drill both|service-down|probes-failing]
//     [--provider codex] [--seed-days 30] [--transcript PATH] [--keep]
//     [--cli PATH] [--hard-stale-ms 4000] [--tick-seconds 2]

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { createLogger } from "../build/maintenance/observability/logger.js";
import {
  backupQuotaDatabase,
  listQuotaBackups,
  restoreQuotaDatabase,
} from "../build/maintenance/quota/coordinator-backup.js";
import { QuotaCoordinatorClient } from "../build/maintenance/quota/coordinator-client.js";
import {
  createQuotaMetrics,
  QUOTA_CLIENT_METRICS,
  QUOTA_METRIC_EVENT,
  QUOTA_SERVICE_METRICS,
} from "../build/maintenance/quota/coordinator-metrics.js";
import { SharedQuotaStore } from "../build/maintenance/quota/shared-store.js";

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function usage() {
  return [
    "Usage:",
    "  pnpm --filter rusa run drill:quota-rollback -- \\",
    "    [--drill both|service-down|probes-failing] [--provider codex] [--seed-days 30] \\",
    "    [--transcript PATH] [--keep] [--cli PATH] [--hard-stale-ms 4000] [--tick-seconds 2] \\",
    "    [--backup-samples 3]",
    "",
    "Runs the coordinator rollback drills against a scratch deployment under a temporary",
    "directory, and writes a Markdown transcript of what was observed.",
    "  --seed-days N     seed N days of five-minute scrapes so the backup is measured at",
    "                    the retention-bound size rather than against an empty file.",
    "  --hard-stale-ms   the client-side hardStaleAfterMs the drill's readers use; kept",
    "                    short so the widening step finishes in seconds, not an hour.",
    "  --backup-samples  how many backups to time for the stage-3 window; the first one is",
    "                    the drill's own backup, the rest are taken and discarded, because a",
    "                    single VACUUM INTO measures page-cache warmth as much as it does size.",
    "  --keep            leave the scratch directory in place afterwards.",
  ].join("\n");
}

export function parseArgs(argv) {
  const result = {
    drill: "both",
    provider: "codex",
    seedDays: 30,
    transcript: null,
    keep: false,
    cli: join(packageDir, "dist", "cli.js"),
    hardStaleMs: 4000,
    tickSeconds: 2,
    backupSamples: 3,
  };
  for (let index = 2; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--") continue;
    if (flag === "--help" || flag === "-h") return { help: true };
    if (flag === "--keep") {
      result.keep = true;
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`missing value for ${flag}`);
    index += 1;
    if (flag === "--drill") {
      if (!["both", "service-down", "probes-failing"].includes(value)) {
        throw new Error(`--drill must be both, service-down or probes-failing, got ${value}`);
      }
      result.drill = value;
    } else if (flag === "--provider") result.provider = value;
    else if (flag === "--seed-days") result.seedDays = Number(value);
    else if (flag === "--transcript") result.transcript = resolve(value);
    else if (flag === "--cli") result.cli = resolve(value);
    else if (flag === "--hard-stale-ms") result.hardStaleMs = Number(value);
    else if (flag === "--tick-seconds") result.tickSeconds = Number(value);
    else if (flag === "--backup-samples") result.backupSamples = Number(value);
    else throw new Error(`unknown argument ${flag}`);
  }
  if (!Number.isFinite(result.seedDays) || result.seedDays < 0) {
    throw new Error("--seed-days must be a non-negative number");
  }
  if (!Number.isInteger(result.tickSeconds) || result.tickSeconds < 1) {
    throw new Error("--tick-seconds must be a positive integer");
  }
  if (!Number.isFinite(result.hardStaleMs) || result.hardStaleMs < 1000) {
    throw new Error("--hard-stale-ms must be at least 1000");
  }
  if (!Number.isInteger(result.backupSamples) || result.backupSamples < 1) {
    throw new Error("--backup-samples must be a positive integer");
  }
  return result;
}

// ---------------------------------------------------------------------------
// Transcript

class Transcript {
  constructor(scrubs) {
    this.scrubs = scrubs;
    this.lines = [];
    this.failures = [];
  }

  /** Paths that would identify the host or the run are replaced before they are kept. */
  scrub(text) {
    let out = String(text);
    for (const [from, to] of this.scrubs) out = out.split(from).join(to);
    return out;
  }

  heading(text) {
    this.lines.push("", `### ${this.scrub(text)}`, "");
  }

  note(text) {
    const line = `- ${new Date().toISOString()}  ${this.scrub(text)}`;
    this.lines.push(line);
    process.stdout.write(`${line}\n`);
  }

  /** A check: recorded as pass/fail in the transcript, and failures fail the run. */
  check(label, ok, observed) {
    const mark = ok ? "PASS" : "FAIL";
    const line = `- ${new Date().toISOString()}  ${mark}  ${this.scrub(label)} — ${this.scrub(observed)}`;
    this.lines.push(line);
    process.stdout.write(`${line}\n`);
    if (!ok) this.failures.push(label);
  }

  render() {
    return `${this.lines.join("\n")}\n`;
  }
}

// ---------------------------------------------------------------------------
// Scratch deployment

function writeScratchConfig(home, opts) {
  // The same shape `rusa init` produces, reduced to what the coordinator reads.
  // The provider entry is what puts the provider on the coordinator's
  // collection lane; the root actor is required by the loader but never runs.
  const yaml = [
    "github:",
    "  account: CodeChopsBot",
    "  pollIntervalSeconds: 300",
    "providers:",
    `  ${opts.provider}:`,
    `    cliCommand: ${opts.provider}`,
    "rootActor:",
    `  provider: ${opts.provider}`,
    `  model: ${opts.rootModel}`,
    "webhook:",
    "  port: 9742",
    "  secret: drill",
    "quota:",
    "  coordinator:",
    `    databasePath: ${opts.databasePath}`,
    `    socketPath: ${opts.socketPath}`,
    `    backupDir: ${opts.backupDir}`,
    "    backupRetention: 14",
    "  throttle:",
    `    tickSeconds: ${opts.tickSeconds}`,
    `    maxIntervalSeconds: ${opts.maxIntervalSeconds}`,
    "",
  ].join("\n");
  writeFileSync(join(home, "config.yaml"), yaml, "utf8");
}

/** A root-actor model the loader accepts for the provider. Only the coordinator runs here. */
function rootModelFor(provider) {
  switch (provider) {
    case "codex":
      return "gpt-5.6-sol";
    case "claude":
      return "claude-opus-5";
    case "kimi":
      return "kimi-for-coding";
    case "agy":
      return "gemini-3.5-pro";
    default:
      throw new Error(`unsupported provider ${provider}`);
  }
}

/**
 * Seed the retention-bound steady state: one parsed scrape per five-minute
 * slot for `days`, with a weekly window burning down and resetting, so the
 * controller has reasoned an interval and the backup is measured at the size
 * a production database settles at rather than against an empty file.
 *
 * `endsAgoMs` — how stale the newest seeded reading is — decides whether the
 * coordinator probes during the drill. Boot hydration seeds the probe layer's
 * cache with the newest persisted reading *at that reading's own timestamp*,
 * so a seed that ends a moment ago leaves every provider inside its TTL and no
 * probe is due; a seed that ends past the longest provider TTL makes the first
 * collection tick probe for real. The two drills want opposite answers.
 */
function seedDatabase(store, opts) {
  const slotMs = 5 * 60 * 1000;
  const weekMs = 7 * 24 * 60 * 60 * 1000;
  const endMs = Date.now() - opts.endsAgoMs;
  const startMs = endMs - opts.days * 24 * 60 * 60 * 1000;
  const cycleStart = (ms) => ms - (ms % weekMs);
  let count = 0;
  const seedAll = store.db.transaction(() => {
    for (let ms = startMs; ms <= endMs; ms += slotMs) {
      const elapsed = (ms - cycleStart(ms)) / weekMs;
      // Burning exactly at budget — the window empties as fast as it refills.
      // The controller is stiff either side of that line: a few percent over
      // and it reasons its way to the ceiling, a few percent under and it
      // collapses toward zero, and in both cases the drill's widening step has
      // nothing to widen from. On budget it settles around a hundred seconds,
      // which is a value an operator would recognise.
      const percentLeft = Math.max(2, 100 - Math.round(elapsed * 100));
      const resetAtIso = new Date(cycleStart(ms) + weekMs).toISOString();
      const scrapedAt = new Date(ms).toISOString();
      const state = {
        provider: opts.provider,
        status: "available",
        scrapedAt,
        limits: [
          {
            label: "Weekly",
            kind: "weekly",
            percentLeft,
            resetAtIso,
            scope: { provider: opts.provider },
          },
        ],
      };
      const id = store.recordRaw({
        provider: opts.provider,
        scrapedAt,
        rawOutput: syntheticScrape(opts.provider, scrapedAt, percentLeft),
      });
      store.recordParsed(id, state, state);
      count += 1;
    }
  });
  seedAll();
  return count;
}

/** About the size of one captured usage panel, so the seeded file is representative. */
function syntheticScrape(provider, scrapedAt, percentLeft) {
  const header = `synthetic ${provider} usage panel captured ${scrapedAt}: ${percentLeft}% left\n`;
  return header + `${"─".repeat(78)}\n`.repeat(36);
}

function dbSummary(databasePath) {
  const db = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    const scrapes = db.prepare("SELECT COUNT(*) AS n FROM quota_scrapes").get().n;
    const observations = db.prepare("SELECT COUNT(*) AS n FROM quota_observations").get().n;
    const newest = db.prepare("SELECT MAX(observed_at) AS t FROM quota_observations").get().t;
    const rows = db
      .prepare("SELECT provider, kind, observed_slot, observed_at FROM quota_observations")
      .all()
      .map((r) => `${r.provider}|${r.kind}|${r.observed_slot}|${r.observed_at}`);
    return { scrapes, observations, newest, rows, bytes: fileBytes(databasePath) };
  } finally {
    db.close();
  }
}

function fileBytes(path) {
  let total = 0;
  for (const suffix of ["", "-wal"]) {
    if (existsSync(`${path}${suffix}`)) total += statSync(`${path}${suffix}`).size;
  }
  return total;
}

// ---------------------------------------------------------------------------
// The coordinator process

function request(socketPath, path) {
  return new Promise((resolvePromise, reject) => {
    const req = http.request({ socketPath, path, method: "GET" }, (res) => {
      let body = "";
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => {
        let json = null;
        try {
          json = JSON.parse(body);
        } catch {}
        resolvePromise({ status: res.statusCode ?? 0, json });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

class Coordinator {
  constructor(opts) {
    this.opts = opts;
    this.child = null;
    this.records = [];
    this.exit = null;
  }

  /** Metric records the service wrote, oldest first. */
  metricRecords() {
    return this.records.filter((r) => r.msg === QUOTA_METRIC_EVENT);
  }

  /** Start the process and resolve once /v1/readyz answers 200. Returns the wait in ms. */
  async start() {
    const startedAt = Date.now();
    this.exit = null;
    this.child = spawn(
      process.execPath,
      [this.opts.cli, "quota-coordinator", "--home", this.opts.home],
      {
        env: {
          ...process.env,
          RUSA_HOME: this.opts.home,
          RUSA_LOG_LEVEL: "debug",
          RUSA_LOG_FORMAT: "json",
        },
        stdio: ["ignore", "pipe", "pipe"],
      }
    );
    const exited = new Promise((resolvePromise) => {
      this.child.on("exit", (code, signal) => {
        this.exit = { code, signal };
        resolvePromise();
      });
    });
    this.exited = exited;
    let pending = "";
    const consume = (chunk) => {
      pending += chunk.toString();
      let newline = pending.indexOf("\n");
      while (newline >= 0) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        if (line.trim()) {
          try {
            this.records.push(JSON.parse(line));
          } catch {
            this.records.push({ msg: line });
          }
        }
        newline = pending.indexOf("\n");
      }
    };
    this.child.stdout.on("data", consume);
    this.child.stderr.on("data", consume);

    const deadline = startedAt + 60_000;
    while (Date.now() < deadline) {
      if (this.exit) {
        throw new Error(`coordinator exited before ready: ${JSON.stringify(this.exit)}`);
      }
      try {
        const ready = await request(this.opts.socketPath, "/v1/readyz");
        if (ready.status === 200 && ready.json?.ready === true) {
          return Date.now() - startedAt;
        }
      } catch {}
      await delay(25);
    }
    throw new Error("coordinator did not answer /v1/readyz within 60s");
  }

  /** SIGTERM, as `systemctl stop` sends, and wait for the exit. */
  async stop() {
    if (!this.child) return null;
    const stoppedAt = Date.now();
    this.child.kill("SIGTERM");
    const result = await Promise.race([
      this.exited.then(() => this.exit),
      delay(15_000).then(() => null),
    ]);
    if (!result) {
      this.child.kill("SIGKILL");
      await this.exited;
    }
    this.child = null;
    return { ...this.exit, ms: Date.now() - stoppedAt, forced: !result };
  }

  async readyz() {
    return request(this.opts.socketPath, "/v1/readyz");
  }

  async healthz() {
    return request(this.opts.socketPath, "/v1/healthz");
  }
}

/** Wait until the collection loop has attempted a probe for the provider. */
async function waitForProbeAttempt(coordinator, provider, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const ready = await coordinator.readyz();
    last = ready.json?.scrapes?.[provider] ?? null;
    if (last && typeof last.attempts === "number" && last.attempts > 0) return last;
    await delay(200);
  }
  return last;
}

// ---------------------------------------------------------------------------
// Instances (readers)

/**
 * One reader per simulated instance, built on the shipped client and emitting
 * the two instance-side series through the shipped logger-backed metrics, so
 * the alert conditions below are evaluated against real records.
 */
function makeReader(name, opts) {
  const records = [];
  const logger = createLogger({
    level: "debug",
    format: "json",
    context: { component: `drill-${name}` },
    destination: {
      write: (chunk) => {
        for (const line of String(chunk).split("\n")) {
          if (!line.trim()) continue;
          try {
            records.push(JSON.parse(line));
          } catch {}
        }
      },
    },
  });
  const client = new QuotaCoordinatorClient({
    socketPath: opts.socketPath,
    maxIntervalSeconds: opts.maxIntervalSeconds,
    hardStaleAfterMs: opts.hardStaleMs,
    metrics: createQuotaMetrics(logger),
    source: name,
  });
  return {
    name,
    client,
    records,
    /** One instance tick: read, and report what this instance would launch at. */
    async tick(provider) {
      let published = null;
      let error = null;
      try {
        published = await client.getThrottle(provider);
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
      }
      return { published, error, applied: client.getLastAppliedInterval(provider) };
    },
    series(metric) {
      return records.filter((r) => r.msg === QUOTA_METRIC_EVENT && r.metric === metric);
    },
  };
}

// ---------------------------------------------------------------------------
// Alert conditions (docs/quota-coordinator-operations.md, "Alerts")

const alerts = {
  /** scrapes_total{outcome="failure"} rising, per provider. */
  scrapeFailures(serviceRecords, provider) {
    return serviceRecords.filter(
      (r) =>
        r.metric === QUOTA_SERVICE_METRICS.scrapesTotal &&
        r.provider === provider &&
        r.outcome === "failure"
    ).length;
  },
  /** service_connected = 0 for more than a few ticks, on any instance. */
  disconnected(reader, ticks = 3) {
    const samples = reader.series(QUOTA_CLIENT_METRICS.serviceConnected).map((r) => r.value);
    let run = 0;
    let longest = 0;
    for (const v of samples) {
      run = v === 0 ? run + 1 : 0;
      longest = Math.max(longest, run);
    }
    return { fires: longest >= ticks, longest };
  },
};

/** Middle sample, or the mean of the middle two. Reported beside the extremes. */
function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

// ---------------------------------------------------------------------------
// Drill 1: the service goes down mid-flight (design §9.5 a–e, §9.2 restore, Q7)

async function drillServiceDown(ctx) {
  const { t, args, provider, coordinator, readers, databasePath, backupDir, socketPath } = ctx;
  t.heading("Drill 1 — service down mid-flight");

  const before = dbSummary(databasePath);
  t.note(
    `seeded database: ${before.scrapes} scrapes, ${before.observations} observations, ${before.bytes} bytes (db + wal), newest observation ${before.newest}`
  );

  const boot1 = await coordinator.start();
  t.note(`coordinator started; start → /v1/readyz 200: ${boot1} ms`);

  // Steady state: every reader applies the published interval.
  const first = await Promise.all(readers.map((r) => r.tick(provider)));
  const published0 = first[0].published;
  t.check(
    "every instance reads a published interval",
    first.every((r) => r.published && typeof r.published.intervalSeconds === "number"),
    first.map((r, i) => `${readers[i].name}: applied ${r.applied}s`).join(", ")
  );
  t.note(
    `published ${provider}: intervalSeconds=${published0?.intervalSeconds} updatedAt=${published0?.updatedAt} governing=${published0?.governingBucketKey}`
  );
  const maxInterval = args.maxIntervalSeconds;
  if (published0 && published0.intervalSeconds >= maxInterval) {
    t.note(
      `note: the published interval already equals maxIntervalSeconds (${maxInterval}); widening in step (d) will be vacuous`
    );
  }

  // No probe is due here, and that is the point: boot hydration put the newest
  // seeded reading in the probe layer's cache at its own timestamp, which is
  // inside the provider TTL. This drill is about a service that is serving,
  // not collecting; the probe path is what drill 2 breaks on purpose.
  await delay(args.tickSeconds * 1000 + 500);
  const collecting = (await coordinator.readyz()).json?.scrapes?.[provider];
  t.note(
    `collection state after a tick: status=${collecting?.status} attempts=${collecting?.attempts ?? 0} failures=${collecting?.failures ?? 0} lastAttemptAt=${collecting?.lastAttemptAt ?? "null"} (no probe due — newest reading is inside the provider TTL)`
  );

  // Stage 3 step 1: the mandatory backup, against the running service.
  const backup = backupQuotaDatabase({ databasePath, backupDir });
  t.note(
    `backup (VACUUM INTO, read-only, service up): ${backup.durationMs} ms, ${backup.bytes} bytes → ${backup.path}`
  );
  t.check(
    "backup opens and passes integrity_check",
    (() => {
      const db = new Database(backup.path, { readonly: true });
      try {
        return db.pragma("integrity_check", { simple: true }) === "ok";
      } finally {
        db.close();
      }
    })(),
    `retained: ${listQuotaBackups(backupDir).length}`
  );

  // Q7 asks for a measured backup, and one `VACUUM INTO` is not a measurement
  // of one: the first vacuum of a run reads a cold page cache and the next ones
  // do not, which on a database this size is a several-fold difference. Take
  // the remaining samples here — same database, same running service — into a
  // directory retention does not own, and discard each one as it is timed, so
  // sampling neither evicts a real backup nor needs the disk for fourteen.
  const sampleDir = join(dirname(backupDir), "backup-samples");
  const backupSamples = [backup.durationMs];
  for (let sample = 1; sample < args.backupSamples; sample += 1) {
    // A fixed instant per sample: the name only has to be distinct, and
    // `VACUUM INTO` at this size can finish twice inside one filename second.
    const stamp = Date.now() + sample * 1000;
    const extra = backupQuotaDatabase({
      databasePath,
      backupDir: sampleDir,
      retain: 1,
      now: () => stamp,
    });
    backupSamples.push(extra.durationMs);
    rmSync(extra.path, { force: true });
  }
  rmSync(sampleDir, { recursive: true, force: true });
  t.note(
    `backup timed ${backupSamples.length}x on the same database: ${backupSamples.map((ms) => `${ms} ms`).join(", ")}`
  );

  const preStop = dbSummary(databasePath);

  // One more successful read immediately before the service goes away, so the
  // outage starts from a fresh one. The client's hard-stale clock runs from its
  // last successful read, not from the stop, and step (a) is about what an
  // instance does *before* that clock expires — step (d) is about after. Reading
  // here keeps the two apart no matter how long the steps above took.
  const lastGood = await Promise.all(readers.map((r) => r.tick(provider)));
  const lastReadAt = Date.now();

  // Bring the service down mid-flight.
  const stop = await coordinator.stop();
  t.note(
    `coordinator stopped (SIGTERM): exit ${JSON.stringify({ code: stop.code, signal: stop.signal })} after ${stop.ms} ms`
  );

  // (a) every instance keeps launching at the interval it last applied.
  const duringOutage = [];
  for (let i = 0; i < 4; i += 1) {
    duringOutage.push(await Promise.all(readers.map((r) => r.tick(provider))));
    await delay(250);
  }
  const lastApplied = duringOutage.at(-1);
  const sinceLastRead = Date.now() - lastReadAt;
  t.check(
    "(a) each instance keeps its last applied interval while the service is down",
    lastApplied.every((r, i) => r.error && r.applied === lastGood[i].applied) &&
      sinceLastRead < args.hardStaleMs,
    `${sinceLastRead} ms into the outage, still inside hardStaleAfterMs (${args.hardStaleMs} ms): ` +
      lastApplied.map((r, i) => `${readers[i].name}: applied ${r.applied}s (${r.error})`).join("; ")
  );

  // (b) no instance writes to the quota database.
  const duringOutageDb = dbSummary(databasePath);
  t.check(
    "(b) no instance wrote to the quota database during the outage",
    duringOutageDb.observations === preStop.observations &&
      duringOutageDb.scrapes === preStop.scrapes,
    `observations ${preStop.observations} → ${duringOutageDb.observations}, scrapes ${preStop.scrapes} → ${duringOutageDb.scrapes}`
  );

  // (c) quota_client_service_connected drops and the alert fires.
  const disconnected = readers.map((r) => alerts.disconnected(r));
  t.check(
    "(c) quota_client_service_connected dropped to 0 on every instance and the alert condition fires",
    disconnected.every((d) => d.fires),
    readers
      .map((r, i) => `${r.name}: ${disconnected[i].longest} consecutive zero samples`)
      .join(", ")
  );

  // (d) past hardStaleAfterMs each instance widens to maxIntervalSeconds on its own.
  const remaining = args.hardStaleMs - (Date.now() - lastReadAt) + 250;
  if (remaining > 0) await delay(remaining);
  const widened = await Promise.all(readers.map((r) => r.tick(provider)));
  t.check(
    `(d) past hardStaleAfterMs (${args.hardStaleMs} ms) each instance widened to maxIntervalSeconds`,
    widened.every((r) => r.applied === maxInterval),
    widened.map((r, i) => `${readers[i].name}: applied ${r.applied}s`).join(", ")
  );

  // (e) on restart, published values resume from the same rows with no gap.
  const boot2 = await coordinator.start();
  t.note(`coordinator restarted; start → /v1/readyz 200: ${boot2} ms`);
  const after = await Promise.all(readers.map((r) => r.tick(provider)));
  const afterDb = dbSummary(databasePath);
  const preserved = preStop.rows.every((row) => afterDb.rows.includes(row));
  const samePublished =
    after[0].published?.intervalSeconds === published0?.intervalSeconds &&
    after[0].published?.updatedAt === published0?.updatedAt;
  t.check(
    "(e) published values resume from the same rows with no gap in quota_observations",
    preserved && samePublished,
    `all ${preStop.rows.length} pre-stop observation rows present; published intervalSeconds ${published0?.intervalSeconds} → ${after[0].published?.intervalSeconds}, updatedAt ${published0?.updatedAt} → ${after[0].published?.updatedAt}`
  );
  t.check(
    "instances reconnect and apply the published interval again",
    after.every((r) => !r.error && r.applied === r.published?.intervalSeconds),
    after.map((r, i) => `${readers[i].name}: applied ${r.applied}s`).join(", ")
  );

  // §9.2 restore drill: stop instances, stop the service, replace the file,
  // start the service, check readyz and the published throttle, start instances.
  t.heading("Restore drill (design §9.2)");
  const stop2 = await coordinator.stop();
  t.note(`instances stopped (readers idle); coordinator stopped after ${stop2.ms} ms`);
  let refused = null;
  try {
    // A listener still on the socket must refuse; there is none now, so this
    // is the positive path — the refusal is covered by the unit tests.
    const restore = await restoreQuotaDatabase({
      backupPath: backup.path,
      databasePath,
      socketPath,
    });
    t.note(
      `restored ${restore.from} over the database in ${restore.durationMs} ms; replaced file archived to ${restore.archivedTo}`
    );
  } catch (err) {
    refused = err instanceof Error ? err.message : String(err);
  }
  t.check("restore replaced the database", refused === null, refused ?? "ok");
  const boot3 = await coordinator.start();
  t.note(`coordinator started on the restored database; start → /v1/readyz 200: ${boot3} ms`);
  const ready = await coordinator.readyz();
  const restored = await Promise.all(readers.map((r) => r.tick(provider)));
  const restoredDb = dbSummary(databasePath);
  t.check(
    "readyz and the published throttle match the backed-up state",
    ready.json?.ready === true &&
      ready.json?.cold === false &&
      restored[0].published?.intervalSeconds === published0?.intervalSeconds &&
      restoredDb.observations === preStop.observations,
    `ready=${ready.json?.ready} cold=${ready.json?.cold}; published ${restored[0].published?.intervalSeconds}s; observations ${restoredDb.observations}`
  );
  t.check(
    "instances started against the restored service apply its interval",
    restored.every((r) => !r.error && r.applied === r.published?.intervalSeconds),
    restored.map((r, i) => `${readers[i].name}: applied ${r.applied}s`).join(", ")
  );
  await coordinator.stop();

  // Q7: the write-quiesce window is the backup plus the start-to-readyz wait.
  // Reported last because the drill produced three starts, and one start is as
  // poor a sample as one backup. Every other stage-3 step is a rename, a mkdir,
  // a config edit or a process start, none of which scale with the data.
  const boots = [boot1, boot2, boot3];
  t.heading("Measured stage-3 window (design Q7)");
  t.note(
    `database at measurement: ${preStop.bytes} bytes (db + wal), ${preStop.scrapes} scrapes, ${preStop.observations} observations`
  );
  t.note(
    `backup (VACUUM INTO, read-only, service up), ${backupSamples.length} samples: ${backupSamples.map((ms) => `${ms} ms`).join(", ")} → median ${median(backupSamples)} ms, slowest ${Math.max(...backupSamples)} ms`
  );
  t.note(
    `start → /v1/readyz, 3 samples: ${boot1} ms (cold start), ${boot2} ms (restart after the outage), ${boot3} ms (on the restored database) → median ${median(boots)} ms, slowest ${Math.max(...boots)} ms`
  );
  t.note(
    `window = backup + start-to-readyz: median ${median(backupSamples) + median(boots)} ms, slowest observed ${Math.max(...backupSamples) + Math.max(...boots)} ms`
  );
}

// ---------------------------------------------------------------------------
// Drill 2: the service stays up and its probes fail (design §9.5, second half)

async function drillProbesFailing(ctx) {
  const { t, args, provider, coordinator, readers, home, databasePath } = ctx;
  t.heading("Drill 2 — service up, probes failing");

  // Point workersDir somewhere unwritable: a regular file where the probe
  // expects to create quota-probe-<provider>/. Applied before boot rather than
  // mid-run because the probe layer caches a reading for the provider's TTL;
  // on a live deployment the same break surfaces at the first tick after that
  // TTL (minutes to half an hour, by provider), which the runbook says to wait for.
  const workersDir = join(home, "workers");
  rmSync(workersDir, { recursive: true, force: true });
  writeFileSync(workersDir, "not a directory\n", "utf8");
  t.note(`workers directory replaced by a regular file: ${workersDir}`);

  const boot = await coordinator.start();
  t.note(`coordinator started; start → /v1/readyz 200: ${boot} ms`);

  const before = await Promise.all(readers.map((r) => r.tick(provider)));
  const published0 = before[0].published;
  t.note(
    `published ${provider}: intervalSeconds=${published0?.intervalSeconds} updatedAt=${published0?.updatedAt}`
  );

  // Let at least two ticks fail so the counter is seen rising, not just set.
  const probe = await waitForProbeAttempt(coordinator, provider, 30_000);
  await delay(args.tickSeconds * 1000 * 2 + 500);
  const readyz = await coordinator.readyz();
  const healthz = await coordinator.healthz();
  const scrape = readyz.json?.scrapes?.[provider];

  t.check(
    "healthz still passes",
    healthz.status === 200 && healthz.json?.ok === true,
    `status ${healthz.status} ok=${healthz.json?.ok}`
  );
  t.check(
    "readyz reports the per-provider scrape failure",
    readyz.status === 200 &&
      readyz.json?.ready === true &&
      scrape?.status === "error" &&
      typeof scrape?.error === "string" &&
      scrape.failures >= 1,
    `ready=${readyz.json?.ready} ${provider}: status=${scrape?.status} attempts=${scrape?.attempts} failures=${scrape?.failures} lastAttemptAt=${scrape?.lastAttemptAt} error=${scrape?.error ?? "(none)"} (first attempt seen: ${probe?.attempts ?? 0})`
  );
  const failures = alerts.scrapeFailures(coordinator.metricRecords(), provider);
  t.check(
    'quota_service_scrapes_total{outcome="failure"} is rising and the alert condition fires',
    failures >= 2,
    `${failures} failure increments in the service's metric records`
  );

  // Clients go on applying a frozen interval without complaint.
  const during = [];
  for (let i = 0; i < 3; i += 1) {
    during.push(await Promise.all(readers.map((r) => r.tick(provider))));
    await delay(args.tickSeconds * 1000);
  }
  const last = during.at(-1);
  t.check(
    "clients keep applying the frozen interval without complaint",
    last.every(
      (r) =>
        !r.error &&
        r.published?.intervalSeconds === published0?.intervalSeconds &&
        r.published?.updatedAt === published0?.updatedAt &&
        r.applied === published0?.intervalSeconds
    ),
    last
      .map(
        (r, i) => `${readers[i].name}: applied ${r.applied}s, updatedAt ${r.published?.updatedAt}`
      )
      .join("; ")
  );
  const connected = readers.map((r) =>
    r.series(QUOTA_CLIENT_METRICS.serviceConnected).every((s) => s.value === 1)
  );
  t.check(
    "quota_client_service_connected stayed at 1 — this failure is invisible to the connection alert",
    connected.every(Boolean),
    readers.map((r, i) => `${r.name}: ${connected[i] ? "always 1" : "dropped"}`).join(", ")
  );
  const dbAfter = dbSummary(databasePath);
  t.note(
    `database unchanged by the failing probes: ${dbAfter.scrapes} scrapes, ${dbAfter.observations} observations`
  );

  const stop = await coordinator.stop();
  t.note(
    `coordinator stopped (SIGTERM): exit ${JSON.stringify({ code: stop.code, signal: stop.signal })} after ${stop.ms} ms`
  );
}

// ---------------------------------------------------------------------------
// Scratch deployment lifecycle

/**
 * Build one scratch deployment: its own RUSA_HOME, database, socket, backup
 * directory, workers directory, coordinator process and readers.
 *
 * Each drill gets its own, rather than sharing one, because the two want
 * opposite probe conditions — see `seedDatabase` on `endsAgoMs` — and because
 * fresh readers mean each drill's client metric series contains only its own
 * samples, so an alert assertion cannot be satisfied by the previous drill.
 */
function setupScratch(t, args, opts) {
  // A short socket path: Unix socket paths are limited to roughly a hundred
  // bytes, and a scratch directory under a deep temporary root would exceed it.
  const root = mkdtempSync(join(tmpdir(), "rusa-qdrill-"));
  t.scrubs.unshift([root, "<scratch>"]);
  const home = join(root, "home");
  const databasePath = join(root, "quota", "quota-coordinator.db");
  const backupDir = join(root, "quota", "backups");
  const socketPath = join(root, "coordinator.sock");
  mkdirSync(join(home, "workers"), { recursive: true });
  mkdirSync(dirname(databasePath), { recursive: true });

  writeScratchConfig(home, {
    provider: args.provider,
    rootModel: rootModelFor(args.provider),
    databasePath,
    socketPath,
    backupDir,
    tickSeconds: args.tickSeconds,
    maxIntervalSeconds: args.maxIntervalSeconds,
  });

  const store = new SharedQuotaStore(databasePath);
  let seeded = 0;
  const seededAt = Date.now();
  try {
    store.configureController({ maxIntervalSeconds: args.maxIntervalSeconds });
    seeded = seedDatabase(store, {
      provider: args.provider,
      days: opts.seedDays,
      endsAgoMs: opts.seedEndsAgoMs,
    });
  } finally {
    store.close();
  }
  t.note(
    `scratch deployment seeded: ${seeded} parsed scrapes over ${opts.seedDays} day(s), newest ${Math.round(opts.seedEndsAgoMs / 1000)}s old, in ${Date.now() - seededAt} ms`
  );

  return {
    t,
    args,
    provider: args.provider,
    coordinator: new Coordinator({ cli: args.cli, home, socketPath }),
    readers: ["instance-a", "instance-b"].map((name) =>
      makeReader(name, {
        socketPath,
        maxIntervalSeconds: args.maxIntervalSeconds,
        hardStaleMs: args.hardStaleMs,
      })
    ),
    root,
    home,
    databasePath,
    backupDir,
    socketPath,
  };
}

async function teardown(ctx, keep) {
  await ctx.coordinator.stop();
  if (keep) process.stdout.write(`scratch deployment kept at ${ctx.root}\n`);
  else rmSync(ctx.root, { recursive: true, force: true });
}

export async function run(argv = process.argv) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (!existsSync(args.cli)) {
    throw new Error(
      `${args.cli} not found; build the CLI first (pnpm --filter rusa exec tsup) or pass --cli`
    );
  }
  // The product default ceiling. Not configurable here: it is the value the
  // client widens to in step (d), and a drill that moved it would be measuring
  // its own setting rather than the shipped one.
  args.maxIntervalSeconds = 3600;

  const t = new Transcript([[homedir(), "~"]]);
  t.lines.push(
    `Run: ${new Date().toISOString()} · provider ${args.provider} · seed ${args.seedDays} days · tick ${args.tickSeconds}s · client hardStaleAfterMs ${args.hardStaleMs} · node ${process.version}`
  );

  try {
    if (args.drill === "both" || args.drill === "service-down") {
      // Newest reading half a minute old: inside every provider TTL, so boot
      // hydration suppresses probing and this drill measures a service doing
      // nothing but serving — which is what steps (a)–(e) are about.
      const ctx = setupScratch(t, args, { seedDays: args.seedDays, seedEndsAgoMs: 30_000 });
      try {
        await drillServiceDown(ctx);
      } finally {
        await teardown(ctx, args.keep);
      }
    }
    if (args.drill === "both" || args.drill === "probes-failing") {
      // Newest reading 45 minutes old: past the longest provider TTL (codex,
      // 30 minutes), so the first collection tick probes for real — and with
      // the workers directory broken, that probe fails. One day of seed is
      // enough; this drill measures nothing that scales with database size.
      const ctx = setupScratch(t, args, { seedDays: 1, seedEndsAgoMs: 45 * 60 * 1000 });
      try {
        await drillProbesFailing(ctx);
      } finally {
        await teardown(ctx, args.keep);
      }
    }
  } finally {
    if (args.transcript) {
      mkdirSync(dirname(args.transcript), { recursive: true });
      writeFileSync(args.transcript, t.render(), "utf8");
      process.stdout.write(`transcript written to ${args.transcript}\n`);
    }
  }

  if (t.failures.length > 0) {
    throw new Error(`drill failed: ${t.failures.join("; ")}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run().catch((err) => {
    process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    process.exitCode = 1;
  });
}
