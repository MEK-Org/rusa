import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Actor } from "../actor/actor.js";
import { waitUntil } from "../remote-instances/harness.js";
import { CodexProvider, listEffectiveCodexMcpServers } from "./codex.js";
import { classifyRunExhaustion } from "./exhaustion-classifier.js";

const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// Fake inventory only. This models the configuration layers characterized by
// separate native config-read receipts; it is not proof of native tool execution.
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "rusa-886-inventory-"));
  dirs.push(root);
  const project = join(root, `project-${root.split("-").at(-1)}`);
  const home = join(root, "home");
  const codexHome = join(home, ".codex");
  const bin = join(project, "bin");
  for (const dir of [project, codexHome, bin, join(project, ".codex")])
    mkdirSync(dir, { recursive: true });
  const receipt = join(project, "invocations.jsonl");
  const command = join(bin, "codex");
  const parser = createRequire(import.meta.url).resolve("smol-toml");
  writeFileSync(
    command,
    `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { parse } = require(${JSON.stringify(parser)});
const args = process.argv.slice(2);
if (process.env.FAKE_NO_JSON && args.includes("--json")) { console.error("unsupported --json"); process.exit(2); }
if (process.env.FAKE_DISCOVERY_HANG && args.includes("mcp")) { setTimeout(() => {}, 60000); return; }
const home = process.env.CODEX_HOME;
function load(file) { return fs.existsSync(file) ? parse(fs.readFileSync(file, "utf8")) : {}; }
function merge(a, b) { for (const [k, v] of Object.entries(b)) {
  if (v && typeof v === "object" && !Array.isArray(v)) a[k] = merge(a[k] || {}, v);
  else a[k] = v;
} return a; }
let config = load(path.join(home, "config.toml"));
const profileAt = args.indexOf("--profile");
if (profileAt >= 0) config = merge(config, load(path.join(home, args[profileAt + 1] + ".config.toml")));
if (config.projects?.[process.cwd()]?.trust_level === "trusted") config = merge(config, load(path.join(process.cwd(), ".codex", "config.toml")));
for (let i = 0; i < args.length; i++) if (["-c", "--config"].includes(args[i])) {
  const override = args[++i];
  const equal = override.indexOf("=");
  const keys = override.slice(0, equal).split(".");
  let current = config;
  for (const key of keys.slice(0, -1)) current = current[key] ||= {};
  current[keys.at(-1)] = parse("value=" + override.slice(equal + 1)).value;
}
const servers = Object.entries(config.mcp_servers || {}).map(([name, c]) => {
  if (!c.command && !c.url) { console.error("invalid transport"); process.exit(1); }
  return { name, enabled: c.enabled !== false, transport: c.command ? { type: "stdio", command: c.command, args: c.args || [] } : { type: "streamable_http", url: c.url } };
});
const plugins = Object.entries(config.plugins || {}).filter(([, c]) => c.enabled !== false).map(([id]) => id);
const inventory = { servers, plugins };
if (process.env.FAKE_RECEIPT_PATH) fs.appendFileSync(process.env.FAKE_RECEIPT_PATH, JSON.stringify({ args, inventory }) + "\\n");
if (args.includes("mcp")) {
  if (process.env.FAKE_DISCOVERY_STDERR) console.error(process.env.FAKE_DISCOVERY_STDERR);
  const shape = process.env.FAKE_DISCOVERY_SHAPE;
  if (shape === "exit") process.exit(1);
  if (shape === "empty") process.exit(0);
  if (shape === "truncated") { process.stdout.write(JSON.stringify(servers).slice(0, -1)); process.exit(0); }
  if (shape === "object") { console.log(JSON.stringify({ servers })); process.exit(0); }
  console.log(JSON.stringify(servers)); process.exit(0);
}
if (args.includes("resume") && process.env.FAKE_RESUME_FAIL) process.exit(1);
if (args.includes("exec")) {
  console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify(inventory) } }));
  console.log(JSON.stringify({ type: "turn.completed" }));
  process.exit(0);
}
console.error("unsupported command"); process.exit(2);
`,
    { mode: 0o755 }
  );
  vi.stubEnv("HOME", home);
  vi.stubEnv("CODEX_HOME", codexHome);
  vi.stubEnv("PATH", `${bin}:${process.env.PATH}`);
  vi.stubEnv("FAKE_RECEIPT_PATH", receipt);
  const configPath = join(codexHome, "config.toml");
  writeFileSync(configPath, `[projects."${project}"]\ntrust_level="trusted"\n`);
  const provider = new CodexProvider("codex", { cliCommand: command }, "fixture-model");
  return { project, codexHome, configPath, command, provider, receipt };
}

