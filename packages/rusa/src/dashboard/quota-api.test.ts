import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import type { RusaConfig } from "../config/types.js";
import { type ProviderQuotaSnapshot, QuotaService } from "../mcp/quota-mcp.js";
import type { CodingProvider } from "../providers/types.js";
import {
  buildQuotaHistory,
  buildQuotaSnapshot,
  handleQuotaApiRequest,
  type QuotaApiDeps,
  type QuotaHistorySource,
  type QuotaSnapshotDto,
} from "./quota-api.js";

function historyPoint(
  overrides: Partial<QuotaHistorySource> & Pick<QuotaHistorySource, "observedAt" | "percentLeft">
): QuotaHistorySource {
  return {
    scope: "provider",
    kind: "weekly",
    label: "Weekly",
    resetAtIso: null,
    controllerError: null,
    intervalSeconds: null,
    ...overrides,
  };
}

describe("buildQuotaHistory", () => {
  it("uses stored decisions and leaves exhausted evidence without a synthetic interval", () => {
    expect(
      buildQuotaHistory(
        "claude",
        [
          {
            scope: "provider",
            kind: "weekly",
            label: "Weekly",
            observedAt: "2030-01-01T00:00:00.000Z",
            percentLeft: 50,
            resetAtIso: "2030-01-08T00:00:00.000Z",
            controllerError: 50,
            intervalSeconds: 900,
          },
          {
            scope: "provider",
            kind: "weekly",
            label: "Weekly",
            observedAt: "2030-01-07T23:00:00.000Z",
            percentLeft: 0,
            resetAtIso: "2030-01-08T00:00:00.000Z",
            controllerError: null,
            intervalSeconds: null,
          },
        ],
        "2030-01-01T00:00:00.000Z",
        "2030-01-08T00:00:00.000Z"
      )[0]?.points
    ).toEqual([
      {
        observedAt: "2030-01-01T00:00:00.000Z",
        remainingPercent: 50,
        error: -50,
        resetAtIso: "2030-01-08T00:00:00.000Z",
        intervalSeconds: 900,
      },
      {
        observedAt: "2030-01-07T23:00:00.000Z",
        remainingPercent: 0,
        error: null,
        resetAtIso: "2030-01-08T00:00:00.000Z",
        intervalSeconds: null,
      },
    ]);
  });
});

function fakeReq(method: string): IncomingMessage {
  return { method, headers: {} } as unknown as IncomingMessage;
}

function fakeRes(): { res: ServerResponse; status: () => number; json: () => unknown } {
  let status = 0;
  let body = "";
  const res = {
    writeHead(code: number) {
      status = code;
      return res;
    },
    end(payload?: string) {
      if (payload) body = payload;
    },
  } as unknown as ServerResponse;
  return { res, status: () => status, json: () => (body ? JSON.parse(body) : undefined) };
}

const u = (path: string): URL => new URL(`http://dash${path}`);

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const FIVE_HOUR_MS = 5 * 60 * 60 * 1000;

const claudeState: ProviderQuotaSnapshot = {
  provider: "claude",
  status: "available",
  limits: [
    { label: "Session", kind: "session", percentLeft: 100 },
    { label: "Weekly", kind: "weekly", percentLeft: 97 },
  ],
};

const codexState: ProviderQuotaSnapshot = {
  provider: "codex",
  status: "available",
  limits: [
    { label: "5h", kind: "five_hour", percentLeft: 99 },
    { label: "Weekly", kind: "weekly", percentLeft: 93 },
  ],
};

const agyState: ProviderQuotaSnapshot = {
  provider: "agy",
  status: "available",
  limits: [
    {
      label: "Weekly",
      kind: "weekly",
      percentLeft: 80,
      scope: "provider",
    },
    {
      label: "5h",
      kind: "five_hour",
      percentLeft: 95,
      scope: "provider",
    },
  ],
};

const kimiState: ProviderQuotaSnapshot = {
  provider: "kimi",
  status: "available",
  limits: [
    { label: "5h", kind: "five_hour", percentLeft: 72 },
    { label: "Weekly", kind: "weekly", percentLeft: 50 },
  ],
};

