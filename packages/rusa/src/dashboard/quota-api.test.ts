import { mkdtempSync, rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { RusaConfig } from "../config/types.js";
import { inferQuotaState, type ProviderQuotaSnapshot, QuotaService } from "../mcp/quota-mcp.js";
import type { CodingProvider } from "../providers/types.js";
import { SharedQuotaStore } from "../quota/shared-store.js";
import {
  buildQuotaHistory,
  buildQuotaHistorySnapshot,
  buildQuotaSnapshot,
  HISTORY_WINDOW_MS,
  handleQuotaApiRequest,
  MAX_HISTORY_POINTS_PER_SERIES,
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

/**
 * The sanitized codex `/status` panel behind the reserve-headline defect (#249),
 * carried here as the extractor already scopes it — row order model, provider,
 * model, model:
 *
 *   gpt-reserve Weekly limit:    [████████████████████] 100% left (resets 14:56 on 12 Sep)
 *   Weekly limit:                [██████████░░░░░░░░░░] 52% left (resets 18:08 on 7 Sep)
 *   GPT-5.3-Codex-Spark limit:
 *   5h limit:                    [████████████████████] 100% left (resets 19:56)
 *   Weekly limit:                [████████████████████] 100% left (resets 16:11 on 7 Sep)
 *
 * The model reserve's weekly row sits first and reads 100% left, so it used to
 * win the weekly headline and report the provider as 0% used.
 */
const codexReservePanelState: ProviderQuotaSnapshot = {
  provider: "codex",
  status: "available",
  limits: [
    {
      label: "Weekly limit",
      kind: "weekly",
      percentLeft: 100,
      resetAtIso: "2026-09-12T14:56:00.000Z",
      scope: "model",
    },
    {
      label: "Weekly limit",
      kind: "weekly",
      percentLeft: 52,
      resetAtIso: "2026-09-07T18:08:00.000Z",
      scope: "provider",
    },
    {
      label: "5h limit",
      kind: "five_hour",
      percentLeft: 100,
      resetAtIso: "2026-09-05T19:56:00.000Z",
      scope: "model",
    },
    {
      label: "Weekly limit",
      kind: "weekly",
      percentLeft: 100,
      resetAtIso: "2026-09-07T16:11:00.000Z",
      scope: "model",
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

describe("dashboard quota snapshot", () => {
  it("builds one DTO per supported provider without history payload", async () => {
    const { deps, calls } = fakeDeps({
      claude: claudeState,
      codex: codexState,
      agy: agyState,
      kimi: kimiState,
    });
    const snapshot = await buildQuotaSnapshot(deps);

    expect(calls()).toEqual(["claude", "codex", "agy", "kimi"]);
    expect(snapshot.generatedAt).toBe(new Date(1000).toISOString());
    expect(snapshot).not.toHaveProperty("historySince");
    expect(snapshot).not.toHaveProperty("history");
    expect(snapshot.providers.map((p) => p.provider)).toEqual(["claude", "codex", "agy", "kimi"]);
    expect(snapshot.providers.every((p) => p.throttle === null)).toBe(true);
  });

  it("retains valid durable fallback state when the current probe has no limits", async () => {
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
        estimated: false,
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
              expired: false,
              capped: false,
              buckets: [],
              uncappedIntervalSeconds: 73,
              updatedAt: "2026-07-22T12:00:00.000Z",
            }
          : null,
    });

    const throttle = snapshot.providers.find((p) => p.provider === "claude")?.throttle;
    expect(throttle).toEqual({
      intervalSeconds: 73,
      expired: false,
      capped: false,
      buckets: [],
      uncappedIntervalSeconds: 73,
      updatedAt: "2026-07-22T12:00:00.000Z",
    });
    expect(throttle).not.toHaveProperty("held");
    expect(throttle).not.toHaveProperty("learning");
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
        estimated: false,
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
        estimated: false,
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
        estimated: false,
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
        estimated: false,
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
        estimated: false,
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
        estimated: false,
      },
    ]);
    expect(codex?.usedPercent).toBe(7);
  });

  describe("model-scoped windows (#752)", () => {
    const claudeWithFable: ProviderQuotaSnapshot = {
      provider: "claude",
      status: "available",
      scrapedAt: "2026-09-28T13:00:00.000Z",
      limits: [
        {
          label: "Current session",
          kind: "session",
          percentLeft: 80,
          scope: { provider: "claude" },
        },
        {
          label: "Current week (all models)",
          kind: "weekly",
          percentLeft: 60,
          resetAtIso: "2026-10-01T18:00:00.000Z",
          scope: { provider: "claude" },
        },
        {
          label: "Current week (Fable)",
          kind: "weekly",
          percentLeft: 25,
          resetAtIso: "2026-10-02T09:00:00.000Z",
          scope: { provider: "claude", models: ["claude-fable-5-1"] },
        },
      ],
    };

    it("serves the model's weekly separately from the provider's own windows", async () => {
      const { deps } = fakeDeps({ claude: claudeWithFable });
      const snapshot = await buildQuotaSnapshot({ ...deps, providers: ["claude"] });
      const claude = snapshot.providers[0];

      expect(claude.windows.map((w) => w.label)).toEqual([
        "Current session",
        "Current week (all models)",
      ]);
      expect(claude.usedPercent).toBe(40);
      expect(claude.modelWindows).toEqual([
        {
          id: "weekly",
          label: "Current week (Fable)",
          usedPercent: 75,
          status: "available",
          resetAtIso: "2026-10-02T09:00:00.000Z",
          headline: true,
          windowMs: WEEK_MS,
          scrapedAt: "2026-09-28T13:00:00.000Z",
          estimated: false,
          modelIds: ["claude-fable-5-1"],
        },
      ]);
    });

    it("never substitutes the model's weekly for a missing provider weekly", async () => {
      const { deps } = fakeDeps({
        claude: {
          ...claudeWithFable,
          limits: claudeWithFable.limits?.filter(
            (limit) => limit.label !== "Current week (all models)"
          ),
        },
      });
      const snapshot = await buildQuotaSnapshot({ ...deps, providers: ["claude"] });
      const claude = snapshot.providers[0];

      expect(claude.windows.map((w) => w.id)).toEqual(["session"]);
      expect(claude.usedPercent).toBeNull();
      expect(claude.modelWindows.map((w) => w.usedPercent)).toEqual([75]);
    });

    it("serves no model window when the snapshot has none", async () => {
      const { deps } = fakeDeps({ claude: claudeState });
      const snapshot = await buildQuotaSnapshot({ ...deps, providers: ["claude"] });

      expect(snapshot.providers[0].modelWindows).toEqual([]);
    });

    it("drops a model row that carries no model identity", async () => {
      const { deps } = fakeDeps({ codex: codexReservePanelState });
      const snapshot = await buildQuotaSnapshot({ ...deps, providers: ["codex"] });

      expect(snapshot.providers[0].modelWindows).toEqual([]);
    });

    it("keeps model identity on the durable fallback path", async () => {
      const now = Date.parse("2026-09-28T14:00:00.000Z");
      const snapshot = await buildQuotaSnapshot({
        getQuota: async () => ({ provider: "claude", status: "unknown" }),
        providers: ["claude"],
        now: () => now,
        listHistory: () => [
          historyPoint({
            label: "Current week (all models)",
            observedAt: "2026-09-28T13:00:00.000Z",
            percentLeft: 60,
          }),
          historyPoint({
            scope: "model",
            models: ["claude-fable-5-1"],
            label: "Current week (Fable)",
            observedAt: "2026-09-28T13:00:00.000Z",
            percentLeft: 25,
          }),
        ],
      });
      const claude = snapshot.providers[0];

      expect(claude.windows.map((w) => w.usedPercent)).toEqual([40]);
      expect(claude.modelWindows).toEqual([
        expect.objectContaining({
          id: "weekly",
          usedPercent: 75,
          modelIds: ["claude-fable-5-1"],
          scrapedAt: "2026-09-28T13:00:00.000Z",
        }),
      ]);
    });

    it("model-only history fallback preserves model window with original scrapedAt without promoting provider status", async () => {
      const now = Date.parse("2026-09-28T14:00:00.000Z");
      const snapshot = await buildQuotaSnapshot({
        getQuota: async () => ({ provider: "claude", status: "unknown" }),
        providers: ["claude"],
        now: () => now,
        listHistory: () => [
          historyPoint({
            scope: "model",
            models: ["claude-fable-5-1"],
            label: "Current week (Fable)",
            observedAt: "2026-09-28T11:00:00.000Z",
            percentLeft: 25,
          }),
        ],
      });
      const claude = snapshot.providers[0];

      expect(claude.status).toBe("unknown");
      expect(claude.windows).toEqual([]);
      expect(claude.usedPercent).toBeNull();
      expect(claude.modelWindows).toEqual([
        expect.objectContaining({
          id: "weekly",
          usedPercent: 75,
          modelIds: ["claude-fable-5-1"],
          scrapedAt: "2026-09-28T11:00:00.000Z",
        }),
      ]);
    });

    it("history fallback keeps an older unexpired Fable point beside a newer provider point", async () => {
      const now = Date.parse("2026-09-28T15:00:00.000Z");
      const snapshot = await buildQuotaSnapshot({
        getQuota: async () => ({ provider: "claude", status: "unknown" }),
        providers: ["claude"],
        now: () => now,
        listHistory: () => [
          historyPoint({
            scope: "model",
            models: ["claude-fable-5-1"],
            label: "Current week (Fable)",
            observedAt: "2026-09-28T11:00:00.000Z",
            percentLeft: 25,
            resetAtIso: "2026-10-01T00:00:00.000Z",
          }),
          // An expired older window is not revived.
          historyPoint({
            scope: "model",
            models: ["claude-sonnet-5"],
            label: "Current week (Sonnet)",
            observedAt: "2026-09-28T11:00:00.000Z",
            percentLeft: 50,
            resetAtIso: "2026-09-28T12:00:00.000Z",
          }),
          historyPoint({
            label: "Current week (all models)",
            observedAt: "2026-09-28T14:00:00.000Z",
            percentLeft: 60,
          }),
        ],
      });
      const claude = snapshot.providers[0];

      expect(claude.status).toBe("available");
      expect(claude.windows).toEqual([
        expect.objectContaining({ usedPercent: 40, scrapedAt: "2026-09-28T14:00:00.000Z" }),
      ]);
      expect(claude.modelWindows).toEqual([
        expect.objectContaining({
          id: "weekly",
          usedPercent: 75,
          modelIds: ["claude-fable-5-1"],
          scrapedAt: "2026-09-28T11:00:00.000Z",
        }),
      ]);
    });

    it("history fallback keeps older model points for Claude only", async () => {
      const now = Date.parse("2026-09-28T15:00:00.000Z");
      const snapshot = await buildQuotaSnapshot({
        getQuota: async () => ({ provider: "codex", status: "unknown" }),
        providers: ["codex"],
        now: () => now,
        listHistory: () => [
          historyPoint({
            scope: "model",
            models: ["gpt-spark"],
            label: "Spark weekly",
            observedAt: "2026-09-28T11:00:00.000Z",
            percentLeft: 25,
            resetAtIso: "2026-10-01T00:00:00.000Z",
          }),
          historyPoint({
            observedAt: "2026-09-28T14:00:00.000Z",
            percentLeft: 60,
          }),
        ],
      });
      const codex = snapshot.providers[0];

      expect(codex.status).toBe("available");
      expect(codex.modelWindows ?? []).toEqual([]);
    });

    it("history fallback for other providers reads only the newest scrape, as before #763", async () => {
      const now = Date.parse("2026-09-28T15:00:00.000Z");
      const resetAtIso = "2026-10-01T00:00:00.000Z";
      const fallback = (listHistory: QuotaApiDeps["listHistory"]) =>
        buildQuotaSnapshot({
          getQuota: async () => ({ provider: "codex", status: "unknown" }),
          providers: ["codex"],
          now: () => now,
          listHistory,
        }).then((snapshot) => snapshot.providers[0]);

      // An older provider window is not revived beside a newer scrape.
      const olderProvider = await fallback(() => [
        historyPoint({ observedAt: "2026-09-28T11:00:00.000Z", percentLeft: 25, resetAtIso }),
        historyPoint({
          kind: "five_hour",
          label: "5h",
          observedAt: "2026-09-28T14:00:00.000Z",
          percentLeft: 60,
          resetAtIso,
        }),
      ]);
      expect(olderProvider.windows.map((w) => w.label)).toEqual(["5h"]);

      // A newest scrape with only model points still reads available.
      const modelOnly = await fallback(() => [
        historyPoint({
          scope: "model",
          models: ["gpt-spark"],
          label: "Spark weekly",
          observedAt: "2026-09-28T14:00:00.000Z",
          percentLeft: 60,
        }),
      ]);
      expect(modelOnly.status).toBe("available");

      // An exhausted model window still reads exhausted.
      const exhaustedModel = await fallback(() => [
        historyPoint({ observedAt: "2026-09-28T14:00:00.000Z", percentLeft: 60 }),
        historyPoint({
          scope: "model",
          models: ["gpt-spark"],
          label: "Spark weekly",
          observedAt: "2026-09-28T14:00:00.000Z",
          percentLeft: 0,
        }),
      ]);
      expect(exhaustedModel.status).toBe("exhausted");
    });

    it("dates a carried provider window at its original read for Claude only", async () => {
      const t0 = "2026-09-28T11:00:00.000Z";
      const t1 = "2026-09-28T14:00:00.000Z";
      const resetAtIso = "2026-10-01T00:00:00.000Z";
      for (const [provider, expected] of [
        ["claude", t0],
        ["codex", t1],
        ["agy", t1],
        ["kimi", t1],
      ] as const) {
        const carried = inferQuotaState(
          { provider, status: "unknown", scrapedAt: t1, limits: [] },
          {
            provider,
            status: "available",
            scrapedAt: t0,
            limits: [
              {
                label: "Weekly",
                kind: "weekly",
                percentLeft: 60,
                resetAtIso,
                scope: "provider",
              },
            ],
          },
          t1
        );
        const snapshot = await buildQuotaSnapshot({
          getQuota: async () => carried,
          providers: [provider],
          now: () => Date.parse(t1),
        });
        expect(snapshot.providers[0].windows.map((w) => w.scrapedAt)).toEqual([expected]);
      }
    });

    it("history fallback treats one lane read under two labels as a single window", async () => {
      const now = Date.parse("2026-09-28T15:00:00.000Z");
      const snapshot = await buildQuotaSnapshot({
        getQuota: async () => ({ provider: "claude", status: "unknown" }),
        providers: ["claude"],
        now: () => now,
        listHistory: () => [
          historyPoint({
            label: "Current week (all models)",
            observedAt: "2026-09-28T11:00:00.000Z",
            percentLeft: 0,
            resetAtIso: "2026-10-01T00:00:00.000Z",
          }),
          historyPoint({
            label: "Weekly (all models)",
            observedAt: "2026-09-28T14:00:00.000Z",
            percentLeft: 60,
            resetAtIso: "2026-10-01T00:00:00.000Z",
          }),
        ],
      });
      const claude = snapshot.providers[0];

      expect(claude.status).toBe("available");
      expect(claude.windows).toEqual([
        expect.objectContaining({ usedPercent: 40, scrapedAt: "2026-09-28T14:00:00.000Z" }),
      ]);
    });

    it("passes limit.scrapedAt through to modelWindows and provider windows", async () => {
      const snapshot = await buildQuotaSnapshot({
        getQuota: async () => ({
          provider: "claude",
          status: "available",
          scrapedAt: "2026-09-28T14:00:00.000Z",
          limits: [
            {
              label: "Current week (all models)",
              kind: "weekly",
              percentLeft: 60,
              scope: "provider",
              scrapedAt: "2026-09-28T14:00:00.000Z",
            },
            {
              label: "Current week (Fable)",
              kind: "weekly",
              percentLeft: 25,
              scope: { provider: "claude", models: ["claude-fable-5-1"] },
              scrapedAt: "2026-09-28T11:00:00.000Z",
            },
          ],
        }),
        providers: ["claude"],
      });
      const claude = snapshot.providers[0];

      expect(claude.windows[0].scrapedAt).toBe("2026-09-28T14:00:00.000Z");
      expect(claude.modelWindows[0].scrapedAt).toBe("2026-09-28T11:00:00.000Z");
    });

    it.each([
      "codex",
      "agy",
      "kimi",
    ] as const)("ignores a per-limit scrapedAt for %s, as before #763", async (provider) => {
      const scrapeAt = "2026-09-28T14:00:00.000Z";
      const perLimitAt = "2026-09-28T11:00:00.000Z";
      const snapshot = await buildQuotaSnapshot({
        getQuota: async () => ({
          provider,
          status: "available",
          scrapedAt: scrapeAt,
          limits: [
            {
              label: "Weekly",
              kind: "weekly",
              percentLeft: 60,
              scope: "provider",
              scrapedAt: perLimitAt,
            },
            {
              label: "Weekly (model)",
              kind: "weekly",
              percentLeft: 25,
              scope: { provider, models: [`${provider}-model`] },
              scrapedAt: perLimitAt,
            },
          ],
        }),
        providers: [provider],
      });
      const dto = snapshot.providers[0];

      expect(dto.windows.map((w) => w.scrapedAt)).toEqual([scrapeAt]);
      expect(dto.modelWindows.map((w) => w.scrapedAt)).toEqual([scrapeAt]);
    });
  });

  it("codex: reports the provider's own weekly, not a model reserve at 100% left (#249)", async () => {
    const { deps } = fakeDeps({ codex: codexReservePanelState });
    const snapshot = await buildQuotaSnapshot(deps);
    const codex = snapshot.providers.find((p) => p.provider === "codex");

    expect(codex?.windows).toEqual([
      {
        id: "weekly",
        label: "Weekly limit",
        usedPercent: 48,
        status: "available",
        resetAtIso: "2026-09-07T18:08:00.000Z",
        headline: true,
        windowMs: WEEK_MS,
        scrapedAt: null,
        estimated: false,
      },
    ]);
    expect(codex?.usedPercent).toBe(48);
  });

  it("codex: a model-only panel yields no headline rather than an unqualified provider Weekly", async () => {
    const { deps } = fakeDeps({
      codex: {
        ...codexReservePanelState,
        limits: codexReservePanelState.limits?.filter((limit) => limit.scope === "model"),
      },
    });
    const snapshot = await buildQuotaSnapshot(deps);
    const codex = snapshot.providers.find((p) => p.provider === "codex");

    expect(codex?.windows).toEqual([]);
    expect(codex?.usedPercent).toBeNull();
  });

  it("codex: the durable fallback path drops model rows too", async () => {
    const now = Date.parse("2026-09-05T20:00:00.000Z");
    const snapshot = await buildQuotaSnapshot({
      getQuota: async () => ({ provider: "codex", status: "unknown" }),
      providers: ["codex"],
      now: () => now,
      listHistory: () => [
        historyPoint({
          scope: "model",
          label: "Weekly limit",
          observedAt: "2026-09-05T19:00:00.000Z",
          percentLeft: 100,
        }),
        historyPoint({
          label: "Weekly limit",
          observedAt: "2026-09-05T19:00:00.000Z",
          percentLeft: 52,
        }),
      ],
    });

    expect(snapshot.providers[0].windows.map((w) => w.usedPercent)).toEqual([48]);
    expect(snapshot.providers[0].usedPercent).toBe(48);
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
        estimated: false,
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
        estimated: false,
      },
    ]);
    expect(agy).not.toHaveProperty("groups");
    // Headline usedPercent mirrors the first group's headline (weekly) window.
    expect(agy?.usedPercent).toBe(20);
  });

  it("agy: a window the parse left unscoped is still the provider's own, as ingestion counts it", async () => {
    const { deps } = fakeDeps({
      agy: {
        ...agyState,
        limits: [{ label: "Weekly", kind: "weekly", percentLeft: 80 }],
      },
    });
    const snapshot = await buildQuotaSnapshot(deps);
    const agy = snapshot.providers.find((p) => p.provider === "agy");

    expect(agy?.windows.map((w) => w.id)).toEqual(["weekly"]);
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

  it("history keeps independently identified model buckets, while ignoring short windows and observations outside the range", () => {
    const series = buildQuotaHistory(
      "codex",
      [
        historyPoint({
          observedAt: "2026-07-25T19:59:59.000Z",
          percentLeft: 60,
        }),
        historyPoint({
          scope: "model",
          models: ["codex-fable"],
          label: "Fable",
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

    expect(series).toMatchObject([
      {
        provider: "codex",
        windowId: "weekly",
        scope: "model",
        modelIds: ["codex-fable"],
        label: "Fable",
        points: [{ remainingPercent: 55 }],
      },
    ]);
  });

  it("keeps provider and Fable weekly histories as separate explicit lanes", () => {
    const series = buildQuotaHistory(
      "claude",
      [
        historyPoint({ observedAt: "2026-07-25T21:00:00.000Z", percentLeft: 70 }),
        historyPoint({
          scope: "model",
          models: ["claude-fable"],
          label: "Fable",
          observedAt: "2026-07-25T21:00:00.000Z",
          percentLeft: 40,
        }),
      ],
      "2026-07-25T20:00:00.000Z",
      "2026-07-26T20:00:00.000Z"
    );

    expect(series).toMatchObject([
      { scope: "provider", modelIds: [], points: [{ remainingPercent: 70 }] },
      {
        scope: "model",
        modelIds: ["claude-fable"],
        label: "Fable",
        points: [{ remainingPercent: 40 }],
      },
    ]);
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

  it("bounds a dense 3-day series to one real reading per time bucket and leaves an outage empty", () => {
    const sinceMs = Date.parse("2026-09-12T12:00:00.000Z");
    const untilMs = sinceMs + HISTORY_WINDOW_MS;
    const reset = "2026-09-14T06:00:00.000Z";
    const rows: QuotaHistorySource[] = [];
    for (let t = sinceMs; t <= untilMs; t += 5 * 60 * 1000) {
      // A twelve-hour outage with no readings at all must stay a gap.
      if (
        t >= Date.parse("2026-09-13T00:00:00.000Z") &&
        t < Date.parse("2026-09-13T12:00:00.000Z")
      ) {
        continue;
      }
      const beforeReset = t < Date.parse(reset);
      rows.push(
        historyPoint({
          scope: "model",
          models: ["claude-fable"],
          label: "Fable",
          observedAt: new Date(t).toISOString(),
          percentLeft: Math.round((beforeReset ? 40 : 90) - ((t - sinceMs) % 1000) / 100),
          resetAtIso: beforeReset ? reset : "2026-09-21T06:00:00.000Z",
          controllerError: 0.05 + ((t - sinceMs) % 7) / 10,
          intervalSeconds: 300 + ((t - sinceMs) % 11),
        })
      );
    }
    expect(rows.length).toBeGreaterThan(MAX_HISTORY_POINTS_PER_SERIES);

    const [series] = buildQuotaHistory(
      "claude",
      rows,
      new Date(sinceMs).toISOString(),
      new Date(untilMs).toISOString()
    );

    expect(series.points.length).toBeLessThanOrEqual(MAX_HISTORY_POINTS_PER_SERIES);
    // Every point is a real reading with its stored controller fields, never
    // an average or a filled value.
    const byObservedAt = new Map(rows.map((row) => [row.observedAt, row]));
    for (const point of series.points) {
      const source = byObservedAt.get(point.observedAt);
      expect(source).toBeDefined();
      expect(point.remainingPercent).toBe(source?.percentLeft);
      // The DTO carries the stored controller error sign-flipped, as for every reading.
      expect(point.error).toBe(-(source?.controllerError ?? 0));
      expect(point.intervalSeconds).toBe(source?.intervalSeconds);
    }
    expect(series.points.at(-1)?.observedAt).toBe(rows.at(-1)?.observedAt);
    // Nothing is invented inside the outage.
    expect(
      series.points.filter(
        (point) =>
          point.observedAt >= "2026-09-13T00:00:00.000Z" &&
          point.observedAt < "2026-09-13T12:00:00.000Z"
      )
    ).toEqual([]);
  });

  it("holds the bound for a fully covered 3-day range with a reading exactly at its end", () => {
    const sinceMs = Date.parse("2026-09-12T12:00:00.000Z");
    const untilMs = sinceMs + HISTORY_WINDOW_MS;
    const rows: QuotaHistorySource[] = [];
    for (let t = sinceMs; t <= untilMs; t += 5 * 60 * 1000) {
      rows.push(historyPoint({ observedAt: new Date(t).toISOString(), percentLeft: 50 }));
    }
    expect(rows.at(-1)?.observedAt).toBe(new Date(untilMs).toISOString());
    expect(rows.length).toBeGreaterThan(MAX_HISTORY_POINTS_PER_SERIES);

    const [series] = buildQuotaHistory(
      "claude",
      rows,
      new Date(sinceMs).toISOString(),
      new Date(untilMs).toISOString()
    );

    expect(series.points.length).toBeLessThanOrEqual(MAX_HISTORY_POINTS_PER_SERIES);
    expect(series.points.at(-1)?.observedAt).toBe(new Date(untilMs).toISOString());
  });

  it("keeps a reset visible when it falls inside a bucket whose prior bucket is empty", () => {
    const sinceMs = Date.parse("2026-09-12T12:00:00.000Z");
    const untilMs = sinceMs + HISTORY_WINDOW_MS;
    const bucketMs = HISTORY_WINDOW_MS / MAX_HISTORY_POINTS_PER_SERIES;
    // The reset lands two minutes into bucket 312; bucket 311 has no reading.
    const resetMs = sinceMs + 312 * bucketMs + 2 * 60 * 1000;
    const oldReset = new Date(resetMs).toISOString();
    const newReset = new Date(resetMs + 7 * 24 * 60 * 60 * 1000).toISOString();
    const rows: QuotaHistorySource[] = [];
    // One-minute readings, so bucket 312 holds readings on both sides of the reset.
    for (let t = sinceMs; t <= untilMs; t += 60 * 1000) {
      if (t >= sinceMs + 311 * bucketMs && t < sinceMs + 312 * bucketMs) continue;
      rows.push(
        historyPoint({
          observedAt: new Date(t).toISOString(),
          percentLeft: t < resetMs ? 3 : 100,
          resetAtIso: t < resetMs ? oldReset : newReset,
        })
      );
    }

    const [series] = buildQuotaHistory(
      "claude",
      rows,
      new Date(sinceMs).toISOString(),
      new Date(untilMs).toISOString()
    );

    // The newest reading of bucket 312 is post-reset, and the reading kept
    // before it is still pre-reset from bucket 310: the reported reset
    // instant changes between two adjacent kept points.
    const firstAfter = series.points.findIndex((point) => point.resetAtIso === newReset);
    expect(firstAfter).toBeGreaterThan(0);
    expect(series.points[firstAfter - 1]).toMatchObject({
      resetAtIso: oldReset,
      remainingPercent: 3,
    });
    expect(Date.parse(series.points[firstAfter - 1].observedAt)).toBeLessThan(
      sinceMs + 311 * bucketMs
    );
  });

  it("leaves a series at or under the bound untouched", () => {
    const rows = Array.from({ length: 12 }, (_, i) =>
      historyPoint({
        observedAt: new Date(Date.parse("2026-09-20T00:00:00.000Z") + i * 60_000).toISOString(),
        percentLeft: 50 - i,
      })
    );
    const [series] = buildQuotaHistory(
      "claude",
      rows,
      "2026-09-18T00:00:00.000Z",
      "2026-09-21T00:00:00.000Z"
    );
    expect(series.points.map((point) => point.remainingPercent)).toEqual(
      rows.map((row) => row.percentLeft)
    );
  });
});

describe("dashboard quota history snapshot", () => {
  it("returns prior-3-day durable readings as quota remaining, not quota used", () => {
    const now = Date.parse("2026-07-26T20:00:00.000Z");
    const calls: Array<{ provider: string; sinceIso: string }> = [];
    const historySnapshot = buildQuotaHistorySnapshot({
      getQuota: async () => claudeState,
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
    expect(historySnapshot.generatedAt).toBe("2026-07-26T20:00:00.000Z");
    expect(historySnapshot.historySince).toBe("2026-07-23T20:00:00.000Z");
    expect(historySnapshot.history).toEqual([
      {
        provider: "claude",
        windowId: "weekly",
        scope: "provider",
        modelIds: [],
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

  it("uses the same first weekly limit as the header ring and excludes short windows", () => {
    const now = Date.parse("2026-07-26T20:00:00.000Z");
    const historySnapshot = buildQuotaHistorySnapshot({
      getQuota: async () => codexState,
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

    expect(historySnapshot.history).toEqual([
      {
        provider: "codex",
        windowId: "weekly",
        scope: "provider",
        modelIds: [],
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

  it("keeps divergent weekly-window ordering and availability from splicing pools", () => {
    const now = Date.parse("2026-07-26T20:00:00.000Z");
    const historySnapshot = buildQuotaHistorySnapshot({
      getQuota: async () => codexState,
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

    expect(historySnapshot.history).toEqual([
      {
        provider: "codex",
        windowId: "weekly",
        scope: "provider",
        modelIds: [],
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
});

describe("GET /api/quota and GET /api/quota/history", () => {
  it("returns 200 with the current snapshot on GET /api/quota", async () => {
    const { deps } = fakeDeps({ claude: claudeState, codex: codexState, agy: agyState });
    const r = fakeRes();
    const handled = await handleQuotaApiRequest(fakeReq("GET"), r.res, u("/api/quota"), deps);

    expect(handled).toBe(true);
    expect(r.status()).toBe(200);
    expect(r.json()).toEqual(await buildQuotaSnapshot(deps));
  });

  it("returns 200 with the history series on GET /api/quota/history", async () => {
    const { deps } = fakeDeps({ claude: claudeState, codex: codexState, agy: agyState });
    const r = fakeRes();
    const handled = await handleQuotaApiRequest(
      fakeReq("GET"),
      r.res,
      u("/api/quota/history"),
      deps
    );

    expect(handled).toBe(true);
    expect(r.status()).toBe(200);
    expect(r.json()).toEqual(buildQuotaHistorySnapshot(deps));
  });

  it("reads each configured provider through and isolates a failed provider before serving history (#707)", async () => {
    const nowMs = Date.parse("2026-09-26T16:00:00.000Z");
    const cache = new Map<string, QuotaHistorySource[]>();
    const readThrough: string[] = [];
    const deps: QuotaApiDeps = {
      getQuota: async () => {
        throw new Error("history route must not read quota");
      },
      providers: ["claude", "codex"],
      now: () => nowMs,
      listHistory: (provider) => cache.get(provider) ?? [],
      readThroughHistory: async (provider) => {
        readThrough.push(provider);
        await new Promise((resolve) => setTimeout(resolve, 5));
        if (provider === "claude") {
          cache.set(provider, [
            historyPoint({ observedAt: "2026-09-26T15:00:00.000Z", percentLeft: 64 }),
          ]);
        } else {
          throw new Error("coordinator unavailable");
        }
      },
    };
    const r = fakeRes();
    await handleQuotaApiRequest(fakeReq("GET"), r.res, u("/api/quota/history"), deps);

    expect(r.status()).toBe(200);
    expect(readThrough).toEqual(["claude", "codex"]);
    const body = r.json() as { history: { provider: string; points: unknown[] }[] };
    expect(body.history.map((s) => [s.provider, s.points.length])).toEqual([["claude", 1]]);
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

  it("405s a non-GET method on matching paths", async () => {
    const { deps } = fakeDeps({ claude: claudeState, codex: codexState, agy: agyState });
    const r1 = fakeRes();
    const handled1 = await handleQuotaApiRequest(fakeReq("POST"), r1.res, u("/api/quota"), deps);
    expect(handled1).toBe(true);
    expect(r1.status()).toBe(405);

    const r2 = fakeRes();
    const handled2 = await handleQuotaApiRequest(
      fakeReq("POST"),
      r2.res,
      u("/api/quota/history"),
      deps
    );
    expect(handled2).toBe(true);
    expect(r2.status()).toBe(405);
  });

  it("503s when no QuotaService is bound (deps null)", async () => {
    const r1 = fakeRes();
    const handled1 = await handleQuotaApiRequest(fakeReq("GET"), r1.res, u("/api/quota"), null);
    expect(handled1).toBe(true);
    expect(r1.status()).toBe(503);

    const r2 = fakeRes();
    const handled2 = await handleQuotaApiRequest(
      fakeReq("GET"),
      r2.res,
      u("/api/quota/history"),
      null
    );
    expect(handled2).toBe(true);
    expect(r2.status()).toBe(503);
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

describe("dead-reckoned lane estimates (#759)", () => {
  const FABLE = ["claude-fable-5-1"];
  const RESET = "2026-10-02T09:00:00.000Z";
  const at = (hhmm: string, day = "2026-09-28") => `${day}T${hhmm}:00.000Z`;
  const fablePoint = (observedAt: string, percentLeft: number, resetAtIso: string | null = RESET) =>
    historyPoint({
      scope: "model",
      models: FABLE,
      label: "Current week (Fable)",
      observedAt,
      percentLeft,
      resetAtIso,
    });
  /** A Claude reading carrying only the provider weekly, as when the Fable panel is missed. */
  const providerOnly = (scrapedAt: string): ProviderQuotaSnapshot => ({
    provider: "claude",
    status: "available",
    scrapedAt,
    limits: [
      { label: "Current week (all models)", kind: "weekly", percentLeft: 60, resetAtIso: RESET },
    ],
  });
  const snapshotAt = (
    nowIso: string,
    state: ProviderQuotaSnapshot,
    history: QuotaHistorySource[]
  ): Promise<QuotaSnapshotDto> =>
    buildQuotaSnapshot({
      getQuota: async () => state,
      providers: ["claude"],
      now: () => Date.parse(nowIso),
      listHistory: () => history,
    });

  it("estimates a missed lane from its window's pace, flagged with the last reading time", async () => {
    // 80% at 10:00 and 70% at 12:00 is five points an hour; the 13:00 reading
    // missed the Fable panel, so at 13:30 the lane reads 70 - 5 x 1.5 = 62.5.
    const snapshot = await snapshotAt(at("13:30"), providerOnly(at("13:00")), [
      fablePoint(at("10:00"), 80),
      fablePoint(at("12:00"), 70),
    ]);
    const claude = snapshot.providers[0];

    expect(claude.modelWindows).toEqual([
      {
        id: "weekly",
        label: "Current week (Fable)",
        usedPercent: 37.5,
        status: "available",
        resetAtIso: RESET,
        headline: true,
        windowMs: WEEK_MS,
        scrapedAt: at("12:00"),
        estimated: true,
        modelIds: FABLE,
      },
    ]);
    // The provider weekly was read in the newest scrape and stays a reading.
    expect(claude.windows).toEqual([
      expect.objectContaining({ id: "weekly", usedPercent: 40, estimated: false }),
    ]);
  });

  it("estimates a lane at the first scrape that misses it, however recent its last reading", async () => {
    // The 12:06 scrape missed the Fable panel six minutes after its last
    // reading, well inside the stale threshold: 70 - 5 x 0.1 = 69.5.
    const snapshot = await snapshotAt(at("12:06"), providerOnly(at("12:06")), [
      fablePoint(at("10:00"), 80),
      fablePoint(at("12:00"), 70),
    ]);

    expect(snapshot.providers[0].modelWindows).toEqual([
      expect.objectContaining({ usedPercent: 30.5, scrapedAt: at("12:00"), estimated: true }),
    ]);
  });

  it("keeps a fresh reading as-is even when history could extend it", async () => {
    const snapshot = await snapshotAt(
      at("13:10"),
      {
        ...providerOnly(at("13:00")),
        limits: [
          {
            label: "Current week (Fable)",
            kind: "weekly",
            scope: { provider: "claude", models: FABLE },
            percentLeft: 65,
            resetAtIso: RESET,
          },
        ],
      },
      [fablePoint(at("10:00"), 80), fablePoint(at("12:00"), 70), fablePoint(at("13:00"), 65)]
    );

    expect(snapshot.providers[0].modelWindows).toEqual([
      expect.objectContaining({ usedPercent: 35, scrapedAt: at("13:00"), estimated: false }),
    ]);
  });

  it("estimates a lane still in the newest reading once that reading has gone stale", async () => {
    // The scraper stalled after 12:00: the lane is in the newest reading, but
    // three hours on that reading is no longer fresh.
    const snapshot = await snapshotAt(
      at("15:00"),
      {
        provider: "claude",
        status: "available",
        scrapedAt: at("12:00"),
        limits: [{ label: "Weekly", kind: "weekly", percentLeft: 70, resetAtIso: RESET }],
      },
      [historyPoint({ observedAt: at("10:00"), percentLeft: 80, resetAtIso: RESET })]
    );

    expect(snapshot.providers[0].windows).toEqual([
      expect.objectContaining({ usedPercent: 45, scrapedAt: at("12:00"), estimated: true }),
    ]);
    expect(snapshot.providers[0].usedPercent).toBe(45);
  });

  it("keeps a one-reading lane unknown", async () => {
    const snapshot = await snapshotAt(at("13:30"), providerOnly(at("13:00")), [
      fablePoint(at("12:00"), 70),
    ]);

    expect(snapshot.providers[0].modelWindows).toEqual([]);
  });

  it("paces only on readings from the current window", async () => {
    // The 90% reading belongs to the previous window (its reset differs), so
    // the current window has one reading and nothing to pace on.
    const snapshot = await snapshotAt(at("13:30"), providerOnly(at("13:00")), [
      fablePoint(at("10:00"), 90, "2026-09-28T11:00:00.000Z"),
      fablePoint(at("12:00"), 70),
    ]);

    expect(snapshot.providers[0].modelWindows).toEqual([]);
  });

  /** A stalled scrape that still carries the Fable weekly, as last read at `scrapedAt`. */
  const withFable = (
    scrapedAt: string,
    percentLeft: number,
    resetAtIso: string
  ): ProviderQuotaSnapshot => ({
    ...providerOnly(scrapedAt),
    limits: [
      ...(providerOnly(scrapedAt).limits ?? []),
      {
        label: "Current week (Fable)",
        kind: "weekly",
        scope: { provider: "claude", models: FABLE },
        percentLeft,
        resetAtIso,
      },
    ],
  });
  const rolloverHistory = [
    fablePoint(at("11:30"), 40, at("13:00")),
    fablePoint(at("12:30"), 30, at("13:00")),
  ];

  it("shows an approximately full estimate right after the window rolls over", async () => {
    // Ten points an hour; the window reset at 13:00 with the last reading at
    // 12:30, so at 13:30 the new window is estimated at 100 - 10 x 0.5 = 95.
    const snapshot = await snapshotAt(
      at("13:30"),
      withFable(at("12:30"), 30, at("13:00")),
      rolloverHistory
    );

    expect(snapshot.providers[0].modelWindows).toEqual([
      expect.objectContaining({
        usedPercent: 5,
        resetAtIso: null,
        scrapedAt: at("12:30"),
        estimated: true,
      }),
    ]);
  });

  it("measures the two-hour hold at the reset, not at read time", async () => {
    // The window ended 30 minutes after its last reading, so the new window is
    // still estimated at 16:00, three and a half hours after that reading.
    const snapshot = await snapshotAt(
      at("16:00"),
      withFable(at("12:30"), 30, at("13:00")),
      rolloverHistory
    );

    expect(snapshot.providers[0].modelWindows).toEqual([
      expect.objectContaining({ usedPercent: 30, resetAtIso: null, estimated: true }),
    ]);
  });

  it("estimates no next window when the last reading was over two hours old at the reset", async () => {
    const snapshot = await snapshotAt(at("13:10"), withFable(at("10:30"), 30, at("13:00")), [
      fablePoint(at("10:00"), 40, at("13:00")),
      fablePoint(at("10:30"), 30, at("13:00")),
    ]);

    // The ended window is passed through as read, for the ring to show as reset.
    expect(snapshot.providers[0].modelWindows).toEqual([
      expect.objectContaining({ usedPercent: 70, resetAtIso: at("13:00"), estimated: false }),
    ]);
  });

  it("stops the rollover estimate where the next window would end", async () => {
    const session = (percentLeft: number, observedAt: string) =>
      historyPoint({
        kind: "session",
        label: "Session",
        observedAt,
        percentLeft,
        resetAtIso: at("13:00"),
      });
    const state = (scrapedAt: string): ProviderQuotaSnapshot => ({
      provider: "claude",
      status: "available",
      scrapedAt,
      limits: [{ label: "Session", kind: "session", percentLeft: 30, resetAtIso: at("13:00") }],
    });
    const history = [session(40, at("11:30")), session(30, at("12:30"))];

    const before = await snapshotAt(at("17:59"), state(at("12:30")), history);
    expect(before.providers[0].windows).toEqual([
      expect.objectContaining({ id: "session", resetAtIso: null, estimated: true }),
    ]);
    const after = await snapshotAt(at("18:00"), state(at("12:30")), history);
    expect(after.providers[0].windows).toEqual([
      expect.objectContaining({ id: "session", resetAtIso: at("13:00"), estimated: false }),
    ]);
  });

  it("estimates a dropped lane only until its window resets, when #588 retires it", async () => {
    const snapshot = await snapshotAt(at("13:30"), providerOnly(at("13:15")), rolloverHistory);

    expect(snapshot.providers[0].modelWindows).toEqual([]);
  });

  it("keeps estimating inside the window however old the last reading is", async () => {
    const snapshot = await snapshotAt(
      at("12:00", "2026-09-30"),
      providerOnly(at("11:00", "2026-09-30")),
      [fablePoint(at("10:00"), 80), fablePoint(at("12:00"), 78)]
    );

    // One point an hour for 48 hours.
    expect(snapshot.providers[0].modelWindows).toEqual([
      expect.objectContaining({ usedPercent: 70, scrapedAt: at("12:00"), estimated: true }),
    ]);
  });

  it("writes no estimate to the quota database", async () => {
    const root = mkdtempSync(join(tmpdir(), "rusa-quota-estimate-"));
    const store = new SharedQuotaStore(join(root, "quota.db"));
    try {
      const record = (scrapedAt: string, limits: ProviderQuotaSnapshot["limits"]) => {
        const state: ProviderQuotaSnapshot = {
          provider: "claude",
          status: "available",
          scrapedAt,
          limits,
        };
        store.recordParsed(
          store.recordRaw({ provider: "claude", scrapedAt, rawOutput: "raw" }),
          state,
          state
        );
      };
      const session = {
        label: "Current session",
        kind: "session" as const,
        percentLeft: 90,
        resetAtIso: at("15:00"),
      };
      const weekly = (percentLeft: number) => ({
        label: "Weekly",
        kind: "weekly" as const,
        percentLeft,
        resetAtIso: RESET,
      });
      record(at("10:00"), [session, weekly(80)]);
      record(at("12:00"), [session, weekly(70)]);
      // The newest scrape missed the weekly panel.
      record(at("13:00"), [session]);
      const counts = () =>
        store.db
          .prepare(
            `SELECT (SELECT count(*) FROM quota_observations) AS observations,
                    (SELECT count(*) FROM quota_scrapes) AS scrapes`
          )
          .get();
      const before = counts();

      const snapshot = await buildQuotaSnapshot({
        getQuota: async () =>
          store.getLatestSnapshot("claude") ?? { provider: "claude", status: "unknown" },
        providers: ["claude"],
        now: () => Date.parse(at("13:30")),
        listHistory: (provider, sinceIso) => store.listHistorySince(provider, sinceIso),
      });

      expect(snapshot.providers[0].windows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: "weekly", usedPercent: 37.5, estimated: true }),
        ])
      );
      expect(counts()).toEqual(before);
      expect(
        store.db
          .prepare("SELECT count(*) AS n FROM quota_observations WHERE percent_left = 62.5")
          .get()
      ).toEqual({ n: 0 });
    } finally {
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
