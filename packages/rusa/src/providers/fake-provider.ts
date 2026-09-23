import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CodingProvider, RunOptions, RunResult } from "./types.js";

const SCRIPT_PREFIX = "FAKE_PROVIDER_OUTPUT: ";

interface ScriptedToolCall {
  id: string;
  name: string;
  arguments?: Record<string, unknown>;
}

interface ScriptedRunResult extends Partial<RunResult> {
  toolCalls?: ScriptedToolCall[];
  /**
   * Hold the run open this long after any scripted tool calls, so an e2e
   * scenario can keep an actor visibly running (and saturate the concurrency
   * cap so others queue). An abort — an interrupt, a cancel, or the actor's
   * run-ceiling watchdog — ends it early.
   */
  delayMs?: number;
}

/**
 * How often a held run streams a heartbeat chunk. A real provider streams
 * output as it works; a silent one trips the actor's stall watchdog.
 */
const HOLD_HEARTBEAT_MS = 60_000;

/** Resolves after `ms`, or as soon as `signal` aborts, streaming a heartbeat meanwhile. */
function holdUnlessAborted(
  ms: number,
  signal?: AbortSignal,
  onChunk?: (chunk: string) => void
): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    const heartbeat = onChunk ? setInterval(() => onChunk("."), HOLD_HEARTBEAT_MS) : undefined;
    function done() {
      clearTimeout(timer);
      if (heartbeat) clearInterval(heartbeat);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

/**
 * A scripted {@link CodingProvider} for tests and the e2e runner — exercises the
 * actor loop without spawning a real LLM (nondeterministic, slow, costs tokens).
 * Records every call and returns a configurable result; by default it echoes a
 * resumed session id or mints a fresh one on creation.
 */
export class FakeProvider implements CodingProvider {
  readonly name: string;
  readonly providerName: string;
  readonly calls: RunOptions[] = [];
  private created = 0;

  constructor(
    private readonly responder?: (
      opts: RunOptions
    ) => Partial<RunResult> | Promise<Partial<RunResult>>,
    name = "fake",
    public readonly model?: string,
    public readonly effort?: string
  ) {
    this.name = name;
    this.providerName = name;
  }

  async run(opts: RunOptions): Promise<RunResult> {
    this.calls.push(opts);
    let override = (await this.responder?.(opts)) ?? {};

    // For e2e hydration: allow the system prompt or messages to script the output.
    const scriptLine = opts.prompt.split("\n").find((line) => line.startsWith(SCRIPT_PREFIX));
    let delayMs: number | undefined;
    if (scriptLine) {
      try {
        const { delayMs: scriptedDelay, ...parsed } = JSON.parse(
          scriptLine.slice(SCRIPT_PREFIX.length)
        ) as ScriptedRunResult;
        delayMs = scriptedDelay;
        override = { ...override, ...parsed };

        if (parsed.toolCalls && opts.mcpServers) {
          for (const call of parsed.toolCalls) {
            const server = opts.mcpServers.find((s) => call.name.startsWith(`mcp_${s.name}_`));
            if (!server) throw new Error(`No MCP server found for scripted tool ${call.name}`);
            const toolName = call.name.slice(`mcp_${server.name}_`.length);
            const client = new Client({ name: "rusa-scripted-provider", version: "0.1.0" });
            try {
              await client.connect(new StreamableHTTPClientTransport(new URL(server.url)));
              const result = await client.callTool({ name: toolName, arguments: call.arguments });
              if (result.isError) {
                throw new Error(`Scripted MCP tool ${call.name} returned an error`);
              }
            } finally {
              await client.close();
            }
          }
        }
      } catch (e) {
        throw new Error("Failed to execute FAKE_PROVIDER_OUTPUT", { cause: e });
      }
    }
    if (typeof delayMs === "number" && delayMs > 0) {
      await holdUnlessAborted(delayMs, opts.signal, opts.onChunk);
    }

    const sessionId = override.sessionId ?? opts.session?.id ?? `fake-session-${++this.created}`;
    return {
      success: true,
      output: "ok",
      exitCode: 0,
      sessionId,
      ...override,
    };
  }
}
