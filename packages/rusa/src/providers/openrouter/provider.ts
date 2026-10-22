import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ProviderConfig } from "../../config/types.js";
import { buildActorBwrapArgs, buildActorBwrapCommand, teardownFlutterOverlay } from "../sandbox.js";
import { runSubprocess, type SubprocessDuplex } from "../subprocess-execution.js";
import type { CodingProvider, RunOptions, RunResult } from "../types.js";
import { mcpAdmissionExtension } from "./mcp-admission.js";
import { PiRpcInvocation, type PiRpcOutcome } from "./pi-rpc.js";

/** Local end-to-end prototype. Fresh Pi process, portable context, built-in and MCP tools.
 * Worker launches use the shared actor bwrap boundary with isolated Pi state.
 * Usage stays in an artifact, outside subscription accounting and quota pacing.
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
      const config = this.config.openrouterPoc;
      if (process.env.RUSA_OPENROUTER_POC !== "1" || !config || !this.model) {
        throw new Error(
          "OpenRouter prototype requires RUSA_OPENROUTER_POC=1, explicit paths and model"
        );
      }
      if (opts.session?.id || opts.computerUse) {
        throw new Error("OpenRouter prototype supports fresh runs without computer use only");
      }
      const authDir =
        config.authDir ?? process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
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
      const work = join(root, "work");
      await mkdir(agent, { mode: 0o700 });
      await mkdir(work, { mode: 0o700 });
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
      let command = config.piCommand ?? "pi";
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
        // private state, then override its actor cwd to avoid Pi migrations.
        sandbox.args.push(
          "--bind",
          root,
          root,
          "--ro-bind",
          authPath,
          join(agent, "auth.json"),
          "--chdir",
          work
        );
        spawnArgs = buildActorBwrapCommand(sandbox, command, args);
        command = "bwrap";
      }
      const processResult = await runSubprocess({
        command,
        args: spawnArgs,
        cwd: work,
        // Pi receives the operator-managed login and actor-bound MCP URLs.
        // Empty cwd avoids Pi startup migration of the actor workspace.
        env: {
          HOME: root,
          PI_CODING_AGENT_DIR: agent,
          NODE_COMPILE_CACHE: join(root, "cache"),
          PI_SKIP_VERSION_CHECK: "1",
          PI_TELEMETRY: "0",
          PATH: process.env.PATH,
        },
        timeoutMs: Math.min(opts.timeoutMs ?? 120_000, 120_000),
        signal: opts.signal,
        onSpawn: () => opts.onPromptLaunched?.(opts.prompt),
        onDuplex: (value) => {
          transport = value;
          invocation = new PiRpcInvocation(value, this.model as string);
          outcome = invocation.run(opts.prompt);
        },
        handleStdoutData: (chunk) => {
          invocation?.acceptStdout(chunk);
          // Progress without publishing raw RPC/tool records or credentials.
          opts.onChunk?.(".");
        },
        onStdoutEnd: (_chunks, cause) => {
          if (cause === "eof") invocation?.endStdout();
        },
        handleStderrData: () => {},
        buildKilledResult: () => failed("Pi prototype deadline or cancellation"),
        buildSignalResult: () => failed("Pi prototype process signalled"),
        buildExitResult: () => failed("Pi prototype process exited before settlement"),
        buildSpawnErrorResult: () => failed("Pi prototype could not start"),
      });
      await transport?.close();
      if (!outcome) return processResult;
      const result = await outcome;
      // Harness observations only. Do not mislabel these as subscription tokens
      // or OpenRouter billed cost. Retain across process cleanup for review.
      const artifactDir = config.artifactDir;
      if (artifactDir) {
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
      }
      return {
        success: result.success,
        output: result.success ? result.output : (result.reason ?? "Pi failed"),
        exitCode: result.success ? 0 : 1,
        // The process's own settlement is the run's termination evidence.
        termination: processResult.termination,
        // Pi message.model is a configuration echo, not upstream read-back.
        ...(opts.signal?.aborted
          ? { cancelled: true, abortReason: processResult.abortReason }
          : {}),
      };
    } finally {
      await transport?.close();
      if (opts.sandbox) teardownFlutterOverlay(opts.sandbox.worktreePath);
      await Promise.all(tempPaths.map((path) => rm(path, { recursive: true, force: true })));
    }
  }
}
