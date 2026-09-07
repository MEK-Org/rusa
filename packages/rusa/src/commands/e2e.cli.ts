import { Command } from "commander";
import { runE2EDown } from "../e2e/provision.js";
import { runProviderContextAB } from "./ab-context.js";
import { runActorMeshE2EUp } from "./e2e-actor-mesh.js";
import { runE2EHydrate } from "./e2e-hydrate.js";

/**
 * Dev-only entry point for the self-contained actor-mesh e2e runner. This is
 * intentionally NOT a `rusa` CLI subcommand — it is a development tool for
 * working on the rusa codebase itself, run via `pnpm e2e`. See
 * devlog/2026-06-07-self-contained-runner/design.md §5.1.
 *
 * The v2 `up`/`report` subcommands (scheduler + dashboard + orchestrator run
 * report) were removed with the v2 orchestrator; the actor mesh is exercised via
 * `am-up` and torn down via `am-down`/`down`. Observe a run by tailing the actor
 * firehose (the runner's stdout) or via `rusa report`.
 */
const program = new Command();

program
  .name("rusa-e2e")
  .description(
    "Dev tool: run a self-contained actor-mesh instance against a disposable scratch repo"
  );

program
  .command("am-up")
  .description(
    "Provision and run a disposable instance of the ACTOR MESH (real providers, fake GitHub + chat)"
  )
  .option("--root <path>", "Use a specific root directory instead of a fresh tempdir")
  .option("--resume", "Resume an existing instance root without reprovisioning")
  .option("--base-config-home <path>", "Home to seed providers and the Gemini key from")
  .option("--root-driver <driver>", "Root driver: provider or external", "provider")
  .option("--port-offset <n>", "Offset the disposable instance's default ports", Number, 0)
  .option("--follower-bind <ip>", "Enable follower gateway on this Tailscale IPv4 address")
  .option("--follower-port <port>", "Follower gateway port", Number, 8190)
  .option("--follower-token-file <path>", "File containing follower enrollment secret")
  .option("--root-control-port <port>", "External root control HTTP port", (v) =>
    Number.parseInt(v, 10)
  )
  .action(
    async (opts: {
      root?: string;
      baseConfigHome?: string;
      rootDriver: string;
      portOffset: number;
      followerBind?: string;
      followerPort: number;
      followerTokenFile?: string;
      rootControlPort?: number;
      resume?: boolean;
    }) => {
      if (opts.rootDriver !== "provider" && opts.rootDriver !== "external") {
        throw new Error("--root-driver must be provider or external");
      }
      if (opts.followerBind && (!opts.followerTokenFile || opts.resume)) {
        throw new Error("Follower prototype requires --follower-token-file and a fresh instance");
      }
      await runActorMeshE2EUp({
        root: opts.root,
        baseConfigHome: opts.baseConfigHome,
        rootDriver: opts.rootDriver,
        portOffset: opts.portOffset,
        followerGateway:
          opts.followerBind && opts.followerTokenFile
            ? {
                host: opts.followerBind,
                port: opts.followerPort,
                tokenFile: opts.followerTokenFile,
              }
            : undefined,
        rootControlPort: opts.rootControlPort,
        resume: opts.resume,
      });
    }
  );

