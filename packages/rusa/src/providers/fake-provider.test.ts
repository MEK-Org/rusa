import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { McpHttpServer } from "../mcp/http-server.js";
import { toolOk } from "../mcp/result.js";
import { createMcpServer } from "../mcp/strict-server.js";
import { FakeProvider } from "./fake-provider.js";

describe("FakeProvider scripted runs", () => {
  let http: McpHttpServer | undefined;

  afterEach(async () => {
    await http?.close();
  });

  it("executes a scripted tool through the advertised streamable-HTTP endpoint", async () => {
    const calls: unknown[] = [];
    http = new McpHttpServer({
      servers: {
        mesh: () => {
          const server = createMcpServer({ name: "mesh", version: "0.1.0" });
          server.registerTool(
            "yield_run",
            { inputSchema: { status: z.enum(["complete", "blocked"]), note: z.string() } },
            async (args) => {
              calls.push(args);
              return toolOk("yielded");
            }
          );
          return server;
        },
      },
    });
    await http.start();

    const provider = new FakeProvider();
    const result = await provider.run({
      cwd: "/tmp",
      prompt:
        "charter\nFAKE_PROVIDER_OUTPUT: " +
        JSON.stringify({
          output: "done",
          toolCalls: [
            {
              id: "call-1",
              name: "mcp_mesh_yield_run",
              arguments: { status: "blocked", note: "review" },
            },
          ],
        }) +
        "\nworker appendix",
      mcpServers: http.urls(),
    });

    expect(result.output).toBe("done");
    expect(calls).toEqual([{ status: "blocked", note: "review" }]);
  });

  it("fails loudly when a scripted tool has no matching server", async () => {
    const provider = new FakeProvider();
    await expect(
      provider.run({
        cwd: "/tmp",
        prompt:
          "FAKE_PROVIDER_OUTPUT: " +
          JSON.stringify({
            toolCalls: [{ id: "call-1", name: "mcp_mesh_yield_run", arguments: {} }],
          }),
        mcpServers: [],
      })
    ).rejects.toThrow("Failed to execute FAKE_PROVIDER_OUTPUT");
  });

  it("preserves the ordinary responder behavior when no script marker is present", async () => {
    const provider = new FakeProvider(async () => ({ output: "ordinary", exitCode: 7 }));
    await expect(provider.run({ cwd: "/tmp", prompt: "no marker" })).resolves.toMatchObject({
      output: "ordinary",
      exitCode: 7,
    });
  });

  describe("scripted delayMs", () => {
    const script = (delayMs: number) =>
      `charter\nFAKE_PROVIDER_OUTPUT: ${JSON.stringify({ delayMs, output: "held" })}`;

    afterEach(() => {
      vi.useRealTimers();
    });

    it("holds the run open for the scripted time and keeps delayMs out of the result", async () => {
      vi.useFakeTimers();
      const provider = new FakeProvider();
      let settled = false;
      const run = provider.run({ cwd: "/tmp", prompt: script(60_000) }).then((result) => {
        settled = true;
        return result;
      });

      await vi.advanceTimersByTimeAsync(59_999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      const result = await run;
      expect(result).toMatchObject({ success: true, output: "held" });
      expect(result).not.toHaveProperty("delayMs");
    });

    it("streams a heartbeat while held, so the stall watchdog sees a live run", async () => {
      vi.useFakeTimers();
      const provider = new FakeProvider();
      const chunks: string[] = [];
      const run = provider.run({
        cwd: "/tmp",
        prompt: script(3 * 60_000 + 1),
        onChunk: (chunk) => chunks.push(chunk),
      });

      await vi.advanceTimersByTimeAsync(3 * 60_000 + 1);
      await run;
      expect(chunks).toHaveLength(3);
    });

    it("ends the hold as soon as the run is aborted", async () => {
      vi.useFakeTimers();
      const provider = new FakeProvider();
      const controller = new AbortController();
      const run = provider.run({
        cwd: "/tmp",
        prompt: script(3_600_000),
        signal: controller.signal,
      });

      controller.abort();
      await expect(run).resolves.toMatchObject({ output: "held" });
    });
  });
});
