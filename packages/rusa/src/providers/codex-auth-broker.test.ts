import { type ChildProcess, spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LogFields, Logger } from "../observability/logger.js";
import {
  CODEX_OAUTH_CLIENT_ID,
  CodexAuthBroker,
  type CodexAuthBrokerOptions,
  codexAuthBrokerConfigured,
  parseCodexRefreshRequest,
  seedBrokeredCodexHome,
} from "./codex-auth-broker.js";

// Fixture credentials only: every token below is a made-up string, and every
// canonical file lives in a throwaway directory.

interface LogRecord {
  level: string;
  event: string;
  fields?: LogFields;
}

function recorder(records: LogRecord[]): Logger {
  const log: Logger = {
    debug: (event, fields) => records.push({ level: "debug", event, fields }),
    info: (event, fields) => records.push({ level: "info", event, fields }),
    warn: (event, fields) => records.push({ level: "warn", event, fields }),
    error: (event, fields) => records.push({ level: "error", event, fields }),
    child: () => log,
  };
  return log;
}

/**
 * A strict single-use refresh endpoint: each refresh token works once, and a
 * reused one is refused the way the real endpoint refuses it.
 */
class FixtureUpstream {
  calls: Array<Record<string, unknown>> = [];
  private live = new Set<string>();
  private generation = 0;
  delayMs = 0;
  mode: "ok" | "reject" | "hang" | "error" = "ok";
  private server!: Server;
  url = "";

