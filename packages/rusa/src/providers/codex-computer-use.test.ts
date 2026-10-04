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

describe("CodexProvider computer-use configuration and precedence (#885)", () => {
  it("discovers project direct MCP bindings and preserves transport and unrelated endpoints", async () => {
    const root = mkdtempSync(join(tmpdir(), "rusa-codex-mcp-fixture-"));
    dirs.push(root);

    const codexHome = join(root, "codex-home");
    const project = join(root, "project");
    const projectCodex = join(project, ".codex");
    mkdirSync(codexHome, { recursive: true });
    mkdirSync(projectCodex, { recursive: true });

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

    const servers = await listEffectiveCodexMcpServers("codex", project, {
      ...process.env,
      CODEX_HOME: codexHome,
    });

    const serverNames = servers.map((s) => s.name).sort();
    expect(serverNames).toEqual(["computer-use", "docs"]);

    const cu = servers.find((s) => s.name === "computer-use");
    expect(cu).toBeDefined();
    expect(cu?.enabled).toBe(true);
    expect(cu?.transport).toMatchObject({
      type: "stdio",
      command: "fake-desktop-never-launched",
    });

    const docs = servers.find((s) => s.name === "docs");
    expect(docs).toBeDefined();
    expect(docs?.enabled).toBe(true);
  });

  it("proves project config overrides profile config for direct computer-use binding", async () => {
    const root = mkdtempSync(join(tmpdir(), "rusa-codex-profile-fixture-"));
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

    const servers = await listEffectiveCodexMcpServers("codex", project, {
      ...process.env,
      CODEX_HOME: codexHome,
    });

    const cu = servers.find((s) => s.name === "computer-use");
    expect(cu).toBeDefined();
    // Project precedence: project settings win over profile settings
    expect(cu?.transport).toMatchObject({
      command: "fake-desktop-never-launched",
      args: ["project"],
    });
  });

  it("fails closed without unfiltered fallback when configuration loading fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "rusa-codex-broken-fixture-"));
    dirs.push(root);

    const codexHome = join(root, "codex-home");
    const project = join(root, "project");
    mkdirSync(codexHome, { recursive: true });
    mkdirSync(project, { recursive: true });

    // Invalid transport in configuration
    writeFileSync(
      join(codexHome, "config.toml"),
      `[mcp_servers.computer-use]\ninvalid_key="bad"\n`
    );

    const config: ProviderConfig = { cliCommand: "codex" };
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
});
