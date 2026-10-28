// Synthetic peer only. No Pi imports, credentials, network or model requests.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { accessSync, readFileSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";

// Direct synthetic-pipe tests pass their mode as argv; provider tests use an
// environment wrapper because the adapter owns argv. Keep both fixture entry
// points so a provider-test extension cannot silently change pipe semantics.
const mode = process.env.RUSA_TEST_PEER_MODE ?? process.argv[2];
const progressPath = process.env.RUSA_TEST_PEER_MARKER;
if (process.env.PI_CODING_AGENT_DIR) {
  const settings = JSON.parse(
    await readFile(join(process.env.PI_CODING_AGENT_DIR, "settings.json"), "utf8")
  );
  if (settings.cacheWarming !== "off") process.exit(77);
  const auth = JSON.parse(
    await readFile(join(process.env.PI_CODING_AGENT_DIR, "auth.json"), "utf8")
  );
  assert.equal(auth.openrouter.key ?? auth.openrouter.access, "synthetic-not-a-real-key");
  assert.equal(process.env.OPENROUTER_API_KEY, undefined);
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
  if (command.type === "prompt" && command.message.startsWith("sandbox-probe:")) {
    const probe = JSON.parse(command.message.slice("sandbox-probe:".length));
    assert.throws(() =>
      writeFileSync(join(process.env.PI_CODING_AGENT_DIR, "auth.json"), "changed")
    );
    writeFileSync(join(process.cwd(), ".cwd-receipt"), process.cwd());
    assert.equal(readFileSync(probe.ownFile, "utf8"), "own");
    writeFileSync(probe.ownFile, "updated");
    assert.throws(() => accessSync(probe.siblingFile));
    assert.throws(() => accessSync(probe.secretFile));
    assert.equal(readFileSync(probe.hostFile, "utf8"), "private");
    assert.throws(() => writeFileSync(probe.hostFile, "changed"));
  }
  if (command.type === "prompt" && command.message === "repository-write") {
    assert.equal(
      execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { encoding: "utf8" }).trim(),
      "true"
    );
    execFileSync("node", ["--version"], { stdio: "ignore" });
    execFileSync("gh", ["--version"], { stdio: "ignore" });
    writeFileSync(join(process.cwd(), "repository-marker"), "first invocation\n");
  }
  if (command.type === "prompt" && command.message === "repository-read") {
    assert.equal(
      execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { encoding: "utf8" }).trim(),
      "true"
    );
    assert.equal(
      readFileSync(join(process.cwd(), "repository-marker"), "utf8"),
      "first invocation\n"
    );
  }
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
  if (progressPath) {
    // The parent test waits for this acknowledgement before observing the
    // following execution event, so admission traffic cannot satisfy it.
    writeFileSync(progressPath, JSON.stringify({ pid: process.pid, stage: "prompt-accepted" }));
  }
  emit({ type: "turn_start" });
  if (mode === "wait") {
    emit({ type: "message_update", assistantMessageEvent: { type: "text_delta" } });
    return;
  }
  if (mode === "failure") {
    emit({
      type: "message_end",
      message: {
        role: "assistant",
        provider: "openrouter",
        model: "vendor/fixed-model",
        stopReason: "error",
        content: [{ type: "text", text: "synthetic provider failure" }],
        usage: { input: 3, output: 2 },
      },
    });
    emit({ type: "agent_settled" });
    return;
  }
  if (mode === "stream") {
    emit({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "streamed " },
    });
    emit({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "reply" },
    });
    emit({
      type: "message_update",
      assistantMessageEvent: {
        type: "toolcall_start",
        contentIndex: 1,
        id: "call-stream",
        toolName: "mcp__inbox__read",
      },
    });
    emit({
      type: "tool_execution_start",
      toolCallId: "call-stream",
      toolName: "mcp__inbox__read",
      args: { private: "not rendered" },
    });
    emit({
      type: "tool_execution_end",
      toolCallId: "call-stream",
      toolName: "mcp__inbox__read",
      result: { content: [{ type: "text", text: "not rendered" }] },
      isError: true,
    });
  }
  emit({
    type: "message_end",
    message: {
      role: "assistant",
      provider: "openrouter",
      model: "vendor/fixed-model",
      stopReason: "stop",
      content: [{ type: "text", text: mode === "stream" ? "streamed reply" : command.message }],
      usage: { input: 3, output: 2 },
    },
  });
  emit({ type: "agent_end" });
  // EOF before settlement must fail even with a complete assistant answer.
  if (mode === "eof") process.stdout.end();
  else emit({ type: "agent_settled" });
});
