import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProviderPacer } from "../actor/provider-pacer.js";
import type { ProviderQuotaSnapshot } from "../mcp/quota-mcp.js";
import { applyThrottleStatusToPacer } from "../quota/coordinator-client.js";
import { publishedThrottle } from "../quota/coordinator-protocol.js";
import { SharedQuotaStore } from "../quota/shared-store.js";
import { runQuotaPacingReset } from "./quota-pacing-reset.js";

const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function writeHome(quotaBlock: string): string {
  const home = mkdtempSync(join(tmpdir(), "rusa-quota-pacing-reset-"));
  homes.push(home);
  mkdirSync(join(home, "data"), { recursive: true });
  writeFileSync(
    join(home, "config.yaml"),
    `
github:
  account: mock-bot
rootActor:
  provider: claude
  model: claude-3-5-sonnet
providers:
  claude:
    cliCommand: claude
quota:
${quotaBlock}
`
  );
  return home;
}

/** Feed a store enough standing error that both providers hold learned state. */
function warmProviders(databasePath: string, providers: readonly string[]): void {
  const store = new SharedQuotaStore(databasePath);
  try {
    store.configureController({ maxIntervalSeconds: 36000 });
    const reset = "2030-01-08T00:00:00.000Z";
    const startedMs = Date.parse("2030-01-01T00:00:00.000Z");
    for (const provider of providers) {
      for (let slot = 0; slot < 13; slot += 1) {
        const scrapedAt = new Date(startedMs + slot * 5 * 60 * 1000).toISOString();
        const timeRemainingPct =
          ((Date.parse(reset) - Date.parse(scrapedAt)) / (7 * 24 * 60 * 60 * 1000)) * 100;
        const state: ProviderQuotaSnapshot = {
          provider,
          status: "available",
          scrapedAt,
          limits: [
            {
              label: "Weekly",
              kind: "weekly",
              scope: "provider",
              percentLeft: timeRemainingPct - 10,
              resetAtIso: reset,
            },
          ],
        };
        store.recordParsed(
          store.recordRaw({ provider, scrapedAt, rawOutput: "raw" }),
          state,
          state
        );
      }
      expect(store.getProviderThrottle(provider)?.intervalSeconds).toBeGreaterThan(0);
    }
  } finally {
    store.close();
  }
}

/** Record one provider-scoped observation, the way a scrape would. */
function record(
  databasePath: string,
  provider: string,
  scrapedAt: string,
  percentLeft: number,
  resetAtIso: string
): void {
  const store = new SharedQuotaStore(databasePath);
  try {
    store.configureController({ maxIntervalSeconds: 36000 });
    const state: ProviderQuotaSnapshot = {
      provider,
      status: percentLeft <= 0 ? "exhausted" : "available",
      scrapedAt,
      limits: [{ label: "Weekly", kind: "weekly", scope: "provider", percentLeft, resetAtIso }],
    };
    store.recordParsed(store.recordRaw({ provider, scrapedAt, rawOutput: "raw" }), state, state);
  } finally {
    store.close();
  }
}

/** The production read path: stored status → published envelope → pacer. */
function applyPublished(databasePath: string, provider: string, pacer: ProviderPacer): void {
  const store = new SharedQuotaStore(databasePath);
  try {
    const stored = store.getProviderThrottle(provider);
    if (!stored) throw new Error(`no stored status for ${provider}`);
    applyThrottleStatusToPacer(pacer, publishedThrottle(stored, { nowMs: NOW_MS }));
  } finally {
    store.close();
  }
}

const RESET_AT = "2030-01-08T00:00:00.000Z";
// Inside the observation window, so nothing reads as stale in these tests.
const NOW_MS = Date.parse("2030-01-01T01:10:00.000Z");

