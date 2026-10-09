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
import { createActorLifecycle } from "../actor/actor-lifecycle.js";
import { waitUntil } from "../remote-instances/harness.js";
import { CodexProvider } from "./codex.js";

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
// The observed failure: \`mcp list --json\` exits 0 with blank stdout.
if (args.includes("mcp")) process.exit(0);
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
  it("filters only known plugins for denied, allowed, revoked and allowed-after-denied invocations without modifying settings", async () => {
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
      // No startup discovery: an unsandboxed run inherits a direct binding unchanged.
      expect(observed.servers.find((s) => s.name === "computer-use")).toMatchObject({
        enabled: true,
        transport: { command: "fake-desktop-never-launched" },
      });
      expect(observed.servers.find((s) => s.name === "docs")).toMatchObject({ enabled: true });
      expect(observed.servers.find((s) => s.name === "cua_repl")).toMatchObject({ enabled: true });
      expect(readFileSync(f.configPath, "utf8")).toBe(before);
    }
  });

  it("strips the host-only direct binding from the sandbox merged configuration", async () => {
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
    expect(receipts).toHaveLength(1);
    expect(receipts[0].args).toContain("exec");
    expect(receipts[0].args).not.toContain("mcp_servers.computer-use.enabled=false");
  });

  it("starts the actor's run without a discovery subprocess when MCP listing would return blank success", async () => {
    const f = fixture();
    appendFileSync(
      f.configPath,
      '[plugins."computer-use@openai-bundled"]\nenabled=true\n[plugins."unrelated@fixture"]\nenabled=true\n'
    );
    const attempts: string[] = [];
    const outputs: string[] = [];
    const actor = new Actor({
      id: "no-discovery",
      cwd: f.project,
      modelConfig: [{ provider: "codex" }, { provider: "fallback" }],
      mcpServers: [],
      resolveProvider: (entry) => {
        attempts.push(entry.provider);
        return f.provider;
      },
      lifecycle: createActorLifecycle([
        {
          onEnd: ({ terminal }) => {
            if (terminal.kind === "result") outputs.push(terminal.result.output);
          },
        },
      ]),
      loadSessionId: () => undefined,
      saveSessionId: () => {},
      buildPrompt: () => ({ prompt: "synthetic" }),
    });
    try {
      actor.requestRun();
      await waitUntil(() => outputs.length === 1 && !actor.isBusy);
      expect(attempts).toEqual(["codex"]);
      expect(inventory(outputs[0]).plugins).toEqual(["unrelated@fixture"]);
      const invocations = readFileSync(f.receipt, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line).args as string[]);
      expect(invocations).toHaveLength(1);
      expect(invocations[0]).toContain("exec");
      expect(invocations[0]).not.toContain("mcp");
    } finally {
      actor.close();
    }
  });
});
