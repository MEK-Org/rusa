import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildCodexArgs } from "./codex.js";
import {
  buildActorBwrapArgs,
  codexRolloutStoreDir,
  SANDBOX_CODEX_SHELL_ENV_OVERRIDE,
  SANDBOX_CODEX_SHELL_HOME,
  teardownFlutterOverlay,
} from "./sandbox.js";

function probeBwrapCapable(): boolean {
  try {
    execFileSync("bwrap", ["--ro-bind", "/", "/", "--", "/bin/true"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const BWRAP_CAPABLE = probeBwrapCapable();

function probeCodexCli(): boolean {
  try {
    execFileSync("codex", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const CODEX_CLI = probeCodexCli();

describe.skipIf(!BWRAP_CAPABLE)("Codex shared auth bind (real bwrap)", () => {
  const originalHome = process.env.HOME;
  let actorDir: string;
  let fixtureHome: string;

  beforeEach(() => {
    fixtureHome = mkdtempSync(join(tmpdir(), "codex-auth-home-"));
    process.env.HOME = fixtureHome;
    actorDir = mkdtempSync(join(tmpdir(), "codex-auth-actor-"));
  });

  afterEach(() => {
    rmSync(codexRolloutStoreDir(actorDir), { recursive: true, force: true });
    teardownFlutterOverlay(actorDir);
    rmSync(actorDir, { recursive: true, force: true });
    rmSync(fixtureHome, { recursive: true, force: true });
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  });

  it("persists a sandbox write through /tmp/auth.json to the host auth file", () => {
    const hostAuthPath = join(fixtureHome, ".codex", "auth.json");
    mkdirSync(join(fixtureHome, ".codex"), { recursive: true });
    writeFileSync(hostAuthPath, "host-before", { mode: 0o600 });

    const { args } = buildActorBwrapArgs(actorDir, "codex");
    execFileSync(
      "bwrap",
      [...args, "--", "/bin/sh", "-c", "printf sandbox-after > /tmp/auth.json"],
      { stdio: "pipe" }
    );

    expect(readFileSync(hostAuthPath, "utf8")).toBe("sandbox-after");
  });
});

// Unsigned JWT: codex parses id/access token claims but does not verify them.
function fixtureJwt(exp: number): string {
  const part = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${part({ alg: "none", typ: "JWT" })}.${part({
    email: "fixture@example.invalid",
    exp,
    "https://api.openai.com/auth": {
      chatgpt_plan_type: "pro",
      chatgpt_account_id: "fixture-account",
      chatgpt_user_id: "fixture-user",
    },
  })}.fixture`;
}

/**
 * Local stand-in for the Responses API and the token endpoint. The first model
 * turn asks codex to run `shellCommand` through its shell tool; the next turn
 * ends the conversation. Token requests return a rotated fixture refresh token.
 */
function startMockCodexBackend(shellCommand: string): Promise<{
  server: Server;
  port: number;
  tokenRequests: () => number;
}> {
  let turns = 0;
  let tokens = 0;
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      const url = req.url ?? "";
      if (url.startsWith("/oauth/token")) {
        tokens++;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            id_token: fixtureJwt(4102444800),
            access_token: fixtureJwt(4102444800),
            refresh_token: "fixture-rotated-refresh",
          })
        );
        return;
      }
      if (req.method !== "POST" || !url.startsWith("/v1/responses")) {
        res.writeHead(404);
        res.end();
        return;
      }
      turns++;
      res.writeHead(200, { "content-type": "text/event-stream" });
      const event = (o: { type: string } & Record<string, unknown>) =>
        res.write(`event: ${o.type}\ndata: ${JSON.stringify(o)}\n\n`);
      event({ type: "response.created", response: { id: `r${turns}` } });
      event({
        type: "response.output_item.done",
        item:
          turns === 1
            ? {
                type: "function_call",
                name: "exec_command",
                arguments: JSON.stringify({ cmd: shellCommand }),
                call_id: "call-1",
              }
            : {
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: "done" }],
              },
      });
      event({
        type: "response.completed",
        response: {
          id: `r${turns}`,
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        },
      });
      res.end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () =>
      resolve({
        server,
        port: (server.address() as AddressInfo).port,
        tokenRequests: () => tokens,
      })
    );
  });
}

function runToExit(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv
): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (d) => (output += d));
    child.stderr.on("data", (d) => (output += d));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, output }));
  });
}

// The actor's Codex CLI and every process it starts share the sandbox's mounts,
// so /tmp/auth.json (the live host auth bind) is reachable by path from both.
// What separates them is CODEX_HOME: the CLI keeps /tmp, its shell children get
// SANDBOX_CODEX_SHELL_HOME. Drive a real codex against a local mock backend, all
// on fixture credentials, and check both halves in one run.
describe.skipIf(!BWRAP_CAPABLE || !CODEX_CLI)(
  "Codex shell children vs the live auth bind (real bwrap + real codex CLI)",
  () => {
    const originalHome = process.env.HOME;
    let actorDir: string;
    let fixtureHome: string;
    let server: Server | undefined;

    beforeEach(() => {
      fixtureHome = mkdtempSync(join(tmpdir(), "codex-shell-home-host-"));
      process.env.HOME = fixtureHome;
      actorDir = mkdtempSync(join(tmpdir(), "codex-shell-home-actor-"));
    });

    afterEach(async () => {
      if (server) await new Promise((resolve) => server?.close(resolve));
      server = undefined;
      rmSync(codexRolloutStoreDir(actorDir), { recursive: true, force: true });
      teardownFlutterOverlay(actorDir);
      rmSync(actorDir, { recursive: true, force: true });
      rmSync(fixtureHome, { recursive: true, force: true });
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
    });

    it("persists the CLI's own refresh but not a shell child's $CODEX_HOME/auth.json write", async () => {
      const hostAuthPath = join(fixtureHome, ".codex", "auth.json");
      mkdirSync(join(fixtureHome, ".codex"), { recursive: true });
      // Expired access token: the CLI refreshes before its first model request.
      writeFileSync(
        hostAuthPath,
        JSON.stringify({
          auth_mode: "chatgpt",
          OPENAI_API_KEY: null,
          tokens: {
            id_token: fixtureJwt(1000000000),
            access_token: fixtureJwt(1000000000),
            refresh_token: "fixture-original-refresh",
            account_id: "fixture-account",
          },
          last_refresh: "2020-01-01T00:00:00Z",
        }),
        { mode: 0o600 }
      );

      // What the incident's fake CLI did: trust ambient CODEX_HOME and write a
      // "refreshed" auth file there. Also record which home the child saw.
      const childHomeRecord = join(actorDir, "child-codex-home.txt");
      const backend = await startMockCodexBackend(
        `printf '%s' "$CODEX_HOME" > ${childHomeRecord}; printf fixture-child-write > "$CODEX_HOME/auth.json"`
      );
      server = backend.server;
      const base = `http://127.0.0.1:${backend.port}`;

      const { args } = buildActorBwrapArgs(actorDir, "codex");
      const codexArgs = buildCodexArgs({
        prompt: "fixture turn",
        cwd: actorDir,
        configOverrides: [
          SANDBOX_CODEX_SHELL_ENV_OVERRIDE,
          'model_provider="fixture"',
          'model_providers.fixture.name="fixture"',
          `model_providers.fixture.base_url="${base}/v1"`,
          'model_providers.fixture.wire_api="responses"',
          "model_providers.fixture.requires_openai_auth=true",
          `chatgpt_base_url="${base}/backend-api/"`,
          "features.apps=false",
          "features.daemon_auto_start=false",
        ],
      });
      const result = await runToExit("bwrap", [...args, "--", "codex", ...codexArgs], {
        ...process.env,
        CODEX_REFRESH_TOKEN_URL_OVERRIDE: `${base}/oauth/token`,
      });

      expect(result.code, result.output).toBe(0);
      const hostAuth = readFileSync(hostAuthPath, "utf8");
      // The shell child's write never reached the host file...
      expect(hostAuth).not.toContain("fixture-child-write");
      expect(readFileSync(childHomeRecord, "utf8")).toBe(SANDBOX_CODEX_SHELL_HOME);
      // ...while the CLI's own refresh went through the bind to it.
      expect(backend.tokenRequests()).toBeGreaterThan(0);
      expect(JSON.parse(hostAuth).tokens.refresh_token).toBe("fixture-rotated-refresh");
    }, 60_000);
  }
);