program
  .command("ab-context")
  .description(
    "Side-by-side provider-agnostic-context A/B (design ISSUE_NUM): run the evolving todo-app " +
      "scenario on a native vs a portable-context worker; emit metrics + a blind-judging package"
  )
  .option("--root <path>", "Reuse a specific instance root instead of a fresh tempdir")
  .option("--base-config-home <path>", "Home to seed providers and the Gemini key from")
  .requiredOption("--provider <name>", "Provider for BOTH variants")
  .requiredOption("--model <name>", "Model for BOTH variants")
  .option("--filler-per-gap <n>", "Filler runs between decisions (small = cheap smoke run)", (v) =>
    Number.parseInt(v, 10)
  )
  .option(
    "--scenario <name>",
    "Scenario: 'todo-evolving' (default), 'constraint-airgap' (G2-v2 run 1 / primary), or " +
      "'short-pivot' (G2-v2 run 2, CRDT); unknown names are REJECTED. Pair the short runs " +
      "with PORTABLE_CONTEXT_MAX_RUNS=2"
  )
  .option("--quiet-ms <ms>", "Idle quiet window per step", (v) => Number.parseInt(v, 10))
  .option("--step-timeout-ms <ms>", "Per-step per-variant idle timeout", (v) =>
    Number.parseInt(v, 10)
  )
  .option(
    "--max-run-ends-per-step <n>",
    "Cap the run_ends ONE step may burn on ONE arm (G2-v3): self-continuation is ~94% of " +
      "this rig's burn, so an uncapped step is how one arm eats the shared provider window",
    (v) => Number.parseInt(v, 10)
  )
  .option(
    "--min-free-bytes <n>",
    "Refuse to launch below this much free space on the instance root's filesystem " +
      "(default 200M — an UNMEASURED placeholder; the run prints its measured peak, set this from that)",
    (v) => Number.parseInt(v, 10)
  )
  .option("--disk-sample-ms <ms>", "Disk-usage sampling interval for gate calibration", (v) =>
    Number.parseInt(v, 10)
  )
  .option(
    "--allow-under-evicted",
    "Launch even when the filler can't age a decision out of PORTABLE_CONTEXT_MAX_RUNS. " +
      "Only for a deliberate non-aging smoke test — a measurement run launched this way " +
      "completes clean and measures nothing, at full provider cost"
  )
  .option(
    "--allow-over-window",
    "Launch even when the planned provider calls exceed one measured provider window. " +
      "The run will very likely 403 partway through, and the alternation makes the " +
      "portable arm's probe the casualty — a full-cost run that measures nothing"
  )
  .option("--out-dir <path>", "Where to write the report + blind package")
  .option("--shuffle-seed <n>", "Even keeps native→variant-1; odd swaps", (v) =>
    Number.parseInt(v, 10)
  )
  .option("--native-conv-path <path>", "Native variant's provider conversation store (size proxy)")
  .action(
    async (opts: {
      root?: string;
      baseConfigHome?: string;
      provider: string;
      model: string;
      fillerPerGap?: number;
      scenario?: string;
      quietMs?: number;
      stepTimeoutMs?: number;
      maxRunEndsPerStep?: number;
      minFreeBytes?: number;
      diskSampleMs?: number;
      allowUnderEvicted?: boolean;
      allowOverWindow?: boolean;
      outDir?: string;
      shuffleSeed?: number;
      nativeConvPath?: string;
    }) => {
      await runProviderContextAB(opts);
    }
  );

program
  .command("hydrate")
  .description("Hydrate an external-root e2e instance by driving the real mesh APIs")
  .requiredOption(
    "--scenario <name>",
    "Scenario: dashboard-basic or dashboard-empty (requires am-up --root-driver external)"
  )
  .option("--root-control-port <port>", "Root control HTTP port", (v) => Number.parseInt(v, 10))
  .option("--chat-control-port <port>", "Chat control HTTP port", (v) => Number.parseInt(v, 10))
  .option("--tracker-port <port>", "Tracker HTTP port", (v) => Number.parseInt(v, 10))
  .action(async (opts) => {
    await runE2EHydrate(opts);
  });

program
  .command("down")
  .description("Stop a running instance and remove its state unless --preserve is set")
  .requiredOption("--root <path>", "The instance root")
  .option(
    "--preserve",
    "Keep actors, conversations, context, run history, workspaces, and repositories for --resume"
  )
  .action(async (opts: { root: string; preserve?: boolean }) => {
    await runE2EDown({ root: opts.root, preserve: opts.preserve });
  });

program
  .command("am-down")
  .description("Alias of `down` for actor-mesh instances")
  .requiredOption("--root <path>", "The instance root")
  .option(
    "--preserve",
    "Keep actors, conversations, context, run history, workspaces, and repositories for --resume"
  )
  .action(async (opts: { root: string; preserve?: boolean }) => {
    await runE2EDown({ root: opts.root, preserve: opts.preserve });
  });

program.parse();