describe("runQuotaPacingReset exhausted-lane semantics", () => {
  it("leaves the lane gated on the old reset until a fresh scrape, because it resets pacing and not quota", async () => {
    const home = writeHome(`  coordinator:
    databasePath: data/quota-service.db`);
    const databasePath = join(home, "data", "quota-service.db");
    warmProviders(databasePath, ["claude"]);
    // The provider then reports exhausted, with its window reset still ahead.
    record(databasePath, "claude", "2030-01-01T01:05:00.000Z", 0, RESET_AT);

    const pacer = new ProviderPacer(0, () => NOW_MS);
    // A lane that has actually run before, which is how a lane reaches exhaustion.
    await pacer.submit(async () => "ok", {
      enqueueNormal: (fn) => ({ result: fn(), started: true }) as never,
    }).result;

    runQuotaPacingReset({ home, provider: "claude" });
    applyPublished(databasePath, "claude", pacer);

    // Period is gone, but the exhaustion gate still holds the lane: the
    // operator reset pacing policy, and only a scrape can say quota returned.
    expect(pacer.interval).toBe(0);
    expect(pacer.quote(NOW_MS)).toBe(Date.parse(RESET_AT));

    // A fresh scrape showing headroom is what releases it.
    record(databasePath, "claude", "2030-01-01T01:10:00.000Z", 80, RESET_AT);
    applyPublished(databasePath, "claude", pacer);
    expect(pacer.quote(NOW_MS)).toBeLessThan(Date.parse(RESET_AT));
  });

  it("does not publish an unpaced lane when the reset leaves only stale evidence", () => {
    const home = writeHome(`  coordinator:
    databasePath: data/quota-service.db`);
    const databasePath = join(home, "data", "quota-service.db");
    warmProviders(databasePath, ["claude"]);
    runQuotaPacingReset({ home, provider: "claude" });

    const store = new SharedQuotaStore(databasePath);
    try {
      const stored = store.getProviderThrottle("claude") as NonNullable<
        ReturnType<typeof store.getProviderThrottle>
      >;
      // The reset-specific shape: no reasoned row survives, so the status has
      // no governing bucket and no buckets at all. That is the one status
      // shape the envelope's freshness has to age from `updatedAt` rather
      // than from bucket observations, and the only way production reaches it
      // with evidence on file.
      expect(stored.intervalSeconds).toBe(0);
      expect(stored.governingBucketKey).toBeNull();
      expect(stored.buckets).toEqual([]);

      // While the evidence is fresh the reset is published as is: zero period.
      const fresh = publishedThrottle(stored, { nowMs: NOW_MS, maxIntervalSeconds: 36000 });
      expect(fresh.freshness.hardStale).toBe(false);
      expect(fresh.intervalSeconds).toBe(0);

      // Long after the last observation the envelope applies its hard-stale
      // floor, so a reset lane is never handed out unpaced once its evidence
      // ages — the regression this pins is a freshness that reads an empty
      // bucket set as "never stale".
      const stale = publishedThrottle(stored, {
        nowMs: Date.parse("2030-02-01T00:00:00.000Z"),
        maxIntervalSeconds: 36000,
      });
      expect(stale.freshness.hardStale).toBe(true);
      expect(stale.intervalSeconds).toBe(36000);
    } finally {
      store.close();
    }
  });
});

describe("runQuotaPacingReset", () => {
  it("resets only the named provider on the service-owned database and reports what it cleared", () => {
    const home = writeHome(`  coordinator:
    databasePath: data/quota-service.db`);
    const databasePath = join(home, "data", "quota-service.db");
    warmProviders(databasePath, ["codex", "claude"]);

    const result = runQuotaPacingReset({ home, provider: "codex" });
    expect(result).toEqual({
      databasePath,
      provider: "codex",
      clearedDecisions: 13,
      observations: 13,
    });

    const store = new SharedQuotaStore(databasePath);
    try {
      expect(store.getProviderThrottle("codex")?.intervalSeconds).toBe(0);
      expect(store.getProviderThrottle("claude")?.intervalSeconds).toBeGreaterThan(0);
    } finally {
      store.close();
    }
  });

  it("accepts a provider alias and falls back to the pre-service database path", () => {
    const home = writeHome("  databasePath: data/quota.db");
    const databasePath = join(home, "data", "quota.db");
    warmProviders(databasePath, ["agy"]);

    const result = runQuotaPacingReset({ home, provider: "antigravity" });
    expect(result.provider).toBe("agy");
    expect(result.databasePath).toBe(databasePath);
    expect(result.clearedDecisions).toBe(13);
  });

  it("refuses a provider the coordinator does not pace, before opening anything", () => {
    const home = writeHome(`  coordinator:
    databasePath: data/quota-service.db`);
    expect(() => runQuotaPacingReset({ home, provider: "openai" })).toThrow(
      /not a quota-paced provider/
    );
    expect(() => runQuotaPacingReset({ home, provider: "  " })).toThrow(/--provider/);
  });

  it("refuses when no quota database is configured", () => {
    const home = writeHome("  throttle:\n    enabled: false");
    expect(() => runQuotaPacingReset({ home, provider: "codex" })).toThrow(
      /No quota database configured/
    );
  });
});
