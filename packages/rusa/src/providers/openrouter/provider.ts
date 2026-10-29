import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { resolveHome } from "../../config/secrets.js";
import type { ProviderConfig } from "../../config/types.js";
import { createLogger, type Logger } from "../../observability/logger.js";
import {
  buildActorBwrapArgs,
  buildActorBwrapCommand,
  buildToolchainPath,
  teardownFlutterOverlay,
} from "../sandbox.js";
import { runSubprocess, type SubprocessDuplex } from "../subprocess-execution.js";
import { formatSigtermResult } from "../termination-attribution.js";
import type { CodingProvider, RunOptions, RunResult } from "../types.js";
import { mcpAdmissionExtension } from "./mcp-admission.js";
import { PiRpcInvocation, type PiRpcOutcome } from "./pi-rpc.js";

let _openrouterLogger: Logger | undefined;
export function setOpenRouterLogger(logger: Logger | undefined): void {
  _openrouterLogger = logger;
}
function openrouterLog(): Logger {
  _openrouterLogger ??= createLogger({ context: { component: "openrouter" } });
  return _openrouterLogger;
}

/** Fresh Pi process, portable context, built-in and MCP tools.
 * Worker launches use the shared actor bwrap boundary with isolated Pi state.
 * Usage stays in an internal artifact, outside subscription accounting and quota pacing.
 */
export class OpenRouterProvider implements CodingProvider {
  readonly providerName = "openrouter";

  constructor(
    public readonly name: string,
    private readonly config: ProviderConfig,
    public readonly model?: string
  ) {}

