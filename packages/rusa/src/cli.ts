import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { runActorChat } from "./commands/chat.js";
import { runChatSmoke } from "./commands/chat-smoke.js";
import { CONFIG_DOCS, printConfigDocs } from "./commands/config-docs.js";
import { runDashboard } from "./commands/dashboard.js";
import { runDev } from "./commands/dev.js";
import { runActorMeshE2EUp } from "./commands/e2e-actor-mesh.js";
import { runForwardWebhooks } from "./commands/forward-webhooks.js";
import { runInit } from "./commands/init.js";
import { runInstallService } from "./commands/install-service.js";
import { runLogs } from "./commands/logs.js";
import { runQuickstart, runQuickstartConfigure } from "./commands/quickstart.js";
import { runReport } from "./commands/report.js";
import { runServiceRestart, runServiceStatus, runServiceStop } from "./commands/service-control.js";
import { runStart } from "./commands/start.js";
import { runUnderstandingRecompute } from "./commands/understanding.js";
import {
  runEvalRetrieve,
  runExtractOps,
  runUnderstandingEvalDistill,
  runUnderstandingEvalReplay,
} from "./commands/understanding-eval.js";
import { runUninstallService } from "./commands/uninstall-service.js";

type ServiceEnvironment = "production" | "staging";
type DeploymentMode = "package" | "self";

function readCliVersion(): string {
  try {
    const cliDir = dirname(fileURLToPath(import.meta.url));
    const packageJsonPath = join(cliDir, "..", "package.json");
    const parsed = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as { version?: unknown };
    if (typeof parsed.version === "string" && parsed.version.trim().length > 0) {
      return parsed.version.trim();
    }
  } catch {
    // Fall back to a safe placeholder if package metadata is unavailable.
  }
  return "0.0.0";
}

const program = new Command();

program.name("rusa").description("Autonomous coding agent orchestrator").version(readCliVersion());

program
  .command("init")
  .description("Set up rusa configuration")
  .option("--non-interactive", "Run without prompts (requires --config or --defaults)")
  .option("--config <path>", "Path to a YAML/JSON config file to write")
  .option("--defaults", "Use safe defaults in non-interactive mode")
  .option("--home <path>", "Override RUSA_HOME for this init")
  .action(
    async (opts: {
      nonInteractive?: boolean;
      config?: string;
      defaults?: boolean;
      home?: string;
    }) => {
      await runInit({
        nonInteractive: opts.nonInteractive,
        configPath: opts.config,
        defaults: opts.defaults,
        home: opts.home,
      });
    }
  );

program
  .command("config")
  .description("Explain the config.yaml file format")
  .addHelpText("after", `\n${CONFIG_DOCS.trimEnd()}`)
  .action(() => {
    printConfigDocs();
  });

program
  .command("start")
  .description("Start the orchestrator")
  .option(
    "--deploy-on-merge-branch <branch>",
    "Auto-deploy this rusa instance when the repository receives a push on the given branch"
  )
  .option("--profile <name>", "Apply a named config profile")
  .action(async (opts: { deployOnMergeBranch?: string; profile?: string }) => {
    await runStart({
      deployOnMergeBranch: opts.deployOnMergeBranch,
      profile: opts.profile,
    });
  });

const quickstart = program
  .command("quickstart")
  .description("Build and run a local Docker quickstart container")
  .option("--image <name>", "Docker image tag to build/run", "rusa:quickstart")
  .option("--container <name>", "Docker container name", "rusa-quickstart")
  .option("--volume <name>", "Docker volume for RUSA_HOME", "rusa-quickstart-home")
  .option("--no-build", "Skip docker build and run an existing image")
  .option(
    "--reconfigure",
    "Re-run interactive configuration wizard even if volume is already configured"
  )
  .action(
    async (opts: {
      image: string;
      container: string;
      volume: string;
      build: boolean;
      reconfigure?: boolean;
    }) => {
      await runQuickstart({
        image: opts.image,
        container: opts.container,
        volume: opts.volume,
        skipBuild: opts.build === false,
        reconfigure: opts.reconfigure,
      });
    }
  );

quickstart
  .command("configure")
  .description("Run the in-container quickstart credential/config wizard")
  .option("--home <path>", "Override RUSA_HOME for this setup")
  .action(async (opts: { home?: string }) => {
    await runQuickstartConfigure({ home: opts.home });
  });

