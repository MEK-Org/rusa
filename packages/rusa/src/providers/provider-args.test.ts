import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  agyMcpConfigPaths,
  buildAntigravityArgs,
  createTempAgyMcpConfig,
  mergeAgyMcpConfig,
  parseConversationId,
} from "./antigravity.js";
import { buildClaudeArgs, buildClaudeMcpConfig } from "./claude.js";
import { clearProviderModelCatalog, setProviderModelCatalog } from "./model-catalog.js";

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
  afterEach(() => {
    clearProviderModelCatalog("agy");
  });

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
    setProviderModelCatalog("agy", [
      { identifier: "gemini-3.1-pro-high", displayLabel: "Gemini 3.1 Pro (High)", passable: true },
    ]);
    const args = buildAntigravityArgs({
      prompt: "hi",
      conversationId: "conv-123",
      model: "Gemini 3.1 Pro (High)",
      timeoutMs: 60_000,
    });
    expect(args[args.indexOf("--conversation") + 1]).toBe("conv-123");
    expect(args[args.indexOf("--model") + 1]).toBe("gemini-3.1-pro");
    expect(args[args.indexOf("--effort") + 1]).toBe("high");
  });

  it("passes an explicit effort independently from model when model is a base slug", () => {
    setProviderModelCatalog("agy", [
      {
        identifier: "gemini-3.7-flash-high",
        displayLabel: "Gemini 3.7 Flash (High)",
        passable: true,
      },
    ]);
    const args = buildAntigravityArgs({
      prompt: "hi",
      model: "gemini-3.7-flash",
      effort: "high",
      timeoutMs: 60_000,
    });
    expect(args.slice(args.indexOf("--model"), args.indexOf("--model") + 2)).toEqual([
      "--model",
      "gemini-3.7-flash",
    ]);
    expect(args.slice(args.indexOf("--effort"), args.indexOf("--effort") + 2)).toEqual([
      "--effort",
      "high",
    ]);
  });

  it("rejects an explicit effort combined with a legacy passable display label containing a tier", () => {
    expect(() =>
      buildAntigravityArgs({
        prompt: "hi",
        model: "Gemini 3.1 Pro (High)",
        effort: "low",
        timeoutMs: 60_000,
      })
    ).toThrowError(
      'invalid model selection (--model "Gemini 3.1 Pro (High)" --effort "low"): --effort is not supported for model "Gemini 3.1 Pro (High)"'
    );
  });

  it("resolves a canonical base display label to its identifier to emit a valid selector with --effort", () => {
    // Populate the mock catalog for this test so the lookup succeeds.

    setProviderModelCatalog("agy", [
      {
        identifier: "gemini-3.7-flash-high",
        displayLabel: "Gemini 3.7 Flash (High)",
        passable: true,
      },
    ]);
    const args = buildAntigravityArgs({
      prompt: "hi",
      model: "Gemini 3.7 Flash",
      effort: "high",
      timeoutMs: 60_000,
    });
    expect(args.slice(args.indexOf("--model"), args.indexOf("--model") + 2)).toEqual([
      "--model",
      "gemini-3.7-flash",
    ]);
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
  it("preserves provider-default effort when no model is explicitly passed", () => {
    const args = buildAntigravityArgs({
      prompt: "hi",
      effort: "high",
      timeoutMs: 60_000,
    });
    expect(args).not.toContain("--model");
    expect(args.slice(args.indexOf("--effort"), args.indexOf("--effort") + 2)).toEqual([
      "--effort",
      "high",
    ]);
  });

  it("rejects when the model is not found in the catalog", () => {
    setProviderModelCatalog("agy", [
      { identifier: "other-model", displayLabel: "Other", passable: true },
    ]);
    expect(() =>
      buildAntigravityArgs({
        prompt: "hi",
        model: "missing-model",
        timeoutMs: 60_000,
      })
    ).toThrowError('invalid model selection: model "missing-model" not found in catalog');
  });

  it("rejects when the effort is not supported by the catalog model", () => {
    setProviderModelCatalog("agy", [
      { identifier: "test-model", displayLabel: "Test Model", passable: true, efforts: ["low"] },
    ]);
    expect(() =>
      buildAntigravityArgs({
        prompt: "hi",
        model: "test-model",
        effort: "high",
        timeoutMs: 60_000,
      })
    ).toThrowError('invalid model selection: effort "high" is not supported by model "Test Model"');
  });

  it("rejects when the model requires an effort but none was provided", () => {
    setProviderModelCatalog("agy", [
      { identifier: "test-model-high", displayLabel: "Test Model (High)", passable: true },
    ]);
    expect(() =>
      buildAntigravityArgs({
        prompt: "hi",
        model: "Test Model",
        timeoutMs: 60_000,
      })
    ).toThrowError(
      'invalid model selection: model "Test Model" requires an effort but none was provided'
    );
  });

  it("canonicalizes exact display label and slug into base slug + effort argv through the catalog", () => {
    // Normalizing entries will populate base model "gemini-3.7-flash" with efforts ["high"]
    setProviderModelCatalog("agy", [
      {
        identifier: "gemini-3.7-flash-high",
        displayLabel: "Gemini 3.7 Flash (High)",
        passable: true,
      },
    ]);
    const argsSlug = buildAntigravityArgs({
      prompt: "hi",
      model: "gemini-3.7-flash-high",
      timeoutMs: 60_000,
    });
    expect(argsSlug.slice(argsSlug.indexOf("--model"), argsSlug.indexOf("--model") + 2)).toEqual([
      "--model",
      "gemini-3.7-flash",
    ]);
    expect(argsSlug.slice(argsSlug.indexOf("--effort"), argsSlug.indexOf("--effort") + 2)).toEqual([
      "--effort",
      "high",
    ]);

    const argsDisplay = buildAntigravityArgs({
      prompt: "hi",
      model: "Gemini 3.7 Flash (High)",
      timeoutMs: 60_000,
    });
    expect(
      argsDisplay.slice(argsDisplay.indexOf("--model"), argsDisplay.indexOf("--model") + 2)
    ).toEqual(["--model", "gemini-3.7-flash"]);
    expect(
      argsDisplay.slice(argsDisplay.indexOf("--effort"), argsDisplay.indexOf("--effort") + 2)
    ).toEqual(["--effort", "high"]);
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