  async run(opts: RunOptions): Promise<RunResult> {
    const tempPaths: string[] = opts.sandbox?.understandingMount
      ? [opts.sandbox.understandingMount]
      : [];
    let transport: SubprocessDuplex | undefined;
    let invocation: PiRpcInvocation | undefined;
    let outcome: Promise<PiRpcOutcome> | undefined;
    const failed = (reason: string): RunResult => {
      invocation?.fail(reason);
      return { success: false, output: reason, exitCode: 1 };
    };
    try {
      if (!this.model) throw new Error("OpenRouter requires a model");
      if (opts.session?.id || opts.computerUse) {
        throw new Error("OpenRouter supports fresh runs without computer use only");
      }
      const actorCwd = resolve(opts.cwd);
      const authDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
      const authPath = resolve(authDir, "auth.json");
      try {
        const auth = JSON.parse(await readFile(authPath, "utf8"));
        const entry = auth?.openrouter;
        const key =
          entry?.type === "oauth"
            ? entry.access
            : entry?.type === "api_key"
              ? entry.key
              : undefined;
        if (typeof key !== "string" || !key.trim() || key.startsWith("!")) throw new Error();
      } catch {
        throw new Error("OpenRouter authentication required: launch pi and run /login openrouter");
      }
      const root = await mkdtemp(join(tmpdir(), "rusa-openrouter-"));
      tempPaths.push(root);
      const agent = join(root, "agent");
      await mkdir(agent, { mode: 0o700 });
      // Unsandboxed Pi uses the operator-managed profile directly. Workers receive
      // a read-only bind below, never a copied credential or secret-file grant.
      if (!opts.sandbox) await symlink(authPath, join(agent, "auth.json"));
      await writeFile(
        join(agent, "settings.json"),
        JSON.stringify({
          cacheWarming: "off",
          retry: { enabled: false },
          compaction: { enabled: false },
        }),
        { mode: 0o600 }
      );
      await writeFile(
        join(agent, "mcp.json"),
        JSON.stringify({
          mcpServers: Object.fromEntries(
            (opts.mcpServers ?? []).map((server) => [
              server.name,
              { url: server.url, exposure: "direct" },
            ])
          ),
        }),
        { mode: 0o600 }
      );
      const admissionPath = join(root, "mcp-admission.mjs");
      await writeFile(
        admissionPath,
        mcpAdmissionExtension((opts.mcpServers ?? []).map((s) => s.name)),
        { mode: 0o600 }
      );
      const args = [
        "--mode",
        "rpc",
        "--no-session",
        "--no-extensions",
        "-e",
        "builtin:mcp",
        "-e",
        admissionPath,
        "--no-skills",
        "--no-prompt-templates",
        "--no-context-files",
        "--no-themes",
        "--no-approve",
        "--provider",
        "openrouter",
        "--model",
        this.model,
      ];
      let command = this.config.cliCommand ?? "pi";
      let spawnArgs = args;
      if (opts.sandbox) {
        const sandbox = buildActorBwrapArgs(
          opts.sandbox.worktreePath,
          undefined,
          undefined,
          opts.sandbox.isE2eRoot,
          opts.sandbox.understandingMount
        );
        tempPaths.push(...sandbox.tempPaths);
        // The shared launcher shadows host /tmp. Rebind only this invocation's
        // private Pi state. Its established actor cwd stays intact so repository
        // discovery and durable workspace changes belong to the actor, not /tmp.
        sandbox.args.push("--bind", root, root, "--ro-bind", authPath, join(agent, "auth.json"));
        spawnArgs = buildActorBwrapCommand(sandbox, command, args);
        command = "bwrap";
      }
      const processResult = await runSubprocess({
        command,
        args: spawnArgs,
        // bwrap's own --chdir selects the same actor directory after mounts are
        // established. Outside bwrap, launch Pi directly from that resolved cwd.
        cwd: opts.sandbox ? "/" : actorCwd,
        // Pi receives only its selected saved login and actor-bound MCP URLs.
        env: {
          HOME: root,
          PI_CODING_AGENT_DIR: agent,
          NODE_COMPILE_CACHE: join(root, "cache"),
          PI_SKIP_VERSION_CHECK: "1",
          PI_TELEMETRY: "0",
          // Same toolchain PATH the shared profile builds. Under bwrap the
          // launcher's own --setenv PATH takes precedence.
          PATH: buildToolchainPath(),
          // HOME stays private to this invocation, which would hide the git and
          // gh configuration the shared profile binds at the real home. Name
          // those paths directly so pushes keep the gh credential helper.
          GIT_CONFIG_GLOBAL: join(homedir(), ".gitconfig"),
          GH_CONFIG_DIR: join(homedir(), ".config", "gh"),
        },
        // The actor owns invocation timing. Its deadline includes the shared
        // watchdog policy and a subprocess grace margin; an adapter-local cap
        // would turn a healthy run into an unrelated provider timeout.
        timeoutMs: opts.timeoutMs ?? 120_000,
        signal: opts.signal,
        onSpawn: () => opts.onPromptLaunched?.(opts.prompt),
        onDuplex: (value) => {
          transport = value;
          invocation = new PiRpcInvocation(
            value,
            this.model as string,
            undefined,
            undefined,
            // Liveness is a separate empty chunk. Pi protocol records are parsed
            // into safe, readable output instead of showing a stream of dots.
            () => opts.onChunk?.(""),
            (chunk) => opts.onChunk?.(chunk)
          );
          outcome = invocation.run(opts.prompt);
        },
        handleStdoutData: (chunk) => {
          invocation?.acceptStdout(chunk);
        },
        onStdoutEnd: (_chunks, cause) => {
          if (cause === "eof") invocation?.endStdout();
          else void invocation?.cancel();
        },
        handleStderrData: () => {},
        buildKilledResult: (termination) => ({ success: false, ...termination }),
        buildSignalResult: () => failed("Pi process signalled"),
        buildExitResult: () => failed("Pi process exited before settlement"),
        buildSpawnErrorResult: () => failed("Pi could not start"),
      });
      await transport?.close();
      if (!outcome) return processResult;
      const result = await outcome;
      // Harness observations only. Do not mislabel these as subscription tokens
      // or OpenRouter billed cost. Retain across process cleanup for review.
      // The receipt is diagnostic: failing to write it must not change the run.
      try {
        const artifactDir = join(resolveHome(), "artifacts", "openrouter");
        await mkdir(artifactDir, { recursive: true, mode: 0o700 });
        await writeFile(
          join(artifactDir, `usage-${randomUUID()}.json`),
          JSON.stringify(
            { success: result.success, reason: result.reason, requests: result.requests },
            null,
            2
          ),
          { mode: 0o600, flag: "wx" }
        );
      } catch (error) {
        openrouterLog().warn("openrouter_usage_receipt_not_written", { err: error });
      }
      const output = result.success ? result.output : (result.reason ?? "Pi failed");
      // A duplex invocation has its own semantic outcome, but subprocess-execution
      // owns termination attribution. Preserve both when the host ended the process:
      // the canonical cancelled result controls the terminal state, while Pi's reason
      // remains useful failure diagnosis instead of being replaced by a bare marker.
      // A normally settled Pi invocation closes its deliberately long-lived
      // subprocess as cleanup, which also yields a cancelled process result.
      // That cleanup must not rewrite a real success or ordinary Pi failure.
      // The host-triggered cancellation path explicitly settles Pi as cancelled.
      // Keep that fact structured instead of coupling this adapter to its diagnosis
      // text: the subprocess result is the canonical terminal attribution, while
      // Pi's reason is useful context for the person reading it.
      if (processResult.cancelled && result.cancelled) {
        return {
          ...processResult,
          success: false,
          output: [result.reason, processResult.output].filter(Boolean).join("\n"),
        };
      }
      // A caller may abort after Pi has settled and its deliberately long-lived
      // subprocess has been reaped. In that narrow window, construct every
      // terminal field from the caller signal rather than combining its marker
      // with the prior cleanup result's unattributed fields.
      if (opts.signal?.aborted) {
        return { success: false, ...formatSigtermResult(output, opts.signal) };
      }
      return {
        success: result.success,
        output,
        exitCode: result.success ? 0 : 1,
        // Pi message.model is a configuration echo, not upstream read-back.
      };
    } finally {
      await transport?.close();
      if (opts.sandbox) teardownFlutterOverlay(opts.sandbox.worktreePath);
      await Promise.all(tempPaths.map((path) => rm(path, { recursive: true, force: true })));
    }
  }
}