// NB: the IU distiller cursor ops (seed/gate/window/advance/mode) are actor-invoked, so
// they live in the distiller MCP , NOT the CLI — per the convention that
// actor-invoked operations go through MCP, reserving the `rusa` CLI for operator/deploy
// use (ISSUE_NUM/ISSUE_NUM). The former `distill` CLI subcommand was removed as redundant residue.

program
  .command("chat")
  .description("Open a turn-based terminal chat with an existing mesh actor")
  .argument("<actor>", "Actor thread id or handle")
  .option("--url <url>", "Dashboard/API base URL (defaults to the configured local dashboard)")
  .option("--home <path>", "Rusa home used to resolve the local dashboard")
  .option(
    "--history <n>",
    "Recent messages to show",
    (value: string) => Number.parseInt(value, 10),
    20
  )
  .action(async (actor: string, opts: { url?: string; home?: string; history: number }) => {
    await runActorChat({
      actor,
      url: opts.url,
      home: opts.home,
      history: opts.history,
    });
  });

program
  .command("chat-smoke")
  .description("Run the Google Chat inbound puller standalone (diagnostic; no orchestrator)")
  .action(async () => {
    await runChatSmoke();
  });

program
  .command("dev")
  .description("Start with a fresh database against ~/.rusa-test (development mode)")
  .option("--keep-db", "Keep the existing database instead of clearing it")
  .option(
    "--no-dashboard-server",
    "Do not bind the separate dashboard server; serve API routes on webhook port"
  )
  .action(async (opts: { keepDb?: boolean; dashboardServer?: boolean }) => {
    await runDev({
      keepDb: opts.keepDb,
      noDashboardServer: opts.dashboardServer === false,
    });
  });

program
  .command("stop")
  .description("Stop the orchestrator service")
  .option("--environment <environment>", "Service environment: production or staging", "production")
  .action(async (opts: { environment: ServiceEnvironment }) => {
    await runServiceStop({ environment: opts.environment });
  });

program
  .command("status")
  .description("Show orchestrator status")
  .option("--environment <environment>", "Service environment: production or staging", "production")
  .action(async (opts: { environment: ServiceEnvironment }) => {
    await runServiceStatus({ environment: opts.environment });
  });

program
  .command("logs")
  .description("Tail the log file")
  .option("--environment <environment>", "Service environment: production or staging", "production")
  .action(async (opts: { environment: ServiceEnvironment }) => {
    await runLogs({ environment: opts.environment });
  });

program
  .command("install-service")
  .description("Install as a systemd service")
  .option("--environment <environment>", "Service environment: production or staging", "production")
  .option("--deployment-mode <mode>", "Executable source: package or self", "package")
  .option("--repo-path <path>", "Repo root or package directory to use for self deployment mode")
  .option(
    "--no-restart",
    "write/enable units and reload systemd, but do not restart running instances"
  )
  .action(
    async (opts: {
      environment: ServiceEnvironment;
      deploymentMode: DeploymentMode;
      repoPath?: string;
      restart: boolean;
    }) => {
      await runInstallService({
        environment: opts.environment,
        deploymentMode: opts.deploymentMode,
        repoPath: opts.repoPath,
        restart: opts.restart,
      });
    }
  );

program
  .command("e2e")
  .description("Run a disposable actor-mesh instance with local test controls")
  .option("--root <path>", "Use a specific root directory instead of a fresh tempdir")
  .option("--resume", "Resume an existing instance root without reprovisioning")
  .option("--base-config-home <path>", "Home to seed providers and the Gemini key from")
  .option("--root-driver <driver>", "Root driver: provider or external", "provider")
  .option("--root-control-port <port>", "External root control HTTP port", (value) =>
    Number.parseInt(value, 10)
  )
  .action(
    async (opts: {
      root?: string;
      baseConfigHome?: string;
      rootDriver: string;
      rootControlPort?: number;
      resume?: boolean;
    }) => {
      if (opts.rootDriver !== "provider" && opts.rootDriver !== "external") {
        throw new Error("--root-driver must be provider or external");
      }
      await runActorMeshE2EUp({
        root: opts.root,
        baseConfigHome: opts.baseConfigHome,
        rootDriver: opts.rootDriver,
        rootControlPort: opts.rootControlPort,
        resume: opts.resume,
      });
    }
  );

