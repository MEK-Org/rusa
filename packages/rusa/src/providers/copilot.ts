import { rmSync } from "node:fs";
import type { ProviderConfig } from "../config/types.js";
import { buildActorBwrapArgs, buildActorBwrapCommand, teardownFlutterOverlay } from "./sandbox.js";
import { runSubprocess } from "./subprocess-execution.js";
import type { CodingProvider, RunOptions, RunResult } from "./types.js";

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

/**
 * GitHub Copilot CLI provider.
 * Spawns `copilot explain "<prompt>"` or similar based on usage.
 * Assuming non-interactive mode is needed.
 */
export class CopilotProvider implements CodingProvider {
  public readonly providerName = "copilot";

  constructor(
    public readonly name: string,
    private readonly config: ProviderConfig,
    public readonly model?: string
  ) {}

  async run(opts: RunOptions): Promise<RunResult> {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const command = this.config.cliCommand ?? "copilot";

    const args = ["--allow-all-tools", "--prompt", opts.prompt];

    if (this.model) {
      args.push("--model", this.model);
    }

    let spawnCommand = command;
    let spawnArgs = args;
    const spawnCwd = opts.sandbox ? "/" : opts.cwd;
    const tempPaths: string[] = [];

    if (opts.sandbox) {
      const bwrapResult = buildActorBwrapArgs(
        opts.sandbox.worktreePath,
        "copilot",
        undefined,
        opts.sandbox.isE2eRoot,
        opts.sandbox.understandingMount,
        opts.sandbox.e2eWritableRemoteDir
      );
      tempPaths.push(...bwrapResult.tempPaths);
      if (opts.sandbox.understandingMount) {
        tempPaths.push(opts.sandbox.understandingMount);
      }
      spawnArgs = buildActorBwrapCommand(bwrapResult, command, args);
      spawnCommand = "bwrap";
    }

    const cleanupTempPaths = () => {
      for (const p of tempPaths) {
        try {
          rmSync(p, { recursive: true, force: true });
        } catch {
          /* best effort */
        }
      }
      tempPaths.length = 0;
      if (opts.sandbox) {
        teardownFlutterOverlay(opts.sandbox.worktreePath);
      }
    };

    return runSubprocess({
      command: spawnCommand,
      args: spawnArgs,
      cwd: spawnCwd,
      timeoutMs,
      signal: opts.signal,
      onChunk: opts.onChunk,
      cleanup: cleanupTempPaths,
      buildKilledResult: ({
        output,
        exitCode,
        cancelled,
        interrupted,
        interruptSource,
        graceKilled,
      }) => ({
        success: false,
        output,
        exitCode,
        cancelled,
        interrupted,
        interruptSource,
        graceKilled,
      }),
      buildSignalResult: ({
        output,
        exitCode,
        cancelled,
        interrupted,
        interruptSource,
        graceKilled,
      }) => ({
        success: false,
        output,
        exitCode,
        cancelled,
        interrupted,
        interruptSource,
        graceKilled,
      }),
      buildExitResult: (output, exitCode) => ({
        success: exitCode === 0,
        output,
        exitCode,
      }),
      buildSpawnErrorResult: (err) => ({
        success: false,
        output: `Failed to spawn copilot: ${err.message}`,
        exitCode: 1,
      }),
    });
  }
}
