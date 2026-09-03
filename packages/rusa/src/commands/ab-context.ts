import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ActorMesh, MeshActor } from "../actor/actor-mesh.js";
import { runEndModel } from "../actor/mesh-events.js";
import { portableContextMaxRuns } from "../actor/portable-context.js";
import { FakeChatClient, FakeChatSource } from "../chat/fake.js";
import type { RusaConfig } from "../config/types.js";
import { getRepositories } from "../db/index.js";
import type { MeshEvent } from "../db/repositories/mesh-event-repository.js";
import { FakeIssueClient } from "../e2e/fake-issue-client.js";
import { LocalTracker } from "../e2e/local-tracker.js";
import { PID_FILE, provisionE2EInstance } from "../e2e/provision.js";
import { setIssueClient } from "../gitops/issue-client.js";
import {
  type AgingCheck,
  type ArmStepCapture,
  assessArmsIntact,
  assessDiskHeadroom,
  assessModelIdentity,
  assessProbeAnswered,
  assessRunValidity,
  computeVariantMetrics,
  mergeValidity,
  type StepInjectLog,
  type VariantKind,
  type VariantMetrics,
  verifyAging,
} from "../harness/ab-metrics.js";
import {
  type CaptureBounds,
  type IntermediateCapture,
  traceAgainstBaseline,
} from "../harness/artifact-provenance.js";
import {
  assembleBlindPackage,
  type FileSnapshot,
  type VariantResults,
} from "../harness/blind-package.js";
import {
  extractDependencies,
  mergeSnapshots,
  type NoNewDepsScore,
  packageNames,
  scoreNoNewDependencies,
  vendoredSnapshotFromPaths,
} from "../harness/dependency-scorer.js";
import {
  calibrationNote,
  checkFreeSpace,
  createRunDiskWatch,
  DEFAULT_MIN_FREE_BYTES,
  type DiskUsageReport,
  dirSizeBytes,
  formatMiB,
} from "../harness/disk-gate.js";
import {
  foldDurableCapture,
  isGoodSummary,
  type StepCapture,
  type VendorScan,
} from "../harness/durable-capture.js";
import {
  checkModelIdentity,
  comparabilityCaveat,
  comparabilityOf,
  type RunModelCoverage,
} from "../harness/model-identity.js";
import {
  type CaptureQuotaDeps,
  captureQuota,
  type QuotaCapture,
  type QuotaEvidence,
  quotaEvidence,
} from "../harness/quota-capture.js";
import {
  type RelevanceAgingReport,
  type RunEndBody,
  verifyRelevanceAging,
} from "../harness/relevance-aging.js";
import {
  assertWindowFit,
  assertWindowHeadroom,
  assertWindowPairing,
  type Scenario,
  selectScenario,
  type WindowFitVerdict,
  type WindowHeadroomVerdict,
  type WindowPairingVerdict,
} from "../harness/scenario.js";
import { summarizeActivity, waitForActorIdle } from "../harness/wait-idle.js";
import { scanVendorPaths, snapshotWorkdir } from "../harness/workdir-capture.js";
import { createQuotaService, type ProviderQuotaSnapshot } from "../mcp/quota-mcp.js";
import { assertBwrapAvailable } from "../providers/sandbox.js";
import { type RunStartE2EHandles, runStart } from "./start.js";

/**
 * The rig's own thread — the A/B arms' parent, and NOT a descendant of the instance's
 * live root actor (`"root"`, which the arms used to hang off).
 *
 * ## Why the arms cannot hang off root (an issue)
 * They used to. Root is the live autonomous actor of the provisioned instance: it runs on
 * a real provider, it lists its children, and it is chartered to keep its own subtree
 * tidy. Two children spawned back-to-back with the SAME {@link HARNESS_CHARTER} are, from
 * root's seat, indistinguishable duplicates — so root retired one of them, mid-run, as
 * housekeeping. Root was not malfunctioning; it was reading a mesh the rig had lied to it
 * about. The retired arm then went quiet in a way that reads exactly like an MCP outage,
 * and the driver scored the survivor.
 *
 * Two candidate fixes exist and they are not equivalent. Blocking the retire (refusing
 * `retire_thread` against a thread with an active run — an issue option 2, its own PR
 * and a mesh-core seam) stops the damage but leaves root staring at a duplicate it is
 * chartered to clean up, so it will keep trying by other means. Removing the arms from
 * root's subtree removes the STIMULUS: `list_threads` filters on `parentId === selfId`, so
 * root never sees the arms at all, has nothing to deduplicate, and — as a belt —
 * `isAncestorOf("root", arm)` is now false, so the retire is refused on authority even if
 * something did ask for it.
 *
 * The holder is a driver-owned stub: `parentId: null` (the only shape that escapes root's
 * subtree, and the same shape root itself is seeded with), adopted rather than spawned, and
 * inert. It has no provider and never runs — `requestRun()` is a deliberate no-op, so the
 * yields and failure notices the arms address to their parent land in a thread that burns
 * no quota answering them. `mesh-report` renders it as a second tree root, which is what
 * it is: the rig's tree, sitting beside the instance's.
 *
 * Root authority decoupling : `isRoot` is explicitly `false` (the default for
 * parentless non-root stubs), so the holder has no capability grant/revoke authority.
 * It is also inert in practice — no provider, no MCP surface and no run loop.
 */
export const RIG_HOLDER_ID = "ab-rig-holder";

const RIG_HOLDER_CHARTER =
  "Inert holder thread owned by the `e2e ab-context` driver. It exists to be the A/B " +
  "arms' parent so they are not children of the live root actor, which would see two " +
  "identically chartered siblings and retire one as a duplicate (an issue). It never " +
  "runs, and messages sent to it are intentionally unanswered — the driver, not this " +
  "thread, drives the arms.";

/**
 * Inert {@link MeshActor} for {@link RIG_HOLDER_ID} — a registry record needs a live actor
 * to be addressable, and the arms address their parent on every yield.
 *
 * Every method is a no-op ON PURPOSE. `requestRun` is the load-bearing one: the mesh calls
 * it when a child yields or fails, and a real actor would answer on a real provider,
 * spending the window the arms are being measured against. `isRunning`/`isQueued` are
 * permanently false, which is honest — this thread has no runs.
 */
class RigHolderActor implements MeshActor {
  readonly id = RIG_HOLDER_ID;
  readonly isRunning = false;
  readonly isQueued = false;
  requestRun(): void {}
  declareYield(): void {}
  markUnkillable(): void {}
  preemptForResponsive():
    | { preempted: false }
    | { preempted: true; phase: "running" | "winding_down" | "queued" } {
    return { preempted: false };
  }
  close(): void {}
}

/**
 * Register {@link RIG_HOLDER_ID} on `mesh` and return its id, for use as the arms'
 * `parentId`. Exported so the invariant it establishes — the arms are outside the live
 * root's subtree — is testable against a real mesh rather than restated in a test.
 *
 * `adopt` rather than `spawn`: `spawn` always writes a `parentId`, and a `parentId: null`
 * record is the ONLY shape that sits outside every other tree. This is the same call
 * `start.ts` uses to seed the instance root.
 */
export function adoptRigHolder(mesh: ActorMesh): string {
  mesh.adopt(
    {
      id: RIG_HOLDER_ID,
      charter: RIG_HOLDER_CHARTER,
      parentId: null,
      isRoot: false,
      status: "active",
      title: "A/B rig (driver-owned)",
      createdAt: new Date().toISOString(),
    },
    new RigHolderActor()
  );
  return RIG_HOLDER_ID;
}

/**
 * `e2e ab-context` — the provider-agnostic-context side-by-side driver (design ISSUE_NUM,
 * phase 2). It runs ONE evolving coding task (the todo-app scenario) twice in one
 * disposable actor-mesh instance:
 *  - a **native** worker (provider session resumed each run), and
 *  - a **portable** worker (called stateless, with mesh-managed
 *    injected context each run).
 * Both get the SAME operator messages in lockstep, then the driver reduces each variant's
 * `mesh_events` into comparable metrics, verifies the vacuous-pass guard actually bit
 * (decisions aged out of the portable tail), and emits an UNLABELED blind-judging package
 * for cloudy-porpoise to route to the reviewer tier.
 *
 * This is a deliberate, quota-consuming dev run (real providers above the seam) — NOT
 * a CI test. Consult `get_quota` before running (and capture it before/after: the
 * batched quota delta is the ground-truth burn the report leaves a slot for).
 */