program
  .command("uninstall-service")
  .description("Uninstall the systemd service")
  .option("--environment <environment>", "Service environment: production or staging", "production")
  .action(async (opts: { environment: ServiceEnvironment }) => {
    await runUninstallService({ environment: opts.environment });
  });

program
  .command("restart")
  .description("Restart the orchestrator service")
  .option("--environment <environment>", "Service environment: production or staging", "production")
  .action(async (opts: { environment: ServiceEnvironment }) => {
    await runServiceRestart({ environment: opts.environment });
  });

program
  .command("dashboard")
  .description("Launch the Rusa dashboard in your browser")
  .action(async () => {
    await runDashboard();
  });

program
  .command("report")
  .description("Generate a self-contained HTML report of the actor mesh's activity")
  .option("--home <path>", "Rusa home to read (defaults to RUSA_HOME or ~/.rusa)")
  .option("--out <file>", "Output HTML path (default: <repo>/e2e-reports/mesh-report.html)")
  .action((opts: { home?: string; out?: string }) => {
    runReport({ home: opts.home, out: opts.out });
  });

program
  .command("forward-webhooks")
  .description("Fan out GitHub webhook requests to one or more local rusa instances")
  .requiredOption(
    "--target <url>",
    "Downstream webhook URL",
    (value: string, acc: string[]) => {
      acc.push(value);
      return acc;
    },
    []
  )
  .option("--host <host>", "Host/interface to listen on", "0.0.0.0")
  .option("--port <port>", "Port to listen on", (value: string) => Number.parseInt(value, 10), 9742)
  .action(async (opts: { target: string[]; host: string; port: number }) => {
    await runForwardWebhooks({
      host: opts.host,
      port: opts.port,
      targets: opts.target,
    });
  });

const understanding = program
  .command("understanding")
  .description("Manage integrated understanding and knowledge domains");

understanding
  .command("recompute")
  .description("Reset distillation state and re-process raw inputs")
  .option("--since <date>", "Only recompute inputs created after this ISO-8601 date")
  .action(async (opts: { since?: string }) => {
    await runUnderstandingRecompute(opts);
  });

const understandingEval = understanding
  .command("eval")
  .description("Evaluate distillation against a sandbox copy of the DB");

understandingEval
  .command("distill")
  .description("Run distillation against a sandbox copy and show what would change")
  .option("--keep", "Keep the sandbox DB after the run for manual inspection")
  .action(async (opts: { keep: boolean }) => {
    await runUnderstandingEvalDistill(opts);
  });

understandingEval
  .command("extract-ops")
  .description("Extract the flat WireOp list from a replay file into ops.json")
  .requiredOption("--replay-file <path>", "Path to the source replay JSON file")
  .option("--output <path>", "Output path (default: ops.json in cwd)")
  .action(async (opts: { replayFile: string; output?: string }) => {
    runExtractOps(opts);
  });

understandingEval
  .command("retrieve")
  .description("Evaluate retrieval quality by running searchNodes against all raw inputs")
  .option("--limit <n>", "Number of raw inputs to process", (v: string) => parseInt(v, 10))
  .option("--llm", "Also run LLM-based retrieval and show results side by side (costs API calls)")
  .option("--retrieval-model <model>", "Model to use for LLM retrieval (default: gemini-2.5-flash)")
  .action(async (opts: { limit?: number; llm?: boolean; retrievalModel?: string }) => {
    await runEvalRetrieve(opts);
  });

understandingEval
  .command("replay")
  .description(
    "Replay distillation from scratch in batches and open an interactive timeline viewer"
  )
  .option("--batch-size <n>", "Number of raw inputs per step", (v: string) => parseInt(v, 10), 10)
  .option("--batches <n>", "Limit the number of batches to replay", (v: string) => parseInt(v, 10))
  .option("--port <n>", "Port for the viewer server", (v: string) => parseInt(v, 10), 7429)
  .option("--keep", "Keep the sandbox DB after the run for manual inspection")
  .option("--replay-file <path>", "Path to the replay JSON file")
  .option("--days <n>", "Limit the number of days to replay", (v: string) => parseInt(v, 10))
  .option("--no-browser", "Skip opening the browser viewer and exit cleanly after replay completes")
  .action(
    async (opts: {
      batchSize: number;
      batches?: number;
      port: number;
      keep: boolean;
      replayFile?: string;
      days?: number;
      browser?: boolean;
    }) => {
      await runUnderstandingEvalReplay(opts);
    }
  );

program.parse();