/** A fake getQuota that records every provider it was called with. */
function fakeDeps(states: Partial<Record<string, ProviderQuotaSnapshot>>): {
  deps: QuotaApiDeps;
  calls: () => string[];
} {
  const calls: string[] = [];
  return {
    deps: {
      getQuota: async (provider) => {
        calls.push(provider);
        const state =
          states[provider] ??
          { claude: claudeState, codex: codexState, agy: agyState, kimi: kimiState }[provider];
        if (!state) throw new Error(`no fake state for ${provider}`);
        return state;
      },
      now: () => 1000,
    },
    calls: () => calls,
  };
}

describe("dashboard quota snapshot (ISSUE_NUM backend)", () => {
  it("builds one DTO per supported provider", async () => {
    const { deps, calls } = fakeDeps({
      claude: claudeState,
      codex: codexState,
      agy: agyState,
      kimi: kimiState,
    });
    const snapshot = await buildQuotaSnapshot(deps);

    expect(calls()).toEqual(["claude", "codex", "agy", "kimi"]);
    expect(snapshot.generatedAt).toBe(new Date(1000).toISOString());
    expect(snapshot.historySince).toBe(new Date(1000 - 3 * 24 * 60 * 60 * 1000).toISOString());
    expect(snapshot.history).toEqual([]);
    expect(snapshot.providers.map((p) => p.provider)).toEqual(["claude", "codex", "agy", "kimi"]);
    expect(snapshot.providers.every((p) => p.throttle === null)).toBe(true);
  });

  it("returns prior-3-day durable readings as quota remaining, not quota used", async () => {
    const now = Date.parse("2026-07-26T20:00:00.000Z");
    const calls: Array<{ provider: string; sinceIso: string }> = [];
    const { deps } = fakeDeps({ claude: claudeState });
    const snapshot = await buildQuotaSnapshot({
      ...deps,
      providers: ["claude"],
      now: () => now,
      listHistory: (provider, sinceIso) => {
        calls.push({ provider, sinceIso });
        return [
          historyPoint({
            observedAt: "2026-07-25T21:00:00.000Z",
            percentLeft: 80,
          }),
          historyPoint({
            observedAt: "2026-07-26T19:00:00.000Z",
            percentLeft: 62,
          }),
        ];
      },
    });

    expect(calls).toEqual([
      {
        provider: "claude",
        sinceIso: "2026-07-23T20:00:00.000Z",
      },
    ]);
    expect(snapshot.history).toEqual([
      {
        provider: "claude",
        windowId: "weekly",
        label: "Weekly",
        points: [
          {
            observedAt: "2026-07-25T21:00:00.000Z",
            remainingPercent: 80,
            error: null,
            intervalSeconds: null,
            resetAtIso: null,
          },
          {
            observedAt: "2026-07-26T19:00:00.000Z",
            remainingPercent: 62,
            error: null,
            intervalSeconds: null,
            resetAtIso: null,
          },
        ],
      },
    ]);
  });

  it("uses the same first weekly limit as the header ring and excludes short windows", async () => {
    const now = Date.parse("2026-07-26T20:00:00.000Z");
    const current: ProviderQuotaSnapshot = {
      provider: "codex",
      status: "available",
      limits: [
        {
          label: "Weekly limit",
          kind: "weekly",
          percentLeft: 70,
        },
        {
          label: "Weekly",
          kind: "weekly",
          percentLeft: 40,
        },
        {
          label: "5h",
          kind: "five_hour",
          percentLeft: 90,
        },
      ],
    };
    const snapshot = await buildQuotaSnapshot({
      getQuota: async () => current,
      providers: ["codex"],
      now: () => now,
      listHistory: () => [
        historyPoint({
          label: "Weekly limit",
          observedAt: "2026-07-26T19:00:00.000Z",
          percentLeft: 68,
        }),
        historyPoint({
          kind: "five_hour",
          label: "5h",
          observedAt: "2026-07-26T19:00:00.000Z",
          percentLeft: 25,
        }),
      ],
    });

    // The ring's `_findWindow` takes the first id=weekly DTO.
    expect(snapshot.providers[0].windows.find((window) => window.id === "weekly")).toMatchObject({
      label: "Weekly limit",
      usedPercent: 30,
    });
    expect(snapshot.history).toEqual([
      {
        provider: "codex",
        windowId: "weekly",
        label: "Weekly limit",
        points: [
          {
            observedAt: "2026-07-26T19:00:00.000Z",
            remainingPercent: 68,
            error: null,
            intervalSeconds: null,
            resetAtIso: null,
          },
        ],
      },
    ]);
  });

  it("keeps divergent weekly-window ordering and availability from splicing pools", async () => {
    const now = Date.parse("2026-07-26T20:00:00.000Z");
    const current: ProviderQuotaSnapshot = {
      provider: "codex",
      status: "available",
      limits: [
        {
          label: "Weekly (all models)",
          kind: "weekly",
          scope: "provider",
          percentLeft: 70,
        },
        {
          label: "Weekly (model-specific)",
          kind: "weekly",
          scope: "model",
          percentLeft: 40,
        },
      ],
    };
    const snapshot = await buildQuotaSnapshot({
      getQuota: async () => current,
      providers: ["codex"],
      now: () => now,
      listHistory: () => [
        historyPoint({
          scope: "model",
          label: "Weekly (model-specific)",
          observedAt: "2026-07-26T18:00:00.000Z",
          percentLeft: 20,
        }),
        historyPoint({
          label: "Weekly (all models)",
          observedAt: "2026-07-26T18:00:00.000Z",
          percentLeft: 68,
        }),
        historyPoint({
          scope: "model",
          label: "Weekly (model-specific)",
          observedAt: "2026-07-26T19:00:00.000Z",
          percentLeft: 10,
        }),
      ],
    });

    expect(snapshot.history).toEqual([
      {
        provider: "codex",
        windowId: "weekly",
        label: "Weekly (all models)",
        points: [
          {
            observedAt: "2026-07-26T18:00:00.000Z",
            remainingPercent: 68,
            error: null,
            intervalSeconds: null,
            resetAtIso: null,
          },
        ],
      },
    ]);
  });

  it("retains valid durable history when the current probe has no limits", async () => {
    const now = Date.parse("2026-07-26T20:00:00.000Z");
    const unavailable: ProviderQuotaSnapshot = {
      provider: "codex",
      status: "unknown",
      message: "current probe could not be parsed",
    };
    const snapshot = await buildQuotaSnapshot({
      getQuota: async () => unavailable,
      providers: ["codex"],
      now: () => now,
      listHistory: () => [
        historyPoint({
          label: "Weekly (all models)",
          observedAt: "2026-07-26T18:00:00.000Z",
          percentLeft: 72,
        }),
        historyPoint({
          label: "Weekly (all models)",
          observedAt: "2026-07-26T19:00:00.000Z",
          percentLeft: 65,
        }),
      ],
    });

    expect(snapshot.providers[0].carriedForward).toBe(true);
    expect(snapshot.providers[0].windows).toEqual([
      {
        id: "weekly",
        label: "Weekly (all models)",
        usedPercent: 35,
        status: "available",
        resetAtIso: null,
        headline: true,
        windowMs: 604800000,
        scrapedAt: "2026-07-26T19:00:00.000Z",
        carriedForward: true,
      },
    ]);
    expect(snapshot.history).toEqual([
      {
        provider: "codex",
        windowId: "weekly",
        label: "Weekly (all models)",
        points: [
          {
            observedAt: "2026-07-26T18:00:00.000Z",
            remainingPercent: 72,
            error: null,
            intervalSeconds: null,
            resetAtIso: null,
          },
          {
            observedAt: "2026-07-26T19:00:00.000Z",
            remainingPercent: 65,
            error: null,
            intervalSeconds: null,
            resetAtIso: null,
          },
        ],
      },
    ]);
  });

  it("reads and exposes only the configured providers", async () => {
    const { deps, calls } = fakeDeps({ claude: claudeState, agy: agyState });
    const snapshot = await buildQuotaSnapshot({
      ...deps,
      providers: ["claude", "agy"],
    });

    expect(calls()).toEqual(["claude", "agy"]);
    expect(snapshot.providers.map((p) => p.provider)).toEqual(["claude", "agy"]);
  });

  it("includes the runtime's latest quota-throttle decision when supplied", async () => {
    const { deps } = fakeDeps({ claude: claudeState });
    const snapshot = await buildQuotaSnapshot({
      ...deps,
      getThrottle: (provider) =>
        provider === "claude"
          ? {
              intervalSeconds: 73,
              held: false,
              expired: false,
              capped: false,
              learning: false,
              buckets: [],
              uncappedIntervalSeconds: 73,
              updatedAt: "2026-07-22T12:00:00.000Z",
            }
          : null,
    });

    expect(snapshot.providers.find((p) => p.provider === "claude")?.throttle).toMatchObject({
      intervalSeconds: 73,
    });
  });

  it("kimi: carries the 5h and Weekly windows from the CLI /usage scrape", async () => {
    const { deps } = fakeDeps({ kimi: kimiState });
    const snapshot = await buildQuotaSnapshot(deps);
    const kimi = snapshot.providers.find((p) => p.provider === "kimi");

    expect(kimi?.windows).toEqual([
      {
        id: "five_hour",
        label: "5h",
        usedPercent: 28,
        status: "available",
        resetAtIso: null,
        headline: false,
        windowMs: FIVE_HOUR_MS,
        scrapedAt: null,
      },
      {
        id: "weekly",
        label: "Weekly",
        usedPercent: 50,
        status: "available",
        resetAtIso: null,
        headline: true,
        windowMs: WEEK_MS,
        scrapedAt: null,
      },
    ]);
    expect(kimi?.usedPercent).toBe(50);
  });

  it("claude: carries both the session and Weekly windows through, marking Weekly as headline", async () => {
    const { deps } = fakeDeps({ claude: claudeState, codex: codexState, agy: agyState });
    const snapshot = await buildQuotaSnapshot(deps);
    const claude = snapshot.providers.find((p) => p.provider === "claude");

    expect(claude?.windows).toEqual([
      {
        id: "session",
        label: "Session",
        usedPercent: 0,
        status: "available",
        resetAtIso: null,
        headline: false,
        windowMs: FIVE_HOUR_MS,
        scrapedAt: null,
      },
      {
        id: "weekly",
        label: "Weekly",
        usedPercent: 3,
        status: "available",
        resetAtIso: null,
        headline: true,
        windowMs: WEEK_MS,
        scrapedAt: null,
      },
    ]);
    expect(claude?.usedPercent).toBe(3);
  });

  it("claude: session window id is keyed off kind, not the free-text label ", async () => {
    // Reproduces ISSUE_NUM: the LLM's label wording for claude's session window
    // varies run to run ("Session" vs "Current session" vs ...), which used
    // to be lowercased/underscored straight into the DTO id
    // (`current_session`), breaking the dashboard's fixed-id lookup
    // (kDefaultQuotaProviders['claude'].sessionWindow === 'session'). The
    // fix keys the id off the LLM-classified `kind` instead, so label
    // wording can vary freely without breaking the ring lookup.
    const { deps } = fakeDeps({
      claude: {
        ...claudeState,
        limits: [
          { label: "Current session", kind: "session", percentLeft: 100 },
          { label: "Weekly", kind: "weekly", percentLeft: 97 },
        ],
      },
      codex: codexState,
      agy: agyState,
    });
    const snapshot = await buildQuotaSnapshot(deps);
    const claude = snapshot.providers.find((p) => p.provider === "claude");

    const session = claude?.windows.find((w) => w.label === "Current session");
    expect(session?.id).toBe("session");
    expect(claude?.windows.some((w) => w.id === "current_session")).toBe(false);
  });

  it("claude: yields no windows when limits are absent", async () => {
    const { deps } = fakeDeps({
      claude: {
        provider: "claude",
        status: "unknown",
      },
      codex: codexState,
      agy: agyState,
    });
    const snapshot = await buildQuotaSnapshot(deps);
    const claude = snapshot.providers.find((p) => p.provider === "claude");

    // The snapshot no longer carries top-level headline fields, so without
    // structured limits there is nothing to render — no fabricated window.
    expect(claude?.windows).toEqual([]);
    expect(claude?.usedPercent).toBeNull();
  });

  it("codex: carries both the five_hour and Weekly windows through, marking Weekly as headline", async () => {
    const { deps } = fakeDeps({ claude: claudeState, codex: codexState, agy: agyState });
    const snapshot = await buildQuotaSnapshot(deps);
    const codex = snapshot.providers.find((p) => p.provider === "codex");

    expect(codex?.windows).toEqual([
      {
        id: "five_hour",
        label: "5h",
        usedPercent: 1,
        status: "available",
        resetAtIso: null,
        headline: false,
        windowMs: FIVE_HOUR_MS,
        scrapedAt: null,
      },
      {
        id: "weekly",
        label: "Weekly",
        usedPercent: 7,
        status: "available",
        resetAtIso: null,
        headline: true,
        windowMs: WEEK_MS,
        scrapedAt: null,
      },
    ]);
    expect(codex?.usedPercent).toBe(7);
  });

  it("codex: yields no windows when limits are absent", async () => {
    const { deps } = fakeDeps({
      claude: claudeState,
      codex: { provider: "codex", status: "unknown" },
      agy: agyState,
    });
    const snapshot = await buildQuotaSnapshot(deps);
    const codex = snapshot.providers.find((p) => p.provider === "codex");

    expect(codex?.windows).toEqual([]);
    expect(codex?.usedPercent).toBeNull();
  });

  it("agy: reports provider-scoped flat windows", async () => {
    const { deps } = fakeDeps({ claude: claudeState, codex: codexState, agy: agyState });
    const snapshot = await buildQuotaSnapshot(deps);
    const agy = snapshot.providers.find((p) => p.provider === "agy");

    expect(agy?.windows).toEqual([
      {
        id: "weekly",
        label: "Weekly",
        usedPercent: 20,
        status: "available",
        resetAtIso: null,
        headline: true,
        windowMs: WEEK_MS,
        scrapedAt: null,
      },
      {
        id: "five_hour",
        label: "5h",
        usedPercent: 5,
        status: "available",
        resetAtIso: null,
        headline: false,
        windowMs: FIVE_HOUR_MS,
        scrapedAt: null,
      },
    ]);
    expect(agy).not.toHaveProperty("groups");
    // Headline usedPercent mirrors the first group's headline (weekly) window.
    expect(agy?.usedPercent).toBe(20);
  });

  it("threads resetAtIso through end-to-end from ProviderQuotaSnapshot to the DTO ", async () => {
    const { deps } = fakeDeps({
      claude: {
        ...claudeState,
        limits: [
          { label: "Session", kind: "session", percentLeft: 100 },
          {
            label: "Weekly",
            kind: "weekly",
            percentLeft: 97,
            resetAtIso: "2026-07-13T02:59:00.000Z",
          },
        ],
      },
      codex: codexState,
      agy: {
        ...agyState,
        limits: [
          {
            label: "Weekly",
            kind: "weekly",
            percentLeft: 0,
            resetAtIso: "2026-07-15T10:26:02.673Z",
            scope: "provider",
          },
        ],
      },
    });
    const snapshot = await buildQuotaSnapshot(deps);

    const claude = snapshot.providers.find((p) => p.provider === "claude");
    expect(claude?.windows.find((w) => w.id === "weekly")?.resetAtIso).toBe(
      "2026-07-13T02:59:00.000Z"
    );
    expect(claude?.windows.find((w) => w.id === "session")?.resetAtIso).toBeNull();

    const agy = snapshot.providers.find((p) => p.provider === "agy");
    expect(agy?.windows[0]?.resetAtIso).toBe("2026-07-15T10:26:02.673Z");
  });

  it("threads scrapedAt through end-to-end from ProviderQuotaSnapshot to every window and the provider DTO ", async () => {
    const scrapedAt = "2026-07-14T09:15:00.000Z";
    const { deps } = fakeDeps({
      claude: { ...claudeState, scrapedAt },
      codex: { ...codexState, scrapedAt },
      agy: { ...agyState, scrapedAt },
      kimi: { ...kimiState, scrapedAt },
    });
    const snapshot = await buildQuotaSnapshot(deps);

    for (const providerName of ["claude", "codex", "kimi"] as const) {
      const provider = snapshot.providers.find((p) => p.provider === providerName);
      expect(provider?.scrapedAt).toBe(scrapedAt);
      for (const w of provider?.windows ?? []) {
        expect(w.scrapedAt).toBe(scrapedAt);
      }
    }

    const agy = snapshot.providers.find((p) => p.provider === "agy");
    expect(agy?.scrapedAt).toBe(scrapedAt);
    for (const w of agy?.windows ?? []) {
      expect(w.scrapedAt).toBe(scrapedAt);
    }
  });

  it("threads carriedForward through from limits and snapshot to QuotaWindowDto and ProviderQuotaDto", async () => {
    const { deps } = fakeDeps({
      claude: {
        ...claudeState,
        carriedForward: true,
        limits: [
          { label: "Session", kind: "session", percentLeft: 100, carriedForward: true },
          { label: "Weekly", kind: "weekly", percentLeft: 97 },
        ],
      },
      codex: {
        ...codexState,
        limits: [
          { label: "5h", kind: "five_hour", percentLeft: 99, carriedForward: true },
          { label: "Weekly", kind: "weekly", percentLeft: 93, carriedForward: false },
        ],
      },
      agy: agyState,
      kimi: kimiState,
    });
    const snapshot = await buildQuotaSnapshot(deps);

    const claude = snapshot.providers.find((p) => p.provider === "claude");
    expect(claude?.carriedForward).toBe(true);
    expect(claude?.windows.find((w) => w.id === "session")?.carriedForward).toBe(true);
    // Inherited from snapshot
    expect(claude?.windows.find((w) => w.id === "weekly")?.carriedForward).toBe(true);

    const codex = snapshot.providers.find((p) => p.provider === "codex");
    expect(codex?.carriedForward).toBe(true);
    expect(codex?.windows.find((w) => w.id === "five_hour")?.carriedForward).toBe(true);
    expect(codex?.windows.find((w) => w.id === "weekly")?.carriedForward).toBeUndefined();

    const agy = snapshot.providers.find((p) => p.provider === "agy");
    expect(agy?.carriedForward).toBeUndefined();
    expect(agy?.windows.every((w) => w.carriedForward === undefined)).toBe(true);
  });

  it("scrapedAt is null when the underlying state never reached a probe", async () => {
    const { deps } = fakeDeps({
      claude: { provider: "claude", status: "unknown" },
      codex: codexState,
      agy: agyState,
      kimi: kimiState,
    });
    const snapshot = await buildQuotaSnapshot(deps);
    const claude = snapshot.providers.find((p) => p.provider === "claude");

    expect(claude?.scrapedAt).toBeNull();
    expect(claude?.windows.every((w) => w.scrapedAt === null)).toBe(true);
  });

  it("history ignores non-provider buckets, short windows, and observations outside the range", () => {
    const series = buildQuotaHistory(
      "codex",
      [
        historyPoint({
          observedAt: "2026-07-25T19:59:59.000Z",
          percentLeft: 60,
        }),
        historyPoint({
          scope: "model",
          observedAt: "2026-07-25T21:00:00.000Z",
          percentLeft: 55,
        }),
        historyPoint({
          kind: "five_hour",
          observedAt: "2026-07-25T22:00:00.000Z",
          percentLeft: 50,
        }),
        historyPoint({
          observedAt: "2026-07-26T21:00:00.000Z",
          percentLeft: 45,
        }),
      ],
      "2026-07-25T20:00:00.000Z",
      "2026-07-26T20:00:00.000Z"
    );

    expect(series).toEqual([]);
  });

  it("uses the persisted controller error and interval instead of recomputing either", () => {
    const resetIso = "2026-07-30T00:00:00.000Z";
    const observedIso = "2026-07-26T12:00:00.000Z";

    const series = buildQuotaHistory(
      "claude",
      [
        historyPoint({
          observedAt: observedIso,
          percentLeft: 30,
          resetAtIso: resetIso,
          controllerError: 20,
          intervalSeconds: 1234,
        }),
      ],
      "2026-07-20T00:00:00.000Z",
      "2026-07-31T00:00:00.000Z"
    );

    expect(series[0].points[0]).toEqual({
      observedAt: observedIso,
      remainingPercent: 30,
      error: -20,
      intervalSeconds: 1234,
      resetAtIso: resetIso,
    });
  });

  it("preserves null control values for evidence that produced no reasoned decision", () => {
    const series = buildQuotaHistory(
      "claude",
      [
        historyPoint({
          observedAt: "2026-07-26T12:00:00.000Z",
          percentLeft: 0,
        }),
      ],
      "2026-07-20T00:00:00.000Z",
      "2026-07-31T00:00:00.000Z"
    );

    expect(series[0].points[0]).toEqual({
      observedAt: "2026-07-26T12:00:00.000Z",
      remainingPercent: 0,
      error: null,
      intervalSeconds: null,
      resetAtIso: null,
    });
  });
});

