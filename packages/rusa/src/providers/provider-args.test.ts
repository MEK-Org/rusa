import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  agyMcpConfigPaths,
  buildAntigravityArgs,
  createTempAgyMcpConfig,
  mergeAgyMcpConfig,
  parseConversationId,
} from "./antigravity.js";
import { buildClaudeArgs, buildClaudeMcpConfig } from "./claude.js";

describe("buildClaudeArgs", () => {
  it("builds the base print/stream args", () => {
    const args = buildClaudeArgs({ prompt: "hi" });
    expect(args).toEqual([
      "-p",
      "hi",
      "--dangerously-skip-permissions",
      "--output-format",
      "stream-json",
      "--include-partial-messages",
      "--verbose",
    ]);
  });

  it("resumes a session by id with --resume", () => {
    const args = buildClaudeArgs({ prompt: "hi", session: { id: "abc", resume: true } });
    expect(args[args.indexOf("--resume") + 1]).toBe("abc");
    expect(args).not.toContain("--session-id");
  });

  it("creates a session with a chosen id via --session-id", () => {
    const args = buildClaudeArgs({ prompt: "hi", session: { id: "abc", resume: false } });
    expect(args[args.indexOf("--session-id") + 1]).toBe("abc");
    expect(args).not.toContain("--resume");
  });

  it("adds --mcp-config and --strict-mcp-config with a config path", () => {
    const args = buildClaudeArgs({ prompt: "hi", mcpConfigPath: "/tmp/x.json" });
    const i = args.indexOf("--mcp-config");
    expect(i).toBeGreaterThanOrEqual(0);
    expect(args[i + 1]).toBe("/tmp/x.json");
    expect(args).toContain("--strict-mcp-config");
  });

  it("maps model dots to dashes", () => {
    const args = buildClaudeArgs({ prompt: "hi", model: "claude-opus-4.8" });
    const i = args.indexOf("--model");
    expect(args[i + 1]).toBe("claude-opus-4-8");
  });

  it("passes an explicit effort independently from model", () => {
    const args = buildClaudeArgs({
      prompt: "hi",
      model: "claude-opus-4-8",
      effort: "max",
    });
    expect(args.slice(args.indexOf("--effort"), args.indexOf("--effort") + 2)).toEqual([
      "--effort",
      "max",
    ]);
  });

  it("omits MCP/session flags when not requested", () => {
    const args = buildClaudeArgs({ prompt: "hi" });
    expect(args).not.toContain("--resume");
    expect(args).not.toContain("--session-id");
    expect(args).not.toContain("--mcp-config");
    expect(args).not.toContain("--add-dir");
  });

  // ISSUE_NUM: worker fallback machinery is removed outright — no config shape
  // (root or worker) should ever put --fallback-model on the built argv.
  it("never emits --fallback-model, under any config ", () => {
    const args = buildClaudeArgs({ prompt: "hi", model: "claude-opus-4-8" });
    expect(args).not.toContain("--fallback-model");
  });

  it("emits a repeatable --add-dir for each granted directory", () => {
    const args = buildClaudeArgs({ prompt: "hi", addDirs: ["/repos/a", "/repos/b"] });
    expect(args.join(" ")).toContain("--add-dir /repos/a --add-dir /repos/b");
  });
});

describe("buildClaudeMcpConfig", () => {
  it("emits an http mcpServers map keyed by name", () => {
    const json = buildClaudeMcpConfig([
      { name: "tracker", url: "http://127.0.0.1:9099/tracker" },
      { name: "chat", url: "http://127.0.0.1:9099/chat" },
    ]);
    expect(JSON.parse(json)).toEqual({
      mcpServers: {
        tracker: { type: "http", url: "http://127.0.0.1:9099/tracker" },
        chat: { type: "http", url: "http://127.0.0.1:9099/chat" },
      },
    });
  });
});

