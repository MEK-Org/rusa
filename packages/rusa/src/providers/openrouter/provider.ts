import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderConfig } from "../../config/types.js";
import { runSubprocess, type SubprocessDuplex } from "../subprocess-execution.js";
import type { CodingProvider, RunOptions, RunResult } from "../types.js";
import { PiRpcInvocation, type PiRpcOutcome } from "./pi-rpc.js";

/** Local end-to-end prototype. Fresh Pi process, portable context, MCP-only tools.
 * Requires host execution; refuses sandbox requests until the launch boundary
 * is integrated. This is not a sandbox implementation.
 * Usage stays in an artifact, outside subscription accounting and quota pacing.
 */
export class OpenRouterProvider implements CodingProvider {
  readonly providerName = "openrouter";

  constructor(
    public readonly name: string,
    private readonly config: ProviderConfig,
    public readonly model?: string,
    public readonly effort?: string
  ) {}

  async run(opts: RunOptions): Promise<RunResult> {
    const config = this.config.openrouterPoc;
    if (process.env.RUSA_OPENROUTER_POC !== "1" || !config || !this.model) {
      throw new Error(
        "OpenRouter prototype requires RUSA_OPENROUTER_POC=1, explicit paths and model"
      );
    }
    if (opts.sandbox || opts.session?.id || opts.computerUse) {
      throw new Error("OpenRouter prototype supports fresh host runs only");
    }
    const keyStat = await stat(config.apiKeyPath);
    if (!keyStat.isFile() || (keyStat.mode & 0o077) !== 0) {
      throw new Error("OpenRouter key must be a private file (mode 600 or stricter)");
    }
    const key = (await readFile(config.apiKeyPath, "utf8")).trim();
    if (!key) throw new Error("OpenRouter key file is empty");
    const root = await mkdtemp(join(tmpdir(), "rusa-openrouter-"));
    let transport: SubprocessDuplex | undefined;
    let invocation: PiRpcInvocation | undefined;
    let outcome: Promise<PiRpcOutcome> | undefined;
    const failed = (reason: string): RunResult => {
      invocation?.fail(reason);
      return { success: false, output: reason, exitCode: 1 };
    };
    try {
      const agent = join(root, "agent");
      const work = join(root, "work");
      await mkdir(agent, { mode: 0o700 });
      await mkdir(work, { mode: 0o700 });
      await writeFile(
        join(agent, "settings.json"),
        JSON.stringify({
          cacheWarming: { enabled: false },
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
      const args = [
        config.piPath,
        "--mode",
        "rpc",
        "--no-session",
        "--no-builtin-tools",
        "--no-extensions",
        "-e",
        "builtin:mcp",
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
      if (this.effort) args.push("--thinking", this.effort);
      const processResult = await runSubprocess({
        command: config.nodePath,
        args,
        cwd: work,
        // The model receives only its inference key and actor-bound MCP URLs.
        // Empty cwd avoids Pi startup migration of the actor workspace.
        env: {
          HOME: root,
          PI_CODING_AGENT_DIR: agent,
          NODE_COMPILE_CACHE: join(root, "cache"),
          PI_SKIP_VERSION_CHECK: "1",
          PI_TELEMETRY: "0",
          OPENROUTER_API_KEY: key,
        },
        timeoutMs: Math.min(opts.timeoutMs ?? 120_000, 120_000),
        signal: opts.signal,
        onSpawn: () => opts.onPromptLaunched?.(opts.prompt),
        onDuplex: (value) => {
          transport = value;
          invocation = new PiRpcInvocation(value, this.model as string, this.effort);
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
      await mkdir(join(opts.cwd, ".openrouter-poc"), { recursive: true, mode: 0o700 });
      await writeFile(
        join(opts.cwd, ".openrouter-poc", `usage-${Date.now()}.json`),
        JSON.stringify(
          { success: result.success, reason: result.reason, requests: result.requests },
          null,
          2
        ),
        { mode: 0o600 }
      );
      return {
        success: result.success,
        output: result.success ? result.output : (result.reason ?? "Pi failed"),
        exitCode: result.success ? 0 : 1,
        model: result.requests.at(-1)?.reportedModel,
        ...(opts.signal?.aborted
          ? { cancelled: true, abortReason: processResult.abortReason }
          : {}),
      };
    } finally {
      await transport?.close();
      await rm(root, { recursive: true, force: true });
    }
  }
}
