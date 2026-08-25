import { spawn } from "node:child_process";
import { formatSigtermResult, type TerminationAttribution } from "./termination-attribution.js";
import type { RunResult } from "./types.js";

/**
 * Shared lifecycle for a detached, process-grouped subprocess run.
 *
 * Providers parameterize the parts that differ (stdout/stderr handling, result
 * shaping) while this helper owns the load-bearing mechanics: spawn, group kill,
 * timeout, cancellation listener attach/detach, and settlement ordering.
 */
export interface SubprocessRunConfig {
  command: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  signal?: AbortSignal;
  onChunk?: (chunk: string) => void;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
  /** Replace the default raw stdout capture. */
  handleStdoutData?: (data: Buffer, chunks: string[]) => void;
  /** Replace the default raw stderr capture. */
  handleStderrData?: (data: Buffer, chunks: string[]) => void;
  /** Optional stdout end hook (e.g. flushing a line buffer). */
  onStdoutEnd?: (chunks: string[]) => void;
  cleanup?: () => void;
  buildKilledResult: (sigtermResult: TerminationAttribution) => RunResult;
  buildSignalResult: (sigtermResult: TerminationAttribution, signal: NodeJS.Signals) => RunResult;
  buildExitResult: (output: string, exitCode: number) => RunResult;
  buildSpawnErrorResult: (err: Error) => RunResult;
}

export function runSubprocess(config: SubprocessRunConfig): Promise<RunResult> {
  return new Promise<RunResult>((resolve) => {
    const chunks: string[] = [];

    // `detached: true` makes the child its own process-group leader so we can
    // signal the whole group with `process.kill(-pid, ...)`, reaping any
    // grandchildren the CLI spawned (interactive shells, subprocesses, etc.).
    const child = spawn(config.command, config.args, {
      cwd: config.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
      // Do NOT pass `timeout:` here — Node's spawn timeout signals only the
      // direct child, leaving the rest of the detached group alive. We own the
      // timeout via `setTimeout` below instead.
    });

    const killGroup = () => {
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          /* group already gone — ESRCH is the normal race */
        }
      }
    };

    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const settle = (resolvedValue: RunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      config.signal?.removeEventListener("abort", onAbort);
      config.cleanup?.();
      resolve(resolvedValue);
    };

    // Own the timeout in Node (not spawn's `timeout`, whose SIGTERM leaves the
    // detached group alive) so we can kill the whole group on expiry.
    timer = setTimeout(() => {
      killGroup();
      const sigtermResult = formatSigtermResult(chunks.join(""), config.signal);
      settle(config.buildKilledResult(sigtermResult));
    }, config.timeoutMs);

    const onAbort = () => {
      killGroup();
      const sigtermResult = formatSigtermResult(chunks.join(""), config.signal);
      settle(config.buildKilledResult(sigtermResult));
    };
    if (config.signal?.aborted) {
      // Signal was already aborted before we registered — handle immediately.
      onAbort();
      return;
    }
    config.signal?.addEventListener("abort", onAbort);

    child.stdout.on("data", (data: Buffer) => {
      if (config.handleStdoutData) {
        config.handleStdoutData(data, chunks);
      } else {
        const text = data.toString();
        config.onStdout?.(text);
        chunks.push(text);
        config.onChunk?.(text);
      }
    });

    if (config.onStdoutEnd) {
      const onEnd = config.onStdoutEnd;
      child.stdout.on("end", () => {
        onEnd(chunks);
      });
    }

    child.stderr.on("data", (data: Buffer) => {
      if (config.handleStderrData) {
        config.handleStderrData(data, chunks);
      } else {
        const text = data.toString();
        config.onStderr?.(text);
        chunks.push(text);
        config.onChunk?.(text);
      }
    });

    child.on("error", (err) => {
      killGroup();
      settle(config.buildSpawnErrorResult(err));
    });

    child.on("close", (code, signal) => {
      // Check if the process was terminated by a kill signal from our paths.
      if (signal === "SIGTERM" || signal === "SIGKILL") {
        const sigtermResult = formatSigtermResult(chunks.join(""), config.signal);
        settle(config.buildSignalResult(sigtermResult, signal));
        return;
      }
      const exitCode = code ?? 1;
      settle(config.buildExitResult(chunks.join(""), exitCode));
    });
  });
}