export interface AbContextOptions {
  /** Reuse a specific instance root instead of a fresh tempdir. */
  root?: string;
  /** Home to seed providers + the Gemini key from. */
  baseConfigHome?: string;
  /** Provider for BOTH variants (default: the config's worker default). */
  provider: string;
  /** Model for BOTH variants. */
  model: string;
  /** Filler runs between decisions (small for a cheap smoke run; default = scenario default). */
  fillerPerGap?: number;
  /**
   * Which scenario to run: the full v1 evolving arc (default), or a G2-v2 short run —
   * `"constraint-airgap"` (run 1 / PRIMARY: the non-artifact-embodied air-gap/no-new-deps
   * pivot) or `"short-pivot"` (run 2: the artifact-embodied CRDT pivot). Pair either short
   * run with a shrunk `PORTABLE_CONTEXT_MAX_RUNS` env override (e.g. 2) so the pivot ages out
   * cheaply.
   */
  scenario?: string;
  /** Idle quiet window (ms) — no new run_start ⇒ step done. */
  quietMs?: number;
  /** Per-step per-variant idle timeout (ms). */
  stepTimeoutMs?: number;
  /**
   * Max `run_end`s ONE step may consume on ONE arm before the driver stops waiting
   * (G2-v3 rail 1). Self-continuation is ~94% of this rig's burn — one operator message
   * costs 17–21 runs — so an uncapped step is how a single arm eats a provider window
   * and leaves its partner unrunnable. Undefined = uncapped (the v2 behaviour).
   */
  maxRunEndsPerStep?: number;
  /**
   * Refuse to launch unless the instance root's filesystem has this many bytes free
   * (G2-v3 rail 4). Defaults to {@link DEFAULT_MIN_FREE_BYTES}, which is an UNMEASURED
   * placeholder — the run reports its own measured peak so the next run can set this
   * from data.
   */
  minFreeBytes?: number;
  /** Disk-usage sampling interval (ms) for the gate's self-calibration. */
  diskSampleMs?: number;
  /**
   * Launch even when the scenario's filler cannot age a decision out of the runtime
   * window (see `assertWindowPairing`). Only for a deliberate non-aging smoke test —
   * a real measurement run launched this way completes clean and measures nothing.
   */
  allowUnderEvicted?: boolean;
  /**
   * Launch even when the configuration plans more provider runs than one fresh window has
   * been measured to cover (see `assertWindowFit`). Only for a deliberately partial run —
   * quota exhaustion lands on the portable arm's probe, so the read will be invalid.
   */
  allowOverWindow?: boolean;
  /** Where to write the report + blind package (default: <instanceRoot>/ab-out). */
  outDir?: string;
  /** Even keeps native→variant-1 in the blind package; odd swaps. */
  shuffleSeed?: number;
  /**
   * Optional path to the NATIVE variant's provider conversation store, measured at the
   * end as the native trajectory-size proxy (provider-specific; omitted if unset).
   */
  nativeConvPath?: string;
  /**
   * Reads one provider's quota, for the run's own before/after window readings. Injectable
   * so a test can drive the recorder without a provider CLI; defaults to a quota service
   * built against the provisioned instance with **`ttlMs: 0`** — see
   * {@link QuotaRecorder} for why a cached one would measure nothing.
   */
  readQuota?: (provider: string) => Promise<ProviderQuotaSnapshot>;
}

const HARNESS_CHARTER =
  "You are a coding agent building a small application from scratch in your current " +
  "working directory. An operator will send you a sequence of messages that evolve the " +
  "requirements — an initial task, then refinements and high-level pivots. For each " +
  "message: implement the change, keep the WHOLE app coherent and runnable (don't drag " +
  "abandoned design forward, and don't drop an earlier decision that still applies), and " +
  "commit your work with git. When you have applied the current message, briefly summarize " +
  "what you changed and why, then yield your turn. Re-derive current state from the files " +
  "in your working directory each turn.";

const POLL_MS = 2_000;
const DEFAULT_QUIET_MS = 20_000;
const DEFAULT_STEP_TIMEOUT_MS = 20 * 60_000;
const DEFAULT_DISK_SAMPLE_MS = 30_000;

/**
 * Takes the run's own quota readings and makes sure they reach the disk (an issue).
 *
 * ## What was here before
 * `ab-report.json.quota` was a note telling the operator to do this by hand. Nobody
 * reliably did, and the runs where it mattered most are exactly the runs where nobody
 * could: `g2v3c` died on a 403 partway through provider run 10 of 10, and the driver —
 * which had been holding the arms' whole history — wrote no window reading at all. The
 * `/usage` panel cannot be queried for a past moment, so that evidence is simply gone.
 *
 * ## Three properties, each of which was a way this went wrong
 *
 * **The readings must be real probes, not the same probe twice.** `QuotaService` caches
 * for 5 minutes on claude/agy/kimi and **30 minutes on codex**, longer than a short run.
 * The default service here is built with `ttlMs: 0`; `diffQuota` independently refuses
 * when both readings carry the same `scrapedAt`, so a caller who reintroduces a cache
 * gets a refusal rather than a fictional burn of `0`.
 *
 * **The exit reading must survive the run failing.** {@link finish} is called from a
 * `finally`, and once from the happy path just before the report is assembled; it is
 * memoized, so the reading is taken at whichever of those comes first and the report and
 * `quota.json` carry the same one. Nothing in here throws — a recorder that raised out of
 * a `finally` would replace the run's real error with its own.
 *
 * **`quota.json` is written twice on purpose** — once at launch, once at finish. The
 * launch write is the one that survives a `SIGKILL`, an OOM, or a worker plane that
 * destroys the process's PID namespace mid-run, none of which run a `finally`.
 */
class QuotaRecorder {
  private target: { provider: string; outDir: string; deps: CaptureQuotaDeps } | null = null;
  private launch: QuotaCapture | null = null;
  private exit: QuotaCapture | null = null;
  private exitTaken = false;
  private runError: string | null = null;

  constructor(private readonly readQuota?: AbContextOptions["readQuota"]) {}

  /**
   * Point the recorder at the provisioned instance and take the launch reading.
   *
   * Called after provisioning because the probe must run against the SAME home and
   * provider credentials the arms will burn — a reading of some other installation's
   * window is worse than none.
   */
  async start(target: {
    provider: string;
    outDir: string;
    config: RusaConfig;
    workersDir: string;
  }): Promise<QuotaCapture> {
    const readQuota =
      this.readQuota ??
      (() => {
        // ttlMs: 0 — see the class comment. A cached service would hand the exit call the
        // launch snapshot and the run would report a burn of exactly nothing.
        const service = createQuotaService({
          config: target.config,
          workersDir: target.workersDir,
          ttlMs: 0,
        });
        return (provider: string) =>
          service.getQuota(provider as "claude" | "codex" | "agy" | "kimi");
      })();
    this.target = { provider: target.provider, outDir: target.outDir, deps: { readQuota } };
    this.launch = await captureQuota("launch", target.provider, this.target.deps);
    this.persist();
    return this.launch;
  }

  /** Record how the run died, so the exit reading says what it is a reading OF. */
  noteRunError(err: unknown): void {
    this.runError = err instanceof Error ? err.message : String(err);
  }

  /**
   * Take the exit reading (once) and write the evidence. Never throws, and returns null
   * only when the run never got as far as {@link start} — in which case there is nothing
   * to record and no outDir to record it in.
   */
  async finish(): Promise<QuotaEvidence | null> {
    const target = this.target;
    if (!target) return null;
    if (!this.exitTaken) {
      this.exitTaken = true;
      this.exit = await captureQuota("exit", target.provider, target.deps);
    }
    const evidence = this.persist();
    return evidence;
  }

