import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ProviderConfig } from "../config/types.js";
import { CodexProvider, listEffectiveCodexMcpServers } from "./codex.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * Creates a hermetic fake Codex CLI script supporting --version, mcp list --json,
 * profile loading, project trust, configuration overrides, and exec event stream.
 */
function createFakeCodexCli(binDir: string): string {
  mkdirSync(binDir, { recursive: true });
  const scriptPath = join(binDir, "fake-codex");
  const scriptContent = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");

const args = process.argv.slice(2);

if (args.includes("--version")) {
  console.log("codex-cli 0.160.0");
  process.exit(0);
}

if (process.env.SIMULATE_DISCOVERY_DELAY_MS) {
  const ms = parseInt(process.env.SIMULATE_DISCOVERY_DELAY_MS, 10);
  setTimeout(() => {}, ms);
  return;
}

let profile = undefined;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--profile" && i + 1 < args.length) {
    profile = args[i + 1];
  }
}

const overrides = [];
for (let i = 0; i < args.length; i++) {
  if ((args[i] === "-c" || args[i] === "--config") && i + 1 < args.length) {
    overrides.push(args[i + 1]);
  }
}

const isMcpList = args.includes("mcp") && args.includes("list");
const isExec = args.includes("exec");

if (isMcpList) {
  const codexHome = process.env.CODEX_HOME || path.join(process.env.HOME || "/root", ".codex");
  const baseConfigPath = path.join(codexHome, "config.toml");
  let baseContent = "";
  if (fs.existsSync(baseConfigPath)) {
    baseContent = fs.readFileSync(baseConfigPath, "utf8");
  }

  let profileContent = "";
  if (profile) {
    const profilePath = path.join(codexHome, \`\${profile}.config.toml\`);
    if (fs.existsSync(profilePath)) {
      profileContent = fs.readFileSync(profilePath, "utf8");
    }
  }

  function parseToml(content) {
    const servers = new Map();
    const projects = new Map();
    let currentServer = null;
    let currentProject = null;

    const lines = content.split("\\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;

      const mcpMatch = trimmed.match(/^\\[mcp_servers\\.([a-zA-Z0-9_-]+)\\]$/);
      if (mcpMatch) {
        currentServer = mcpMatch[1];
        currentProject = null;
        if (!servers.has(currentServer)) servers.set(currentServer, {});
        continue;
      }

      const projMatch = trimmed.match(/^\\[projects\\."([^"]+)"\\]$/);
      if (projMatch) {
        currentProject = projMatch[1];
        currentServer = null;
        if (!projects.has(currentProject)) projects.set(currentProject, {});
        continue;
      }

      if (trimmed.startsWith("[")) {
        currentServer = null;
        currentProject = null;
        continue;
      }

      if (currentServer) {
        const kv = trimmed.match(/^([a-zA-Z0-9_-]+)\\s*=\\s*(.*)$/);
        if (kv) {
          const k = kv[1];
          let v = kv[2].trim();
          try { v = JSON.parse(v); } catch {}
          servers.get(currentServer)[k] = v;
        }
      } else if (currentProject) {
        const kv = trimmed.match(/^([a-zA-Z0-9_-]+)\\s*=\\s*(.*)$/);
        if (kv) {
          const k = kv[1];
          let v = kv[2].trim();
          try { v = JSON.parse(v); } catch {}
          projects.get(currentProject)[k] = v;
        }
      }
    }
    return { servers, projects };
  }

  const baseParsed = parseToml(baseContent);
  const profileParsed = parseToml(profileContent);

  const mergedServers = new Map(baseParsed.servers);
  for (const [name, cfg] of profileParsed.servers.entries()) {
    mergedServers.set(name, { ...(mergedServers.get(name) || {}), ...cfg });
  }

  const cwd = process.cwd();
  const projectTrust = baseParsed.projects.get(cwd);
  if (projectTrust && projectTrust.trust_level === "trusted") {
    const projectConfigPath = path.join(cwd, ".codex", "config.toml");
    if (fs.existsSync(projectConfigPath)) {
      const projectParsed = parseToml(fs.readFileSync(projectConfigPath, "utf8"));
      for (const [name, cfg] of projectParsed.servers.entries()) {
        mergedServers.set(name, { ...(mergedServers.get(name) || {}), ...cfg });
      }
    }
  }

  for (const override of overrides) {
    const match = override.match(/^mcp_servers\\.([a-zA-Z0-9_-]+)\\.([a-zA-Z0-9_-]+)=(.*)$/);
    if (match) {
      const sName = match[1];
      const sKey = match[2];
      let sVal = match[3];
      try { sVal = JSON.parse(sVal); } catch {}
      if (!mergedServers.has(sName)) mergedServers.set(sName, {});
      mergedServers.get(sName)[sKey] = sVal;
    }
  }

  const result = [];
  for (const [name, cfg] of mergedServers.entries()) {
    if (cfg.invalid_key !== undefined) {
      console.error(\`Invalid configuration for \${name}: invalid_key\`);
      process.exit(1);
    }
    const isEnabled = cfg.enabled !== false;
    let transport = undefined;
    if (cfg.url) {
      transport = { type: "sse", url: cfg.url };
    } else if (cfg.command) {
      transport = {
        type: "stdio",
        command: cfg.command,
        args: Array.isArray(cfg.args) ? cfg.args : [],
      };
    } else if (isEnabled) {
      console.error(\`Invalid configuration for \${name}: missing transport\`);
      process.exit(1);
    }
    result.push({ name, enabled: isEnabled, transport });
  }

  console.log(JSON.stringify(result));
  process.exit(0);
}

if (isExec) {
  console.log(JSON.stringify({ type: "thread.started" }));
  console.log(JSON.stringify({ type: "turn.started" }));
  console.log(JSON.stringify({
    type: "item.completed",
    item: { type: "agent_message", text: "hermetic-codex-test-output" }
  }));
  console.log(JSON.stringify({ type: "turn.completed" }));
  process.exit(0);
}

console.error("Unknown command or options");
process.exit(1);
`;
  writeFileSync(scriptPath, scriptContent, { mode: 0o755 });
  return scriptPath;
}

let hasNativeCodex = false;
try {
  const version = execSync("codex --version", {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  hasNativeCodex = version.includes("codex");
} catch {
  hasNativeCodex = false;
}

describe("CodexProvider computer-use configuration and precedence (#885)", () => {
  it("discovers project direct MCP bindings and preserves transport and unrelated endpoints", async () => {
    const root = mkdtempSync(join(tmpdir(), "rusa-codex-mcp-fixture-"));
    dirs.push(root);

    const codexHome = join(root, "codex-home");
    const project = join(root, "project");
    const projectCodex = join(project, ".codex");
    mkdirSync(codexHome, { recursive: true });
    mkdirSync(projectCodex, { recursive: true });

    const fakeCodex = createFakeCodexCli(join(project, "bin"));

    // User-level config has unrelated docs server and trusts the project
    writeFileSync(
      join(codexHome, "config.toml"),
      `[mcp_servers.docs]\nurl="https://example.invalid/docs"\n\n[projects."${project}"]\ntrust_level="trusted"\n`
    );

    // Project-level config has direct computer-use binding (computer-use)
    writeFileSync(
      join(projectCodex, "config.toml"),
      `[mcp_servers.computer-use]\ncommand="fake-desktop-never-launched"\nargs=["project"]\n`
    );

    const servers = await listEffectiveCodexMcpServers({
      command: fakeCodex,
      cwd: project,
      env: {
        ...process.env,
        CODEX_HOME: codexHome,
      },
    });

    const serverNames = servers.map((s) => s.name).sort();
    expect(serverNames).toEqual(["computer-use", "docs"]);

    const cu = servers.find((s) => s.name === "computer-use");
    expect(cu).toBeDefined();
    expect(cu?.enabled).toBe(true);
    expect(cu?.transport).toMatchObject({
      type: "stdio",
      command: "fake-desktop-never-launched",
      args: ["project"],
    });

    const docs = servers.find((s) => s.name === "docs");
    expect(docs).toBeDefined();
    expect(docs?.enabled).toBe(true);
    expect(docs?.transport).toMatchObject({
      type: "sse",
      url: "https://example.invalid/docs",
    });
  });

  it("proves project config overrides profile config for direct computer-use binding via --profile desktop", async () => {
    const root = mkdtempSync(join(tmpdir(), "rusa-codex-profile-fixture-"));
    dirs.push(root);

    const codexHome = join(root, "codex-home");
    const project = join(root, "project");
    const projectCodex = join(project, ".codex");
    mkdirSync(codexHome, { recursive: true });
    mkdirSync(projectCodex, { recursive: true });

    const fakeCodex = createFakeCodexCli(join(project, "bin"));

    writeFileSync(
      join(codexHome, "config.toml"),
      `[projects."${project}"]\ntrust_level="trusted"\n`
    );

    // Profile desktop config has computer-use with profile arg
    writeFileSync(
      join(codexHome, "desktop.config.toml"),
      `[mcp_servers.computer-use]\ncommand="fake-profile-never-launched"\nargs=["profile"]\n`
    );

    // Project config has computer-use with project arg
    writeFileSync(
      join(projectCodex, "config.toml"),
      `[mcp_servers.computer-use]\ncommand="fake-desktop-never-launched"\nargs=["project"]\n`
    );

    // Pass --profile desktop through intended controls
    const servers = await listEffectiveCodexMcpServers({
      command: fakeCodex,
      cwd: project,
      env: {
        ...process.env,
        CODEX_HOME: codexHome,
      },
      profile: "desktop",
    });

    const cu = servers.find((s) => s.name === "computer-use");
    expect(cu).toBeDefined();
    // Project precedence: project settings win over profile settings
    expect(cu?.transport).toMatchObject({
      type: "stdio",
      command: "fake-desktop-never-launched",
      args: ["project"],
    });
  });

  it("host-only direct binding stripped in sandbox merged config is NOT discovered and does NOT add bare disabled server entries", async () => {
    const root = mkdtempSync(join(tmpdir(), "rusa-codex-sandbox-fixture-"));
    dirs.push(root);

    const project = join(root, "project");
    mkdirSync(project, { recursive: true });
    const fakeCodex = createFakeCodexCli(join(project, "bin"));

    // Host home has direct computer-use server
    const hostHome = join(root, "host-home");
    const hostCodex = join(hostHome, ".codex");
    mkdirSync(hostCodex, { recursive: true });
    writeFileSync(
      join(hostCodex, "config.toml"),
      `[mcp_servers.computer-use]\ncommand="host-desktop-only"\nargs=["host"]\n`
    );

    const prevHome = process.env.HOME;
    process.env.HOME = hostHome;

    try {
      const config: ProviderConfig = { cliCommand: fakeCodex };
      const provider = new CodexProvider("codex", config, "gpt-5-codex");

      const result = await provider.run({
        prompt: "test sandbox regression",
        cwd: project,
        computerUse: false,
        sandbox: {
          worktreePath: project,
          isE2eRoot: false,
        },
      });

      expect(result.success).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("hermetic-codex-test-output");
    } finally {
      if (prevHome !== undefined) process.env.HOME = prevHome;
      else delete process.env.HOME;
    }
  });

  it("fails closed without unfiltered fallback when configuration loading fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "rusa-codex-broken-fixture-"));
    dirs.push(root);

    const codexHome = join(root, "codex-home");
    const project = join(root, "project");
    mkdirSync(codexHome, { recursive: true });
    mkdirSync(project, { recursive: true });

    const fakeCodex = createFakeCodexCli(join(project, "bin"));

    // Invalid transport in configuration (invalid_key triggers failure in fake-codex)
    writeFileSync(
      join(codexHome, "config.toml"),
      `[mcp_servers.computer-use]\ninvalid_key="bad"\n`
    );

    const config: ProviderConfig = { cliCommand: fakeCodex };
    const provider = new CodexProvider("codex", config, "gpt-5-codex");

    const prevCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = codexHome;
    try {
      const result = await provider.run({
        prompt: "test broken config",
        cwd: project,
        computerUse: false,
      });

      // Must fail closed with non-zero exit code; never execute unfiltered
      expect(result.success).toBe(false);
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain("Failed to determine effective MCP configuration");
    } finally {
      if (prevCodexHome !== undefined) process.env.CODEX_HOME = prevCodexHome;
      else delete process.env.CODEX_HOME;
    }
  });

  it("cancels cleanly when signal is aborted during configuration discovery", async () => {
    const root = mkdtempSync(join(tmpdir(), "rusa-codex-cancel-fixture-"));
    dirs.push(root);

    const project = join(root, "project");
    mkdirSync(project, { recursive: true });
    const fakeCodex = createFakeCodexCli(join(project, "bin"));

    const config: ProviderConfig = { cliCommand: fakeCodex };
    const provider = new CodexProvider("codex", config, "gpt-5-codex");

    const ac = new AbortController();
    const prevDelay = process.env.SIMULATE_DISCOVERY_DELAY_MS;
    process.env.SIMULATE_DISCOVERY_DELAY_MS = "10000";

    try {
      setTimeout(() => ac.abort(), 50);

      const result = await provider.run({
        prompt: "test cancellation",
        cwd: project,
        computerUse: false,
        signal: ac.signal,
      });

      expect(result.success).toBe(false);
      expect(result.cancelled).toBe(true);
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain("Codex run cancelled during MCP configuration discovery");
    } finally {
      if (prevDelay !== undefined) process.env.SIMULATE_DISCOVERY_DELAY_MS = prevDelay;
      else delete process.env.SIMULATE_DISCOVERY_DELAY_MS;
    }
  });

  const itNative = hasNativeCodex ? it : it.skip;
  itNative("isolated native CLI configuration-read receipts (workstation only)", async () => {
    const root = mkdtempSync(join(tmpdir(), "rusa-native-codex-fixture-"));
    dirs.push(root);

    const codexHome = join(root, "codex-home");
    const project = join(root, "project");
    const projectCodex = join(project, ".codex");
    mkdirSync(codexHome, { recursive: true });
    mkdirSync(projectCodex, { recursive: true });

    writeFileSync(
      join(codexHome, "config.toml"),
      `[projects."${project}"]\ntrust_level="trusted"\n`
    );

    writeFileSync(
      join(projectCodex, "config.toml"),
      `[mcp_servers.docs]\nurl="https://example.invalid/docs"\n`
    );

    const servers = await listEffectiveCodexMcpServers({
      command: "codex",
      cwd: project,
      env: {
        ...process.env,
        CODEX_HOME: codexHome,
      },
    });

    console.log("Observed native Codex MCP discovery receipt:", JSON.stringify(servers));
    expect(servers.length).toBeGreaterThanOrEqual(1);
    const docs = servers.find((s) => s.name === "docs");
    expect(docs).toBeDefined();
  });
});