describe("GET /api/quota (ISSUE_NUM backend)", () => {
  it("returns 200 with the snapshot on a matching GET", async () => {
    const { deps } = fakeDeps({ claude: claudeState, codex: codexState, agy: agyState });
    const r = fakeRes();
    const handled = await handleQuotaApiRequest(fakeReq("GET"), r.res, u("/api/quota"), deps);

    expect(handled).toBe(true);
    expect(r.status()).toBe(200);
    expect(r.json()).toEqual(await buildQuotaSnapshot(deps));
  });

  it("falls through (returns false) for a non-matching path", async () => {
    const { deps } = fakeDeps({ claude: claudeState, codex: codexState, agy: agyState });
    const r = fakeRes();
    const handled = await handleQuotaApiRequest(
      fakeReq("GET"),
      r.res,
      u("/api/mesh/threads"),
      deps
    );

    expect(handled).toBe(false);
    expect(r.status()).toBe(0);
  });

  it("405s a non-GET method on a matching path", async () => {
    const { deps } = fakeDeps({ claude: claudeState, codex: codexState, agy: agyState });
    const r = fakeRes();
    const handled = await handleQuotaApiRequest(fakeReq("POST"), r.res, u("/api/quota"), deps);

    expect(handled).toBe(true);
    expect(r.status()).toBe(405);
  });

  it("503s when no QuotaService is bound (deps null)", async () => {
    const r = fakeRes();
    const handled = await handleQuotaApiRequest(fakeReq("GET"), r.res, u("/api/quota"), null);

    expect(handled).toBe(true);
    expect(r.status()).toBe(503);
  });

  it("500s when the underlying getQuota rejects", async () => {
    const deps: QuotaApiDeps = {
      getQuota: async () => {
        throw new Error("probe worktree busy");
      },
    };
    const r = fakeRes();
    const handled = await handleQuotaApiRequest(fakeReq("GET"), r.res, u("/api/quota"), deps);

    expect(handled).toBe(true);
    expect(r.status()).toBe(500);
    expect(r.json()).toEqual({ error: "probe worktree busy" });
  });

  describe("non-blocking request path wiring with getQuotaCached (issue #10)", () => {
    it("serves GET /api/quota immediately with cold DB fallback while underlying probe remains pending", async () => {
      const now = Date.parse("2026-08-25T23:00:00.000Z");
      // Probe promise that intentionally never resolves during the test
      const pendingProbe = new Promise<{ success: boolean; output: string; exitCode: number }>(
        () => {}
      );
      let probeStarted = false;

      // Real QuotaService instance configured to return the unresolved probe on execution
      const service = new QuotaService({
        config: {
          providers: {
            claude: { cliCommand: "claude" },
          },
        } as unknown as RusaConfig,
        workersDir: "/tmp/workers",
        resolveProvider: () =>
          ({
            name: "claude",
            providerName: "claude",
            run: () => {
              probeStarted = true;
              return pendingProbe;
            },
          }) as unknown as CodingProvider,
      });

      // Wire exactly as start.ts:2545-2552 does in production
      const deps: QuotaApiDeps = {
        getQuota: async (provider) => service.getQuotaCached(provider),
        providers: ["claude"],
        now: () => now,
        listHistory: (_provider, _sinceIso) => [
          historyPoint({
            observedAt: "2026-08-25T22:30:00.000Z", // 30 mins old, within 24h MAX_HOLD_MS
            percentLeft: 85,
          }),
        ],
      };

      const r = fakeRes();
      // handleQuotaApiRequest must complete and respond without awaiting the pending probe
      const handled = await handleQuotaApiRequest(fakeReq("GET"), r.res, u("/api/quota"), deps);

      expect(handled).toBe(true);
      expect(r.status()).toBe(200);
      const body = r.json() as QuotaSnapshotDto;
      expect(body.providers).toHaveLength(1);
      expect(body.providers[0]).toMatchObject({
        provider: "claude",
        status: "available",
        scrapedAt: "2026-08-25T22:30:00.000Z",
        usedPercent: 15,
      });

      // Background probe is kicked asynchronously without blocking the response
      await vi.waitFor(() => {
        expect(probeStarted).toBe(true);
      });
    });

    it("serves unknown placeholder immediately on cold cache without DB history when probe remains pending", async () => {
      const pendingProbe = new Promise<{ success: boolean; output: string; exitCode: number }>(
        () => {}
      );
      const service = new QuotaService({
        config: {
          providers: {
            claude: { cliCommand: "claude" },
          },
        } as unknown as RusaConfig,
        workersDir: "/tmp/workers",
        resolveProvider: () =>
          ({
            name: "claude",
            providerName: "claude",
            run: () => pendingProbe,
          }) as unknown as CodingProvider,
      });

      const deps: QuotaApiDeps = {
        getQuota: async (provider) => service.getQuotaCached(provider),
        providers: ["claude"],
        listHistory: () => [],
      };

      const r = fakeRes();
      const handled = await handleQuotaApiRequest(fakeReq("GET"), r.res, u("/api/quota"), deps);

      expect(handled).toBe(true);
      expect(r.status()).toBe(200);
      const body = r.json() as QuotaSnapshotDto;
      expect(body.providers[0]).toMatchObject({
        provider: "claude",
        status: "unknown",
      });
    });

    it("drops DB history older than 24h MAX_HOLD_MS and serves cold unknown placeholder", async () => {
      const now = Date.parse("2026-08-25T23:00:00.000Z");
      const service = new QuotaService({
        config: {
          providers: {
            claude: { cliCommand: "claude" },
          },
        } as unknown as RusaConfig,
        workersDir: "/tmp/workers",
        resolveProvider: () =>
          ({
            name: "claude",
            providerName: "claude",
            run: () => new Promise<never>(() => {}),
          }) as unknown as CodingProvider,
      });

      const deps: QuotaApiDeps = {
        getQuota: async (provider) => service.getQuotaCached(provider),
        providers: ["claude"],
        now: () => now,
        listHistory: () => [
          historyPoint({
            observedAt: "2026-08-24T22:00:00.000Z", // 25 hours old (> 24h MAX_HOLD_MS)
            percentLeft: 70,
          }),
        ],
      };

      const r = fakeRes();
      const handled = await handleQuotaApiRequest(fakeReq("GET"), r.res, u("/api/quota"), deps);

      expect(handled).toBe(true);
      expect(r.status()).toBe(200);
      const body = r.json() as QuotaSnapshotDto;
      expect(body.providers[0]).toMatchObject({
        provider: "claude",
        status: "unknown",
      });
    });
  });
});
