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
  readonly model: undefined;
  readonly calls: RunOptions[] = [];
  private created = 0;

  constructor(
    private readonly responder?: (
      opts: RunOptions
    ) => Partial<RunResult> | Promise<Partial<RunResult>>,
    name = "fake"
  ) {
    this.name = name;
    this.providerName = name;
  }

  async run(opts: RunOptions): Promise<RunResult> {
    this.calls.push(opts);
    let override = (await this.responder?.(opts)) ?? {};

    // For e2e hydration: allow the system prompt or messages to script the output.
    const scriptLine = opts.prompt.split("\n").find((line) => line.startsWith(SCRIPT_PREFIX));
    if (scriptLine) {
      try {
        const parsed = JSON.parse(scriptLine.slice(SCRIPT_PREFIX.length)) as ScriptedRunResult;
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
