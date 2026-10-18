// Synthetic peer only. No Pi imports, credentials, network or model requests.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";

const mode = process.argv[2];
if (process.env.PI_CODING_AGENT_DIR) {
  const settings = JSON.parse(
    await readFile(join(process.env.PI_CODING_AGENT_DIR, "settings.json"), "utf8")
  );
  if (settings.cacheWarming !== "off") process.exit(77);
  // Provider includes its generated admission extension before model argv.
  const extensionIndex = process.argv.lastIndexOf("-e");
  const extension = await import(process.argv[extensionIndex + 1]);
  const mcp = JSON.parse(await readFile(join(process.env.PI_CODING_AGENT_DIR, "mcp.json"), "utf8"));
  extension.default({
    on: (_event, callback) => {
      globalThis.admit = callback;
    },
    getAllTools: () =>
      Object.keys(mcp.mcpServers).map((name) => ({
        name: `mcp__${name.replace(/[^A-Za-z0-9_]/g, "_")}__fixture`,
      })),
  });
  await globalThis.admit();
}
const emit = (record) => process.stdout.write(`${JSON.stringify(record)}\n`);
const lines = createInterface({ input: process.stdin });
// Remain alive after settlement so the host must perform cleanup.
setInterval(() => {}, 1000);
lines.on("line", (line) => {
  const command = JSON.parse(line);
  const data =
    command.type === "get_state"
      ? {
          model: { provider: "openrouter", id: "vendor/fixed-model" },
          isStreaming: false,
          isCompacting: false,
          pendingMessageCount: 0,
          messageCount: 0,
        }
      : command.type === "prompt"
        ? { disposition: "started" }
        : undefined;
  emit({ type: "response", id: command.id, command: command.type, success: true, data });
  if (command.type !== "prompt") return;
  emit({
    type: "message_end",
    message: {
      role: "assistant",
      provider: "openrouter",
      model: "vendor/fixed-model",
      stopReason: "stop",
      content: [{ type: "text", text: command.message }],
      usage: { input: 3, output: 2 },
    },
  });
  emit({ type: "agent_end" });
  // EOF before settlement must fail even with a complete assistant answer.
  if (mode === "eof") process.stdout.end();
  else emit({ type: "agent_settled" });
});
