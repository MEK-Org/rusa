import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderQuotaSnapshot, QuotaService } from "../mcp/quota-mcp.js";
import { QuotaCollectionLoop } from "./coordinator-collection.js";
import { SharedQuotaStore } from "./shared-store.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function storeWithReading(): SharedQuotaStore {
  const root = mkdtempSync(join(tmpdir(), "rusa-quota-collection-"));
  roots.push(root);
  const store = new SharedQuotaStore(join(root, "quota.db"));
  store.configureController({ maxIntervalSeconds: 3600 });
  const scrapedAt = "2030-01-01T00:00:00.000Z";
  const state: ProviderQuotaSnapshot = {
    provider: "claude",
    status: "available",
    scrapedAt,
    limits: [
      {
        label: "Weekly",
        kind: "weekly",
        percentLeft: 50,
        resetAtIso: "2030-01-08T00:00:00.000Z",
        scope: { provider: "claude" },
      },
    ],
  };
  const id = store.recordRaw({ provider: "claude", scrapedAt, rawOutput: "fixture" });
  store.recordParsed(id, state, state);
  return store;
}

describe("QuotaCollectionLoop", () => {
  it("dedupes concurrent ticks to one service-owned probe and one controller advance", async () => {
    const store = storeWithReading();
    try {
      let resolveProbe: ((state: ProviderQuotaSnapshot) => void) | undefined;
      const getQuota = vi.fn(
        () =>
          new Promise<ProviderQuotaSnapshot>((resolve) => {
            resolveProbe = resolve;
          })
      );
      const advance = vi.spyOn(store, "advancePendingController");
      const loop = new QuotaCollectionLoop({
        store,
        quotaService: { getQuota, hydrate: vi.fn() } as unknown as QuotaService,
        providers: ["claude"],
      });

      const first = loop.tick();
      const second = loop.tick();
      expect(getQuota).toHaveBeenCalledTimes(1);
      resolveProbe?.({ provider: "claude", status: "available" });
      await Promise.all([first, second]);
      expect(getQuota).toHaveBeenCalledTimes(1);
      expect(advance).toHaveBeenCalledTimes(1);
    } finally {
      store.close();
    }
  });

  it("leaves the published interval unchanged and counts a failed probe", async () => {
    const store = storeWithReading();
    try {
      const before = store.getProviderThrottle("claude");
      const loop = new QuotaCollectionLoop({
        store,
        quotaService: {
          getQuota: vi.fn().mockResolvedValue({ provider: "claude", status: "unknown" }),
          hydrate: vi.fn(),
        } as unknown as QuotaService,
        providers: ["claude"],
      });

      await loop.tick();
      expect(store.getProviderThrottle("claude")).toEqual(before);
      expect(loop.getStats("claude")).toMatchObject({
        attempts: 1,
        failures: 1,
        lastOutcome: "failure",
      });
    } finally {
      store.close();
    }
  });

  it("hydrates the sole probe prevState from the latest validated snapshot", () => {
    const store = storeWithReading();
    try {
      const hydrate = vi.fn();
      const loop = new QuotaCollectionLoop({
        store,
        quotaService: { getQuota: vi.fn(), hydrate } as unknown as QuotaService,
        providers: ["claude"],
      });
      loop.hydrate();
      expect(hydrate).toHaveBeenCalledWith(
        "claude",
        expect.objectContaining({
          provider: "claude",
          limits: [expect.objectContaining({ scope: { provider: "claude" } })],
        })
      );
    } finally {
      store.close();
    }
  });
});
