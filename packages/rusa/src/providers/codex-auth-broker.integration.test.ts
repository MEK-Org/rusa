import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CodexProvider } from "./codex.js";
import { CODEX_REFRESH_URL_ENV, configureCodexAuthBroker } from "./codex-auth-broker.js";
import { configureCodexHome } from "./codex-home.js";
import { codexRolloutStoreDir, teardownFlutterOverlay } from "./sandbox.js";
import type { RunResult } from "./types.js";

// Real Codex CLIs driven through CodexProvider.run against a local Responses API
// stand-in and a strict single-use token endpoint, with the host-owned broker on.
// Fixture credentials only: HOME points at a throwaway directory, and every
// token is an unsigned fixture JWT.
//
// Which CLIs: RUSA_CODEX_DRIVER_BINS (colon-separated paths, e.g. the pinned
// 0.144.4 and the current release), else `codex` on PATH. A CLI or bwrap that is
// missing is reported as a skipped test naming the missing evidence; a skip is
// not a pass.

function probe(command: string, args: string[]): string | undefined {
  try {
    return execFileSync(command, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
}

const BWRAP_CAPABLE = probe("bwrap", ["--ro-bind", "/", "/", "--", "/bin/true"]) !== undefined;
const DRIVER_BINS = (process.env.RUSA_CODEX_DRIVER_BINS ?? "codex").split(":").filter(Boolean);
const DRIVERS = DRIVER_BINS.map((bin) => ({ bin, version: probe(bin, ["--version"]) }));

const FAR = 4102444800;
const EXPIRED = 1000000000;

// Unsigned JWT: codex parses id/access token claims but does not verify them.
function fixtureJwt(exp: number, tag: string): string {
  const part = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${part({ alg: "none", typ: "JWT" })}.${part({
    email: "fixture@example.invalid",
    exp,
    tag,
    "https://api.openai.com/auth": {
      chatgpt_plan_type: "pro",
      chatgpt_account_id: "fixture-account",
      chatgpt_user_id: "fixture-user",
    },
  })}.fixture`;
}

const tagOf = (jwt: string): string => {
  try {
    return JSON.parse(Buffer.from(jwt.split(".")[1] ?? "", "base64url").toString()).tag ?? "?";
  } catch {
    return "?";
  }
};

interface Fixture {
  server: Server;
  base: string;
  /** Access tokens the Responses stand-in accepts. */
  valid: Set<string>;
  /** Upstream refresh requests, and the refresh token each one carried. */
  refreshes: string[];
  /** Upstream refreshes refused as reuse. */
  rejects: number;
  /** Responses calls: status and the access token's tag. */
  turns: Array<{ status: number; tag: string }>;
  currentRefresh: string;
  refreshDelayMs: number;
  /** Invalidate the bearer after the tool-call turn (a mid-run 401). */
  revokeAfterToolCall: boolean;
}

/**
 * One local server for both upstreams: `/oauth/token` is a strict single-use
 * refresh endpoint and `/v1/responses` asks codex to run `sh ./child.sh` once,
 * then ends the turn. Only bearers the token endpoint issued are accepted.
 */
async function startFixture(): Promise<Fixture> {
  let generation = 0;
  const fx = {
    valid: new Set<string>(),
    refreshes: [],
    rejects: 0,
    turns: [],
    currentRefresh: "fixture-refresh-0",
    refreshDelayMs: 0,
    revokeAfterToolCall: false,
  } as unknown as Fixture;
  fx.server = createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => {
      raw += d;
    });
    req.on("end", () => {
      const url = req.url ?? "";
      if (url === "/oauth/token") {
        const body = JSON.parse(raw || "{}") as { refresh_token?: string };
        fx.refreshes.push(String(body.refresh_token));
        if (body.refresh_token !== fx.currentRefresh) {
          fx.rejects++;
          res.writeHead(401, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { code: "refresh_token_reused" } }));
          return;
        }
        generation++;
        fx.currentRefresh = `fixture-refresh-${generation}`;
        const access = fixtureJwt(FAR, `a${generation}`);
        fx.valid.add(access);
        setTimeout(() => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              id_token: fixtureJwt(FAR, `i${generation}`),
              access_token: access,
              refresh_token: fx.currentRefresh,
            })
          );
        }, fx.refreshDelayMs);
        return;
      }
      if (req.method !== "POST" || !url.startsWith("/v1/responses")) {
        res.writeHead(404);
        res.end();
        return;
      }
      const bearer = (req.headers.authorization ?? "").replace(/^Bearer /, "");
      if (!fx.valid.has(bearer)) {
        fx.turns.push({ status: 401, tag: tagOf(bearer) });
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "token expired", code: "token_expired" } }));
        return;
      }
      fx.turns.push({ status: 200, tag: tagOf(bearer) });
      const final = raw.includes('"function_call_output"');
      res.writeHead(200, { "content-type": "text/event-stream" });
      const event = (o: { type: string } & Record<string, unknown>) =>
        res.write(`event: ${o.type}\ndata: ${JSON.stringify(o)}\n\n`);
      event({ type: "response.created", response: { id: "r" } });
      event({
        type: "response.output_item.done",
        item: final
          ? { type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] }
          : {
              type: "function_call",
              name: "exec_command",
              arguments: JSON.stringify({ cmd: "sh ./child.sh > ./child-report.txt 2>&1" }),
              call_id: "call-1",
            },
      });
      event({
        type: "response.completed",
        response: { id: "r", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } },
      });
      res.end();
      if (!final && fx.revokeAfterToolCall) fx.valid.delete(bearer);
    });
  });
  await new Promise<void>((r) => fx.server.listen(0, "127.0.0.1", r));
  fx.base = `http://127.0.0.1:${(fx.server.address() as AddressInfo).port}`;
  return fx;
}

/**
 * What a child of the actor's CLI tries: every route to the canonical login,
 * forging and replaying against the broker. Each line reports an outcome only.
 */
const HOSTILE_CHILD = (canonical: string) => `
# Codex may withhold *TOKEN* variables from shell children; a determined child
# finds the URL in its CLI's environment anyway, so the test does too.
url="\${CODEX_REFRESH_TOKEN_URL_OVERRIDE:-$(for f in /proc/[0-9]*/environ; do tr '\\0' '\\n' < "$f" 2>/dev/null; done | sed -n 's/^CODEX_REFRESH_TOKEN_URL_OVERRIDE=//p' | head -n1)}"
echo "found_broker_url:$(case "$url" in http://127.0.0.1:*) echo yes;; *) echo no;; esac)"
cap=$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync("/tmp/auth.json","utf8")).tokens.refresh_token)')
echo "private_refresh_is_cap:$(case "$cap" in rusa-cap-*) echo yes;; *) echo no;; esac)"
( printf child-evil > "$CODEX_HOME/auth.json" ) 2>/dev/null; echo "codex_home_write:$?"
( printf child-evil > "${canonical}" ) 2>/dev/null; echo "canonical_write:$?"
( printf child-evil > "$HOME/.codex/auth.json" ) 2>/dev/null; echo "home_codex_write:$?"
( cat "${canonical}" >/dev/null ) 2>/dev/null; echo "canonical_read:$?"
echo "forged_cap:$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' -d '{"grant_type":"refresh_token","refresh_token":"rusa-cap-forged"}' "$url")"
echo "worker_fields:$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' -d "{\\"grant_type\\":\\"refresh_token\\",\\"refresh_token\\":\\"$cap\\",\\"access_token\\":\\"child-evil\\",\\"path\\":\\"/tmp/x\\"}" "$url")"
resp=$(curl -s -X POST -H 'content-type: application/json' -d "{\\"grant_type\\":\\"refresh_token\\",\\"refresh_token\\":\\"$cap\\"}" "$url")
case "$resp" in *refresh_token*) echo "direct_refresh:leaks-refresh";; *access_token*) echo "direct_refresh:access-only";; *) echo "direct_refresh:other";; esac
`;

describe("Codex host-owned auth broker (real driver)", () => {
  const originalHome = process.env.HOME;
  let root: string;
  let codexDir: string;
  let canonical: string;
  let fx: Fixture;

  const writeCanonical = (accessExp: number) => {
    const access = fixtureJwt(accessExp, "a0");
    if (accessExp > Date.now() / 1000) fx.valid.add(access);
    writeFileSync(
      canonical,
      JSON.stringify({
        auth_mode: "chatgpt",
        OPENAI_API_KEY: null,
        tokens: {
          id_token: fixtureJwt(accessExp, "i0"),
          access_token: access,
          refresh_token: "fixture-refresh-0",
          account_id: "fixture-account",
        },
        last_refresh: "2020-01-01T00:00:00Z",
      }),
      { mode: 0o600 }
    );
  };
  const canonicalRefresh = () => JSON.parse(readFileSync(canonical, "utf8")).tokens.refresh_token;

  const actor = (name: string, script = "true\n") => {
    const dir = join(root, name);
    mkdirSync(dir);
    writeFileSync(join(dir, "child.sh"), script);
    return dir;
  };
  const report = (dir: string) => readFileSync(join(dir, "child-report.txt"), "utf8");

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "codex-broker-driver-"));
    process.env.HOME = join(root, "home");
    codexDir = join(root, "home", ".codex");
    mkdirSync(codexDir, { recursive: true });
    canonical = join(codexDir, "auth.json");
    fx = await startFixture();
    // The driver merges the host config into the sandbox's config.toml; this
    // one points the CLI at the fixture instead of the real service.
    writeFileSync(
      join(codexDir, "config.toml"),
      [
        'model_provider = "fixture"',
        `chatgpt_base_url = "${fx.base}/backend-api/"`,
        "[model_providers.fixture]",
        'name = "fixture"',
        `base_url = "${fx.base}/v1"`,
        'wire_api = "responses"',
        "requires_openai_auth = true",
        "[features]",
        "apps = false",
        "",
      ].join("\n")
    );
    brokerOn();
  });

  const brokerOn = (minRotationIntervalMs?: number) =>
    configureCodexAuthBroker(true, {
      codexHome: codexDir,
      upstreamUrl: `${fx.base}/oauth/token`,
      upstreamTimeoutMs: 10_000,
      minRotationIntervalMs,
    });

  /**
   * Move the fixture login to a dedicated `providers.codex.home` (#782) under
   * `parent`, and leave a decoy at the default `~/.codex` that no run may use:
   * its config points at a closed port and its login is never refreshed. The
   * broker is configured without `codexHome`, so it finds the login only
   * through the resolver.
   */
  const useConfiguredHome = (parent: string, brokered = true) => {
    const home = join(parent, "codex-canary");
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "config.toml"), readFileSync(join(codexDir, "config.toml")));
    writeFileSync(
      join(codexDir, "config.toml"),
      'model_provider = "decoy"\n[model_providers.decoy]\nname = "decoy"\nbase_url = "http://127.0.0.1:9/v1"\nwire_api = "responses"\n'
    );
    writeFileSync(
      join(codexDir, "auth.json"),
      JSON.stringify({ auth_mode: "chatgpt", tokens: { refresh_token: "fixture-refresh-decoy" } }),
      { mode: 0o600 }
    );
    canonical = join(home, "auth.json");
    configureCodexHome(home);
    if (brokered) {
      configureCodexAuthBroker(true, {
        upstreamUrl: `${fx.base}/oauth/token`,
        upstreamTimeoutMs: 10_000,
      });
    } else {
      configureCodexAuthBroker(false);
    }
    return { home, decoy: readFileSync(join(codexDir, "auth.json"), "utf8") };
  };

  afterEach(async () => {
    configureCodexAuthBroker(false);
    configureCodexHome(undefined);
    delete process.env[CODEX_REFRESH_URL_ENV];
    fx.server.closeAllConnections();
    await new Promise((r) => fx.server.close(r));
    for (const name of ["w1", "w2", "w3", "a", "b", "c"]) {
      const dir = join(root, name);
      rmSync(codexRolloutStoreDir(dir), { recursive: true, force: true });
      teardownFlutterOverlay(dir);
    }
    rmSync(root, { recursive: true, force: true });
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  });

  for (const driver of DRIVERS) {
    const label = `${driver.version ?? "unavailable"} (${driver.bin})`;
    const missing = !BWRAP_CAPABLE
      ? "bwrap"
      : !driver.version
        ? `codex CLI ${driver.bin}`
        : undefined;

    describe(label, () => {
      const provider = () =>
        new CodexProvider("codex", { cliCommand: driver.bin }, "fixture-model");
      const runIn = (
        dir: string,
        extra: { signal?: AbortSignal; sandboxed?: boolean } = {}
      ): Promise<RunResult> =>
        provider().run({
          prompt: "fixture turn",
          cwd: dir,
          timeoutMs: 60_000,
          signal: extra.signal,
          ...(extra.sandboxed === false ? {} : { sandbox: { worktreePath: dir } }),
        } as Parameters<CodexProvider["run"]>[0]);

      it.skipIf(!!missing)(
        `steady state: a hostile child reaches no canonical login (missing evidence if skipped: ${missing ?? "none"})`,
        async () => {
          writeCanonical(FAR);
          const before = readFileSync(canonical, "utf8");
          const dir = actor("a", HOSTILE_CHILD(canonical));
          const result = await runIn(dir);
          expect(result.success, result.output.slice(-2000)).toBe(true);
          const lines = report(dir);
          expect(lines).toContain("private_refresh_is_cap:yes");
          expect(lines).toContain("found_broker_url:yes");
          expect(lines).toMatch(/canonical_write:[1-9]/);
          expect(lines).toMatch(/home_codex_write:[1-9]/);
          expect(lines).toMatch(/canonical_read:[1-9]/);
          expect(lines).toContain("forged_cap:401");
          expect(lines).toContain("worker_fields:400");
          expect(lines).toContain("direct_refresh:access-only");
          // The child's direct refresh through the broker rotated canonical once;
          // nothing the child sent reached the canonical file.
          const after = readFileSync(canonical, "utf8");
          expect(after).not.toContain("child-evil");
          expect(fx.refreshes).toEqual(["fixture-refresh-0"]);
          expect(before).not.toBe(after);
        },
        90_000
      );

      it.skipIf(!!missing)(
        "expired at start: the CLI refreshes through the broker, which alone rotates canonical",
        async () => {
          writeCanonical(EXPIRED);
          const dir = actor("a");
          const result = await runIn(dir);
          expect(result.success, result.output.slice(-2000)).toBe(true);
          expect(fx.refreshes).toEqual(["fixture-refresh-0"]);
          expect(canonicalRefresh()).toBe("fixture-refresh-1");
          expect(fx.turns.every((t) => t.status === 200 && t.tag === "a1")).toBe(true);
        },
        90_000
      );

      it.skipIf(!!missing)(
        "401 mid-run: the CLI recovers with a broker-issued token",
        async () => {
          writeCanonical(FAR);
          fx.revokeAfterToolCall = true;
          const dir = actor("a");
          const result = await runIn(dir);
          expect(result.success, result.output.slice(-2000)).toBe(true);
          expect(fx.turns.some((t) => t.status === 401)).toBe(true);
          expect(fx.turns.at(-1)).toEqual({ status: 200, tag: "a1" });
          expect(fx.refreshes).toHaveLength(1);
        },
        90_000
      );

      it.skipIf(!!missing)(
        "expired at start, then 401 mid-run past the rotation window: a second rotation recovers",
        async () => {
          brokerOn(0);
          writeCanonical(EXPIRED);
          fx.revokeAfterToolCall = true;
          const dir = actor("a");
          const result = await runIn(dir);
          expect(result.success, result.output.slice(-2000)).toBe(true);
          expect(fx.turns.some((t) => t.status === 401 && t.tag === "a1")).toBe(true);
          expect(fx.turns.at(-1)).toEqual({ status: 200, tag: "a2" });
          expect(fx.refreshes).toEqual(["fixture-refresh-0", "fixture-refresh-1"]);
          expect(canonicalRefresh()).toBe("fixture-refresh-2");
        },
        90_000
      );

      it.skipIf(!!missing)(
        "expired at start, then 401 mid-run inside the rotation window: the broker serves canonical as is",
        async () => {
          // The default 60 s window bounds capability replay: a freshly rotated
          // token rejected within it is handed back rather than rotated again.
          writeCanonical(EXPIRED);
          fx.revokeAfterToolCall = true;
          const dir = actor("a");
          const result = await runIn(dir);
          expect(result.success).toBe(false);
          expect(fx.turns.filter((t) => t.status === 200).map((t) => t.tag)).toEqual(["a1"]);
          expect(fx.turns.some((t) => t.status === 401 && t.tag === "a1")).toBe(true);
          expect(fx.refreshes).toEqual(["fixture-refresh-0"]);
          expect(canonicalRefresh()).toBe("fixture-refresh-1");
        },
        90_000
      );

      it.skipIf(!!missing)(
        "concurrent sandboxed and unsandboxed runs share one upstream rotation",
        async () => {
          writeCanonical(EXPIRED);
          fx.refreshDelayMs = 1_500;
          const results = await Promise.all([
            runIn(actor("w1")),
            runIn(actor("w2")),
            runIn(actor("w3")),
            runIn(actor("c"), { sandboxed: false }),
          ]);
          for (const r of results) expect(r.success, r.output.slice(-1500)).toBe(true);
          expect(fx.refreshes).toEqual(["fixture-refresh-0"]);
          expect(fx.rejects).toBe(0);
          expect(canonicalRefresh()).toBe("fixture-refresh-1");
        },
        120_000
      );

      it.skipIf(!!missing)(
        "cancellation mid-refresh still persists the rotation for the next run",
        async () => {
          writeCanonical(EXPIRED);
          fx.refreshDelayMs = 3_000;
          const abort = new AbortController();
          const pending = runIn(actor("a"), { signal: abort.signal });
          while (fx.refreshes.length === 0) await new Promise((r) => setTimeout(r, 50));
          abort.abort();
          expect((await pending).success).toBe(false);
          while (canonicalRefresh() === "fixture-refresh-0")
            await new Promise((r) => setTimeout(r, 50));
          fx.refreshDelayMs = 0;
          const next = await runIn(actor("b"));
          expect(next.success, next.output.slice(-1500)).toBe(true);
          expect(fx.refreshes).toEqual(["fixture-refresh-0"]);
          expect(fx.rejects).toBe(0);
        },
        90_000
      );

      it.skipIf(!!missing)(
        "a refused login fails the launch closed and leaves canonical alone",
        async () => {
          writeCanonical(EXPIRED);
          fx.currentRefresh = "fixture-refresh-elsewhere";
          const before = readFileSync(canonical, "utf8");
          const result = await runIn(actor("a"));
          expect(result.success).toBe(false);
          expect(readFileSync(canonical, "utf8")).toBe(before);
          expect(fx.refreshes).toEqual(["fixture-refresh-0"]);
        },
        90_000
      );

      it.skipIf(!!missing)(
        "configured home beneath the actor's writable dir: a hostile child reaches neither login (#782)",
        async () => {
          const parent = join(root, "a");
          const configured = join(parent, "codex-canary", "auth.json");
          const defaultAuth = join(codexDir, "auth.json");
          const dir = actor(
            "a",
            `${HOSTILE_CHILD(configured)}
( printf child-evil > "${defaultAuth}" ) 2>/dev/null; echo "default_write:$?"
( cat "${defaultAuth}" >/dev/null ) 2>/dev/null; echo "default_read:$?"
( ls "${dirname(configured)}" | grep -q . ) 2>/dev/null; echo "configured_listing:$?"
`
          );
          const { decoy } = useConfiguredHome(parent);
          writeCanonical(FAR);
          const before = readFileSync(canonical, "utf8");
          const result = await runIn(dir);
          expect(result.success, result.output.slice(-2000)).toBe(true);
          const lines = report(dir);
          expect(lines).toContain("private_refresh_is_cap:yes");
          expect(lines).toMatch(/canonical_write:[1-9]/);
          expect(lines).toMatch(/canonical_read:[1-9]/);
          expect(lines).toMatch(/default_write:[1-9]/);
          expect(lines).toMatch(/default_read:[1-9]/);
          expect(lines).toMatch(/configured_listing:[1-9]/);
          expect(lines).toContain("direct_refresh:access-only");
          const after = readFileSync(canonical, "utf8");
          expect(after).not.toContain("child-evil");
          expect(after).not.toBe(before);
          expect(fx.refreshes).toEqual(["fixture-refresh-0"]);
          expect(readFileSync(defaultAuth, "utf8")).toBe(decoy);
        },
        90_000
      );

      for (const sandboxed of [true, false]) {
        it.skipIf(!!missing)(
          `configured home, expired at start${sandboxed ? "" : " (unsandboxed)"}: the broker persists the rotation there (#782)`,
          async () => {
            const { decoy } = useConfiguredHome(root);
            writeCanonical(EXPIRED);
            const result = await runIn(actor("a"), { sandboxed });
            expect(result.success, result.output.slice(-2000)).toBe(true);
            expect(fx.refreshes).toEqual(["fixture-refresh-0"]);
            expect(canonicalRefresh()).toBe("fixture-refresh-1");
            expect(fx.turns.every((t) => t.status === 200 && t.tag === "a1")).toBe(true);
            expect(readFileSync(join(codexDir, "auth.json"), "utf8")).toBe(decoy);
          },
          90_000
        );
      }

      it.skipIf(!!missing)(
        "configured home, broker off, unsandboxed: the CLI refreshes the configured login in place (#782)",
        async () => {
          const { decoy } = useConfiguredHome(root, false);
          process.env[CODEX_REFRESH_URL_ENV] = `${fx.base}/oauth/token`;
          writeCanonical(EXPIRED);
          const result = await runIn(actor("a"), { sandboxed: false });
          expect(result.success, result.output.slice(-2000)).toBe(true);
          expect(fx.refreshes).toEqual(["fixture-refresh-0"]);
          expect(canonicalRefresh()).toBe("fixture-refresh-1");
          expect(readFileSync(join(codexDir, "auth.json"), "utf8")).toBe(decoy);
        },
        90_000
      );
    });
  }

  it("fails a launch closed, without a writable login bind, when the canonical login is missing", async () => {
    // No CLI needed: the lease fails before any spawn.
    const result = await new CodexProvider("codex", { cliCommand: "/bin/false" }).run({
      prompt: "fixture turn",
      cwd: root,
      sandbox: { worktreePath: actor("a") },
    } as Parameters<CodexProvider["run"]>[0]);
    expect(result.success).toBe(false);
    expect(result.output).toMatch(/login required.*Codex launches are paused/);
  });
});