  private persist(): QuotaEvidence | null {
    const target = this.target;
    if (!target) return null;
    const evidence = quotaEvidence({
      provider: target.provider,
      launch: this.launch,
      exit: this.exit,
      runError: this.runError,
    });
    try {
      writeFileSync(
        join(target.outDir, "quota.json"),
        `${JSON.stringify(evidence, null, 2)}\n`,
        "utf8"
      );
    } catch (err) {
      // Losing the file is bad; losing the run over losing the file is worse.
      console.warn(
        `⚠️  could not write quota.json: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    return evidence;
  }
}

/**
 * Run the A/B, bracketed by the run's own quota readings.
 *
 * The bracket lives out here rather than inside the body so the ~500-line body keeps its
 * shape: the body cannot be trusted to reach its own exit reading, because the whole point
 * is the runs that end by throwing.
 */
export async function runProviderContextAB(opts: AbContextOptions): Promise<void> {
  const quota = new QuotaRecorder(opts.readQuota);
  try {
    await runProviderContextABBody(opts, quota);
  } catch (err) {
    quota.noteRunError(err);
    throw err;
  } finally {
    // `finish` swallows its own failures by construction — nothing here may displace the
    // error the body is in the middle of throwing.
    await quota.finish();
  }
}

async function runProviderContextABBody(
  opts: AbContextOptions,
  quota: QuotaRecorder
): Promise<void> {
  try {
    assertBwrapAvailable();
  } catch (err) {
    console.error(`❌ ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  // Only touch the default runs dir when no explicit --root is given — otherwise
  // we'd fail trying to mkdir under $HOME even when the caller pointed us at a
  // writable root (e.g. a sandbox that mounts $HOME read-only).
  const instanceRoot =
    opts.root ??
    (() => {
      const runsDir = join(homedir(), ".rusa-ab");
      mkdirSync(runsDir, { recursive: true });
      return mkdtempSync(join(runsDir, "run-"));
    })();

  // Launch-time free-space gate (G2-v3 rail 4). Runs BEFORE provisioning so a refusal
  // costs nothing and leaves no half-built instance. It cannot refuse when it cannot
  // measure — see disk-gate.ts for why that bias is deliberate.
  //
  // The banner names the check . It used to print `free space 4971M available ≥
  // 200M required` and stop, which reads as a property of the run rather than of one
  // instant before it — the same over-claim the gate's own doc comment warns about. There
  // are now two checks and an operator has to be able to tell which one just spoke.
  const minFreeBytes = opts.minFreeBytes ?? DEFAULT_MIN_FREE_BYTES;
  const freeSpace = checkFreeSpace(instanceRoot, minFreeBytes);
  console.log(`💾 launch gate (once, pre-provisioning): ${freeSpace.message}`);
  if (!freeSpace.ok) {
    console.error(`❌ refusing to launch: ${freeSpace.message}`);
    process.exit(1);
  }

  // Both scenario gates sit here, BEFORE provisioning, for the same reason the disk gate
  // does: a refusal should cost nothing and leave no half-built instance behind. Neither
  // depends on the instance.
  //
  // Reject an unknown --scenario loudly rather than silently running the default (seal's
  // ISSUE_NUM hardening) — a typo on this measurement rig would otherwise burn a provider window.
  // ...and reject a scenario whose filler cannot outrun the runtime window, for the same
  // reason. A short run launched against the default window completes clean and measures
  // nothing; that cost a full kimi 5h window once already.
  //
  // Reported the way the disk gate reports: a refusal an operator has to act on should read
  // as a refusal, not as a crash with a stack trace over the remedy it is trying to offer.
  //
  // ...and reject a configuration that cannot fit one provider window. The 5-step scenario
  // is 10 runs against a kimi window measured at 9: it could not have produced a valid read
  // in ANY window, and the run that dies is deterministically the portable arm's probe.
  // That is arithmetic we can do before spending anything (see `assertWindowFit`).
  const rootProvider = opts.provider ?? "claude";
  const gated = ((): {
    scenario: Scenario;
    pairing: WindowPairingVerdict;
    windowFit: WindowFitVerdict;
  } => {
    try {
      const selected = selectScenario(opts.scenario, opts.fillerPerGap);
      return {
        scenario: selected,
        pairing: assertWindowPairing(selected, { allowUnderEvicted: opts.allowUnderEvicted }),
        windowFit: assertWindowFit(selected, {
          provider: rootProvider,
          allowOverWindow: opts.allowOverWindow,
        }),
      };
    } catch (err) {
      console.error(`❌ refusing to launch: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  })();
  const { scenario, pairing, windowFit } = gated;
  const instance = provisionE2EInstance({
    root: instanceRoot,
    baseConfigHome: opts.baseConfigHome,
    rootActor: { provider: rootProvider },
    chat: {
      projectId: "ab",
      subscription: "ab",
      pubsubKeyPath: "/dev/null",
      gchatConfigDir: "/tmp/rusa-ab-gchat",
      errorChat: "spaces/ab-errors",
    },
  });
  const { root: rootDir, home, config, repo } = instance;
  const bot = config.github.account ?? "quickstart-user";

  appendFileSync(
    join(rootDir, "gitconfig"),
    [`[url "${instance.remotePath}"]`, `\tinsteadOf = https://github.com/${repo}`, ""].join("\n"),
    "utf8"
  );
  writeFileSync(join(rootDir, PID_FILE), String(process.pid), "utf8");

  const chatClient = new FakeChatClient();
  const chatSource = new FakeChatSource();
  let emitGitHubEvent: RunStartE2EHandles["emitGitHubEvent"] | null = null;
  const tracker = new LocalTracker({
    repo,
    baseUrl: "http://localhost:8099",
    botAccount: bot,
    onEvent: async (event, payload) => {
      await emitGitHubEvent?.(event, payload);
    },
    remotePath: instance.remotePath,
  });
  setIssueClient(new FakeIssueClient(tracker, bot));

  const quietMs = opts.quietMs ?? DEFAULT_QUIET_MS;
  const stepTimeoutMs = opts.stepTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;
  const outDir = opts.outDir ?? join(instanceRoot, "ab-out");
  mkdirSync(outDir, { recursive: true });

  console.log(`\n🔬 Provider-agnostic-context A/B — ${scenario.title}\n${"━".repeat(30)}`);
  console.log(`E2E_ROOT=${rootDir}`);
  console.log(`OUT_DIR=${outDir}`);
  console.log(
    `scenario steps=${scenario.steps.length}  fillerPerGap=${opts.fillerPerGap ?? "default"}`
  );
  // Print the pairing the run is actually launching with. The window is an ENV knob with
  // no CLI flag, so it is otherwise invisible in the command line that started the run —
  // which is exactly how a mispaired run gets launched without anyone noticing.
  console.log(
    `aging pairing: ${pairing.ok ? "OK" : "UNDER-EVICTED (overridden)"} — ` +
      `shortest filler gap ${pairing.fillerGapSteps} step(s) vs window ${pairing.windowSize} run(s)`
  );
  // Print the window fit too. Same reasoning as the pairing line: the run's provider-call
  // count is a product of step count and arm count, neither of which appears in the command
  // line, so "this cannot fit" is otherwise invisible until the 403 lands on the probe.
  console.log(`${windowFit.ok ? "" : "⚠️  "}${windowFit.message.split("\n")[0]}`);

  // The run's own launch-side window reading . Taken here — after provisioning, so
  // it probes the home the arms will actually burn, and before the arms exist, so it is a
  // reading of the window they start from. This used to be a line telling the operator to
  // do it by hand; the runs that most needed it are the ones where nobody was watching.
  const launchQuota = await quota.start({
    provider: rootProvider,
    outDir,
    config,
    workersDir: join(home, "workers"),
  });
  console.log(
    `${launchQuota.outcome === "read" ? "" : "⚠️  "}${launchQuota.message}\n` +
      `   (a second reading is taken when the run ends, however it ends → ${join(outDir, "quota.json")})`
  );

  // ...and now the half `assertWindowFit` deliberately left out (ISSUE_NUM item 2). The
  // structural gate above compared this configuration against a FULL FRESH window; this one
  // compares it against the window we are actually standing in, using the launch reading we
  // just took rather than a second probe. It sits here, after provisioning, because that is
  // where the reading exists — a refusal still costs zero provider runs, which is the cost
  // that matters. If the probe could not read, this does NOT refuse and does NOT pass: it
  // reports NOT CHECKED and the run proceeds un-gated, visibly.
  const headroom = ((): WindowHeadroomVerdict => {
    try {
      return assertWindowHeadroom(scenario, {
        provider: rootProvider,
        launch: launchQuota,
        allowOverWindow: opts.allowOverWindow,
      });
    } catch (err) {
      console.error(`❌ refusing to launch: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  })();
  console.log(`${headroom.fits === true ? "" : "⚠️  "}${headroom.message.split("\n")[0]}\n`);

  const ready = new Promise<RunStartE2EHandles>((resolve) => {
    void runStart({
      e2e: {
        chatClient,
        chatSource,
        onReady: (handles) => {
          emitGitHubEvent = handles.emitGitHubEvent;
          resolve(handles);
        },
      },
    });
  });
  const handles = await ready;
  const { mesh } = handles;

  // Adopt the rig's own root-level holder BEFORE spawning the arms — see RIG_HOLDER_ID
  // for why the arms must not be root's children (an issue).
  adoptRigHolder(mesh);

  const chosenProvider = opts.provider?.trim();
  if (!chosenProvider) {
    throw new Error("ab-context requires an explicit --provider");
  }
  const chosenModel = opts.model?.trim();
  if (!chosenModel) {
    throw new Error("ab-context requires an explicit --model");
  }

  // Spawn both variants. Native resumes its provider session; portable is stateless.
  const nativeId = mesh.spawn({
    charter: HARNESS_CHARTER,
    parentId: RIG_HOLDER_ID,
    modelConfig: { provider: chosenProvider, model: chosenModel },
    title: "ab-native",
  });
  const portableId = mesh.spawn({
    charter: HARNESS_CHARTER,
    parentId: RIG_HOLDER_ID,
    modelConfig: { provider: chosenProvider, model: chosenModel },
    context: { type: "portable", mode: "tail" },
    title: "ab-portable",
  });
  const variants: [VariantKind, string][] = [
    ["native", nativeId],
    ["portable", portableId],
  ];
  console.log(`native=${nativeId}  portable=${portableId} (portable tail context)\n`);

  const allEvents = (): MeshEvent[] => getRepositories().meshEvents.list();
  const idleDeps = {
    poll: () => Promise.resolve(allEvents()),
    sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
    now: () => Date.now(),
  };

  // Self-calibrating disk sampler (G2-v3 rail 4): the gate above required a number
  // nobody has measured; this measures what the run actually costs so the next one can
  // set the threshold from data instead of carrying the placeholder forward.
  //
  // As of ISSUE_NUM leg 2 it also WATCHES: every tick reads free space on the device and
  // compares it against the same `--min-free-bytes` floor the launch gate used. The two
  // measure different things on purpose — consumed-by-this-run is the calibration number,
  // free-on-device is the safety number, and on a shared box the thing that fills the
  // disk is usually somebody else's spawn, which `dirSizeBytes` cannot see at all.
  const diskSampleMs = opts.diskSampleMs ?? DEFAULT_DISK_SAMPLE_MS;
  const sampler = createRunDiskWatch(instanceRoot, diskSampleMs, minFreeBytes);
  sampler.start();
  console.log(
    `💾 mid-run watch (every ${Math.round(diskSampleMs / 1000)}s until the run ends): ` +
      `aborts before the next arm dispatch if free space falls below ${formatMiB(minFreeBytes)}\n`
  );

  // Per-variant cursor over that actor's chronological events, and the step logs.
  const cursor: Record<string, number> = { [nativeId]: 0, [portableId]: 0 };
  const stepLogs: Record<VariantKind, StepInjectLog[]> = { native: [], portable: [] };
  /** Per-step wall-clock windows per arm — the provenance the v2 report could not show. */
  const stepWindows: Record<VariantKind, ArmStepWindow[]> = { native: [], portable: [] };
  /**
   * The tree as it stood at the step that introduced `c-no-new-deps` — the BASELINE the
   * air-gap criterion is a delta against. Scoring the final tree alone cannot answer
   * "was a dependency added AFTER the constraint", which is half of the v2 defect.
   */
  const depBaseline: Record<VariantKind, FileSnapshot[] | null> = { native: null, portable: null };
  /** The baseline step's OWN vendor scan — paired with `depBaseline`, never re-read live. */
  const depBaselineVendor: Record<VariantKind, VendorScan | null> = {
    native: null,
    portable: null,
  };
  /** What the baseline walk left out — without it, `added` is a guess. See ISSUE_NUM. */
  const depBaselineBounds: Record<VariantKind, CaptureBounds | null> = {
    native: null,
    portable: null,
  };
  /**
   * What each arm held at each step AFTER the baseline: the captured paths, and the
   * package names visible at that step. Together they catch two things neither endpoint
   * tree can show — a file created after the constraint and removed again before the end,
   * and a dependency the arm took on and then withdrew. (The reviewer's own bound on the
   * `g2v3d` verdict.) The dependency side needs its own per-step vendor scan, because the
   * file snapshot deliberately never enters `node_modules/`, so a vendored-then-deleted
   * package leaves nothing at all in `paths`.
   */
  const postBaselineSteps: Record<VariantKind, IntermediateCapture[]> = {
    native: [],
    portable: [],
  };
  const constraintStepId =
    scenario.steps.find((s) => s.addChecks.some((c) => c.id === "c-no-new-deps"))?.id ?? null;
  // Durable per-step artifact capture (an issue, Concern 1). Snapshotted into
  // outDir after every step and folded so the last GOOD artifact survives a teardown
  // that wipes/cancels a later step — collection then never depends on the live
  // workspace surviving to the very end.
  const durable: Record<VariantKind, StepCapture | null> = { native: null, portable: null };
  /**
   * How many files each arm's snapshot held after each step — the input to the
   * lost-arm invariant ({@link assessArmsIntact}). Kept separately from `durable`
   * because the fold deliberately KEEPS the last good capture: after it, a step that
   * captured nothing is indistinguishable from one that captured the same tree twice.
   */
  const stepCaptures: Record<VariantKind, ArmStepCapture[]> = { native: [], portable: [] };
  const workdirOf = (id: string): string => join(home, "workers", id);

  /**
   * Set when the mid-run watch has seen the device drop below the floor (ISSUE_NUM leg 2).
   * The sampler's timer never aborts anything itself — it records, and the loop below
   * asks. Killing the run from inside a timer callback could land mid-dispatch, with one
   * arm messaged and the other not, which is a state the report has no way to describe;
   * asking at the top of an arm turn means the run always stops on a boundary the report
   * already understands. What is worth preventing is the NEXT provider run, and this is
   * the last moment before one.
   *
   * Structured rather than a message string (seal's ISSUE_NUM nit): the field's whole job is
   * to let a reader of `ab-report.json` alone place the cut, and a reader who has to
   * recover "which step, which arm" by parsing prose — or worse, by going back to the
   * console the run already threw away — has been handed a claim the artifact does not
   * carry. The console line is now derived FROM this, so the two cannot disagree.
   */
  let diskAbort: {
    /** The sampler's own verdict text, verbatim — the numbers and the measured path. */
    message: string;
    /** The step whose dispatch was refused. Steps BEFORE this one completed normally. */
    stoppedBeforeStepId: string;
    /** 0-based, so a reader can say "3 of 5 steps ran" without counting scenario entries. */
    stoppedBeforeStepIndex: number;
    /**
     * The arm that did not get this step. Its partner may already have taken it: the run
     * stops between the two arms of a step, never inside one, so the last step is
     * legitimately lopsided — which is itself a reason the run is invalid.
     */
    stoppedBeforeArm: VariantKind;
    stoppedBeforeActorId: string;
  } | null = null;

  for (const [stepIndex, step] of scenario.steps.entries()) {
    console.log(`▶ ${step.id} (${step.kind}): ${step.message.slice(0, 80)}`);

    // ── ONE ARM AT A TIME (G2-v3 rail 3) ────────────────────────────────────
    // v2 dispatched both arms concurrently and awaited them together. That is why run 2
    // burned 105 runs on one arm and 77 on the other against a SHARED provider window:
    // whichever arm ran hot consumed quota the other still needed, and the arm that hit
    // the wall did so at a different point in the scenario than its partner. The
    // comparison then rests on two arms that met different provider conditions — an
    // asymmetry in the instrument, not in the thing measured.
    //
    // So: send to one arm, wait for it to settle, then send to the other. Interleaving
    // per STEP (rather than running arm 1's whole scenario then arm 2's) is a deliberate
    // deviation from "sequential arms" and keeps quota exposure SYMMETRIC: if the window
    // runs out it runs out at roughly the same scenario position for both, which is a
    // jointly-invalid run (detectable, honest) instead of a lopsided one that still
    // looks scoreable. The cost is wall-clock — the arms no longer overlap.
    //
    // ALTERNATE which arm goes first each step. Going one arm at a time fixes the gross
    // asymmetry but introduces a small systematic one in its place: whoever always goes
    // first always meets the fresher window, on every step of the run. Alternating
    // spreads that across both arms instead of banking it for one — and `firstArm` is
    // recorded per step so the residual ordering is visible in the report rather than
    // being something a reader has to reconstruct.
    const order = stepIndex % 2 === 0 ? variants : [...variants].reverse();
    for (const [variant, id] of order) {
      // The mid-run disk check, polled at the cheapest stopping point there is: after the
      // previous arm settled and before this one is dispatched. A breach is sticky in the
      // sampler, so a device that dipped and recovered still stops the run — a transient
      // dip is exactly the shape of the near-miss this exists for, and un-sticking it
      // would make the only evidence disappear.
      const headroom = sampler.headroom();
      if (headroom.state === "breached") {
        diskAbort = {
          message: headroom.message,
          stoppedBeforeStepId: step.id,
          stoppedBeforeStepIndex: stepIndex,
          stoppedBeforeArm: variant,
          stoppedBeforeActorId: id,
        };
        // Printed FROM the recorded value, not alongside it, so the console cannot say
        // something the report does not also carry.
        console.error(`❌ aborting run: ${diskAbort.message}`);
        console.error(
          `   stopped before dispatching ${diskAbort.stoppedBeforeStepId} to ` +
            `${diskAbort.stoppedBeforeArm} (${diskAbort.stoppedBeforeActorId})`
        );
        break;
      }
      const baselineActivity = summarizeActivity(allEvents(), id);
      const baselineRunEnds = baselineActivity.runEnds;
      const startedAt = new Date().toISOString();
      // Sent AS the holder, not as root: the operator messages must come from the arms'
      // own parent, or the arms would hold a handle back to the live root and address
      // their yields there — reintroducing exactly the coupling RIG_HOLDER_ID removes.
      mesh.sendMessage(id, step.message, RIG_HOLDER_ID);
      const result = await waitForActorIdle(idleDeps, {
        actorId: id,
        baselineRunEnds,
        baselineActivity,
        quietMs,
        pollMs: POLL_MS,
        timeoutMs: stepTimeoutMs,
        maxRunEnds: opts.maxRunEndsPerStep,
      });
      const endedAt = new Date().toISOString();
      if (result.capped) {
        console.warn(
          `  ⚠️  ${variant} (${id}) hit the per-step run cap (${opts.maxRunEndsPerStep}) — step output is TRUNCATED`
        );
      } else if (!result.idle) {
        console.warn(`  ⚠️  ${variant} (${id}) did not go idle before timeout`);
      }
      stepWindows[variant].push({ stepId: step.id, startedAt, endedAt, firstArm: order[0][0] });

      const actorEvents = allEvents().filter((e) => e.actorId === id);
      const fresh = actorEvents.slice(cursor[id]);
      cursor[id] = actorEvents.length;
      const runEnds = fresh.filter((e) => e.kind === "run_end");
      // The injection is folded onto run_start: its body is the InjectRecord
      // JSON. Take the first run_start whose body actually parses to
      // sourceEventIds — non-injecting runs (native, or a portable first run) carry no
      // body, so parseSourceIds returns null and they're skipped.
      const firstInjectSourceIds =
        fresh
          .filter((e) => e.kind === "run_start")
          .map((e) => parseSourceIds(e.body))
          .find((ids) => ids !== null) ?? null;
      stepLogs[variant].push({
        stepId: step.id,
        runEndIds: runEnds.map((e) => e.id),
        firstInjectSourceIds,
        // Recorded PER STEP, not just per run: the v2 close-gate could see that the run
        // as a whole had successes and could NOT see that the probe step had none.
        successfulRunEnds: runEnds.filter((e) => e.success !== false).length,
        capped: result.capped,
        idle: result.idle,
      });

      // Durably capture this variant's artifact for the step: snapshot the workdir and
      // take the last GOOD self-report among the step's fresh run_ends. Persist it
      // (the mid-scenario checkpoints we want anyway) and fold it so a later wipe or
      // cancel can never destroy the last good artifact.
      const stepSummary =
        [...fresh].reverse().find((e) => e.kind === "run_end" && isGoodSummary(e.body))?.body ?? "";
      const snapshot = snapshotWorkdir(workdirOf(id));
      const capture: StepCapture = {
        stepId: step.id,
        summary: stepSummary,
        files: snapshot.files,
        bounds: snapshot.bounds,
        // Scanned HERE, once, and carried with the files through the fold. Vendored trees
        // are skipped by the snapshot, so this is the only record of them at this step —
        // and re-reading it live at collection time would describe a different moment.
        vendor: scanVendorPaths(workdirOf(id)),
      };
      const stepDir = join(outDir, "steps", step.id);
      mkdirSync(stepDir, { recursive: true });
      writeFileSync(
        join(stepDir, `${variant}.json`),
        `${JSON.stringify(capture, null, 2)}\n`,
        "utf8"
      );
      stepCaptures[variant].push({ stepId: step.id, capturedFileCount: capture.files.length });
      durable[variant] = foldDurableCapture(durable[variant], capture);
      if (step.id === constraintStepId) {
        depBaseline[variant] = capture.files;
        depBaselineBounds[variant] = capture.bounds;
        // The capture's own scan, not a fresh one: a baseline blind to vendoring would
        // score a pre-existing vendored package as newly added.
        depBaselineVendor[variant] = capture.vendor;
      } else if (depBaseline[variant]) {
        // Strictly after the baseline (the branch above claims the baseline step itself).
        postBaselineSteps[variant].push({
          paths: capture.files.map((f) => f.path),
          dependencyNames: dependencyNamesOf(capture.files, capture.vendor),
        });
      }
    }
    if (diskAbort !== null) break;
  }

  // ── Collect ──────────────────────────────────────────────────────────────
  // Collection runs even on a disk abort. The steps that DID complete are real data and
  // their captures are already on disk; what must not happen is the abbreviated run
  // reading as a short scenario that finished cleanly, and that is `assessDiskHeadroom`'s
  // job below — a fatal validity reason, not a silently smaller report.
  const diskUsage = sampler.stop();
  const events = allEvents();
  const metrics: Record<VariantKind, VariantMetrics> = {
    native: computeVariantMetrics("native", nativeId, events),
    portable: computeVariantMetrics("portable", portableId, events),
  };
  if (opts.nativeConvPath) {
    // Only a walk that saw the whole tree may report a size: a partial total understates
    // exactly the growth this experiment measures, and an omitted field says "not captured"
    // where a number would have said "this small". No `existsSync` guard — an absent path
    // walks to a complete 0, which is the same answer, honestly derived.
    const size = dirSizeBytes(opts.nativeConvPath);
    if (size.complete) metrics.native.conversationDbBytes = size.bytes;
  }
  const aging: Record<VariantKind, AgingCheck[]> = {
    native: verifyAging(scenario, stepLogs.native),
    portable: verifyAging(scenario, stepLogs.portable),
  };
  // Relevance-aware aging (an issue, Concern 3): reconstruct the injector's SELECT
  // set at each probe step from the event log + step boundaries, so aging is measured
  // against what would actually be injected (window + byte cap) — robust to a live
  // firstInjectSourceIds miss (Concern 2) and self-explaining (why kept/evicted). It
  // also yields the re-run's window-safe filler recommendation.
  const runEndBodies = new Map<string, RunEndBody>();
  for (const e of events) {
    if (e.kind === "run_end") runEndBodies.set(e.id, { ts: e.ts, body: e.body });
  }
  const relevanceAging = verifyRelevanceAging(scenario, stepLogs.portable, runEndBodies);

  // Prefer the durable per-step capture (survives a teardown that wiped the live
  // workspace); fall back to a fresh live snapshot only if nothing durable was kept.
  const variantOutput = (variant: VariantKind, id: string): CapturedVariant => {
    const d = durable[variant];
    if (d && d.files.length > 0) {
      // The kept capture's OWN bounds and vendor scan, not a fresh walk's: all three have
      // to describe the same tree — the one the judge is about to be shown.
      return {
        results: { variant, summary: d.summary, files: d.files },
        bounds: d.bounds,
        vendor: d.vendor,
      };
    }
    const live = snapshotWorkdir(workdirOf(id));
    return {
      results: {
        variant,
        summary: isGoodSummary(d?.summary) ? (d?.summary ?? "") : lastRunEndBody(events, id),
        files: live.files,
      },
      bounds: live.bounds,
      vendor: scanVendorPaths(workdirOf(id)),
    };
  };
  /**
   * Annotate a variant's final tree against the constraint-step baseline (ISSUE_NUM, after
   * the `g2v3d` false positive). A final tree alone cannot distinguish a difference the
   * condition under test produced from one that ORIGINATED at the baseline — that
   * ambiguity is what manufactured `g2v3d`'s retracted "retention" finding. When there
   * is no baseline to measure against, the trace is omitted entirely rather than
   * defaulted, so the judge reads it as unmeasured and not as "nothing changed".
   */
  const withProvenance = (captured: CapturedVariant): VariantResults => {
    const out = captured.results;
    const baseline = depBaseline[out.variant];
    const baselineBounds = depBaselineBounds[out.variant];
    const baselineVendor = depBaselineVendor[out.variant];
    if (!constraintStepId || !baseline || !baselineBounds || !baselineVendor) return out;
    const trace = traceAgainstBaseline({
      baselineStepId: constraintStepId,
      baseline,
      baselineBounds,
      baselineDependencyNames: dependencyNamesOf(baseline, baselineVendor),
      final: out.files,
      finalBounds: captured.bounds,
      // The COLLECTED capture's own vendor scan. Reading the live workdir here was the
      // withdrawn-dependency bug: after a teardown the kept tree still declares its
      // packages while the live tree has none, so every one of them read as withdrawn.
      finalDependencyNames: dependencyNamesOf(out.files, captured.vendor),
      intermediate: postBaselineSteps[out.variant],
    });
    // An incomplete endpoint capture silently weakens every membership claim in the
    // package, so say it out loud rather than leaving it for a judge to notice.
    const { baseline: bc, final: fc } = trace.provenance.coverage;
    if (!bc.complete || !fc.complete) {
      console.warn(
        `⚠️  ${out.variant}: bounded capture — provenance claims are limited ` +
          `(baseline capped=${bc.capped} skipped=${bc.skippedPaths.length} unreadableDirs=${bc.unreadableDirs.length} truncated=${bc.truncatedPaths.length}; ` +
          `final capped=${fc.capped} skipped=${fc.skippedPaths.length} unreadableDirs=${fc.unreadableDirs.length} truncated=${fc.truncatedPaths.length})`
      );
    }
    // Vendor coverage is invisible to the file coverage above — the snapshot never enters
    // those directories — so an unlistable vendor tree has to announce itself separately.
    if (!baselineVendor.complete || !captured.vendor.complete) {
      console.warn(
        `⚠️  ${out.variant}: vendor scan incomplete (baseline=${baselineVendor.complete} ` +
          `final=${captured.vendor.complete}) — withdrawn-dependency timeline omitted`
      );
    }
    return { ...out, files: trace.files, provenance: trace.provenance };
  };
  const outputs: [VariantResults, VariantResults] = [
    withProvenance(variantOutput("native", nativeId)),
    withProvenance(variantOutput("portable", portableId)),
  ];
  // NOTE: assembled further down, once `modelIdentity` is known — the package carries the
  // bounds on what a verdict against it can support, and those are not known until the
  // arms' provenance has been read back.

  // Mechanical `c-no-new-deps` score (G2-v3 rail 2b/2c). This does NOT replace the blind
  // judge — it is the one criterion that is objectively decidable from the artifacts, and
  // the v2 judge decided it by matching the bare word "express" (which also occurs inside
  // "expression"). Scored as a DELTA against the constraint step's tree, and reported
  // alongside the judge's verdict so a disagreement shows up as a disagreement.
  const noNewDeps: Partial<Record<VariantKind, NoNewDepsScore>> = {};
  if (constraintStepId) {
    for (const [variant, id] of variants) {
      const baseFiles = depBaseline[variant];
      if (!baseFiles) {
        // No baseline ⇒ the arm never completed the constraint step. Say so rather than
        // omitting the variant, so an absent score reads as "unmeasurable" and not as
        // "nothing found". (The probe-answered gate independently makes this fatal.)
        console.warn(
          `⚠️  ${variant}: no c-no-new-deps baseline — the arm never completed ${constraintStepId}`
        );
        continue;
      }
      const baseVendor = depBaselineVendor[variant];
      const captured = variantOutput(variant, id);
      if (!baseVendor?.complete || !captured.vendor.complete) {
        // A vendor directory that could not be listed scans as empty, and an empty final
        // vendor set scores as "added nothing" — a pass manufactured by a failed read.
        // Omit the score so it reads as unmeasurable, exactly like a missing baseline.
        console.warn(
          `⚠️  ${variant}: no c-no-new-deps score — vendor scan incomplete ` +
            `(baseline=${baseVendor?.complete ?? false} final=${captured.vendor.complete})`
        );
        continue;
      }
      const baseline = mergeSnapshots(
        extractDependencies(baseFiles),
        vendoredSnapshotFromPaths(baseVendor.paths)
      );
      // Same capture the judge is shown, and ITS vendor scan — not the live workdir, which
      // after a teardown holds neither.
      const final = mergeSnapshots(
        extractDependencies(captured.results.files),
        vendoredSnapshotFromPaths(captured.vendor.paths)
      );
      noNewDeps[variant] = scoreNoNewDependencies(baseline, final, scenario.language);
    }
  }

  // Structural judgeability guard (ISSUE_NUM second finding / ISSUE_NUM-class): a run whose history
  // is entirely prompt failures (e.g. the kimi EROFS creds bug — runFailures N/N on both
  // arms) must not masquerade as a clean exit-0 pass. Fold the verdict into the report so
  // downstream blind routing can refuse it, and (below) exit nonzero when it's fatal.
  //
  // Merged with the probe-answered gate (G2-v3 rail 1): `assessRunValidity` is the COARSE
  // check — it only fires when an arm has zero successes across the WHOLE run, which is
  // why v2 run 2 exited 0 with `AGED-OUT ✓` while its probe was dispatched into a provider
  // that had already started refusing. A run that answers five steps and loses the sixth —
  // the one the run exists to ask — is not a partial result; it is no result.
  //
  // And merged with the lost-arm invariant : both prior gates read the arms'
  // OWN histories, so an arm that was torn down by an outside authority mid-run — or one
  // whose workdir came back empty — can still leave a plausible-looking half-A/B behind.
  // A comparison missing one of its two sides is not a weak result; it is not a result.
  // Per-arm provenance (written to `report.provenance.arms` below). Computed up here
  // because the validity merge needs the arms' bound models: an A/B whose two sides ran
  // different models is void no matter how clean everything else reads.
  const armProvenance = Object.fromEntries(
    variants.map(([variant, id]) => {
      const rec = mesh.registry.get(id);
      const windows = stepWindows[variant];
      return [
        variant,
        {
          actorId: id,
          provider: rec?.modelConfig?.[0]?.provider ?? null,
          // What the arm's runs REPORTED they ran on — the arm's ACTUAL models, which is
          // what a comparability claim rests on, and deliberately NOT the model the arm
          // was configured with. Empty on every provider but codex; `modelIdentity` below
          // is what stops that emptiness reading as a pass.
          //
          // Read run-scoped off `run_end` rather than off the thread record. A per-thread
          // copy is written on every run and cleared on none, so an actor moved from a
          // reporting provider to a non-reporting one answers with the model it LEFT,
          // indefinitely — a stale value that reads exactly like a fresh one.
          //
          // Carried as the whole list rather than collapsed to one value here: an arm
          // that re-pinned mid-scenario HAS no single value, and choosing one for it
          // would launder a void run into a comparable-looking one.
          // The count travels with the list. `checkModelIdentity` does not read it — the
          // verdict is the same with or without it — but the `same` verdict's message
          // says "all arms ran X", and on a six-step arm that sentence is only as wide
          // as the runs that actually reported. The coverage is what lets a reader see
          // how wide that is instead of taking the wording at face value.
          ...armRunModels(events, id),
          firstStepStartedAt: windows[0]?.startedAt ?? null,
          lastStepEndedAt: windows[windows.length - 1]?.endedAt ?? null,
          stepWindows: windows,
        },
      ];
    })
  );

  // ISSUE_NUM: "both arms bound the same model" must not be inferred from two matching nulls.
  // `assessModelIdentity` owns the fatal-vs-warning policy (a demonstrated mismatch voids
  // the run; an unmeasured one does not) — see its doc for why, and for the first version
  // of this call site, which got it wrong in a way the unit tests could not see.
  const modelIdentity = checkModelIdentity(armProvenance);
  const comparability = comparabilityOf(modelIdentity);
  const judgeCaveat = comparabilityCaveat(modelIdentity);
  const blind = assembleBlindPackage(
    scenario,
    outputs,
    opts.shuffleSeed ?? 0,
    judgeCaveat ? [judgeCaveat] : []
  );
  const validity = mergeValidity(
    assessRunValidity(metrics),
    assessProbeAnswered(scenario, stepLogs),
    assessArmsIntact({ native: nativeId, portable: portableId }, events, stepCaptures),
    assessModelIdentity(modelIdentity),
    // A breach voids the run (ISSUE_NUM leg 2): the loop stopped dispatching, so every number
    // below is computed over a prefix of the scenario. Without this the blind package
    // would be indistinguishable from a short scenario that ran to completion.
    assessDiskHeadroom(diskUsage.headroom)
  );
  // The exit-side window reading, taken here — the arms are done, so this is the burn of
  // the run and not of the teardown. Memoized: the `finally` in the caller will reuse this
  // exact reading rather than probing a second time, so the report and `quota.json` agree.
  const quotaEvidenceForRun = await quota.finish();
  const report = {
    scenarioId: scenario.id,
    scenarioTitle: scenario.title,
    steps: scenario.steps.length,
    fillerPerGap: opts.fillerPerGap ?? "default",
    actorIds: { native: nativeId, portable: portableId },
    invalid: !validity.valid,
    invalidReasons: validity.fatal,
    warnings: validity.warnings,
    // What this run's numbers can be ATTRIBUTED to, as distinct from whether they are
    // judgeable at all (`invalid` above). `unverified` means the harness could not show
    // the two arms ran the same model, so a delta between them cannot be pinned on the
    // condition under test — the run is still worth judging, but a writeup that says
    // "portable context caused X" is not supported by it.
    //
    // Top-level, beside `invalid`, because the review of PR ISSUE_NUM found the first version
    // buried in `provenance` where a consumer reading the driver's established pass
    // surfaces would never meet it. A caveat nobody encounters is not a caveat.
    comparability,
    metrics,
    aging,
    relevanceAging,
    stepLogs,
    // Provenance the v2 report could not show: WHICH provider each arm actually ran on,
    // WHEN each step ran on each arm, and the sequencing/cap knobs in force. Without
    // these an arm that silently fell back to another provider, or two arms that met
    // different quota conditions, are indistinguishable from a clean comparison.
    provenance: {
      sequencing:
        "per-step interleaved (one arm in flight at a time); first-arm alternates each step",
      maxRunEndsPerStep: opts.maxRunEndsPerStep ?? null,
      quietMs,
      stepTimeoutMs,
      portableContextMaxRuns: portableContextMaxRuns(),
      // The pairing this run launched under. `portableContextMaxRuns` alone doesn't say
      // whether it was ADEQUATE for this scenario's filler — that comparison is the one
      // that decides whether the report below measures anything.
      windowPairing: {
        ok: pairing.ok,
        fillerGapSteps: pairing.fillerGapSteps,
        windowSize: pairing.windowSize,
        overridden: pairing.ok ? false : (opts.allowUnderEvicted ?? false),
      },
      // Whether the run could fit one fresh window at all. Recorded even when it passed:
      // a reader asking "was this read invalidated by quota?" needs the planned-vs-capacity
      // arithmetic, and `capacityRuns: null` says plainly that nobody has measured this
      // provider rather than implying the check passed on merit.
      windowFit: {
        ok: windowFit.ok,
        plannedRuns: windowFit.plannedRuns,
        capacityRuns: windowFit.capacityRuns,
        headroomRuns: windowFit.headroomRuns,
        overridden: windowFit.ok ? false : (opts.allowOverWindow ?? false),
      },
      // ...and whether the window it ACTUALLY launched into had room, which the field above
      // cannot say — it compares against a fresh window by construction. Kept as its own
      // key rather than folded into `windowFit` because a structural pass and a live pass
      // are different claims. `fits: null` is NOT CHECKED, never a pass: no reading was
      // obtained, so nothing was compared. See ISSUE_NUM item 2.
      windowHeadroom: {
        provenance: headroom.provenance,
        fits: headroom.fits,
        plannedRuns: headroom.plannedRuns,
        rows: headroom.rows,
        binding: headroom.binding,
        reason: headroom.provenance === "not-checked" ? headroom.reason : null,
        overridden: headroom.fits === false ? (opts.allowOverWindow ?? false) : false,
      },
      // The driver's OWN invocation, recorded as provenance: what this `ab-context` run
      // was asked to launch. Deliberately kept through the divergence teardown, because
      // it is not half of a divergence pair — nothing compares it to what the arms ran,
      // and no surface derives a verdict from the difference. It is the only record of
      // what was asked for, and `armProvenance.models` (what ran) cannot answer that.
      requestedProvider: opts.provider ?? null,
      requestedModel: opts.model ?? null,
      // Whether the arms are even comparable. `ok: null` means NOT CAPTURED — nobody
      // measured — and is deliberately NOT `true`, so a reader (or a later gate) cannot
      // turn two matching nulls into "same model on both arms ✓". See ISSUE_NUM.
      modelIdentity: {
        ok: modelIdentity.ok,
        status: modelIdentity.status,
        capturedArms: modelIdentity.capturedArms,
        uncapturableArms: modelIdentity.uncapturableArms,
        message: modelIdentity.message,
      },
      arms: armProvenance,
    },
    noNewDeps: constraintStepId
      ? { baselineStepId: constraintStepId, ...noNewDeps }
      : { baselineStepId: null, note: "scenario has no c-no-new-deps criterion" },
    disk: {
      // Two different questions, kept separate on purpose: `gate` is free space at one
      // instant before provisioning, `headroom` is the mid-run watch over the whole run,
      // and `usage` is what this run consumed (the calibration input, not a safety check).
      gate: freeSpace,
      headroom: diskUsage.headroom,
      // Non-null only when the mid-run watch stopped the run. It names the step and the arm
      // whose dispatch was refused in their OWN fields, so a reader of the report alone can
      // place the cut without parsing the verdict prose.
      abortedRun: diskAbort,
      usage: diskUsage,
      calibration: calibrationNote(freeSpace, diskUsage),
    },
    // The run's OWN before/after window readings and the burn between them . `burn.
    // computed: false` carries the reason it could not be measured — an unreadable panel,
    // a probe that threw, a provider `get_quota` cannot probe — and no number, because a
    // `0` here would read as "this run was free". Also written standalone to `quota.json`,
    // which is the copy that exists when the run dies before this report is assembled.
    quota: quotaEvidenceForRun,
  };

  writeFileSync(join(outDir, "ab-report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  writeFileSync(
    join(outDir, "blind-package.json"),
    `${JSON.stringify(blind.package, null, 2)}\n`,
    "utf8"
  );
  writeFileSync(join(outDir, "blind-key.json"), `${JSON.stringify(blind.key, null, 2)}\n`, "utf8");

  printSummary(
    metrics,
    aging.portable,
    relevanceAging,
    outDir,
    rootDir,
    noNewDeps,
    diskUsage,
    freeSpace,
    pairing
  );
  if (quotaEvidenceForRun) {
    // Prefixed with the warning glyph when the burn could NOT be computed, on the disk
    // gate's precedent: the line an operator most needs to notice is the one saying the
    // measurement did not happen.
    console.log(
      `\n${quotaEvidenceForRun.burn.computed ? "📊" : "⚠️ "} ${quotaEvidenceForRun.burn.message}`
    );
  }
  for (const w of validity.warnings) console.warn(`⚠️  ${w}`);
  if (comparability !== "verified") {
    // Printed AFTER the summary and its numbers, deliberately: an operator who reads the
    // metrics and stops has still met the sentence that bounds what those metrics mean.
    console.warn(
      `\n🔎 COMPARABILITY: ${comparability.toUpperCase()} — this run's numbers are real, but a ` +
        "delta between the arms cannot be attributed to the context regime alone.\n" +
        `   ${modelIdentity.message}`
    );
  }
  if (!validity.valid) {
    // Loud + nonzero so an operator or the launch sidecar treats the run as unjudgeable
    // rather than reading the written blind package as a result.
    console.error(
      `\n⛔ RUN INVALID — do NOT blind-judge:\n${validity.fatal.map((r) => `   • ${r}`).join("\n")}`
    );
    process.exitCode = 1;
  }
  await handles.shutdown();
}

/**
 * What an arm's own runs said they ran on: every DISTINCT model in the order first seen,
 * and how many of the arm's runs reported one at all.
 *
 * A list rather than "the model it finished on": an arm runs once per scenario step, so
 * reducing its history to a single value hides a mid-run model change behind whichever
 * end you pick, and `checkModelIdentity` would then compare a claim that is only true of
 * part of the arm. Empty is a real answer — "nothing reported" — and callers must not
 * fill it in from configuration; see `harness/model-identity.ts`.
 *
 * Runs that reported nothing contribute nothing rather than truncating the scan. A codex
 * run legitimately reports nothing whenever its rollout cannot be read back
 * (`captureModel` in `providers/codex.ts`), so treating one silent run as a reason to
 * discard the runs that did report would make the gate read UNVERIFIED on a read hiccup
 * — trading a working check for alarm fatigue. What the gate refuses is an unbacked
 * claim; one agreeing report is backing, and a contradicting one is caught above.
 *
 * The count ships with the list, out of ONE scan, rather than from a second exported
 * helper. Two loops would each carry their own idea of which events belong to the arm,
 * and the day one of those predicates changes the coverage would silently describe a
 * different population than the models it is offered as coverage OF — a number that
 * looks like evidence and is not, which is the whole failure class this area exists to
 * refuse.
 */
export function armRunModels(
  events: MeshEvent[],
  actorId: string
): { models: string[]; coverage: RunModelCoverage } {
  const models: string[] = [];
  let reported = 0;
  let total = 0;
  for (const event of events) {
    if (event.actorId !== actorId || event.kind !== "run_end") continue;
    total += 1;
    const model = runEndModel(event.payload);
    if (!model) continue;
    reported += 1;
    if (!models.includes(model)) models.push(model);
  }
  return { models, coverage: { reported, total } };
}

/** Parse the `sourceEventIds` out of a `run_start` inject body (an InjectRecord JSON). */
function parseSourceIds(body: string | null): string[] | null {
  if (!body) return null;
  try {
    const rec = JSON.parse(body) as { sourceEventIds?: unknown };
    return Array.isArray(rec.sourceEventIds) ? (rec.sourceEventIds as string[]) : null;
  } catch {
    return null;
  }
}

/** The most-recent `run_end` body for an actor (its final self-report). */
function lastRunEndBody(events: readonly MeshEvent[], actorId: string): string {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.actorId === actorId && e.kind === "run_end") return e.body ?? "";
  }
  return "";
}

/**
 * The distinct package names one capture shows — declared in a manifest, imported by
 * source, or vendored into the tree.
 *
 * Same evidence the `c-no-new-deps` score is computed from, so the withdrawn-dependency
 * timeline and the mechanical score cannot disagree about what counts as a dependency.
 * The vendor scan must be passed in: the file snapshot never enters `node_modules/`, so
 * a package that was vendored and later deleted is invisible without it.
 *
 * `undefined` when that scan was incomplete — this is a set-level claim, and a set built
 * from a scan that could not list a vendor directory is a lower bound wearing a measured
 * set's clothes. Every consumer treats `undefined` as unmeasured and omits its claim.
 */
function dependencyNamesOf(
  files: readonly FileSnapshot[],
  vendor: VendorScan
): string[] | undefined {
  if (!vendor.complete) return undefined;
  const merged = mergeSnapshots(
    extractDependencies(files),
    vendoredSnapshotFromPaths(vendor.paths)
  );
  return [...packageNames(merged)].sort();
}

/**
 * One arm's collected artifact with everything measured AT THE SAME MOMENT as its files.
 *
 * The three fields travel together on purpose. The final tree usually comes from the
 * durable fold of an earlier step (that is what the fold is for), so pairing it with
 * anything read live at collection time compares two different trees and calls the
 * difference a finding.
 */
interface CapturedVariant {
  results: VariantResults;
  bounds: CaptureBounds;
  vendor: VendorScan;
}

/** One arm's wall-clock window for one scenario step. */
export interface ArmStepWindow {
  stepId: string;
  startedAt: string;
  endedAt: string;
  /** Which arm was dispatched FIRST on this step (the arms alternate — see the loop). */
  firstArm: VariantKind;
}

function printSummary(
  metrics: Record<VariantKind, VariantMetrics>,
  ownedAging: AgingCheck[],
  relevanceAging: RelevanceAgingReport,
  outDir: string,
  rootDir: string,
  noNewDeps: Partial<Record<VariantKind, NoNewDepsScore>>,
  diskUsage: DiskUsageReport,
  freeSpace: ReturnType<typeof checkFreeSpace>,
  pairing: WindowPairingVerdict
): void {
  console.log(`\n${"━".repeat(30)}\n📊 A/B result\n`);
  for (const variant of ["native", "portable"] as const) {
    const m = metrics[variant];
    console.log(
      `${variant.padEnd(6)} runs=${m.runCount} fails=${m.runFailures} cont=${m.continuations} ` +
        `injects=${m.contextInjections} injBytesTotal=${m.injectedBytesTotal} injBytesMax=${m.injectedBytesMax}` +
        (m.conversationDbBytes != null ? ` convDbBytes=${m.conversationDbBytes}` : "")
    );
  }
  console.log(`\nOwned-variant aging (vacuous-pass guard — did decisions age out of the tail?):`);
  for (const c of ownedAging) {
    const verdict =
      c.agedOut === true
        ? "AGED-OUT ✓"
        : c.agedOut === false
          ? "STILL-IN-TAIL (vacuous)"
          : "inconclusive";
    console.log(`  ${c.decisionStepId} → tested@${c.testedAtStepId}: ${verdict}`);
  }
  console.log(
    `\nOwned-variant relevance-aware aging (reconstructed injector SELECT set — window + byte cap):`
  );
  for (const c of relevanceAging.checks) {
    const verdict =
      c.agedOut === true
        ? `AGED-OUT ✓ (${c.reason})`
        : c.agedOut === false
          ? `STILL-IN-SELECT (vacuous; depth ${c.windowDepthAtTest}/${portableContextMaxRuns()})`
          : `inconclusive (${c.reason})`;
    console.log(
      `  ${c.decisionStepId} → tested@${c.testedAtStepId}: ${verdict}  ` +
        `[select=${c.selectSet.length} runs]`
    );
  }
  console.log(
    `\nRe-run filler recommendation (window-safe floor): ${relevanceAging.recommendedFillerPerGap} ` +
      `(observed ${relevanceAging.observedRunEndsPerFillerStep.toFixed(1)} run_ends/filler step; ` +
      `${relevanceAging.underEvicted ? "UNDER-EVICTED at current filler — RAISE" : "current filler evicted all pairs"})`
  );
  // Raising filler is only ONE of the two ways out, and it's the expensive one: the
  // recommendation above reads the window as fixed and solves for filler. Shrinking the
  // window instead costs nothing extra, so name it — and name the ratio, since "3x the
  // runs" on this rig means 3x the provider windows.
  if (relevanceAging.underEvicted && pairing.fillerGapSteps > 0) {
    const ratio = relevanceAging.recommendedFillerPerGap / pairing.fillerGapSteps;
    console.log(
      `  cheaper alternative: keep filler at ${pairing.fillerGapSteps} and set ` +
        `PORTABLE_CONTEXT_MAX_RUNS=${pairing.fillerGapSteps} (window is ${pairing.windowSize} now). ` +
        `Same run cost; raising filler instead is ~${ratio.toFixed(1)}x the runs.`
    );
  }
  if (Object.keys(noNewDeps).length > 0) {
    console.log(`\nMechanical c-no-new-deps score (delta vs. the constraint step's tree):`);
    for (const variant of ["native", "portable"] as const) {
      const score = noNewDeps[variant];
      if (!score) continue;
      const mark =
        score.verdict === "clean"
          ? "CLEAN ✓"
          : score.verdict === "violated"
            ? "VIOLATED ✗"
            : "INDETERMINATE ?";
      console.log(`  ${variant.padEnd(8)} ${mark} — ${score.reason}`);
      if (score.vendoredPackages.length > 0) {
        console.log(
          `           vendored (ruled a violation): ${score.vendoredPackages.join(", ")}`
        );
      }
    }
    console.log(
      `  (advisory to the blind judge, not a substitute for it — a disagreement between\n` +
        `   this and the judge's verdict is itself the finding and must be reported.)`
    );
  }
  console.log(`\nDisk gate calibration: ${calibrationNote(freeSpace, diskUsage)}`);
  // Printed unconditionally, including the `not-enforced` case: a watch that took no usable
  // reading has to say so out loud, or its silence reads as "nothing went wrong".
  console.log(`Disk mid-run watch:    ${diskUsage.headroom.message}`);
  console.log(`\nArtifacts: ${outDir}`);
  console.log(`  ab-report.json     — metrics + aging + relevanceAging + step logs`);
  console.log(`  blind-package.json — UNLABELED variants + rubric (route to reviewer tier)`);
  console.log(`  blind-key.json     — sealed variant↔identity map (judge must NOT see)`);
  console.log(`\nTear down:  pnpm e2e am-down --root ${rootDir}\n`);
}