describe("buildAntigravityArgs", () => {
  it("builds base args with a budget-matched print-timeout", () => {
    const args = buildAntigravityArgs({ prompt: "hi", timeoutMs: 10 * 60 * 1000 });
    expect(args.slice(0, 5)).toEqual([
      "-p",
      "hi",
      "--dangerously-skip-permissions",
      "--output-format",
      "stream-json",
    ]);
    const i = args.indexOf("--print-timeout");
    expect(args[i + 1]).toBe("10m0s");
  });

  it("rounds the print-timeout up to at least 1 minute", () => {
    const args = buildAntigravityArgs({ prompt: "hi", timeoutMs: 5_000 });
    expect(args[args.indexOf("--print-timeout") + 1]).toBe("1m0s");
  });

  it("resumes a conversation by id and passes the model", () => {
    const args = buildAntigravityArgs({
      prompt: "hi",
      conversationId: "conv-123",
      model: "Gemini 3.1 Pro (High)",
      timeoutMs: 60_000,
    });
    expect(args[args.indexOf("--conversation") + 1]).toBe("conv-123");
    expect(args[args.indexOf("--model") + 1]).toBe("Gemini 3.1 Pro (High)");
  });

  it("passes an explicit effort independently from model", () => {
    const args = buildAntigravityArgs({
      prompt: "hi",
      model: "gemini-3.7-flash",
      effort: "high",
      timeoutMs: 60_000,
    });
    expect(args.slice(args.indexOf("--effort"), args.indexOf("--effort") + 2)).toEqual([
      "--effort",
      "high",
    ]);
  });

  it("omits --conversation when starting fresh", () => {
    const args = buildAntigravityArgs({ prompt: "hi", timeoutMs: 60_000 });
    expect(args).not.toContain("--conversation");
  });

  it("passes --log-file when capturing the session id", () => {
    const args = buildAntigravityArgs({ prompt: "hi", logFile: "/tmp/x.log", timeoutMs: 60_000 });
    expect(args[args.indexOf("--log-file") + 1]).toBe("/tmp/x.log");
  });

  it("emits a repeatable --add-dir for each granted directory", () => {
    const args = buildAntigravityArgs({
      prompt: "hi",
      addDirs: ["/repos/a", "/repos/b"],
      timeoutMs: 60_000,
    });
    expect(args.join(" ")).toContain("--add-dir /repos/a --add-dir /repos/b");
  });
});

describe("parseConversationId", () => {
  it("extracts the id agy logs at run start", () => {
    const log = [
      "I0616 15:10:54 printmode.go:155] Print mode: conversation=ddae405d-1314-4808-8c7d-332ccaaf4848, sending message",
      "I0616 15:10:56 conversation_manager.go:613] Stream completed for ddae405d-1314-4808-8c7d-332ccaaf4848",
    ].join("\n");
    expect(parseConversationId(log)).toBe("ddae405d-1314-4808-8c7d-332ccaaf4848");
  });

  it("returns undefined when no conversation id is present", () => {
    expect(parseConversationId("no conversation id here")).toBeUndefined();
  });
});

describe("agy mcp_config", () => {
  it("targets both known agy config locations under ~/.gemini", () => {
    const paths = agyMcpConfigPaths();
    expect(paths.some((p) => p.endsWith("/.gemini/config/mcp_config.json"))).toBe(true);
    expect(paths.some((p) => p.endsWith("/.gemini/antigravity/mcp_config.json"))).toBe(true);
  });

  it("merges servers (url schema), preserving existing entries", () => {
    const file = join(mkdtempSync(join(tmpdir(), "agymcp-")), "mcp_config.json");
    writeFileSync(file, JSON.stringify({ mcpServers: { user: { url: "http://keep" } }, other: 1 }));
    mergeAgyMcpConfig(file, [{ name: "tracker", url: "http://127.0.0.1:1/mcp/tracker" }]);
    const cfg = JSON.parse(readFileSync(file, "utf-8"));
    expect(cfg.mcpServers.user).toEqual({ url: "http://keep" });
    expect(cfg.mcpServers.tracker).toEqual({ url: "http://127.0.0.1:1/mcp/tracker" });
    expect(cfg.other).toBe(1);
  });

  it("creates the config (and parent dirs) from a missing file", () => {
    const file = join(mkdtempSync(join(tmpdir(), "agymcp-")), "nested", "mcp_config.json");
    mergeAgyMcpConfig(file, [{ name: "chat", url: "http://x/mcp/chat" }]);
    const cfg = JSON.parse(readFileSync(file, "utf-8"));
    expect(cfg.mcpServers.chat).toEqual({ url: "http://x/mcp/chat" });
  });

  it("creates a temp config from ONLY the given servers (no global seed)", () => {
    const tempFile = createTempAgyMcpConfig([
      { name: "tracker", url: "http://x/mcp/tracker" },
      { name: "mesh", url: "http://x/mcp/mesh-worker" },
    ]);
    expect(existsSync(tempFile)).toBe(true);
    const content = JSON.parse(readFileSync(tempFile, "utf-8"));
    // Exactly the passed servers — nothing seeded from the global ~/.gemini config
    // (which would leak `chat` / the root's mesh endpoint into a worker).
    expect(Object.keys(content.mcpServers).sort()).toEqual(["mesh", "tracker"]);
    expect(content.mcpServers.mesh).toEqual({ url: "http://x/mcp/mesh-worker" });
    expect(content.mcpServers.chat).toBeUndefined();
    rmSync(tempFile);
  });
});