  constructor(initialRefresh: string) {
    this.live.add(initialRefresh);
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => {
        raw += c;
      });
      req.on("end", async () => {
        const body = JSON.parse(raw) as Record<string, unknown>;
        this.calls.push(body);
        if (this.mode === "hang") return;
        if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
        const json = (status: number, payload: unknown) => {
          res.writeHead(status, { "content-type": "application/json" });
          res.end(JSON.stringify(payload));
        };
        if (this.mode === "error") return json(500, { error: "server_error" });
        const token = String(body.refresh_token);
        if (this.mode === "reject" || !this.live.delete(token)) {
          return json(401, { error: { code: "refresh_token_reused" } });
        }
        this.generation += 1;
        const next = `fixture-refresh-${this.generation}`;
        this.live.add(next);
        json(200, {
          access_token: `fixture-access-${this.generation}`,
          id_token: `fixture-id-${this.generation}`,
          refresh_token: next,
        });
      });
    });
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/oauth/token`;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((r) => this.server.close(() => r()));
  }
}

function writeCanonical(dir: string, access: string, refresh: string): void {
  writeFileSync(
    join(dir, "auth.json"),
    JSON.stringify({
      OPENAI_API_KEY: null,
      tokens: {
        id_token: "fixture-id-0",
        access_token: access,
        refresh_token: refresh,
        account_id: "fixture-account",
      },
      last_refresh: "2026-01-01T00:00:00Z",
    }),
    { mode: 0o600 }
  );
}

function readCanonical(dir: string): { tokens: Record<string, string>; last_refresh: string } {
  return JSON.parse(readFileSync(join(dir, "auth.json"), "utf8"));
}

function capOf(authJson: string): string {
  return (JSON.parse(authJson) as { tokens: { refresh_token: string } }).tokens.refresh_token;
}

async function refresh(
  url: string,
  body: unknown,
  init: RequestInit = {}
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
    ...init,
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : {} };
}

const refreshBody = (cap: string) => ({
  client_id: CODEX_OAUTH_CLIENT_ID,
  grant_type: "refresh_token",
  refresh_token: cap,
});

describe("CodexAuthBroker (fixture upstream)", () => {
  let home: string;
  let upstream: FixtureUpstream;
  let logs: LogRecord[];
  const brokers: CodexAuthBroker[] = [];
  const children: ChildProcess[] = [];

  const makeBroker = (opts: Partial<CodexAuthBrokerOptions> = {}) => {
    const broker = new CodexAuthBroker({
      codexHome: home,
      upstreamUrl: upstream.url,
      upstreamTimeoutMs: 2_000,
      lockWaitMs: 5_000,
      logger: recorder(logs),
      ...opts,
    });
    brokers.push(broker);
    return broker;
  };

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), "codex-broker-home-"));
    writeCanonical(home, "fixture-access-0", "fixture-refresh-0");
    upstream = new FixtureUpstream("fixture-refresh-0");
    await upstream.start();
    logs = [];
  });

  afterEach(async () => {
    for (const child of children.splice(0)) child.kill("SIGKILL");
    for (const broker of brokers.splice(0)) await broker.close();
    await upstream.stop();
    rmSync(home, { recursive: true, force: true });
  });

  /** No log record may carry a token or capability. */
  const expectLogsRedacted = (secrets: string[]) => {
    const text = JSON.stringify(logs);
    for (const secret of [
      "fixture-refresh-",
      "fixture-access-",
      "fixture-id-",
      "rusa-cap-",
      ...secrets,
    ]) {
      expect(text).not.toContain(secret);
    }
  };

  it("leases a copy whose refresh token is a capability, never the canonical token", async () => {
    const lease = await makeBroker().lease(60_000);
    const copy = JSON.parse(lease.authJson) as { tokens: Record<string, string> };
    expect(copy.tokens.access_token).toBe("fixture-access-0");
    expect(copy.tokens.account_id).toBe("fixture-account");
    expect(copy.tokens.refresh_token).toMatch(/^rusa-cap-[A-Za-z0-9_-]{43}$/);
    expect(lease.authJson).not.toContain("fixture-refresh-0");
    expect(lease.refreshUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/oauth\/token$/);
  });

  it("rotates canonical durably before answering, and answers only with access material", async () => {
    const lease = await makeBroker().lease(60_000);
    const res = await refresh(lease.refreshUrl, refreshBody(capOf(lease.authJson)));
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ access_token: "fixture-access-1", id_token: "fixture-id-1" });
    // The broker built the upstream request from canonical, not from the consumer.
    expect(upstream.calls).toEqual([
      {
        client_id: CODEX_OAUTH_CLIENT_ID,
        grant_type: "refresh_token",
        refresh_token: "fixture-refresh-0",
      },
    ]);
    const canonical = readCanonical(home);
    expect(canonical.tokens).toMatchObject({
      access_token: "fixture-access-1",
      id_token: "fixture-id-1",
      refresh_token: "fixture-refresh-1",
      account_id: "fixture-account",
    });
    expect(canonical.last_refresh).not.toBe("2026-01-01T00:00:00Z");
    expect(statSync(join(home, "auth.json")).mode & 0o777).toBe(0o600);
    expect(readdirSync(home).filter((f) => f.endsWith(".tmp") || f.endsWith(".intent"))).toEqual(
      []
    );
    expectLogsRedacted([capOf(lease.authJson)]);
  });

  it.each([
    ["a GET", { method: "GET" }, undefined, 404],
    ["another path", {}, "/v1/oauth/token", 404],
    ["non-JSON", {}, undefined, 400, "refresh_token=x"],
    [
      "a wrong grant",
      {},
      undefined,
      400,
      { grant_type: "authorization_code", refresh_token: "CAP" },
    ],
    [
      "a worker-supplied token field",
      {},
      undefined,
      400,
      { grant_type: "refresh_token", refresh_token: "CAP", access_token: "evil" },
    ],
    [
      "a worker-supplied path field",
      {},
      undefined,
      400,
      { grant_type: "refresh_token", refresh_token: "CAP", auth_path: "/tmp/x" },
    ],
    [
      "a forged capability",
      {},
      undefined,
      401,
      { grant_type: "refresh_token", refresh_token: "rusa-cap-forged" },
    ],
    [
      "the canonical refresh token itself",
      {},
      undefined,
      401,
      { grant_type: "refresh_token", refresh_token: "fixture-refresh-0" },
    ],
  ] as Array<
    [string, RequestInit, string | undefined, number, unknown?]
  >)("rejects %s without touching upstream or canonical", async (_label, init, path, status, body) => {
    const lease = await makeBroker().lease(60_000);
    const cap = capOf(lease.authJson);
    const url = path ? lease.refreshUrl.replace("/oauth/token", path) : lease.refreshUrl;
    const payload =
      typeof body === "string"
        ? body
        : JSON.stringify(body ?? refreshBody(cap)).replaceAll("CAP", cap);
    const res = await fetch(url, {
      method: "POST",
      body: init.method === "GET" ? undefined : payload,
      ...init,
    });
    expect(res.status).toBe(status);
    expect(await res.text()).not.toMatch(/fixture-|rusa-cap-/);
    expect(upstream.calls).toHaveLength(0);
    expect(readCanonical(home).tokens.refresh_token).toBe("fixture-refresh-0");
  });

  it("rejects oversized bodies", async () => {
    const lease = await makeBroker().lease(60_000);
    const res = await fetch(lease.refreshUrl, {
      method: "POST",
      body: "x".repeat(64 * 1024),
    }).catch(() => undefined);
    if (res) expect(res.status).toBe(413);
    expect(upstream.calls).toHaveLength(0);
  });

  it("refuses revoked and expired capabilities", async () => {
    let clock = 1_000_000;
    const broker = makeBroker({ now: () => clock });
    const revoked = await broker.lease(60_000);
    revoked.revoke();
    expect((await refresh(revoked.refreshUrl, refreshBody(capOf(revoked.authJson)))).status).toBe(
      401
    );
    const expiring = await broker.lease(60_000);
    clock += 60_001;
    expect((await refresh(expiring.refreshUrl, refreshBody(capOf(expiring.authJson)))).status).toBe(
      401
    );
    expect(broker.activeLeases).toBe(0);
    expect(upstream.calls).toHaveLength(0);
  });

  it("does not let a capability refreshed by one consumer be replayed into a second rotation", async () => {
    const lease = await makeBroker().lease(60_000);
    const cap = capOf(lease.authJson);
    expect((await refresh(lease.refreshUrl, refreshBody(cap))).status).toBe(200);
    // Replaying the same request (the CLI after a stale-access 401, or a child
    // that copied the capability) is served canonical's just-rotated tokens
    // rather than rotating the login again.
    for (let i = 0; i < 5; i++) {
      const replay = await refresh(lease.refreshUrl, refreshBody(cap));
      expect(replay.json.access_token).toBe("fixture-access-1");
    }
    expect(upstream.calls).toHaveLength(1);
  });

  it("serves a stale-access consumer canonical's tokens without an upstream call", async () => {
    const broker = makeBroker();
    const first = await broker.lease(60_000);
    const second = await broker.lease(60_000);
    expect(
      (await refresh(first.refreshUrl, refreshBody(capOf(first.authJson)))).json.access_token
    ).toBe("fixture-access-1");
    const res = await refresh(second.refreshUrl, refreshBody(capOf(second.authJson)));
    expect(res.json.access_token).toBe("fixture-access-1");
    expect(upstream.calls).toHaveLength(1);
  });

  it("rotates once for concurrent consumers of one broker", async () => {
    upstream.delayMs = 200;
    const broker = makeBroker();
    const leases = await Promise.all([1, 2, 3, 4].map(() => broker.lease(60_000)));
    const results = await Promise.all(
      leases.map((l) => refresh(l.refreshUrl, refreshBody(capOf(l.authJson))))
    );
    expect(results.map((r) => r.json.access_token)).toEqual(Array(4).fill("fixture-access-1"));
    expect(upstream.calls).toHaveLength(1);
  });

  it("rotates once for two brokers (prod and staging daemons) sharing the login", async () => {
    upstream.delayMs = 200;
    const prod = makeBroker();
    const staging = makeBroker();
    const [a, b] = await Promise.all([prod.lease(60_000), staging.lease(60_000)]);
    const results = await Promise.all([
      refresh(a.refreshUrl, refreshBody(capOf(a.authJson))),
      refresh(b.refreshUrl, refreshBody(capOf(b.authJson))),
    ]);
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    expect(results.map((r) => r.json.access_token)).toEqual([
      "fixture-access-1",
      "fixture-access-1",
    ]);
    expect(upstream.calls).toHaveLength(1);
    // A capability is only good at the broker that issued it.
    expect((await refresh(a.refreshUrl, refreshBody(capOf(b.authJson)))).status).toBe(401);
  });

  describe("across processes", () => {
    const sqlitePath = createRequire(import.meta.url).resolve("better-sqlite3");

    /**
     * Another process that takes the host refresh lock, then runs `script`
     * while holding it. Resolves once the lock is held.
     */
    const holdLockInChild = async (script: string): Promise<ChildProcess> => {
      const child = spawn(
        process.execPath,
        [
          "-e",
          `const Database = require(${JSON.stringify(sqlitePath)});
           const fs = require("node:fs");
           const db = new Database(${JSON.stringify(join(home, "rusa-auth-refresh.lock"))});
           db.exec("BEGIN IMMEDIATE");
           process.stdout.write("locked\\n");
           ${script}`,
        ],
        { stdio: ["ignore", "pipe", "inherit"] }
      );
      children.push(child);
      await new Promise<void>((resolve, reject) => {
        child.stdout?.on("data", (d: Buffer) => d.toString().includes("locked") && resolve());
        child.on("exit", () => reject(new Error("lock holder exited early")));
      });
      return child;
    };

    it("waits for another process's rotation and serves it without an upstream call", async () => {
      const lease = await makeBroker().lease(60_000);
      const rotated = JSON.stringify({
        tokens: {
          id_token: "other-id",
          access_token: "other-access",
          refresh_token: "other-refresh",
        },
      });
      await holdLockInChild(
        `setTimeout(() => {
           fs.writeFileSync(${JSON.stringify(join(home, "auth.json"))}, ${JSON.stringify(rotated)});
           db.exec("COMMIT");
           setTimeout(() => process.exit(0), 50);
         }, 400);`
      );
      const started = Date.now();
      const res = await refresh(lease.refreshUrl, refreshBody(capOf(lease.authJson)));
      expect(Date.now() - started).toBeGreaterThanOrEqual(300);
      expect(res.json).toEqual({ access_token: "other-access", id_token: "other-id" });
      expect(upstream.calls).toHaveLength(0);
    });

    it("takes over when the lock holder is killed mid-refresh", async () => {
      const lease = await makeBroker().lease(60_000);
      const child = await holdLockInChild("setInterval(() => {}, 1000);");
      const pending = refresh(lease.refreshUrl, refreshBody(capOf(lease.authJson)));
      await new Promise((r) => setTimeout(r, 200));
      expect(upstream.calls).toHaveLength(0);
      child.kill("SIGKILL");
      const res = await pending;
      expect(res.json.access_token).toBe("fixture-access-1");
      expect(upstream.calls).toHaveLength(1);
    });

    it("fails closed when the lock never frees", async () => {
      const lease = await makeBroker({ lockWaitMs: 300 }).lease(60_000);
      await holdLockInChild("setInterval(() => {}, 1000);");
      const res = await refresh(lease.refreshUrl, refreshBody(capOf(lease.authJson)));
      expect(res.status).toBe(502);
      expect(upstream.calls).toHaveLength(0);
    });
  });

  it("marks a refused login dead: consumers fail closed without re-hitting upstream until re-login", async () => {
    upstream.mode = "reject";
    const broker = makeBroker();
    const lease = await broker.lease(60_000);
    const cap = capOf(lease.authJson);
    const first = await refresh(lease.refreshUrl, refreshBody(cap));
    expect(first).toEqual({ status: 401, json: { error: "invalid_grant" } });
    expect((await refresh(lease.refreshUrl, refreshBody(cap))).status).toBe(401);
    expect(upstream.calls).toHaveLength(1);
    const alarm = logs.find((l) => l.event === "codex_auth_login_rejected");
    expect(alarm?.level).toBe("error");
    expect(String(alarm?.fields?.error)).toContain("refresh_token_reused");
    // An operator `codex login` replaces canonical: consumers recover.
    upstream.mode = "ok";
    writeCanonical(home, "fixture-access-relogin", "fixture-refresh-0");
    expect((await refresh(lease.refreshUrl, refreshBody(cap))).json.access_token).toBe(
      "fixture-access-relogin"
    );
    expectLogsRedacted([cap]);
  });

  it("keeps an intent marker across an interrupted refresh and reports it to the next owner", async () => {
    upstream.mode = "hang";
    const lease = await makeBroker({ upstreamTimeoutMs: 200 }).lease(60_000);
    const cap = capOf(lease.authJson);
    expect((await refresh(lease.refreshUrl, refreshBody(cap))).status).toBe(502);
    expect(existsSync(join(home, "rusa-auth-refresh.intent"))).toBe(true);
    expect(readCanonical(home).tokens.refresh_token).toBe("fixture-refresh-0");
    upstream.mode = "ok";
    const next = await makeBroker().lease(60_000);
    expect((await refresh(next.refreshUrl, refreshBody(capOf(next.authJson)))).status).toBe(200);
    expect(logs.some((l) => l.event === "codex_auth_previous_refresh_interrupted")).toBe(true);
    expect(existsSync(join(home, "rusa-auth-refresh.intent"))).toBe(false);
    expectLogsRedacted([cap]);
  });

  it("maps upstream server errors to a retryable failure without marking the login dead", async () => {
    upstream.mode = "error";
    const lease = await makeBroker().lease(60_000);
    const cap = capOf(lease.authJson);
    expect((await refresh(lease.refreshUrl, refreshBody(cap))).json).toEqual({
      error: "temporarily_unavailable",
    });
    upstream.mode = "ok";
    expect((await refresh(lease.refreshUrl, refreshBody(cap))).status).toBe(200);
  });

  it("persists a rotation even when the consumer disconnects mid-refresh", async () => {
    upstream.delayMs = 300;
    const lease = await makeBroker().lease(60_000);
    const abort = new AbortController();
    const pending = refresh(lease.refreshUrl, refreshBody(capOf(lease.authJson)), {
      signal: abort.signal,
    }).catch(() => "aborted");
    await new Promise((r) => setTimeout(r, 100));
    abort.abort();
    expect(await pending).toBe("aborted");
    await new Promise((r) => setTimeout(r, 500));
    expect(readCanonical(home).tokens.refresh_token).toBe("fixture-refresh-1");
    expect(upstream.calls).toHaveLength(1);
  });

  it("passes API-key logins through unchanged", async () => {
    writeFileSync(
      join(home, "auth.json"),
      JSON.stringify({ OPENAI_API_KEY: "fixture-api-key", tokens: null })
    );
    const lease = await makeBroker().lease(60_000);
    expect(JSON.parse(lease.authJson)).toEqual({ OPENAI_API_KEY: "fixture-api-key", tokens: null });
  });

  it("refuses to lease without a readable canonical login, naming no path", async () => {
    rmSync(join(home, "auth.json"));
    await expect(makeBroker().lease(60_000)).rejects.toThrow(/codex login/);
    await expect(makeBroker().lease(60_000)).rejects.not.toThrow(home);
  });

  it("seeds an unsandboxed home without the canonical login or broker files", async () => {
    writeFileSync(join(home, "config.toml"), 'model = "fixture"\n');
    const lease = await makeBroker().lease(60_000);
    await refresh(lease.refreshUrl, refreshBody(capOf(lease.authJson)));
    const seeded = seedBrokeredCodexHome(home, lease);
    try {
      expect(readdirSync(seeded).sort()).toEqual(["auth.json", "config.toml"]);
      expect(readFileSync(join(seeded, "auth.json"), "utf8")).toBe(lease.authJson);
      expect(statSync(join(seeded, "auth.json")).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(seeded, { recursive: true, force: true });
    }
  });
});

describe("parseCodexRefreshRequest", () => {
  it("accepts exactly the CLI's refresh body", () => {
    expect(parseCodexRefreshRequest(JSON.stringify(refreshBody("rusa-cap-x")))).toBe("rusa-cap-x");
    expect(
      parseCodexRefreshRequest(JSON.stringify({ grant_type: "refresh_token", refresh_token: "c" }))
    ).toBe("c");
  });

  it.each([
    "[]",
    "null",
    JSON.stringify({ grant_type: "refresh_token" }),
    JSON.stringify({ grant_type: "refresh_token", refresh_token: 7 }),
    JSON.stringify({ grant_type: "refresh_token", refresh_token: "c", client_id: 1 }),
    JSON.stringify({ grant_type: "refresh_token", refresh_token: "c", scope: "openid" }),
    JSON.stringify({ grant_type: "refresh_token", refresh_token: "x".repeat(257) }),
  ])("rejects %s", (raw) => {
    expect(parseCodexRefreshRequest(raw)).toBeUndefined();
  });
});

describe("codexAuthBrokerConfigured", () => {
  it("is on only for providers.codex.authBroker === true", () => {
    expect(codexAuthBrokerConfigured({ providers: { codex: { authBroker: true } } })).toBe(true);
    expect(codexAuthBrokerConfigured({ providers: { codex: {} } })).toBe(false);
    expect(codexAuthBrokerConfigured({ providers: {} })).toBe(false);
  });
});
