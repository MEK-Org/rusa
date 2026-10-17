import { type ChildProcessByStdio, spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { formatSigtermResult, type TerminationAttribution } from "./termination-attribution.js";
import type { RunResult } from "./types.js";

/**
 * Reduce a synchronous spawn rejection to what is safe to put in a run record.
 *
 * Node's own message quotes the rejected value (up to 128 inspected characters)
 * and its stack repeats it, so for a provider launch the raw error can be a
 * verbatim slice of the prompt. Only the actionable identifiers survive: the
 * error class and Node's stable code. The original is deliberately NOT attached
 * as `cause` either — a serializer that walks the cause chain would put the
 * quoted value straight back into the record. Total, so an unrecognizable throw
 * still settles the run as a stated launch failure rather than escaping into
 * the generic terminal-failure path with its stack, argv and all (#206).
 */
function describeSpawnRejection(err: unknown): Error {
  const errorClass = err instanceof Error ? err.name : typeof err;
  const code = (err as { code?: unknown } | null)?.code;
  const classification = typeof code === "string" ? `${errorClass} [${code}]` : errorClass;
  return new Error(
    "process-argument validation rejected this launch before the CLI started " +
      `(${classification}); argument values withheld`
  );
}

export interface SubprocessDuplex {
  /** Resolves when Node invokes the stdin write callback, without peer acknowledgment. */
  write(record: string): Promise<void>;
  /** Close stdin, kill the process group, and await the direct child close event. */
  close(): Promise<void>;
}

export interface SubprocessRunConfig {
  /** Opt into piped stdin. Called after onSpawn, with lifecycle handlers attached. */
  onDuplex?: (transport: SubprocessDuplex) => void;
  command: string;
  args: string[];
  cwd: string;
  /** Child environment; inherits this process's when omitted. */
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
  signal?: AbortSignal;
  onChunk?: (chunk: string) => void;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
  /** Replace the default raw stdout capture. */
  handleStdoutData?: (data: Buffer, chunks: string[]) => void;
  /** Replace the default raw stderr capture. */
  handleStderrData?: (data: Buffer, chunks: string[]) => void;
  /** Flush stdout on EOF or termination. Actual pipe EOF may follow our own kill signal. */
  onStdoutEnd?: (chunks: string[], cause: "eof" | "termination") => void;
  cleanup?: () => void;
  /** Best-effort observation; called only after Node reports a successful spawn. */
  onSpawn?: () => void;
  buildKilledResult: (sigtermResult: TerminationAttribution) => RunResult;
  buildSignalResult: (sigtermResult: TerminationAttribution, signal: NodeJS.Signals) => RunResult;
  buildExitResult: (output: string, exitCode: number) => RunResult;
  buildSpawnErrorResult: (err: Error) => RunResult;
}

/**
 * Shared lifecycle for a detached, process-grouped subprocess run.
 *
 * Providers parameterize the parts that differ (stdout/stderr handling, result
 * shaping) while this helper owns the load-bearing mechanics: spawn, group kill,
 * timeout, cancellation listener attach/detach, and settlement ordering.
 */
export function runSubprocess(config: SubprocessRunConfig): Promise<RunResult> {
  return new Promise<RunResult>((resolve) => {
    const chunks: string[] = [];

    // argv reaches `spawn` exactly as the adapter assembled it. Assembled text
    // was already made spawnable where the prompt entered argv; everything left
    // here is a configured value or a host path — under `bwrap` the provider
    // executable and every bind/`--chdir` operand are argv too — and rewriting a
    // character inside one of those would launch a different path instead of
    // repairing anything. A NUL there is a configuration fault, which the catch
    // below reports as one (#206).
    //
    // `detached: true` makes the child its own process-group leader so we can
    // signal the whole group with `process.kill(-pid, ...)`, reaping any
    // grandchildren the CLI spawned (interactive shells, subprocesses, etc.).
    // Stdin is piped only for duplex consumers; stdout/stderr are always piped.
    let child: ChildProcessByStdio<Writable | null, Readable, Readable>;
    try {
      const options = {
        cwd: config.cwd,
        env: config.env,
        detached: true,
        // Do NOT pass `timeout:` here — Node's spawn timeout signals only the
        // direct child, leaving the rest of the detached group alive. We own the
        // timeout via `setTimeout` below instead.
      };
      child = config.onDuplex
        ? spawn(config.command, config.args, { ...options, stdio: ["pipe", "pipe", "pipe"] })
        : spawn(config.command, config.args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      // spawn validates command, argv and options synchronously and throws
      // before a process exists: there is no 'error' event coming, no group to
      // kill and no timer or abort listener registered yet, so this settles the
      // run directly. `describeSpawnRejection` is what keeps the rejected value
      // out of the resulting run record.
      config.cleanup?.();
      resolve(config.buildSpawnErrorResult(describeSpawnRejection(err)));
      return;
    }

    const closed = new Promise<void>((resolveClose) => child.once("close", resolveClose));

    child.once("spawn", () => {
      try {
        config.onSpawn?.();
      } catch {
        // Observability must never prevent or fail a provider run.
      }
    });

    const killGroup = () => {
      child.stdin?.destroy();
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

    const settleKilled = (
      build: (sig: TerminationAttribution) => RunResult,
      sigtermResult: TerminationAttribution
    ) => {
      const res = build(sigtermResult);
      if (res.abortReason === undefined) {
        res.abortReason = sigtermResult.abortReason;
      }
      settle(res);
    };

    // Own the timeout in Node (not spawn's `timeout`, whose SIGTERM leaves the
    // detached group alive) so we can kill the whole group on expiry.
    timer = setTimeout(() => {
      killGroup();
      config.onStdoutEnd?.(chunks, "termination");
      const sigtermResult = formatSigtermResult(chunks.join(""), config.signal);
      settleKilled(config.buildKilledResult, sigtermResult);
    }, config.timeoutMs);

    const onAbort = () => {
      killGroup();
      config.onStdoutEnd?.(chunks, "termination");
      const sigtermResult = formatSigtermResult(chunks.join(""), config.signal);
      settleKilled(config.buildKilledResult, sigtermResult);
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
        onEnd(chunks, "eof");
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

    if (config.onDuplex) {
      // The write callback rejects the write. Consume stream errors separately
      // while leaving exit/stderr attribution to the child's close event.
      child.stdin?.on("error", () => {});
      child.once("spawn", () => {
        if (settled) return;
        try {
          config.onDuplex?.({
            write: (record) =>
              new Promise<void>((resolveWrite, rejectWrite) => {
                const stdin = child.stdin;
                if (!stdin || stdin.destroyed) {
                  rejectWrite(new Error("Subprocess stdin closed"));
                  return;
                }
                stdin.write(record, (error) =>
                  error ? rejectWrite(new Error("Subprocess stdin failed")) : resolveWrite()
                );
              }),
            close: () => {
              killGroup();
              return closed;
            },
          });
        } catch {
          killGroup();
          settle(config.buildSpawnErrorResult(new Error("Subprocess duplex setup failed")));
        }
      });
    }

    child.on("close", (code, signal) => {
      // Check if the process was terminated by a kill signal from our paths.
      if (signal === "SIGTERM" || signal === "SIGKILL") {
        config.onStdoutEnd?.(chunks, "termination");
        const sigtermResult = formatSigtermResult(chunks.join(""), config.signal);
        settleKilled((sig) => config.buildSignalResult(sig, signal), sigtermResult);
        return;
      }
      const exitCode = code ?? 1;
      settle(config.buildExitResult(chunks.join(""), exitCode));
    });
  });
}
