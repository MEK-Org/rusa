// Offline pinned-Pi admission probe. Use Node 22.19.0 with --experimental-strip-types.
// All endpoints and the inference key are synthetic. No paid or external inference.

import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mcpAdmissionExtension } from "../../../packages/rusa/src/providers/openrouter/mcp-admission.ts";

if (!process.argv[2])
  throw new Error("usage: node --experimental-strip-types mcp-guard-probe.mjs PI_JS");
const root = await mkdtemp(join(tmpdir(), "clipai-1106-guard-"));
let inference = 0;
const server = createServer((req, res) => {
  if (req.url.includes("chat/completions")) inference++;
  res.writeHead(503);
  res.end("synthetic unavailable");
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const url = `http://127.0.0.1:${server.address().port}`;
await mkdir(join(root, "work"));
await mkdir(join(root, "agent"));
await writeFile(
  join(root, "agent/settings.json"),
  JSON.stringify({ cacheWarming: "off", retry: { enabled: false }, compaction: { enabled: false } })
);
await writeFile(
  join(root, "agent/mcp.json"),
  JSON.stringify({ mcpServers: { required: { url, exposure: "direct" } } })
);
await writeFile(
  join(root, "agent/models.json"),
  JSON.stringify({
    providers: {
      openrouter: {
        baseUrl: url,
        apiKey: "synthetic",
        api: "openai-completions",
        models: [
          {
            id: "synthetic-model",
            name: "Synthetic",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 10000,
            maxTokens: 1000,
          },
        ],
      },
    },
  })
);
await writeFile(join(root, "guard.mjs"), mcpAdmissionExtension(["required"], 100));
const child = spawn(
  process.execPath,
  [
    process.argv[2],
    "--mode",
    "rpc",
    "--no-session",
    "--no-builtin-tools",
    "--no-extensions",
    "-e",
    "builtin:mcp",
    "-e",
    join(root, "guard.mjs"),
    "--no-skills",
    "--no-prompt-templates",
    "--no-context-files",
    "--no-themes",
    "--no-approve",
    "--provider",
    "openrouter",
    "--model",
    "synthetic-model",
  ],
  {
    cwd: join(root, "work"),
    env: {
      HOME: root,
      PI_CODING_AGENT_DIR: join(root, "agent"),
      PI_SKIP_VERSION_CHECK: "1",
      PI_TELEMETRY: "0",
      OPENROUTER_API_KEY: "synthetic",
    },
    stdio: ["pipe", "pipe", "pipe"],
  }
);
let out = "",
  err = "";
child.stdout.on("data", (x) => (out += x));
child.stderr.on("data", (x) => (err += x));
const timer = setTimeout(() => child.kill("SIGKILL"), 30000);
child.stdin.write(
  `${JSON.stringify({
    id: "guard-test",
    type: "prompt",
    message: "Synthetic test. Required MCP unavailable.",
  })}\n`
);
const [code, signal] = await once(child, "close");
clearTimeout(timer);
await new Promise((resolve) => server.close(resolve));
await rm(root, { recursive: true, force: true });
console.log(JSON.stringify({ code, signal, inference, stdout: out, stderr: err }));
if (code !== 78 || inference !== 0) process.exitCode = 1;