function inventory(output: string) {
  return JSON.parse(output) as {
    servers: Array<{ name: string; enabled: boolean; transport: unknown }>;
    plugins: string[];
  };
}

describe("Codex computer-use fake inventories (#885)", () => {
  it("selects a profile, then observes project and invocation override precedence with preserved transport", async () => {
    const f = fixture();
    writeFileSync(
      join(f.codexHome, "desktop.config.toml"),
      '[mcp_servers.computer-use]\ncommand="fake-profile-never-launched"\nargs=["profile"]\nenabled=false\n'
    );
    const read = (configOverrides?: string[]) =>
      listEffectiveCodexMcpServers({
        command: f.command,
        cwd: f.project,
        args: [
          "--profile",
          "desktop",
          "mcp",
          "list",
          "--json",
          ...(configOverrides ?? []).flatMap((c) => ["-c", c]),
        ],
      });
    expect(await read()).toMatchObject([
      {
        name: "computer-use",
        enabled: false,
        transport: { command: "fake-profile-never-launched", args: ["profile"] },
      },
    ]);
    writeFileSync(
      join(f.project, ".codex", "config.toml"),
      '[mcp_servers.computer-use]\ncommand="fake-project-never-launched"\nargs=["project"]\nenabled=true\n[mcp_servers.docs]\nurl="https://example.invalid/docs"\n'
    );
    const project = await read();
    expect(project.find((s) => s.name === "computer-use")).toMatchObject({
      enabled: true,
      transport: { command: "fake-project-never-launched", args: ["project"] },
    });
    const denied = await read(["mcp_servers.computer-use.enabled=false"]);
    expect(denied.find((s) => s.name === "computer-use")).toMatchObject({
      enabled: false,
      transport: { command: "fake-project-never-launched", args: ["project"] },
    });
    expect(denied.find((s) => s.name === "docs")).toEqual(project.find((s) => s.name === "docs"));
  });

  it("filters only known plugin and direct inventories for denied, allowed, revoked and allowed-after-denied invocations without modifying settings", async () => {
    const f = fixture();
    appendFileSync(
      f.configPath,
      '[plugins."unified-computer-use@openai-bundled"]\nenabled=true\n[plugins."computer-use@openai-bundled"]\nenabled=true\n[plugins."unrelated@fixture"]\nenabled=true\n[mcp_servers.computer-use]\ncommand="fake-desktop-never-launched"\n[mcp_servers.docs]\nurl="https://example.invalid/docs"\n[mcp_servers.cua_repl]\ncommand="fake-plugin-server-never-launched"\n'
    );
    const before = readFileSync(f.configPath, "utf8");
    for (const computerUse of [undefined, true, false, true]) {
      const result = await f.provider.run({ prompt: "synthetic", cwd: f.project, computerUse });
      expect(result.success, result.output).toBe(true);
      const observed = inventory(result.output);
      expect(observed.plugins).toEqual(
        computerUse
          ? [
              "unified-computer-use@openai-bundled",
              "computer-use@openai-bundled",
              "unrelated@fixture",
            ]
          : ["unrelated@fixture"]
      );
      expect(observed.servers.find((s) => s.name === "computer-use")).toMatchObject({
        enabled: computerUse === true,
        transport: { command: "fake-desktop-never-launched" },
      });
      expect(observed.servers.find((s) => s.name === "docs")).toMatchObject({ enabled: true });
      expect(observed.servers.find((s) => s.name === "cua_repl")).toMatchObject({ enabled: true });
      expect(readFileSync(f.configPath, "utf8")).toBe(before);
    }
  });

  it("discovers inside the sandbox merged configuration, excluding the stripped host-only binding", async () => {
    const f = fixture();
    appendFileSync(
      f.configPath,
      '[mcp_servers.computer-use]\ncommand="host-only-never-launched"\n'
    );
    const result = await f.provider.run({
      prompt: "synthetic",
      cwd: f.project,
      computerUse: false,
      mcpServers: [{ name: "docs", url: "https://example.invalid/docs" }],
      sandbox: { worktreePath: f.project },
    });
    expect(result.success, result.output).toBe(true);
    expect(inventory(result.output).servers).toMatchObject([{ name: "docs", enabled: true }]);
    const receipts = readFileSync(f.receipt, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(receipts).toHaveLength(2);
    expect(receipts[0].inventory.servers.map((s: { name: string }) => s.name)).toEqual(["docs"]);
    expect(receipts[1].args).not.toContain("mcp_servers.computer-use.enabled=false");
  });

  const outcomes = {
    exit: "codex mcp list exited 1",
    empty: "codex mcp list exited 0 with no output",
    truncated: "codex mcp list exited 0 with invalid JSON (",
    object: "codex mcp list exited 0 with JSON that is not a server list",
  } as const;
  for (const [shape, expected] of Object.entries(outcomes)) {
    it(`names a ${shape} discovery outcome without argv or stdout and fails closed before exec`, async () => {
      const f = fixture();
      vi.stubEnv("FAKE_DISCOVERY_SHAPE", shape);
      appendFileSync(
        f.configPath,
        '[mcp_servers.docs]\ncommand="fake-stdout-only-never-launched"\n'
      );
      const result = await f.provider.run({
        prompt: "synthetic",
        cwd: f.project,
        computerUse: false,
        sandbox: { worktreePath: f.project },
      });
      expect(result.success).toBe(false);
      expect(result.output).toContain(
        `Failed to determine effective MCP configuration for computer-use denial: ${expected}`
      );
      expect(result.output).not.toContain("Command failed");
      expect(result.output).not.toContain("bwrap");
      expect(result.output).not.toContain("fake-stdout-only-never-launched");
      const invocations = readFileSync(f.receipt, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line).args as string[]);
      expect(invocations).toHaveLength(1);
      expect(invocations[0]).toContain("mcp");
    });
  }

  it("does not carry arbitrary stderr from a failed discovery", async () => {
    const f = fixture();
    vi.stubEnv("FAKE_DISCOVERY_SHAPE", "exit");
    vi.stubEnv("FAKE_DISCOVERY_STDERR", "token=SYNTHETIC_DISCOVERY_SECRET");
    const result = await f.provider.run({
      prompt: "synthetic",
      cwd: f.project,
      computerUse: false,
    });
    expect(result.success).toBe(false);
    expect(result.output).toContain("codex mcp list exited 1");
    expect(result.output).not.toContain("token=");
    expect(result.output).not.toContain("SYNTHETIC_DISCOVERY_SECRET");
  });

  for (const problem of ["unsupported-json", "invalid-transport"] as const) {
    it(`fails closed before exec on ${problem}`, async () => {
      const f = fixture();
      if (problem === "unsupported-json") vi.stubEnv("FAKE_NO_JSON", "1");
      else appendFileSync(f.configPath, "[mcp_servers.computer-use]\nenabled=false\n");
      const result = await f.provider.run({
        prompt: "synthetic",
        cwd: f.project,
        computerUse: false,
      });
      expect(result.success).toBe(false);
      expect(result.output).toContain("Failed to determine effective MCP configuration");
      expect(() => readFileSync(f.receipt)).toThrow();
      const attempts: string[] = [];
      const failures: string[] = [];
      const actor = new Actor({
        id: "discovery-failure",
        cwd: f.project,
        modelConfig: [{ provider: "codex" }, { provider: "fallback" }],
        mcpServers: [],
        resolveProvider: (entry) => {
          attempts.push(entry.provider);
          return f.provider;
        },
        classifyExhaustion: async (result) => {
          failures.push(result.output);
          return classifyRunExhaustion(result); // Actual deterministic path, no remote request.
        },
        loadSessionId: () => undefined,
        saveSessionId: () => {},
        buildPrompt: () => ({ prompt: "synthetic" }),
      });
      try {
        actor.requestRun();
        await waitUntil(() => failures.length === 1 && !actor.isBusy);
        expect(attempts).toEqual(["codex"]);
        expect(failures[0]).toContain("Failed to determine effective MCP configuration");
        expect(() => readFileSync(f.receipt)).toThrow();
      } finally {
        actor.close();
      }
    });
  }

  it("bounds a hung discovery by a shorter run timeout without launching exec", async () => {
    const f = fixture();
    vi.stubEnv("FAKE_DISCOVERY_HANG", "1");
    const result = await f.provider.run({
      prompt: "synthetic",
      cwd: f.project,
      computerUse: false,
      timeoutMs: 25,
    });
    expect(result.success).toBe(false);
    expect(result.cancelled).not.toBe(true);
    expect(result.output).toContain("Failed to determine effective MCP configuration");
    expect(result.output).toContain(
      "codex mcp list did not finish within 25ms (terminated by SIGTERM)"
    );
    expect(() => readFileSync(f.receipt)).toThrow();
  });

  it("honors cancellation during configuration discovery without launching exec", async () => {
    const f = fixture();
    vi.stubEnv("FAKE_DISCOVERY_HANG", "1");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 50);
    try {
      const result = await f.provider.run({
        prompt: "synthetic",
        cwd: f.project,
        computerUse: false,
        signal: controller.signal,
      });
      expect(result.cancelled).toBe(true);
      expect(result.success).toBe(false);
      expect(() => readFileSync(f.receipt)).toThrow();
    } finally {
      clearTimeout(timer);
    }
  });
});
