import { afterEach, describe, expect, it } from "vitest";
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
});
