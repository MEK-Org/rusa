import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockGenerateContent = vi.fn();

vi.mock("@google/genai", () => ({
  GoogleGenAI: class {
    models = {
      generateContent: (args: unknown) => mockGenerateContent(args),
    };
  },
  Type: {
    OBJECT: "OBJECT",
    STRING: "STRING",
    ARRAY: "ARRAY",
    BOOLEAN: "BOOLEAN",
    NUMBER: "NUMBER",
  },
}));

import type { RusaConfig } from "../config/types.js";
import { buildQuotaSnapshot } from "../dashboard/quota-api.js";
import { KimiAuthRequiredError } from "../providers/kimi-usage-scrape.js";
import { clearProviderModelCatalog, setProviderModelCatalog } from "../providers/model-catalog.js";
import { buildActorBwrapArgs } from "../providers/sandbox.js";
import type { CodingProvider } from "../providers/types.js";
import { QuotaCoordinatorClient } from "../quota/coordinator-client.js";
import {
  COORDINATOR_PROTOCOL_MAJOR,
  COORDINATOR_PROTOCOL_MINOR,
} from "../quota/coordinator-protocol.js";
import {
  createQuotaMcpServer,
  inferQuotaState,
  type ProviderQuotaSnapshot,
  parseAgyQuota,
  parseClaudeQuota,
  parseCodexQuota,
  parseKimiQuota,
  QuotaService,
} from "./quota-mcp.js";

async function connect(server: McpServer): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientTransport);
  return client;
}

function textOf(result: CallToolResult): string {
  const first = result.content[0];
  return first && first.type === "text" ? first.text : "";
}

describe("quota MCP server", () => {
  describe("parseClaudeQuota (no geminiApiKey)", () => {
    it("returns honest unknown status when key is absent", async () => {
      const output = "Claude Code subscription status output...";
      const parsed = await parseClaudeQuota(output);
      expect(parsed.status).toBe("unknown");
      expect(parsed.message).toBe("no geminiApiKey configured for LLM quota parsing");
    });
  });

  describe("parseCodexQuota (no geminiApiKey)", () => {
    it("returns honest unknown status when key is absent", async () => {
      const output = "Codex status output...";
      const parsed = await parseCodexQuota(output);
      expect(parsed.status).toBe("unknown");
      expect(parsed.message).toBe("no geminiApiKey configured for LLM quota parsing");
    });
  });

  describe("LLM-based parsing with geminiApiKey", () => {
    beforeEach(() => {
      mockGenerateContent.mockReset();
    });

    function lastSystemInstruction(): string {
      return (
        mockGenerateContent.mock.calls[0][0] as {
          config: { systemInstruction: string };
        }
      ).config.systemInstruction;
    }

    it("parses Claude quota using LLM successfully", async () => {
      const output = "Claude output here";
      mockGenerateContent.mockResolvedValue({
        text: () =>
          JSON.stringify({
            status: "available",
            windows: [
              {
                label: "Weekly",
                kind: "weekly",
                usedPercent: 45,
                resetAtIso: "2026-07-13T02:59:00.000Z",
              },
            ],
          }),
      });

      const parsed = await parseClaudeQuota(output, "test-key");
      expect(parsed.status).toBe("available");
      expect(parsed.limits).toEqual([
        {
          label: "Weekly",
          kind: "weekly",
          percentLeft: 55,
          resetAtIso: "2026-07-13T02:59:00.000Z",
          scope: { provider: "claude" },
        },
      ]);

      expect(mockGenerateContent).toHaveBeenCalled();
      const lastCallArgs = mockGenerateContent.mock.calls[0][0] as {
        model: string;
        contents: string;
        config: {
          temperature: number;
          responseSchema: {
            properties: Record<string, unknown>;
          };
        };
      };
      expect(lastCallArgs.model).toBe("gemini-3.5-flash-lite");
      expect(lastCallArgs.config.temperature).toBe(0);
      expect(lastCallArgs.contents).toContain("Claude output here");
      expect(lastCallArgs.config.responseSchema.properties.windows).toBeDefined();
    });

    it("scopes the Claude LLM prompt to the Claude quota clause", async () => {
      mockGenerateContent.mockResolvedValue({
        text: () => JSON.stringify({ status: "available", windows: [] }),
      });

      await parseClaudeQuota("Claude output here", "test-key");

      const systemInstruction = lastSystemInstruction();
      expect(systemInstruction).toContain("You are a precise quota parser");
      expect(systemInstruction).toContain("preserve all printed decimal precision");
      expect(systemInstruction).toContain("For Claude:");
      expect(systemInstruction).toContain("session/week usage windows");
      expect(systemInstruction).toContain("every window carries scope='provider'");
      expect(systemInstruction).toContain("Current Week (Fable)");
      expect(systemInstruction).toContain("The current local time");
      expect(systemInstruction).toContain("RESET CONTRACT: every non-placeholder window");
      expect(systemInstruction).toContain("exactly one of resetAtIso");
      expect(systemInstruction).not.toContain("For Codex:");
      expect(systemInstruction).not.toContain("For agy:");
      expect(systemInstruction).not.toContain("refresh requested");
      expect(systemInstruction).not.toContain("reports quota REMAINING");
    });

    it("parses Codex exhausted quota from golden error string successfully using LLM", async () => {
      const goldenFixture =
        "ERROR: You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Jul 7th, 2026 12:25 PM.";
      mockGenerateContent.mockResolvedValue({
        text: () =>
          JSON.stringify({
            status: "exhausted",
            windows: [
              {
                label: "Weekly",
                kind: "weekly",
                usedPercent: 100,
                resetAtIso: "2026-07-07T12:25:00.000Z",
              },
            ],
          }),
      });

      const parsed = await parseCodexQuota(goldenFixture, "test-key");
      expect(parsed.status).toBe("exhausted");
      expect(parsed.limits?.[0]).toMatchObject({
        label: "Weekly",
        kind: "weekly",
        percentLeft: 0,
        resetAtIso: "2026-07-07T12:25:00.000Z",
      });
    });

    it("scopes the Codex LLM prompt to the Codex quota clause, incl. the issue #8 placeholder contract", async () => {
      mockGenerateContent.mockResolvedValue({
        text: () => JSON.stringify({ status: "unknown", windows: [] }),
      });

      await parseCodexQuota("Limits: refresh requested; run /status again shortly.", "test-key");

      // The placeholder contract from issue #8 lives in the assembled prompt (there
      // is no separate exported constant to assert against): the guidance is only
      // meaningful if it is actually wired into the systemInstruction sent to Gemini.
      const systemInstruction = lastSystemInstruction();
      expect(systemInstruction).toContain("You are a precise quota parser");
      expect(systemInstruction).toContain("GROUNDING REQUIREMENT");
      expect(systemInstruction).toContain("For Codex:");
      expect(systemInstruction).toContain("refresh requested");
      expect(systemInstruction).toContain("run /status again shortly");
      // Placeholder contract: named as a known pending state, classified as
      // unknown/windows=[], and never fabricated, failed, or turned into an
      // invented window.
      expect(systemInstruction).toContain("NOT a reading and NOT a parse error");
      expect(systemInstruction).toContain("return status='unknown' and windows=[]");
      expect(systemInstruction).toContain("do NOT guess a number");
      expect(systemInstruction).toContain("do NOT fail the parse");
      expect(systemInstruction).toContain("do NOT emit an invented window");
      expect(systemInstruction).toContain("every window carries scope='provider'");
      expect(systemInstruction).toContain("gpt-reserve Weekly limit");
      expect(systemInstruction).toContain("beneath a standalone '<model name> limit:' heading");
      expect(systemInstruction).toContain("use the latest such panel");
      expect(systemInstruction).toContain("resets 02:10 on 27 Aug");
      expect(systemInstruction).toContain("15:11 on 1 Sep");
      expect(systemInstruction).toContain("The current local time");
      expect(systemInstruction).not.toContain("For Claude:");
      expect(systemInstruction).not.toContain("For agy:");
      expect(systemInstruction).not.toContain("session/week usage windows");
      expect(systemInstruction).not.toContain("reports quota REMAINING");
    });

    it("parses Codex exhausted status from newly banked /status raw TUI fixture file successfully using LLM", async () => {
      const fixturePath = join(__dirname, "fixtures", "codex-status-exhausted.txt");
      const content = readFileSync(fixturePath, "utf-8");

      mockGenerateContent.mockResolvedValue({
        text: () =>
          JSON.stringify({
            status: "exhausted",
            windows: [
              {
                label: "Weekly",
                kind: "weekly",
                usedPercent: 100,
                resetAtIso: "2026-07-07T12:25:00.000Z",
              },
            ],
          }),
      });

      const parsed = await parseCodexQuota(content, "test-key");
      expect(parsed.status).toBe("exhausted");
      expect(parsed.limits?.[0]).toMatchObject({
        label: "Weekly",
        kind: "weekly",
        percentLeft: 0,
        resetAtIso: "2026-07-07T12:25:00.000Z",
      });
    });

    it("gracefully falls back to unknown when LLM parse fails", async () => {
      const goldenFixture = "ERROR: You've hit your usage limit...";
      mockGenerateContent.mockRejectedValue(new Error("Service unavailable"));

      const parsed = await parseCodexQuota(goldenFixture, "test-key");
      expect(parsed.status).toBe("unknown");
      expect(parsed.message).toContain("LLM quota parsing failed");
    });

    it("keeps every required response-schema key defined in properties (Gemini rejects the request otherwise)", async () => {
      // Regression guard: Gemini validates required ⊆ properties and 400s the
      // whole request ("property is not defined") when a required key is
      // missing from properties — which previously made every provider's LLM
      // parse fail with "LLM quota parsing failed".
      for (const parse of [parseClaudeQuota, parseCodexQuota, parseAgyQuota, parseKimiQuota]) {
        mockGenerateContent.mockReset();
        mockGenerateContent.mockResolvedValue({
          text: () => JSON.stringify({ status: "unknown", windows: [] }),
        });

        await parse("some quota output", "test-key");

        const lastCallArgs = mockGenerateContent.mock.calls[0][0] as {
          config: {
            responseSchema: {
              properties: Record<string, unknown>;
              required: string[];
            };
          };
        };
        const { properties, required } = lastCallArgs.config.responseSchema;
        for (const key of required) {
          expect(properties).toHaveProperty(key);
        }
        expect(required).toEqual(["status", "windows"]);
        expect(properties.status).toBeDefined();
        expect(properties.windows).toBeDefined();
      }
    });

    it("maps per-window claude/codex readings into `limits`, dropping placeholder windows", async () => {
      mockGenerateContent.mockResolvedValue({
        text: () =>
          JSON.stringify({
            status: "unknown",
            windows: [
              { label: "5h", kind: "five_hour", placeholder: true },
              {
                label: "Weekly",
                kind: "weekly",
                usedPercent: 7,
                resetAtIso: "2026-07-14T12:34:00.000Z",
              },
            ],
          }),
      });

      const parsed = await parseCodexQuota(
        "Limits: refresh requested; run /status again shortly.",
        "test-key"
      );
      expect(parsed.status).toBe("unknown");
      // The placeholder window (no number yet) is never fabricated into a limit row —
      // only the real Weekly reading survives (ISSUE_NUM coordination point).
      expect(parsed.limits).toEqual([
        {
          label: "Weekly",
          kind: "weekly",
          percentLeft: 93,
          resetAtIso: "2026-07-14T12:34:00.000Z",
          scope: { provider: "codex" },
        },
      ]);
    });

    it("retries and fails closed when a provider row is malformed beside a valid weekly row", async () => {
      // The 5h row is a provider reading, not an explicit placeholder or model
      // allocation. Its missing usedPercent must reject the whole snapshot rather
      // than silently preserving the Weekly row.
      const incompleteSnapshot = {
        status: "available",
        windows: [
          { label: "5h", kind: "five_hour", placeholder: false, scope: "provider" },
          {
            label: "Weekly",
            kind: "weekly",
            placeholder: false,
            scope: "provider",
            usedPercent: 42,
            resetAtIso: "2026-09-14T00:00:00.000Z",
          },
        ],
      };
      mockGenerateContent.mockResolvedValue({ text: () => JSON.stringify(incompleteSnapshot) });

      const parsed = await parseCodexQuota("synthetic incomplete provider panel", "test-key");

      expect(mockGenerateContent).toHaveBeenCalledTimes(2);
      expect(parsed.status).toBe("unknown");
      expect(parsed.limits).toBeUndefined();
      expect(parsed.message).toContain("invalid usedPercent");
    });

    it("retries a malformed provider snapshot and accepts a complete 5h and weekly replacement", async () => {
      mockGenerateContent
        .mockResolvedValueOnce({
          text: () =>
            JSON.stringify({
              status: "available",
              windows: [
                { label: "5h", kind: "five_hour", scope: "provider" },
                {
                  label: "Weekly",
                  kind: "weekly",
                  scope: "provider",
                  usedPercent: 42,
                  resetAtIso: "2026-09-14T00:00:00.000Z",
                },
              ],
            }),
        })
        .mockResolvedValueOnce({
          text: () =>
            JSON.stringify({
              status: "available",
              windows: [
                {
                  label: "5h",
                  kind: "five_hour",
                  scope: "provider",
                  usedPercent: 10,
                  resetAtIso: "2026-09-08T00:00:00.000Z",
                },
                {
                  label: "Weekly",
                  kind: "weekly",
                  scope: "provider",
                  usedPercent: 42,
                  resetAtIso: "2026-09-14T00:00:00.000Z",
                },
              ],
            }),
        });

      const parsed = await parseCodexQuota("synthetic provider panel", "test-key");

      expect(mockGenerateContent).toHaveBeenCalledTimes(2);
      expect(parsed).toMatchObject({ status: "available" });
      expect(parsed.limits).toEqual([
        {
          label: "5h",
          kind: "five_hour",
          percentLeft: 90,
          resetAtIso: "2026-09-08T00:00:00.000Z",
          scope: { provider: "codex" },
        },
        {
          label: "Weekly",
          kind: "weekly",
          percentLeft: 58,
          resetAtIso: "2026-09-14T00:00:00.000Z",
          scope: { provider: "codex" },
        },
      ]);
    });

    it("derives exhausted status from a validated exhausted provider window", async () => {
      mockGenerateContent.mockResolvedValue({
        text: () =>
          JSON.stringify({
            status: "available",
            windows: [
              {
                label: "Weekly",
                kind: "weekly",
                scope: "provider",
                usedPercent: 100,
                resetAtIso: "2026-09-14T00:00:00.000Z",
              },
            ],
          }),
      });

      const parsed = await parseCodexQuota("synthetic exhausted provider panel", "test-key");

      expect(mockGenerateContent).toHaveBeenCalledTimes(1);
      expect(parsed.status).toBe("exhausted");
      expect(parsed.limits).toHaveLength(1);
    });

    it("retries and fails closed when exhausted model status conflicts with available windows", async () => {
      mockGenerateContent.mockResolvedValue({
        text: () =>
          JSON.stringify({
            status: "exhausted",
            windows: [
              {
                label: "Weekly",
                kind: "weekly",
                scope: "provider",
                usedPercent: 0,
                resetAtIso: "2026-09-14T00:00:00.000Z",
              },
            ],
          }),
      });

      const parsed = await parseCodexQuota("synthetic conflicting provider panel", "test-key");

      expect(mockGenerateContent).toHaveBeenCalledTimes(2);
      expect(parsed.status).toBe("unknown");
      expect(parsed.limits).toBeUndefined();
      expect(parsed.message).toContain("status 'exhausted' disagrees");
    });

    it("keeps an explicit empty-window reading unknown", async () => {
      mockGenerateContent.mockResolvedValue({
        text: () => JSON.stringify({ status: "unknown", windows: [] }),
      });

      const parsed = await parseCodexQuota("synthetic refresh placeholder", "test-key");

      expect(mockGenerateContent).toHaveBeenCalledTimes(1);
      expect(parsed).toEqual({ status: "unknown", limits: [] });
    });

    it("derives exhausted status when an exhausted window accompanies an unknown summary", async () => {
      mockGenerateContent.mockResolvedValue({
        text: () =>
          JSON.stringify({
            status: "unknown",
            windows: [
              {
                label: "Weekly",
                kind: "weekly",
                scope: "provider",
                usedPercent: 100,
                resetAtIso: "2026-09-14T00:00:00.000Z",
              },
            ],
          }),
      });

      const parsed = await parseCodexQuota(
        "synthetic exhausted window with unknown summary",
        "test-key"
      );

      expect(mockGenerateContent).toHaveBeenCalledTimes(1);
      expect(parsed.status).toBe("exhausted");
      expect(parsed.limits).toHaveLength(1);
    });

    it("preserves status exhausted when an exhausted summary has no limits", async () => {
      mockGenerateContent.mockResolvedValue({
        text: () => JSON.stringify({ status: "exhausted", windows: [] }),
      });

      const parsed = await parseCodexQuota("synthetic empty exhausted panel", "test-key");

      expect(mockGenerateContent).toHaveBeenCalledTimes(1);
      expect(parsed).toEqual({ status: "exhausted", limits: [] });
    });

    it("keys the mapped limit's kind off the LLM's classification, not the label wording ", async () => {
      // Reproduces ISSUE_NUM: the LLM's label wording for claude's session window
      // varies run to run ("Session" vs "Current session"), which used to
      // break the dashboard's fixed-id ring lookup when the DTO derived the
      // id from that label. This proves the LLM's own `kind` survives the
      // parse into `limits[].kind` regardless of the label text.
      mockGenerateContent.mockResolvedValue({
        text: () =>
          JSON.stringify({
            status: "available",
            windows: [
              {
                label: "Current session",
                kind: "session",
                usedPercent: 0,
              },
              {
                label: "Weekly",
                kind: "weekly",
                usedPercent: 3,
                resetAtIso: "2026-07-13T02:59:00.000Z",
              },
            ],
          }),
      });

      const parsed = await parseClaudeQuota("Claude output here", "test-key");
      expect(parsed.limits?.[0]).toMatchObject({ label: "Current session", kind: "session" });
      expect(parsed.limits?.[1]).toMatchObject({ label: "Weekly", kind: "weekly" });
    });

    it("fails closed on an unrecognized LLM window kind", async () => {
      mockGenerateContent.mockResolvedValue({
        text: () =>
          JSON.stringify({
            status: "available",
            windows: [{ label: "Mystery Window", kind: "bogus", usedPercent: 0 }],
          }),
      });

      const parsed = await parseClaudeQuota("Claude output here", "test-key");
      expect(parsed.status).toBe("unknown");
      expect(parsed.message).toContain("invalid kind");
    });

    it("exposes resetInIso on the LLM per-window schema for relative reset durations", async () => {
      mockGenerateContent.mockResolvedValue({
        text: () => JSON.stringify({ status: "unknown", windows: [] }),
      });

      await parseCodexQuota("Weekly: 7% used, resets 70h 13m", "test-key");

      const lastCallArgs = mockGenerateContent.mock.calls[0][0] as {
        config: {
          responseSchema: {
            properties: {
              windows: {
                items: {
                  properties: Record<string, unknown>;
                };
              };
            };
          };
        };
      };
      expect(
        lastCallArgs.config.responseSchema.properties.windows.items.properties.resetInIso
      ).toBeDefined();
    });

    it("requires the LLM to classify each window's kind, not just its label ", async () => {
      mockGenerateContent.mockResolvedValue({
        text: () => JSON.stringify({ status: "unknown", windows: [] }),
      });

      await parseCodexQuota("Weekly: 7% used, resets 70h 13m", "test-key");

      const lastCallArgs = mockGenerateContent.mock.calls[0][0] as {
        config: {
          responseSchema: {
            properties: {
              windows: {
                items: {
                  properties: Record<string, { enum?: string[] }>;
                  required: string[];
                };
              };
            };
          };
        };
      };
      const windowSchema = lastCallArgs.config.responseSchema.properties.windows.items;
      expect(windowSchema.properties.kind?.enum).toEqual([
        "session",
        "five_hour",
        "weekly",
        "other",
      ]);
      expect(windowSchema.required).toContain("kind");
    });

    it("accepts only provider-scoped windows in the LLM response schema ", async () => {
      mockGenerateContent.mockResolvedValue({
        text: () => JSON.stringify({ status: "unknown", windows: [] }),
      });

      await parseCodexQuota("Weekly: 7% used, resets 70h 13m", "test-key");

      const lastCallArgs = mockGenerateContent.mock.calls[0][0] as {
        config: {
          responseSchema: {
            properties: {
              windows: {
                items: {
                  properties: Record<string, { enum?: string[] }>;
                  required: string[];
                };
              };
            };
          };
        };
      };
      const windowSchema = lastCallArgs.config.responseSchema.properties.windows.items;
      expect(windowSchema.properties.scope?.enum).toEqual(["provider"]);
      expect(windowSchema.required).toContain("scope");
    });

    it("drops empty model allocations for every provider", async () => {
      for (const parse of [parseClaudeQuota, parseCodexQuota, parseAgyQuota, parseKimiQuota]) {
        mockGenerateContent.mockReset();
        mockGenerateContent.mockResolvedValue({
          text: () =>
            JSON.stringify({
              status: "available",
              windows: [
                {
                  label: "Weekly",
                  kind: "weekly",
                  usedPercent: 0,
                  scope: "provider",
                },
                {
                  label: "Named model weekly",
                  kind: "weekly",
                  usedPercent: 0,
                  scope: "provider",
                  models: [],
                },
              ],
            }),
        });

        const parsed = await parse("quota output", "test-key");
        expect(parsed.limits).toEqual([
          {
            label: "Weekly",
            kind: "weekly",
            percentLeft: 100,
            resetAtIso: undefined,
            scope: expect.objectContaining({ provider: expect.any(String) }),
          },
        ]);
      }
    });

    it("keeps a configured named-model window beside provider evidence with canonical IDs", async () => {
      mockGenerateContent.mockResolvedValue({
        text: () =>
          JSON.stringify({
            status: "available",
            windows: [
              {
                label: "Current Week",
                kind: "weekly",
                usedPercent: 20,
                resetAtIso: "2026-08-27T10:00:00.000Z",
              },
              {
                label: "Current Week (Fable)",
                kind: "weekly",
                usedPercent: 30,
                resetAtIso: "2026-08-27T10:00:00.000Z",
                models: ["FABLE", "claude-fable", "unknown-model"],
              },
            ],
          }),
      });

      const parsed = await parseClaudeQuota("Claude quota", "test-key", Date.now(), [
        { identifier: "claude-fable", displayLabel: "Fable", passable: true },
        { identifier: "claude-sonnet", displayLabel: "Sonnet", passable: true },
      ]);

      expect(parsed.limits?.map((limit) => limit.scope)).toEqual([
        { provider: "claude" },
        { provider: "claude", models: ["claude-fable"] },
      ]);
    });

    it("passes an incomplete configured model window to inference without losing provider evidence", async () => {
      const resetAtIso = "2026-08-27T10:00:00.000Z";
      mockGenerateContent.mockResolvedValue({
        text: () =>
          JSON.stringify({
            status: "available",
            windows: [
              {
                label: "Current Week",
                kind: "weekly",
                usedPercent: 20,
                resetAtIso,
              },
              {
                label: "Current Week (Fable)",
                kind: "weekly",
                usedPercent: 30,
                models: ["Fable"],
              },
            ],
          }),
      });

      const parsed = await parseClaudeQuota("Claude quota", "test-key", Date.now(), [
        { identifier: "claude-fable", displayLabel: "Fable", passable: true },
      ]);
      expect(parsed.status).toBe("available");
      expect(parsed.limits).toEqual([
        expect.objectContaining({
          label: "Current Week",
          resetAtIso,
          scope: { provider: "claude" },
        }),
        expect.objectContaining({
          label: "Current Week (Fable)",
          resetAtIso: undefined,
          scope: { provider: "claude", models: ["claude-fable"] },
        }),
      ]);

      if (parsed.status !== "available" || !parsed.limits) {
        throw new Error("expected parsed provider and model windows");
      }

      const inferred = inferQuotaState({
        provider: "claude",
        scrapedAt: "2026-08-20T10:00:00.000Z",
        status: parsed.status,
        limits: parsed.limits,
      });
      expect(inferred.limits?.[1]?.resetAtIso).toBe(resetAtIso);
      expect(inferred.explanations).toContainEqual({
        window: "Current Week (Fable)",
        field: "resetAtIso",
        rule: "sibling_window_copy",
        detail: "copied from the provider-scope weekly in the same scrape",
      });
    });

    it("discards an unresolved configured model window without losing provider evidence", async () => {
      const resetAtIso = "2026-08-27T10:00:00.000Z";
      mockGenerateContent.mockResolvedValue({
        text: () =>
          JSON.stringify({
            status: "available",
            windows: [
              {
                label: "Current Week",
                kind: "weekly",
                usedPercent: 20,
                resetAtIso,
              },
              {
                label: "Session (Fable)",
                kind: "session",
                usedPercent: 30,
                models: ["Fable"],
              },
            ],
          }),
      });

      const parsed = await parseClaudeQuota("Claude quota", "test-key", Date.now(), [
        { identifier: "claude-fable", displayLabel: "Fable", passable: true },
      ]);
      if (parsed.status !== "available" || !parsed.limits) {
        throw new Error("expected parsed provider and model windows");
      }

      const inferred = inferQuotaState({
        provider: "claude",
        scrapedAt: "2026-08-20T10:00:00.000Z",
        status: parsed.status,
        limits: parsed.limits,
      });
      expect(inferred).toMatchObject({ status: "available" });
      expect(inferred.limits).toEqual([
        expect.objectContaining({
          label: "Current Week",
          resetAtIso,
          scope: { provider: "claude" },
        }),
      ]);
    });

    it("drops unconfigured reserve/model labels and retains provider-wide evidence", async () => {
      mockGenerateContent.mockResolvedValue({
        text: () =>
          JSON.stringify({
            status: "available",
            windows: [
              {
                label: "Weekly limit",
                kind: "weekly",
                usedPercent: 42,
                resetAtIso: "2026-08-27T10:00:00.000Z",
              },
              {
                label: "gpt-reserve Weekly limit",
                kind: "weekly",
                usedPercent: 0,
                resetAtIso: "2026-08-27T10:00:00.000Z",
                models: ["gpt-reserve"],
              },
            ],
          }),
      });

      const parsed = await parseCodexQuota("Codex quota", "test-key", Date.now(), []);
      expect(parsed.status).toBe("available");
      expect(parsed.limits).toEqual([
        expect.objectContaining({ label: "Weekly limit", scope: { provider: "codex" } }),
      ]);
    });

    it("drops an explicitly empty model scope instead of relabelling it provider-wide", async () => {
      mockGenerateContent.mockResolvedValue({
        text: () =>
          JSON.stringify({
            status: "available",
            windows: [
              {
                label: "Weekly limit",
                kind: "weekly",
                usedPercent: 42,
                resetAtIso: "2026-08-27T10:00:00.000Z",
              },
              {
                label: "Unnamed reserve",
                kind: "weekly",
                usedPercent: 0,
                resetAtIso: "2026-08-27T10:00:00.000Z",
                models: [],
              },
            ],
          }),
      });

      const parsed = await parseCodexQuota("Codex quota", "test-key", Date.now(), []);
      expect(parsed.limits).toEqual([
        expect.objectContaining({ label: "Weekly limit", scope: { provider: "codex" } }),
      ]);
    });

    it("resolves LLM-extracted ISO durations for relative reset dialects", async () => {
      const generatedAt = new Date("2026-07-12T10:00:00.000Z");
      vi.useFakeTimers();
      vi.setSystemTime(generatedAt);
      try {
        const cases = [
          {
            raw: "Weekly: 7% used, resets 70h 13m",
            resetInIso: "PT70H13M",
            durationMs: (70 * 60 + 13) * 60_000,
          },
          {
            raw: "5h: 1% used, resets 3h 10m",
            resetInIso: "PT3H10M",
            durationMs: (3 * 60 + 10) * 60_000,
          },
          {
            raw: "Weekly: 100% used, resets 2 days, 22 hours",
            resetInIso: "P2DT22H",
            durationMs: (2 * 24 + 22) * 3_600_000,
          },
        ];

        for (const c of cases) {
          mockGenerateContent.mockReset();
          mockGenerateContent.mockResolvedValue({
            text: () =>
              JSON.stringify({
                status: "unknown",
                windows: [
                  { label: "Weekly", kind: "weekly", usedPercent: 7, resetInIso: c.resetInIso },
                ],
              }),
          });

          const parsed = await parseCodexQuota(c.raw, "test-key");
          const expected = new Date(generatedAt.getTime() + c.durationMs).toISOString();
          expect(parsed.limits).toEqual([
            {
              label: "Weekly",
              kind: "weekly",
              percentLeft: 93,
              resetAtIso: expected,
              scope: { provider: "codex" },
            },
          ]);
        }
      } finally {
        vi.useRealTimers();
      }
    });

    it("parses agy quota using provider-scoped top-level windows", async () => {
      const generatedAt = new Date("2026-07-12T10:00:00.000Z");
      vi.useFakeTimers();
      vi.setSystemTime(generatedAt);
      try {
        mockGenerateContent.mockResolvedValue({
          text: () =>
            JSON.stringify({
              status: "exhausted",
              windows: [
                {
                  label: "Weekly GEMINI MODELS",
                  kind: "weekly",
                  usedPercent: 100,
                  resetInIso: "PT70H13M",
                  scope: "provider",
                },
              ],
            }),
        });

        const parsed = await parseAgyQuota("agy usage output here", "test-key");
        expect(parsed.status).toBe("exhausted");
        expect(parsed).not.toHaveProperty("groups");

        expect(parsed.limits).toEqual([
          {
            label: "Weekly GEMINI MODELS",
            kind: "weekly",
            percentLeft: 0,
            resetAtIso: new Date(generatedAt.getTime() + (70 * 60 + 13) * 60_000).toISOString(),
            scope: { provider: "agy" },
          },
        ]);

        const lastCallArgs = mockGenerateContent.mock.calls[0][0] as {
          model: string;
          config: { responseSchema: { properties: Record<string, unknown> } };
        };
        expect(lastCallArgs.model).toBe("gemini-3.5-flash-lite");
        expect(lastCallArgs.config.responseSchema.properties.groups).toBeUndefined();
        expect(lastCallArgs.config.responseSchema.properties.windows).toBeDefined();
      } finally {
        vi.useRealTimers();
      }
    });

    it("parses agy quota fail-closed when an available response has no provider windows", async () => {
      mockGenerateContent.mockResolvedValue({
        text: () =>
          JSON.stringify({
            status: "available",
          }),
      });
      const parsed = await parseAgyQuota("agy usage output here", "test-key");
      expect(parsed.status).toBe("unknown");
      expect(parsed.limits).toBeUndefined();
    });

    it("scopes the agy LLM prompt to the agy quota clause", async () => {
      mockGenerateContent.mockResolvedValue({
        text: () => JSON.stringify({ status: "available", windows: [] }),
      });

      await parseAgyQuota("agy usage output here", "test-key");

      const systemInstruction = lastSystemInstruction();
      expect(systemInstruction).toContain("You are a precise quota parser");
      expect(systemInstruction).toContain("every window carries scope='provider'");
      expect(systemInstruction).toContain("For agy:");
      expect(systemInstruction).toContain("reports quota REMAINING");
      expect(systemInstruction).toContain("Use the more precise printed percentage");
      expect(systemInstruction).toContain("usedPercent = 100 - N");
      expect(systemInstruction).toContain(
        "Every other named model or model-group section is model-specific"
      );
      expect(systemInstruction).toContain("The current local time");
      expect(systemInstruction).not.toContain("For Claude:");
      expect(systemInstruction).not.toContain("For Codex:");
      expect(systemInstruction).not.toContain("session/week usage windows");
      expect(systemInstruction).not.toContain("refresh requested");
    });

    it("relies on the LLM omitting non-GEMINI sections instead of filtering labels", async () => {
      mockGenerateContent.mockResolvedValue({
        text: () =>
          JSON.stringify({
            status: "available",
            windows: [
              {
                label: "Weekly Limit",
                kind: "weekly",
                usedPercent: 20,
                resetInIso: "PT70H13M",
                scope: "provider",
              },
            ],
          }),
      });

      const parsed = await parseAgyQuota("agy usage output here", "test-key");

      expect(parsed.status).toBe("available");
      expect(parsed.limits).toEqual([
        expect.objectContaining({ label: "Weekly Limit", scope: { provider: "agy" } }),
      ]);

      const systemInstruction = lastSystemInstruction();
      expect(systemInstruction).toContain(
        "Every other named model or model-group section is model-specific"
      );
    });

    it("scopes the Kimi LLM prompt to Kimi /usage and remaining-percent semantics", async () => {
      mockGenerateContent.mockResolvedValue({
        text: () => JSON.stringify({ status: "available", windows: [] }),
      });

      await parseKimiQuota("Kimi Code Platform Usage\nWeekly limit 50% left", "test-key");

      const systemInstruction = lastSystemInstruction();
      expect(systemInstruction).toContain("You are a precise quota parser");
      expect(systemInstruction).toContain("every window carries scope='provider'");
      expect(systemInstruction).toContain("For Kimi:");
      expect(systemInstruction).toContain("interactive /usage panel");
      expect(systemInstruction).toContain("either 'N% used' or 'N% left/remaining'");
      expect(systemInstruction).toContain("usedPercent = 100 - N");
      expect(systemInstruction).toContain(
        "Every named-model or model-group limit is model-specific"
      );
      expect(systemInstruction).toContain("The current local time");
      expect(systemInstruction).not.toContain("For Claude:");
      expect(systemInstruction).not.toContain("For Codex:");
      expect(systemInstruction).not.toContain("For agy:");
    });

    it("requires normalized window `kind` in the LLM response schema ", async () => {
      mockGenerateContent.mockResolvedValue({
        text: () => JSON.stringify({ status: "available", windows: [] }),
      });

      await parseKimiQuota("Kimi Code Platform Usage\nWeekly limit 50% left", "test-key");

      const lastCallArgs = mockGenerateContent.mock.calls[0][0] as {
        config: {
          responseSchema: {
            properties: {
              windows: {
                items: {
                  properties: Record<string, unknown>;
                  required: string[];
                };
              };
            };
          };
        };
      };
      expect(lastCallArgs.config.responseSchema.properties.windows.items.properties.kind).toEqual({
        type: "STRING",
        enum: ["session", "five_hour", "weekly", "other"],
        description: expect.stringContaining("Classify this window by MEANING"),
      });
      expect(lastCallArgs.config.responseSchema.properties.windows.items.required).toContain(
        "kind"
      );
    });

    it("maps Kimi remaining percentages into used-percent limits using the LLM kind enum", async () => {
      const generatedAt = new Date("2026-07-12T10:00:00.000Z");
      vi.useFakeTimers();
      vi.setSystemTime(generatedAt);
      try {
        const fixture = readFileSync(
          join(__dirname, "fixtures", "kimi-usage-expected.txt"),
          "utf-8"
        );
        mockGenerateContent.mockResolvedValue({
          text: () =>
            JSON.stringify({
              status: "available",
              windows: [
                {
                  label: "5h",
                  kind: "five_hour",
                  usedPercent: 28,
                  resetInIso: "PT3H10M",
                },
                {
                  label: "Weekly",
                  kind: "weekly",
                  usedPercent: 50,
                  resetInIso: "P2DT22H",
                },
              ],
            }),
        });

        const parsed = await parseKimiQuota(fixture, "test-key");
        expect(parsed.status).toBe("available");
        expect(parsed.limits).toEqual([
          {
            label: "5h",
            kind: "five_hour",
            percentLeft: 72,
            resetAtIso: new Date(generatedAt.getTime() + (3 * 60 + 10) * 60_000).toISOString(),
            scope: { provider: "kimi" },
          },
          {
            label: "Weekly",
            kind: "weekly",
            percentLeft: 50,
            resetAtIso: new Date(generatedAt.getTime() + (2 * 24 + 22) * 3_600_000).toISOString(),
            scope: { provider: "kimi" },
          },
        ]);
      } finally {
        vi.useRealTimers();
      }
    });

    it("instructs the LLM that agy reports REMAINING quota (guards the ISSUE_NUM inversion regression)", async () => {
      mockGenerateContent.mockResolvedValue({
        text: () => JSON.stringify({ status: "available", windows: [] }),
      });

      await parseAgyQuota("agy usage output here", "test-key");

      const systemInstruction = lastSystemInstruction();
      // ISSUE_NUM: agy's TUI prints "N% remaining" — the inverse of Claude/Codex's "used".
      // The shared `percentLeft = 100 - usedPercent` mapping is only correct if the
      // parser is told to convert remaining→used, so this anchor MUST survive.
      expect(systemInstruction).toContain("REMAINING");
      expect(systemInstruction).toContain("usedPercent = 100 - N");
      // The full-window "Quota available" case must map to usedPercent 0, not be
      // misread as 100% used — anchor the instruction so it can't silently drop.
      expect(systemInstruction).toContain("Quota available");
      expect(systemInstruction).toContain("usedPercent 0");
    });

    it("maps a near-exhausted agy weekly ('3% remaining' → used 97) to percentLeft 3, not 97 ", async () => {
      // A correctly-instructed LLM converts the TUI's "3% remaining" to usedPercent 97;
      // the mapping must then report percentLeft 3 (near-dead), never 97 (near-full).
      mockGenerateContent.mockResolvedValue({
        text: () =>
          JSON.stringify({
            status: "available",
            windows: [
              {
                label: "Weekly",
                kind: "weekly",
                usedPercent: 97,
                resetInIso: "PT70H",
                scope: "provider",
              },
            ],
          }),
      });

      const parsed = await parseAgyQuota("GEMINI MODELS Weekly 3% remaining", "test-key");
      const weekly = parsed.limits?.[0];
      expect(weekly?.percentLeft).toBe(3);
      expect(weekly?.scope).toEqual({ provider: "agy" });
    });

    it("fail-loud gate: fails loud with unknown status and error message when window has percentLeft < 100 and no reset ISO ", async () => {
      mockGenerateContent.mockResolvedValue({
        text: () =>
          JSON.stringify({
            status: "available",
            windows: [{ label: "Weekly", kind: "weekly", usedPercent: 10 }],
          }),
      });

      const parsed = await parseCodexQuota("Weekly: 10% used, resets soon", "test-key");
      expect(parsed.status).toBe("unknown");
      expect(parsed.message).toContain("percentLeft < 100");
    });

    it("reset contract: a malformed resetInIso is a hard parse failure that escalates to the stronger model", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});

      mockGenerateContent
        .mockResolvedValueOnce({
          text: () =>
            JSON.stringify({
              status: "available",
              // Source text copied verbatim instead of an ISO-8601 duration.
              windows: [
                { label: "Weekly", kind: "weekly", usedPercent: 10, resetInIso: "70h 13m" },
              ],
            }),
        })
        .mockResolvedValueOnce({
          text: () =>
            JSON.stringify({
              status: "available",
              windows: [
                { label: "Weekly", kind: "weekly", usedPercent: 10, resetInIso: "PT70H13M" },
              ],
            }),
        });

      const generatedAtMs = Date.parse("2026-07-14T00:00:00.000Z");
      const parsed = await parseCodexQuota(
        "Weekly: 10% used (resets in 70h 13m)",
        "test-key",
        generatedAtMs
      );
      expect(mockGenerateContent).toHaveBeenCalledTimes(2);
      expect((mockGenerateContent.mock.calls[1][0] as { model: string }).model).toBe(
        "gemini-3.5-flash"
      );
      expect(parsed.status).toBe("available");
      expect(parsed.limits?.[0]?.resetAtIso).toBe("2026-07-16T22:13:00.000Z");
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          "attempt 1 (gemini-3.5-flash-lite) failed: Quota parse failed: window 'Weekly' has invalid reset duration '70h 13m'"
        )
      );

      warnSpy.mockRestore();
      infoSpy.mockRestore();
    });

    it("reset contract: a malformed resetInIso on a 100%-left window still fails instead of degrading to an assumed reset", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      mockGenerateContent.mockResolvedValue({
        text: () =>
          JSON.stringify({
            status: "available",
            windows: [{ label: "Weekly", kind: "weekly", usedPercent: 0, resetInIso: "next week" }],
          }),
      });

      const parsed = await parseCodexQuota("Weekly: 100% left (resets next week)", "test-key");
      expect(mockGenerateContent).toHaveBeenCalledTimes(2);
      expect(parsed.status).toBe("unknown");
      expect(parsed.message).toContain("invalid reset duration 'next week'");

      warnSpy.mockRestore();
      errorSpy.mockRestore();
    });

    it("drops a model-scoped window before validating provider reset times", async () => {
      mockGenerateContent.mockResolvedValue({
        text: () =>
          JSON.stringify({
            status: "available",
            windows: [
              {
                label: "Weekly",
                kind: "weekly",
                usedPercent: 40,
                resetAtIso: "2026-08-27T10:00:00.000Z",
                scope: "provider",
              },
              {
                label: "Sonnet (weekly)",
                kind: "weekly",
                usedPercent: 40,
                scope: "provider",
                models: [],
              },
            ],
          }),
      });

      const parsed = await parseClaudeQuota("Weekly: 40% used ... Sonnet: 40% used", "test-key");
      expect(parsed.status).toBe("available");
      expect(parsed.limits).toEqual([
        {
          label: "Weekly",
          kind: "weekly",
          percentLeft: 60,
          resetAtIso: "2026-08-27T10:00:00.000Z",
          scope: { provider: "claude" },
        },
      ]);
    });

    it("fails closed when the LLM returns only a model-scoped window", async () => {
      mockGenerateContent.mockResolvedValue({
        text: () =>
          JSON.stringify({
            status: "available",
            windows: [
              {
                label: "Sonnet (weekly)",
                kind: "weekly",
                usedPercent: 40,
                scope: "provider",
                models: [],
              },
            ],
          }),
      });

      const parsed = await parseClaudeQuota("Sonnet: 40% used", "test-key");
      expect(parsed.status).toBe("unknown");
      expect(parsed.message).toContain("no provider window was returned");
    });

    it("fail-loud gate: does NOT throw when window has percentLeft === 100 without reset ISO ", async () => {
      mockGenerateContent.mockResolvedValue({
        text: () =>
          JSON.stringify({
            status: "available",
            windows: [{ label: "Weekly", kind: "weekly", usedPercent: 0 }],
          }),
      });

      const parsed = await parseCodexQuota("Weekly: 0% used", "test-key");
      expect(parsed.status).toBe("available");
      expect(parsed.limits).toEqual([
        {
          label: "Weekly",
          kind: "weekly",
          percentLeft: 100,
          resetAtIso: undefined,
          scope: { provider: "codex" },
        },
      ]);
    });

    it("attempt-level logging: escalates gemini-3.5-flash-lite → gemini-3.5-flash on attempt 1 failure, logs warn then info on attempt 2 success ", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});

      mockGenerateContent
        .mockResolvedValueOnce({
          text: () =>
            JSON.stringify({
              status: "available",
              windows: [{ label: "Weekly", kind: "weekly", usedPercent: 10 }],
            }),
        })
        .mockResolvedValueOnce({
          text: () =>
            JSON.stringify({
              status: "available",
              windows: [
                {
                  label: "Weekly",
                  kind: "weekly",
                  usedPercent: 10,
                  resetAtIso: "2026-07-14T12:34:00.000Z",
                },
              ],
            }),
        });

      const parsed = await parseCodexQuota("Weekly: 10% used, resets soon", "test-key");
      expect(mockGenerateContent).toHaveBeenCalledTimes(2);
      expect((mockGenerateContent.mock.calls[0][0] as { model: string }).model).toBe(
        "gemini-3.5-flash-lite"
      );
      expect((mockGenerateContent.mock.calls[1][0] as { model: string }).model).toBe(
        "gemini-3.5-flash"
      );
      expect(parsed.status).toBe("available");
      expect(parsed.limits).toEqual([
        {
          label: "Weekly",
          kind: "weekly",
          percentLeft: 90,
          resetAtIso: "2026-07-14T12:34:00.000Z",
          scope: { provider: "codex" },
        },
      ]);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          "[quota-mcp] [codex] LLM quota parse attempt 1 (gemini-3.5-flash-lite) failed: Quota parse failed: window 'Weekly' has percentLeft < 100 (90%) but no resolvable reset ISO"
        )
      );
      expect(infoSpy).toHaveBeenCalledWith(
        "[quota-mcp] [codex] LLM quota parse attempt 2 (gemini-3.5-flash) succeeded"
      );

      warnSpy.mockRestore();
      infoSpy.mockRestore();
    });

    it("attempt-level logging: escalates gemini-3.5-flash-lite → gemini-3.5-flash on attempt 1 failure, logs warn then error when attempt 2 also fails ", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      mockGenerateContent.mockResolvedValue({
        text: () =>
          JSON.stringify({
            status: "available",
            windows: [{ label: "Weekly", kind: "weekly", usedPercent: 10 }],
          }),
      });

      const parsed = await parseCodexQuota("Weekly: 10% used, resets soon", "test-key");
      expect(mockGenerateContent).toHaveBeenCalledTimes(2);
      expect((mockGenerateContent.mock.calls[0][0] as { model: string }).model).toBe(
        "gemini-3.5-flash-lite"
      );
      expect((mockGenerateContent.mock.calls[1][0] as { model: string }).model).toBe(
        "gemini-3.5-flash"
      );
      expect(parsed.status).toBe("unknown");
      expect(parsed.message).toContain("percentLeft < 100");
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          "[quota-mcp] [codex] LLM quota parse attempt 1 (gemini-3.5-flash-lite) failed: Quota parse failed: window 'Weekly' has percentLeft < 100 (90%) but no resolvable reset ISO"
        )
      );
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          "[quota-mcp] [codex] LLM quota parse attempt 2 (gemini-3.5-flash) failed: Quota parse failed: window 'Weekly' has percentLeft < 100 (90%) but no resolvable reset ISO"
        )
      );

      warnSpy.mockRestore();
      errorSpy.mockRestore();
    });

    it("keeps only the provider window from a Codex panel containing named-model limits", async () => {
      // The provider has no 5h row in this valid panel. A named reserve precedes
      // its weekly row and a named-model section follows it; neither belongs in
      // the provider quota snapshot.
      mockGenerateContent.mockResolvedValue({
        text: () =>
          JSON.stringify({
            status: "available",
            windows: [
              {
                label: "gpt-reserve Weekly limit",
                kind: "weekly",
                usedPercent: 0,
                scope: "provider",
                models: [],
              },
              {
                label: "Weekly limit",
                kind: "weekly",
                usedPercent: 42,
                resetAtIso: "2026-09-07T18:08:00.000Z",
                scope: "provider",
              },
              {
                label: "5h limit",
                kind: "five_hour",
                usedPercent: 0,
                scope: "provider",
                models: [],
              },
              {
                label: "Weekly limit",
                kind: "weekly",
                usedPercent: 0,
                scope: "provider",
                models: [],
              },
            ],
          }),
      });

      const rawCodexOutput =
        "gpt-reserve Weekly limit:    [████████████████████] 100% left (resets 10:25 on 12 Sep)\n" +
        "Weekly limit:                [████████████░░░░░░░░] 58% left (resets 18:08 on 7 Sep)\n" +
        "GPT-5.3-Codex-Spark limit:\n" +
        "5h limit:                    [████████████████████] 100% left (resets 15:25)\n" +
        "Weekly limit:                [████████████████████] 100% left (resets 16:11 on 7 Sep)";

      const parsed = await parseCodexQuota(rawCodexOutput, "test-key");
      expect(mockGenerateContent).toHaveBeenCalledTimes(1);
      expect(parsed.status).toBe("available");
      expect(parsed.limits).toEqual([
        {
          label: "Weekly limit",
          kind: "weekly",
          percentLeft: 58,
          resetAtIso: "2026-09-07T18:08:00.000Z",
          scope: { provider: "codex" },
        },
      ]);
    });

    it("a reserve panel drops model scopes end to end: the provider headline reads 48% used", async () => {
      // Sanitized live panel from an operator report: a model reserve weekly at
      // 100% left, the provider's own weekly at 52% left, then a model heading
      // whose 5h and weekly rows are model-scoped too. Scopes in row order are
      // model, provider, model, model — and the provider's headline must come
      // from its own weekly, not from the reserve row printed above it.
      const rawCodexOutput =
        "gpt-reserve Weekly limit:    [████████████████████] 100% left (resets 14:56 on 12 Sep)\n" +
        "Weekly limit:                [██████████░░░░░░░░░░] 52% left (resets 18:08 on 7 Sep)\n" +
        "GPT-5.3-Codex-Spark limit:\n" +
        "5h limit:                    [████████████████████] 100% left (resets 19:56)\n" +
        "Weekly limit:                [████████████████████] 100% left (resets 16:11 on 7 Sep)";

      mockGenerateContent.mockResolvedValue({
        text: () =>
          JSON.stringify({
            status: "available",
            windows: [
              {
                label: "Weekly limit",
                kind: "weekly",
                usedPercent: 0,
                resetAtIso: "2026-09-12T14:56:00.000Z",
                scope: "provider",
                models: [],
              },
              {
                label: "Weekly limit",
                kind: "weekly",
                usedPercent: 48,
                resetAtIso: "2026-09-07T18:08:00.000Z",
                scope: "provider",
              },
              {
                label: "5h limit",
                kind: "five_hour",
                usedPercent: 0,
                resetAtIso: "2026-09-05T19:56:00.000Z",
                scope: "provider",
                models: [],
              },
              {
                label: "Weekly limit",
                kind: "weekly",
                usedPercent: 0,
                resetAtIso: "2026-09-07T16:11:00.000Z",
                scope: "provider",
                models: [],
              },
            ],
          }),
      });

      const parsed = await parseCodexQuota(rawCodexOutput, "test-key");
      expect(parsed.limits?.map((l) => l.scope)).toEqual([{ provider: "codex" }]);

      // `parseCodexQuota` answers a partial snapshot; the service names the
      // provider it probed, exactly as the cache hands it to the endpoint.
      const snapshot = await buildQuotaSnapshot({
        getQuota: async () => ({ provider: "codex", status: "available", ...parsed }),
        providers: ["codex"],
      });
      const codex = snapshot.providers[0];

      expect(codex.usedPercent).toBe(48);
      expect(codex.windows).toEqual([
        expect.objectContaining({
          id: "weekly",
          label: "Weekly limit",
          usedPercent: 48,
          headline: true,
          resetAtIso: "2026-09-07T18:08:00.000Z",
        }),
      ]);
    });

    it("threads an LLM-emitted resetAtIso through unchanged to the resulting limits ", async () => {
      mockGenerateContent.mockResolvedValue({
        text: () =>
          JSON.stringify({
            status: "available",
            windows: [
              {
                label: "Weekly",
                kind: "weekly",
                usedPercent: 3,
                resetAtIso: "2026-07-13T09:59:00.000Z",
              },
            ],
          }),
      });

      const parsed = await parseClaudeQuota("Claude output here", "test-key");
      expect(parsed.limits).toEqual([
        {
          label: "Weekly",
          kind: "weekly",
          percentLeft: 97,
          resetAtIso: "2026-07-13T09:59:00.000Z",
          scope: { provider: "claude" },
        },
      ]);
    });

    describe("codex refresh-pending retry and reserve-only blocks (#517)", () => {
      // The configured codex catalog for this pool. No Spark model is
      // configured, so every Spark reserve row must disappear at the trust
      // boundary rather than stand in for the provider's own weekly.
      const codexCatalog = [
        { displayLabel: "gpt-5.6-sol", identifier: "gpt-5.6-sol" },
        { displayLabel: "gpt-5.5", identifier: "gpt-5.5" },
      ];
      const twoPanelCapture = () =>
        readFileSync(join(__dirname, "fixtures", "codex-status-refresh-then-reserve.txt"), "utf-8");
      const pendingOnlyCapture = () =>
        readFileSync(join(__dirname, "fixtures", "codex-status-refresh-pending.txt"), "utf-8");
      // The scrape instant of the captured production panel this fixture came from.
      const scrapedAtMs = Date.parse("2026-09-16T11:20:19.523Z");
      // codex prints wall-clock reset text with no year and no timezone. The
      // model assembles the instant from the current local date, year and UTC
      // offset the prompt supplies (#517); the parser passes that instant
      // through untouched, so these are the instants the mocked model emits.
      const displayedWeeklyReset = "2026-09-19T08:49:00.000Z";
      const sparkFiveHourReset = "2026-09-16T16:20:00.000Z";
      const sparkWeeklyReset = "2026-09-23T11:20:00.000Z";

      /** The completed panel as the model reads it: one provider weekly + a Spark reserve block. */
      const reservePanelResponse = {
        status: "available",
        windows: [
          {
            label: "Weekly limit",
            kind: "weekly",
            usedPercent: 61,
            resetAtIso: displayedWeeklyReset,
            placeholder: false,
            scope: "provider",
          },
          {
            label: "5h limit",
            kind: "five_hour",
            usedPercent: 0,
            resetAtIso: sparkFiveHourReset,
            placeholder: false,
            scope: "provider",
            models: ["gpt-5.3-codex-spark"],
          },
          {
            label: "Weekly limit",
            kind: "weekly",
            usedPercent: 0,
            resetAtIso: sparkWeeklyReset,
            placeholder: false,
            scope: "provider",
            models: ["gpt-5.3-codex-spark"],
          },
        ],
      };

      it("parses the completed panel and never shows the refresh-pending panel to the model", async () => {
        mockGenerateContent.mockResolvedValue({ text: () => JSON.stringify(reservePanelResponse) });

        await parseCodexQuota(twoPanelCapture(), "test-key", scrapedAtMs, codexCatalog);

        const { contents } = mockGenerateContent.mock.calls[0][0] as { contents: string };
        // The capture holds codex's refresh-pending answer AND the completed
        // panel it rendered after the in-session retry. Only the completed panel
        // is a reading, so only the completed panel is parsed: leaving the
        // pending text in the prompt invites a pending/real mix-up on the very
        // panel that matters.
        expect(contents).toContain("39% left (resets 08:49 on 19 Sep)");
        expect(contents).toContain("GPT-5.3-Codex-Spark limit:");
        expect(contents).not.toContain("refresh requested");
        expect(contents).not.toContain("usage limit resets available");
      });

      it("publishes the weekly reset the model assembled from the printed date", async () => {
        mockGenerateContent.mockResolvedValue({ text: () => JSON.stringify(reservePanelResponse) });

        const parsed = await parseCodexQuota(
          twoPanelCapture(),
          "test-key",
          scrapedAtMs,
          codexCatalog
        );

        // One attempt: the model filled resetAtIso from the printed "08:49 on
        // 19 Sep" plus the supplied current date, so the partially consumed
        // weekly passes its reset gate and nothing escalates. The parser
        // reports the instant the model assembled from the displayed date and
        // never invents an override of its own.
        expect(mockGenerateContent).toHaveBeenCalledTimes(1);
        expect(parsed.status).toBe("available");
        expect(parsed.limits).toEqual([
          {
            label: "Weekly limit",
            kind: "weekly",
            percentLeft: 39,
            resetAtIso: displayedWeeklyReset,
            scope: { provider: "codex" },
          },
        ]);
      });

      it("hands the model the current local date, year and offset instead of a verbatim reset field", async () => {
        mockGenerateContent.mockResolvedValue({
          text: () => JSON.stringify({ status: "unknown", windows: [] }),
        });

        await parseCodexQuota(pendingOnlyCapture(), "test-key", scrapedAtMs, codexCatalog);

        // The panel prints "08:49 on 19 Sep": no year, no zone. Those are the
        // two things the prompt must supply as plain components so the model
        // can shuffle them into an ISO instant rather than decline the
        // arithmetic. Parsing the printed text is the model's job, not code's.
        const now = new Date(scrapedAtMs);
        const pad = (n: number) => String(n).padStart(2, "0");
        const systemInstruction = lastSystemInstruction();
        expect(systemInstruction).toContain(
          `today is ${["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][now.getDay()]} ${now.getDate()} Sep ${now.getFullYear()}`
        );
        expect(systemInstruction).toContain(`the current year is ${now.getFullYear()}`);
        expect(systemInstruction).toContain(
          `the current local clock time is ${pad(now.getHours())}:${pad(now.getMinutes())}`
        );
        expect(systemInstruction).toMatch(/the UTC offset is [+-]\d{2}:\d{2}\./);
        expect(systemInstruction).toContain(
          "A printed reset that omits the year or the timezone is NOT ambiguous"
        );
        expect(systemInstruction).not.toContain("resetText");
        const { config } = mockGenerateContent.mock.calls[0][0] as {
          config: {
            responseSchema: {
              properties: {
                windows: { items: { required: string[]; properties: Record<string, unknown> } };
              };
            };
          };
        };
        expect(config.responseSchema.properties.windows.items.required).not.toContain("resetText");
        expect(config.responseSchema.properties.windows.items.properties).not.toHaveProperty(
          "resetText"
        );
      });

      it("rejects a reserve block read as a second provider-wide window of the same kind", async () => {
        // The failure mode this guards: the Spark heading's rows come back with
        // no `models`, so the reserve weekly stands beside the provider's own
        // weekly as if the account had two. Whichever one downstream picks, the
        // provider reset is contaminated — so the parse fails and escalates
        // rather than publishing an ambiguous panel.
        mockGenerateContent
          .mockResolvedValueOnce({
            text: () =>
              JSON.stringify({
                status: "available",
                windows: [
                  {
                    label: "Weekly limit",
                    kind: "weekly",
                    usedPercent: 61,
                    resetAtIso: displayedWeeklyReset,
                    placeholder: false,
                    scope: "provider",
                  },
                  {
                    label: "Weekly limit",
                    kind: "weekly",
                    usedPercent: 0,
                    resetAtIso: sparkWeeklyReset,
                    placeholder: false,
                    scope: "provider",
                  },
                ],
              }),
          })
          .mockResolvedValue({ text: () => JSON.stringify(reservePanelResponse) });

        const parsed = await parseCodexQuota(
          twoPanelCapture(),
          "test-key",
          scrapedAtMs,
          codexCatalog
        );

        expect(mockGenerateContent).toHaveBeenCalledTimes(2);
        expect((mockGenerateContent.mock.calls[1][0] as { model: string }).model).toBe(
          "gemini-3.5-flash"
        );
        expect(parsed.limits).toEqual([
          {
            label: "Weekly limit",
            kind: "weekly",
            percentLeft: 39,
            resetAtIso: displayedWeeklyReset,
            scope: { provider: "codex" },
          },
        ]);
      });

      it("instructs the model that GPT-5.3-Codex-Spark limit is a heading and all rows beneath it are scoped only to gpt-5.3-codex-spark", async () => {
        mockGenerateContent.mockResolvedValue({
          text: () => JSON.stringify({ status: "unknown", windows: [] }),
        });

        await parseCodexQuota(pendingOnlyCapture(), "test-key", scrapedAtMs, codexCatalog);

        const systemInstruction = lastSystemInstruction();
        expect(systemInstruction).toContain(
          "`GPT-5.3-Codex-Spark limit` is a heading and all rows beneath it are scoped only to the gpt-5.3-codex-spark model class"
        );
        expect(systemInstruction).toContain("Account rows above the heading remain provider scope");
      });

      it("scopes both Spark 5h and Weekly rows to gpt-5.3-codex-spark when configured in the catalog", async () => {
        const catalogWithSpark = [
          ...codexCatalog,
          { displayLabel: "gpt-5.3-codex-spark", identifier: "gpt-5.3-codex-spark" },
        ];
        mockGenerateContent.mockResolvedValue({ text: () => JSON.stringify(reservePanelResponse) });

        const parsed = await parseCodexQuota(
          twoPanelCapture(),
          "test-key",
          scrapedAtMs,
          catalogWithSpark
        );

        expect(parsed.status).toBe("available");
        expect(parsed.limits).toEqual([
          {
            label: "Weekly limit",
            kind: "weekly",
            percentLeft: 39,
            resetAtIso: displayedWeeklyReset,
            scope: { provider: "codex" },
          },
          {
            label: "5h limit",
            kind: "five_hour",
            percentLeft: 100,
            resetAtIso: sparkFiveHourReset,
            scope: { provider: "codex", models: ["gpt-5.3-codex-spark"] },
          },
          {
            label: "Weekly limit",
            kind: "weekly",
            percentLeft: 100,
            resetAtIso: sparkWeeklyReset,
            scope: { provider: "codex", models: ["gpt-5.3-codex-spark"] },
          },
        ]);
      });

      it("publishes the completed panel's provider weekly and drops the reserve block end to end", async () => {
        const capture = twoPanelCapture();
        const scrapeStore = {
          recordRaw: vi.fn().mockReturnValue("scrape-1"),
          recordParsed: vi.fn(),
          recordParseError: vi.fn(),
        };
        mockGenerateContent.mockResolvedValue({ text: () => JSON.stringify(reservePanelResponse) });
        const service = new QuotaService({
          config: {
            providers: { codex: { cliCommand: "codex" } },
            geminiApiKey: "test-gemini-key",
          } as unknown as RusaConfig,
          workersDir: "/tmp/workers",
          scrapeCodexStatus: vi.fn().mockResolvedValue(capture),
          modelCatalogFor: () => codexCatalog,
          scrapeStore,
          now: () => scrapedAtMs,
          ttlMs: 0,
        });

        const state = await service.getQuota("codex");

        expect(state).toMatchObject({
          provider: "codex",
          status: "available",
          limits: [
            {
              label: "Weekly limit",
              kind: "weekly",
              percentLeft: 39,
              resetAtIso: displayedWeeklyReset,
              scope: { provider: "codex" },
            },
          ],
        });
        // The durable row keeps the whole capture, pending panel included —
        // panel selection is a parse-time decision, not an edit to the evidence.
        expect(scrapeStore.recordRaw).toHaveBeenCalledWith({
          provider: "codex",
          scrapedAt: expect.any(String),
          rawOutput: capture,
        });
        const [, , inferred] = scrapeStore.recordParsed.mock.calls[0];
        expect(inferred.limits).toHaveLength(1);
      });

      it("keeps the last good reading when the refresh never completes within the bounded retry", async () => {
        const capture = pendingOnlyCapture();
        const scrapeCodexStatus = vi.fn().mockResolvedValue(capture);
        mockGenerateContent.mockResolvedValue({
          text: () => JSON.stringify({ status: "unknown", windows: [] }),
        });
        const service = new QuotaService({
          config: {
            providers: { codex: { cliCommand: "codex" } },
            geminiApiKey: "test-gemini-key",
          } as unknown as RusaConfig,
          workersDir: "/tmp/workers",
          scrapeCodexStatus,
          modelCatalogFor: () => codexCatalog,
          now: () => scrapedAtMs,
          ttlMs: 0,
        });
        service.hydrate("codex", {
          provider: "codex",
          status: "available",
          scrapedAt: "2026-09-16T10:47:36.825Z",
          limits: [
            {
              label: "Weekly limit",
              kind: "weekly",
              percentLeft: 39,
              resetAtIso: displayedWeeklyReset,
              scope: { provider: "codex" },
            },
          ],
        });

        const state = await service.getQuota("codex");

        // Exactly one scrape: the retry that matters already happened inside the
        // codex session, and a second cold session would only re-render pending.
        expect(scrapeCodexStatus).toHaveBeenCalledTimes(1);
        // The pending panel IS shown to the model here — classifying it as a
        // known no-data state is the whole point of parsing it.
        expect((mockGenerateContent.mock.calls[0][0] as { contents: string }).contents).toContain(
          "refresh requested"
        );
        expect(state).toMatchObject({
          status: "available",
          limits: [{ label: "Weekly limit", percentLeft: 39, resetAtIso: displayedWeeklyReset }],
        });
        expect(state.explanations).toEqual(
          expect.arrayContaining([expect.objectContaining({ rule: "carried_forward_bad_read" })])
        );
      });
    });
  });

  describe("parseAgyQuota (no geminiApiKey)", () => {
    it("returns honest unknown status when key is absent", async () => {
      const parsed = await parseAgyQuota("agy usage output...");
      expect(parsed.status).toBe("unknown");
      expect(parsed.message).toBe("no geminiApiKey configured for LLM quota parsing");
    });
  });

  describe("createQuotaMcpServer", () => {
    let mockConfig: RusaConfig;
    let mockClaudeProvider: CodingProvider;
    let mockCodexProvider: CodingProvider;
    let mockResolveProvider: (config: RusaConfig, name: string) => CodingProvider;

    beforeEach(() => {
      mockConfig = {
        providers: {
          claude: { cliCommand: "claude" },
          codex: { cliCommand: "codex" },
          agy: { cliCommand: "antigravity" },
          kimi: { cliCommand: "kimi" },
        },
      } as unknown as RusaConfig;

      mockClaudeProvider = {
        name: "claude",
        providerName: "claude",
        run: vi.fn().mockResolvedValue({
          success: true,
          output:
            "using your subscription to power...\nCurrent session: 10% used · resets Jul 5, 10:50am (UTC)",
          exitCode: 0,
        }),
      };

      mockCodexProvider = {
        name: "codex",
        providerName: "codex",
        run: vi.fn().mockResolvedValue({
          success: true,
          output: "ok",
          exitCode: 0,
        }),
      };

      mockResolveProvider = vi.fn((_cfg: RusaConfig, name: string) => {
        if (name === "claude") return mockClaudeProvider;
        if (name === "codex") return mockCodexProvider;
        throw new Error("Unknown provider");
      });
    });

    it("implements caching and request deduplication", async () => {
      const server = createQuotaMcpServer({
        config: mockConfig,
        workersDir: "/tmp/workers",
        resolveProvider: mockResolveProvider,
        ttlMs: 2_000,
      });
      const client = await connect(server);

      // Call tool once (no geminiApiKey → fail-closed unknown, but still cached)
      const result1 = (await client.callTool({
        name: "get_quota",
        arguments: { provider: "claude" },
      })) as CallToolResult;
      expect(textOf(result1)).toContain('"status": "unknown"');
      expect(textOf(result1)).toContain("no geminiApiKey configured for LLM quota parsing");
      expect(mockClaudeProvider.run).toHaveBeenCalledTimes(1);

      // Call tool again immediately (should hit cache)
      const result2 = (await client.callTool({
        name: "get_quota",
        arguments: { provider: "claude" },
      })) as CallToolResult;
      expect(textOf(result2)).toContain('"status": "unknown"');
      expect(mockClaudeProvider.run).toHaveBeenCalledTimes(1);

      // Concurrent calls (should deduplicate)
      mockClaudeProvider.run = vi.fn().mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { success: true, output: "available", exitCode: 0 };
      });

      const server2 = createQuotaMcpServer({
        config: mockConfig,
        workersDir: "/tmp/workers",
        resolveProvider: mockResolveProvider,
        ttlMs: 2_000,
      });
      const client2 = await connect(server2);

      // Trigger concurrent calls
      const p1 = client2.callTool({
        name: "get_quota",
        arguments: { provider: "claude" },
      });
      const p2 = client2.callTool({
        name: "get_quota",
        arguments: { provider: "claude" },
      });

      await Promise.all([p1, p2]);
      expect(mockClaudeProvider.run).toHaveBeenCalledTimes(1);
    });

    it("serves list_models returning per-provider catalog with passable field", async () => {
      clearProviderModelCatalog();
      setProviderModelCatalog("codex", [
        { displayLabel: "gpt-5.6-sol", identifier: "gpt-5.6-sol" },
      ]);
      setProviderModelCatalog("agy", [
        { displayLabel: "Gemini Flash", identifier: "gemini-flash", passable: false },
        { displayLabel: "Gemini 3.7 Flash (High)", identifier: "gemini-3.7-flash", passable: true },
        {
          displayLabel: "Claude Sonnet 4.6",
          identifier: "claude-sonnet-4-6",
          passable: true,
        },
        {
          displayLabel: "Claude Opus 4.6 (Thinking)",
          identifier: "claude-opus-4-6-thinking",
          passable: true,
        },
        {
          displayLabel: "GPT-OSS 120B (Medium)",
          identifier: "gpt-oss-120b-medium",
          passable: true,
        },
      ]);

      const server = createQuotaMcpServer({
        config: mockConfig,
        workersDir: "/tmp/workers",
      });
      const client = await connect(server);

      // 1. Call list_models with no arguments (returns all providers)
      const allResult = (await client.callTool({
        name: "list_models",
        arguments: {},
      })) as CallToolResult;
      const allParsed = JSON.parse(textOf(allResult));

      expect(allParsed).toEqual({
        codex: [{ displayLabel: "gpt-5.6-sol", identifier: "gpt-5.6-sol", passable: true }],
        agy: [
          {
            displayLabel: "Gemini Flash",
            identifier: "gemini-flash",
            passable: false,
            efforts: [],
          },
          {
            displayLabel: "Gemini 3.7 Flash",
            identifier: "gemini-3.7-flash",
            passable: true,
            efforts: ["high"],
          },
        ],
      });

      // 2. Call list_models with provider filter
      const agyResult = (await client.callTool({
        name: "list_models",
        arguments: { provider: "agy" },
      })) as CallToolResult;
      const agyParsed = JSON.parse(textOf(agyResult));

      expect(agyParsed).toEqual({
        agy: [
          {
            displayLabel: "Gemini Flash",
            identifier: "gemini-flash",
            passable: false,
            efforts: [],
          },
          {
            displayLabel: "Gemini 3.7 Flash",
            identifier: "gemini-3.7-flash",
            passable: true,
            efforts: ["high"],
          },
        ],
      });

      // 3. Call list_models with antigravity alias
      const antigravityResult = (await client.callTool({
        name: "list_models",
        arguments: { provider: "antigravity" },
      })) as CallToolResult;
      const antigravityParsed = JSON.parse(textOf(antigravityResult));

      expect(antigravityParsed).toEqual({
        antigravity: [
          {
            displayLabel: "Gemini Flash",
            identifier: "gemini-flash",
            passable: false,
            efforts: [],
          },
          {
            displayLabel: "Gemini 3.7 Flash",
            identifier: "gemini-3.7-flash",
            passable: true,
            efforts: ["high"],
          },
        ],
      });
    });

    it("never probes providers absent from config", async () => {
      const scrapeCodexStatus = vi.fn().mockResolvedValue("raw codex status");
      const service = new QuotaService({
        config: {
          ...mockConfig,
          providers: { claude: { cliCommand: "claude" } },
        },
        workersDir: "/tmp/workers",
        scrapeCodexStatus,
      });

      await expect(service.getQuota("codex")).resolves.toMatchObject({
        provider: "codex",
        status: "unsupported",
        message: "codex is not configured on this instance",
      });
      expect(scrapeCodexStatus).not.toHaveBeenCalled();
    });

    it("canonicalizes configured antigravity to agy", async () => {
      const scrapeAgyUsage = vi.fn().mockResolvedValue("Models & Quota");
      const service = new QuotaService({
        config: {
          ...mockConfig,
          providers: { gemini: { cliCommand: "antigravity" } },
        },
        workersDir: "/tmp/workers",
        scrapeAgyUsage,
      });

      await service.getQuota("agy");
      expect(scrapeAgyUsage).toHaveBeenCalledTimes(1);
    });

    it("persists only real probes, preserving raw output exactly", async () => {
      const raw = "line one\r\n\u001b[32m10% used\u001b[0m\n";
      const scrapeStore = {
        recordRaw: vi.fn().mockReturnValue("scrape-1"),
        recordParsed: vi.fn(),
        recordParseError: vi.fn(),
      };
      mockClaudeProvider.run = vi.fn().mockResolvedValue({
        success: true,
        output: raw,
        exitCode: 0,
      });
      const service = new QuotaService({
        config: mockConfig,
        workersDir: "/tmp/workers",
        resolveProvider: mockResolveProvider,
        scrapeStore,
      });

      const first = await service.getQuota("claude");
      const second = await service.getQuota("claude");

      expect(first).toBe(second);
      expect(scrapeStore.recordRaw).toHaveBeenCalledOnce();
      expect(scrapeStore.recordRaw).toHaveBeenCalledWith({
        provider: "claude",
        scrapedAt: expect.any(String),
        rawOutput: raw,
      });
      expect(scrapeStore.recordParsed).toHaveBeenCalledOnce();
      expect(scrapeStore.recordParseError).not.toHaveBeenCalled();
    });

    it("uses the correct per-provider TTL and respects deps.ttlMs", () => {
      const service = new QuotaService({
        config: mockConfig,
        workersDir: "/tmp/workers",
      }) as unknown as { getTtlMs: (provider: string) => number };

      // Default TTLs
      expect(service.getTtlMs("claude")).toBe(5 * 60 * 1000);
      expect(service.getTtlMs("agy")).toBe(5 * 60 * 1000);
      expect(service.getTtlMs("codex")).toBe(30 * 60 * 1000);
      // kimi raised 60s→5min once the /usage pty scrape dropped ~51s→~8s ;
      // 5h/weekly windows don't need sub-minute freshness.
      expect(service.getTtlMs("kimi")).toBe(5 * 60 * 1000);

      // Overridden TTLs
      const serviceWithOverride = new QuotaService({
        config: mockConfig,
        workersDir: "/tmp/workers",
        ttlMs: 50,
      }) as unknown as { getTtlMs: (provider: string) => number };
      expect(serviceWithOverride.getTtlMs("claude")).toBe(50);
      expect(serviceWithOverride.getTtlMs("agy")).toBe(50);
      expect(serviceWithOverride.getTtlMs("codex")).toBe(50);
      expect(serviceWithOverride.getTtlMs("kimi")).toBe(50);
    });

    it("stamps scrapedAt once per probe and preserves it unchanged across a within-TTL cache hit ", async () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date("2026-07-14T09:15:00.000Z"));
        const service = new QuotaService({
          config: mockConfig,
          workersDir: "/tmp/workers",
          resolveProvider: mockResolveProvider,
        });

        const first = await service.getQuota("claude");
        expect(first.scrapedAt).toBe("2026-07-14T09:15:00.000Z");
        expect(mockClaudeProvider.run).toHaveBeenCalledTimes(1);

        // Still within the 5-minute claude TTL — cache hit, scrapedAt rides
        // through unchanged rather than reflecting this later read time.
        vi.setSystemTime(new Date("2026-07-14T09:16:00.000Z"));
        const second = await service.getQuota("claude");
        expect(second.scrapedAt).toBe("2026-07-14T09:15:00.000Z");
        expect(mockClaudeProvider.run).toHaveBeenCalledTimes(1);

        // Past the TTL — a fresh probe runs and stamps a new scrapedAt.
        vi.setSystemTime(new Date("2026-07-14T09:25:00.000Z"));
        const third = await service.getQuota("claude");
        expect(third.scrapedAt).toBe("2026-07-14T09:25:00.000Z");
        expect(mockClaudeProvider.run).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });

    describe("getQuotaCached (non-blocking request path, issue #10)", () => {
      it("returns unsupported for an unconfigured provider without probing", () => {
        const scrapeCodexStatus = vi.fn().mockResolvedValue("raw codex status");
        const service = new QuotaService({
          config: { ...mockConfig, providers: { claude: { cliCommand: "claude" } } },
          workersDir: "/tmp/workers",
          scrapeCodexStatus,
        });

        expect(service.getQuotaCached("codex")).toMatchObject({
          provider: "codex",
          status: "unsupported",
        });
        expect(scrapeCodexStatus).not.toHaveBeenCalled();
      });

      it("returns an 'unknown' placeholder immediately on a cold cache and defers background probe off synchronous stack", async () => {
        const service = new QuotaService({
          config: mockConfig,
          workersDir: "/tmp/workers",
          resolveProvider: mockResolveProvider,
        });

        // Synchronous return — a placeholder with no scrapedAt, no await on the
        // probe. (Message distinguishes the cold placeholder from a probed
        // unknown, which fail-closed parsing without a geminiApiKey also yields.)
        const immediate = service.getQuotaCached("claude");
        expect(immediate).toMatchObject({ provider: "claude", status: "unknown" });
        expect(immediate.scrapedAt).toBeUndefined();
        expect(immediate.message).toContain("refreshing in background");

        // The probe startup is deferred to a microtask, so on the immediate
        // synchronous tick of getQuotaCached(), run has not yet executed.
        expect(mockClaudeProvider.run).toHaveBeenCalledTimes(0);

        // Once microtasks flush and the probe settles, the cache holds a real
        // probe (scrapedAt stamped), even though fail-closed parsing without a
        // geminiApiKey keeps status 'unknown' — the point is the request path
        // never blocked on it.
        await vi.waitFor(() => {
          expect(mockClaudeProvider.run).toHaveBeenCalledTimes(1);
          expect(service.getQuotaCached("claude").scrapedAt).toBeDefined();
        });
      });

      it("serves a stale cached reading immediately and refreshes in the background", async () => {
        vi.useFakeTimers();
        try {
          vi.setSystemTime(new Date("2026-07-14T09:15:00.000Z"));
          const service = new QuotaService({
            config: mockConfig,
            workersDir: "/tmp/workers",
            resolveProvider: mockResolveProvider,
          });

          // Warm the cache with a real reading.
          const warm = await service.getQuota("claude");
          expect(warm.scrapedAt).toBe("2026-07-14T09:15:00.000Z");
          expect(mockClaudeProvider.run).toHaveBeenCalledTimes(1);

          // Advance past the 5-minute claude TTL so the entry is stale.
          vi.setSystemTime(new Date("2026-07-14T09:25:00.000Z"));

          // The stale reading is served immediately — same scrapedAt as the warm
          // probe, NOT a fresh probe time — while a refresh is kicked behind it.
          const stale = service.getQuotaCached("claude");
          expect(stale.scrapedAt).toBe("2026-07-14T09:15:00.000Z");

          // Drain the background probe and confirm the cache advanced.
          await vi.runAllTimersAsync();
          expect(mockClaudeProvider.run).toHaveBeenCalledTimes(2);
          const refreshed = service.getQuotaCached("claude");
          expect(refreshed.scrapedAt).toBe("2026-07-14T09:25:00.000Z");
        } finally {
          vi.useRealTimers();
        }
      });

      it("preserves stale valid reading when a background refresh fails (status: unknown)", async () => {
        vi.useFakeTimers();
        try {
          vi.setSystemTime(new Date("2026-07-14T09:15:00.000Z"));
          const service = new QuotaService({
            config: mockConfig,
            workersDir: "/tmp/workers",
            resolveProvider: mockResolveProvider,
          });

          // Pre-populate cache directly with a valid known reading.
          (service as unknown as { cache: Map<string, unknown> }).cache.set("claude", {
            state: {
              provider: "claude",
              status: "available",
              scrapedAt: "2026-07-14T09:15:00.000Z",
              limits: [{ label: "Session", kind: "session", percentLeft: 90 }],
            },
            timestamp: Date.parse("2026-07-14T09:15:00.000Z"),
          });

          // Advance past the 5-minute claude TTL so the entry is stale.
          vi.setSystemTime(new Date("2026-07-14T09:25:00.000Z"));

          // Scraper/provider run fails closed (returns unknown status).
          vi.mocked(mockClaudeProvider.run).mockResolvedValueOnce({
            success: false,
            output: "Scrape error or unavailable",
            exitCode: 1,
          });

          // Stale reading served immediately.
          const stale = service.getQuotaCached("claude");
          expect(stale.status).toBe("available");
          expect(stale.scrapedAt).toBe("2026-07-14T09:15:00.000Z");
          expect(stale.limits?.[0].percentLeft).toBe(90);

          // Drain background refresh probe.
          await vi.runAllTimersAsync();
          expect(mockClaudeProvider.run).toHaveBeenCalledTimes(1);

          // The failed refresh does NOT overwrite the valid cached reading with
          // unknown. Stale reading is preserved for subsequent reads.
          const afterFailedRefresh = service.getQuotaCached("claude");
          expect(afterFailedRefresh.status).toBe("available");
          expect(afterFailedRefresh.scrapedAt).toBe("2026-07-14T09:15:00.000Z");
          expect(afterFailedRefresh.limits?.[0].percentLeft).toBe(90);

          // Because the entry was not updated with a fresh timestamp, subsequent
          // reads still attempt background refresh until a successful probe lands.
          await vi.runAllTimersAsync();
          expect(mockClaudeProvider.run).toHaveBeenCalledTimes(2);
        } finally {
          vi.useRealTimers();
        }
      });

      it("serves a fresh cached reading without probing", async () => {
        vi.useFakeTimers();
        try {
          vi.setSystemTime(new Date("2026-07-14T09:15:00.000Z"));
          const service = new QuotaService({
            config: mockConfig,
            workersDir: "/tmp/workers",
            resolveProvider: mockResolveProvider,
          });

          await service.getQuota("claude");
          expect(mockClaudeProvider.run).toHaveBeenCalledTimes(1);

          // Still within the 5-minute TTL — no background probe.
          vi.setSystemTime(new Date("2026-07-14T09:16:00.000Z"));
          const fresh = service.getQuotaCached("claude");
          expect(fresh.scrapedAt).toBe("2026-07-14T09:15:00.000Z");
          expect(mockClaudeProvider.run).toHaveBeenCalledTimes(1);
        } finally {
          vi.useRealTimers();
        }
      });

      it("dedupes concurrent background refreshes to a single probe", async () => {
        const service = new QuotaService({
          config: mockConfig,
          workersDir: "/tmp/workers",
          resolveProvider: mockResolveProvider,
        });

        // Three rapid cold reads should share one in-flight probe.
        service.getQuotaCached("claude");
        service.getQuotaCached("claude");
        service.getQuotaCached("claude");

        await vi.waitFor(() => {
          expect(mockClaudeProvider.run).toHaveBeenCalledTimes(1);
        });
      });
    });

    it("asserts context-safety: runs probe inside sandbox with correct worktreePath", async () => {
      const workersDir = "/tmp/workers";
      const server = createQuotaMcpServer({
        config: mockConfig,
        workersDir,
        resolveProvider: mockResolveProvider,
      });
      const client = await connect(server);

      await client.callTool({
        name: "get_quota",
        arguments: { provider: "claude" },
      });

      // Check run options passed to provider.run
      const lastCallOpts = vi.mocked(mockClaudeProvider.run).mock.calls[0]?.[0];
      expect(lastCallOpts).toBeDefined();
      if (lastCallOpts) {
        expect(lastCallOpts.cwd).toBe(`${workersDir}/quota-probe-claude`);
        expect(lastCallOpts.sandbox).toBeDefined();
        if (lastCallOpts.sandbox) {
          expect(lastCallOpts.sandbox.worktreePath).toBe(`${workersDir}/quota-probe-claude`);
        }
      }

      // Verify that bubblewrap arguments generated for this probe match standard worker args
      const bwrapResultProbe = buildActorBwrapArgs(`${workersDir}/quota-probe-claude`, "claude");
      const bwrapResultWorker = buildActorBwrapArgs(`${workersDir}/worker-test-id`, "claude");

      // The bubblewrap arguments should have the exact same structure and configurations
      // (except for the worker-specific directory path)
      expect(bwrapResultProbe.args.length).toBe(bwrapResultWorker.args.length);

      // Verify mounting properties are identical
      const cleanArgs = (args: string[], dir: string) =>
        args.map((a) =>
          a.replaceAll(dir, "/ACTOR_DIR").replace(/\/tmp\/rusa-npmrc-[^/]+$/, "/NPMRC_TEMP")
        );

      expect(cleanArgs(bwrapResultProbe.args, `${workersDir}/quota-probe-claude`)).toEqual(
        cleanArgs(bwrapResultWorker.args, `${workersDir}/worker-test-id`)
      );
    }, 15_000);

    describe("live dispatch routes through the LLM parser when geminiApiKey is configured (ISSUE_NUM guard)", () => {
      beforeEach(() => {
        mockGenerateContent.mockReset();
      });

      it("claude probe uses the LLM parse when geminiApiKey is set", async () => {
        // Stub the LLM to return a reading so the assertion can only pass if the
        // live path actually routed through parseQuotaWithLlm — a future revert
        // away from LLM parsing (like ISSUE_NUM) would make this test fail instead of
        // silently reverting the ratified ISSUE_NUM behavior.
        mockGenerateContent.mockResolvedValue({
          text: () =>
            JSON.stringify({
              status: "available",
              windows: [
                {
                  label: "Current session",
                  kind: "session",
                  usedPercent: 77,
                  resetAtIso: "2026-07-13T02:59:00.000Z",
                },
              ],
            }),
        });

        const server = createQuotaMcpServer({
          config: { ...mockConfig, geminiApiKey: "test-gemini-key" },
          workersDir: "/tmp/workers",
          resolveProvider: mockResolveProvider,
        });
        const client = await connect(server);
        const result = (await client.callTool({
          name: "get_quota",
          arguments: { provider: "claude" },
        })) as CallToolResult;

        expect(mockGenerateContent).toHaveBeenCalledTimes(1);
        const lastCallArgs = mockGenerateContent.mock.calls[0][0] as { model: string };
        expect(lastCallArgs.model).toBe("gemini-3.5-flash-lite");
        const parsed = JSON.parse(textOf(result));
        expect(parsed.status).toBe("available");
        expect(parsed.limits).toEqual([
          {
            label: "Current session",
            kind: "session",
            percentLeft: 23,
            resetAtIso: "2026-07-13T02:59:00.000Z",
            scope: { provider: "claude" },
          },
        ]);
      });

      it("full pipeline: drops model-scoped windows before persistence", async () => {
        const scrapeStore = {
          recordRaw: vi.fn().mockReturnValue("scrape-multi-1"),
          recordParsed: vi.fn(),
          recordParseError: vi.fn(),
        };
        mockClaudeProvider.run = vi.fn().mockResolvedValue({
          success: true,
          output: "Claude /usage output with provider and model windows",
          exitCode: 0,
        });
        mockGenerateContent.mockResolvedValue({
          text: () =>
            JSON.stringify({
              status: "available",
              windows: [
                {
                  label: "Weekly",
                  kind: "weekly",
                  usedPercent: 40,
                  resetAtIso: "2026-08-27T10:00:00.000Z",
                  scope: "provider",
                },
                {
                  label: "Sonnet (weekly)",
                  kind: "weekly",
                  usedPercent: 50,
                  scope: "provider",
                  models: [],
                },
              ],
            }),
        });

        const server = createQuotaMcpServer({
          config: { ...mockConfig, geminiApiKey: "test-gemini-key" },
          workersDir: "/tmp/workers",
          resolveProvider: mockResolveProvider,
          scrapeStore,
        });
        const client = await connect(server);
        const result = (await client.callTool({
          name: "get_quota",
          arguments: { provider: "claude" },
        })) as CallToolResult;

        const parsed = JSON.parse(textOf(result));
        expect(parsed.status).toBe("available");
        expect(parsed.limits).toEqual([
          {
            label: "Weekly",
            kind: "weekly",
            percentLeft: 60,
            resetAtIso: "2026-08-27T10:00:00.000Z",
            scope: { provider: "claude" },
          },
        ]);
        expect(parsed.explanations).toEqual([]);

        expect(scrapeStore.recordParsed).toHaveBeenCalledOnce();
        const [scrapeId, rawStateArg, inferredStateArg] = scrapeStore.recordParsed.mock.calls[0];
        expect(scrapeId).toBe("scrape-multi-1");
        expect(rawStateArg.limits).toHaveLength(1);
        expect(inferredStateArg.limits).toHaveLength(1);
      });

      it("persists a malformed current Codex parse as unknown before carrying forward a prior reading", async () => {
        const priorPanel = "synthetic prior Codex provider panel";
        const malformedPanel = "synthetic malformed current Codex provider panel";
        const scrapeStore = {
          recordRaw: vi.fn().mockReturnValueOnce("scrape-prior").mockReturnValueOnce("scrape-bad"),
          recordParsed: vi.fn(),
          recordParseError: vi.fn(),
        };
        const scrapeCodexStatus = vi
          .fn()
          .mockResolvedValueOnce(priorPanel)
          .mockResolvedValueOnce(malformedPanel);
        mockGenerateContent
          .mockResolvedValueOnce({
            text: () =>
              JSON.stringify({
                status: "available",
                windows: [
                  {
                    label: "Weekly",
                    kind: "weekly",
                    scope: "provider",
                    usedPercent: 40,
                    resetAtIso: "2030-01-01T00:00:00.000Z",
                  },
                ],
              }),
          })
          .mockResolvedValue({
            text: () =>
              JSON.stringify({
                status: "available",
                windows: [
                  { label: "5h", kind: "five_hour", scope: "provider" },
                  {
                    label: "Weekly",
                    kind: "weekly",
                    scope: "provider",
                    usedPercent: 40,
                    resetAtIso: "2030-01-01T00:00:00.000Z",
                  },
                ],
              }),
          });

        const service = new QuotaService({
          config: { ...mockConfig, geminiApiKey: "test-gemini-key" },
          workersDir: "/tmp/workers",
          scrapeCodexStatus,
          scrapeStore,
          ttlMs: 0,
        });

        await expect(service.getQuota("codex")).resolves.toMatchObject({ status: "available" });
        const carriedForward = await service.getQuota("codex");

        expect(scrapeCodexStatus).toHaveBeenCalledTimes(2);
        expect(mockGenerateContent).toHaveBeenCalledTimes(3);
        expect(scrapeStore.recordRaw).toHaveBeenNthCalledWith(1, {
          provider: "codex",
          scrapedAt: expect.any(String),
          rawOutput: priorPanel,
        });
        expect(scrapeStore.recordRaw).toHaveBeenNthCalledWith(2, {
          provider: "codex",
          scrapedAt: expect.any(String),
          rawOutput: malformedPanel,
        });
        expect(scrapeStore.recordParsed).toHaveBeenCalledTimes(2);

        const [, rawCurrent, inferredCurrent] = scrapeStore.recordParsed.mock.calls[1];
        expect(rawCurrent).toMatchObject({
          provider: "codex",
          status: "unknown",
          raw: malformedPanel,
        });
        expect(rawCurrent.limits).toBeUndefined();
        expect(rawCurrent.message).toContain("invalid usedPercent");
        expect(inferredCurrent).toMatchObject({
          provider: "codex",
          status: "available",
          raw: malformedPanel,
          limits: [
            {
              label: "Weekly",
              kind: "weekly",
              percentLeft: 60,
              resetAtIso: "2030-01-01T00:00:00.000Z",
              scope: { provider: "codex" },
            },
          ],
        });
        expect(inferredCurrent.explanations).toEqual(
          expect.arrayContaining([expect.objectContaining({ rule: "carried_forward_bad_read" })])
        );
        expect(carriedForward).toEqual(inferredCurrent);
      });

      it("does not let a parse failure promote hydrated model-only history into provider state", async () => {
        mockGenerateContent.mockResolvedValue({
          text: () =>
            JSON.stringify({
              status: "available",
              windows: [{ label: "broken", kind: "weekly", scope: "provider" }],
            }),
        });
        const service = new QuotaService({
          config: { ...mockConfig, geminiApiKey: "test-gemini-key" },
          workersDir: "/tmp/workers",
          scrapeCodexStatus: vi.fn().mockResolvedValue("malformed current Codex panel"),
          now: () => Date.parse("2030-01-01T00:00:01.000Z"),
          ttlMs: 0,
        });
        service.hydrate("codex", {
          provider: "codex",
          status: "available",
          scrapedAt: "2030-01-01T00:00:00.000Z",
          limits: [
            {
              label: "Spark weekly",
              kind: "weekly",
              percentLeft: 100,
              resetAtIso: "2030-01-08T00:00:00.000Z",
              scope: { provider: "codex", models: ["gpt-spark"] },
            },
          ],
        });

        await expect(service.getQuota("codex")).resolves.toMatchObject({
          status: "unknown",
          limits: undefined,
        });
      });

      it("persists a malformed current Codex parse as unknown and fails closed without limits when prior reading has expired", async () => {
        const priorPanel = "synthetic expired prior Codex provider panel";
        const malformedPanel = "synthetic malformed current Codex provider panel";
        const scrapeStore = {
          recordRaw: vi.fn().mockReturnValueOnce("scrape-prior").mockReturnValueOnce("scrape-bad"),
          recordParsed: vi.fn(),
          recordParseError: vi.fn(),
        };
        const scrapeCodexStatus = vi
          .fn()
          .mockResolvedValueOnce(priorPanel)
          .mockResolvedValueOnce(malformedPanel);
        mockGenerateContent
          .mockResolvedValueOnce({
            text: () =>
              JSON.stringify({
                status: "available",
                windows: [
                  {
                    label: "Weekly",
                    kind: "weekly",
                    scope: "provider",
                    usedPercent: 40,
                    resetAtIso: "2020-01-01T00:00:00.000Z",
                  },
                ],
              }),
          })
          .mockResolvedValue({
            text: () =>
              JSON.stringify({
                status: "available",
                windows: [
                  { label: "5h", kind: "five_hour", scope: "provider" },
                  {
                    label: "Weekly",
                    kind: "weekly",
                    scope: "provider",
                    usedPercent: 40,
                    resetAtIso: "2020-01-01T00:00:00.000Z",
                  },
                ],
              }),
          });

        const service = new QuotaService({
          config: { ...mockConfig, geminiApiKey: "test-gemini-key" },
          workersDir: "/tmp/workers",
          scrapeCodexStatus,
          scrapeStore,
          ttlMs: 0,
        });

        await expect(service.getQuota("codex")).resolves.toMatchObject({ status: "available" });
        const failedClosed = await service.getQuota("codex");

        expect(scrapeCodexStatus).toHaveBeenCalledTimes(2);
        expect(mockGenerateContent).toHaveBeenCalledTimes(3);
        expect(scrapeStore.recordRaw).toHaveBeenNthCalledWith(1, {
          provider: "codex",
          scrapedAt: expect.any(String),
          rawOutput: priorPanel,
        });
        expect(scrapeStore.recordRaw).toHaveBeenNthCalledWith(2, {
          provider: "codex",
          scrapedAt: expect.any(String),
          rawOutput: malformedPanel,
        });
        expect(scrapeStore.recordParsed).toHaveBeenCalledTimes(2);

        const [, rawCurrent, inferredCurrent] = scrapeStore.recordParsed.mock.calls[1];
        expect(rawCurrent).toMatchObject({
          provider: "codex",
          status: "unknown",
          raw: malformedPanel,
        });
        expect(rawCurrent.limits).toBeUndefined();
        expect(rawCurrent.message).toContain("invalid usedPercent");
        expect(inferredCurrent).toMatchObject({
          provider: "codex",
          status: "unknown",
          raw: malformedPanel,
        });
        expect(inferredCurrent.limits).toBeUndefined();
        expect(failedClosed).toEqual(inferredCurrent);
      });

      it("codex probe uses the LLM parse when geminiApiKey is set", async () => {
        const fx = readFileSync(join(__dirname, "fixtures", "codex-status-healthy.txt"), "utf-8");
        mockGenerateContent.mockResolvedValue({
          text: () =>
            JSON.stringify({
              status: "available",
              windows: [
                {
                  label: "5h limit",
                  kind: "five_hour",
                  usedPercent: 1,
                  resetAtIso: "2026-07-14T23:32:00.000Z",
                },
                {
                  label: "Weekly limit",
                  kind: "weekly",
                  usedPercent: 42,
                  resetAtIso: "2026-07-14T12:34:00.000Z",
                },
              ],
            }),
        });
        const scrapeCodexStatus = vi.fn().mockResolvedValue(fx);

        const server = createQuotaMcpServer({
          config: { ...mockConfig, geminiApiKey: "test-gemini-key" },
          workersDir: "/tmp/workers",
          resolveProvider: mockResolveProvider,
          scrapeCodexStatus,
        });
        const client = await connect(server);
        const result = (await client.callTool({
          name: "get_quota",
          arguments: { provider: "codex" },
        })) as CallToolResult;

        expect(mockGenerateContent).toHaveBeenCalledTimes(1);
        const lastCallArgs = mockGenerateContent.mock.calls[0][0] as { model: string };
        expect(lastCallArgs.model).toBe("gemini-3.5-flash-lite");
        const parsed = JSON.parse(textOf(result));
        expect(parsed.status).toBe("available");
        expect(parsed.limits).toEqual([
          {
            label: "5h limit",
            kind: "five_hour",
            percentLeft: 99,
            resetAtIso: "2026-07-14T23:32:00.000Z",
            scope: { provider: "codex" },
          },
          {
            label: "Weekly limit",
            kind: "weekly",
            percentLeft: 58,
            resetAtIso: "2026-07-14T12:34:00.000Z",
            scope: { provider: "codex" },
          },
        ]);
      });

      it("parses the reading the in-session /status retry recovers, without re-running the whole scrape", async () => {
        // The refresh-requested placeholder is now retried IN-SESSION inside the
        // tmux harness (issue #8); by the time scrapeCodexStatus resolves it has
        // already recovered the real table. The MCP layer must NOT re-run the
        // whole scrape (a fresh cold session just re-renders the placeholder).
        const healthy = readFileSync(
          join(__dirname, "fixtures", "codex-status-healthy.txt"),
          "utf-8"
        );
        const scrapeCodexStatus = vi.fn().mockResolvedValue(healthy);
        mockGenerateContent.mockResolvedValue({
          text: () =>
            JSON.stringify({
              status: "available",
              windows: [
                { label: "5h", kind: "five_hour", usedPercent: 1, resetInIso: "PT23H32M" },
                {
                  label: "Weekly",
                  kind: "weekly",
                  usedPercent: 7,
                  resetAtIso: "2026-07-14T12:34:00.000Z",
                },
              ],
            }),
        });

        const server = createQuotaMcpServer({
          config: { ...mockConfig, geminiApiKey: "test-gemini-key" },
          workersDir: "/tmp/workers",
          scrapeCodexStatus,
        });
        const client = await connect(server);
        const result = (await client.callTool({
          name: "get_quota",
          arguments: { provider: "codex" },
        })) as CallToolResult;

        expect(scrapeCodexStatus).toHaveBeenCalledOnce();
        const parsed = JSON.parse(textOf(result));
        expect(parsed.status).toBe("available");
        expect(parsed.limits).toHaveLength(2);
        expect(parsed.limits[0]).toMatchObject({ label: "5h", kind: "five_hour", percentLeft: 99 });
        expect(parsed.limits[1]).toMatchObject({
          label: "Weekly",
          kind: "weekly",
          percentLeft: 93,
          resetAtIso: "2026-07-14T12:34:00.000Z",
        });
      });

      it("returns unknown for a persistent refresh placeholder without re-running the whole scrape", async () => {
        // If the in-session harness still hands back the placeholder (its own
        // budget exhausted), the MCP layer scrapes exactly once — never spinning
        // up additional cold sessions — and reports an honest unknown.
        const placeholder = "Limits: refresh requested; run /status again shortly.";
        const scrapeCodexStatus = vi.fn().mockResolvedValue(placeholder);
        const server = createQuotaMcpServer({
          config: mockConfig,
          workersDir: "/tmp/workers",
          scrapeCodexStatus,
        });
        const client = await connect(server);
        const result = (await client.callTool({
          name: "get_quota",
          arguments: { provider: "codex" },
        })) as CallToolResult;

        expect(scrapeCodexStatus).toHaveBeenCalledOnce();
        const parsed = JSON.parse(textOf(result));
        expect(parsed.status).toBe("unknown");
      });

      it("agy probe uses the LLM parse when geminiApiKey is set", async () => {
        const fx = readFileSync(join(__dirname, "fixtures", "agy-usage.txt"), "utf-8");
        // Stub the LLM to read the GEMINI weekly window as exhausted; the
        // assertion can only pass if the live path routed through
        // parseQuotaWithLlm (agy has no non-LLM parse path at all).
        mockGenerateContent.mockResolvedValue({
          text: () =>
            JSON.stringify({
              status: "exhausted",
              windows: [
                {
                  label: "Weekly",
                  kind: "weekly",
                  usedPercent: 100,
                  resetAtIso: "2026-07-20T00:00:00.000Z",
                  scope: "provider",
                },
                {
                  label: "Five Hour Limit",
                  kind: "five_hour",
                  usedPercent: 100,
                  resetAtIso: "2026-07-22T22:00:00.000Z",
                  scope: "provider",
                },
              ],
            }),
        });
        const scrapeAgyUsage = vi.fn().mockResolvedValue(fx);

        const server = createQuotaMcpServer({
          config: { ...mockConfig, geminiApiKey: "test-gemini-key" },
          workersDir: "/tmp/workers",
          scrapeAgyUsage,
        });
        const client = await connect(server);
        const result = (await client.callTool({
          name: "get_quota",
          arguments: { provider: "agy" },
        })) as CallToolResult;

        expect(mockGenerateContent).toHaveBeenCalledTimes(1);
        const lastCallArgs = mockGenerateContent.mock.calls[0][0] as { model: string };
        expect(lastCallArgs.model).toBe("gemini-3.5-flash-lite");
        const parsed = JSON.parse(textOf(result));
        expect(parsed.status).toBe("exhausted");
      });

      it("fails closed (no LLM call, no fabricated reading) when geminiApiKey is absent", async () => {
        // mockConfig has no geminiApiKey — there is no regex fallback anymore,
        // so the probe must degrade to an honest unknown rather than guess.
        const server = createQuotaMcpServer({
          config: mockConfig,
          workersDir: "/tmp/workers",
          resolveProvider: mockResolveProvider,
        });
        const client = await connect(server);
        const result = (await client.callTool({
          name: "get_quota",
          arguments: { provider: "claude" },
        })) as CallToolResult;

        expect(mockGenerateContent).not.toHaveBeenCalled();
        const parsed = JSON.parse(textOf(result));
        expect(parsed.status).toBe("unknown");
        expect(parsed.message).toBe("no geminiApiKey configured for LLM quota parsing");
        expect(parsed.limits).toBeUndefined();
      });
    });

    describe("codex interactive /status probe", () => {
      const fx = (name: string) => readFileSync(join(__dirname, "fixtures", name), "utf-8");

      beforeEach(() => {
        mockGenerateContent.mockReset();
      });

      it("returns a real remaining-quota reading from the healthy /status scrape", async () => {
        const scrapeCodexStatus = vi.fn().mockResolvedValue(fx("codex-status-healthy.txt"));
        mockGenerateContent.mockResolvedValue({
          text: () =>
            JSON.stringify({
              status: "available",
              windows: [
                { label: "5h", kind: "five_hour", usedPercent: 1, resetInIso: "PT23H32M" },
                {
                  label: "Weekly",
                  kind: "weekly",
                  usedPercent: 7,
                  resetAtIso: "2026-07-14T12:34:00.000Z",
                },
              ],
            }),
        });
        const server = createQuotaMcpServer({
          config: { ...mockConfig, geminiApiKey: "test-gemini-key" },
          workersDir: "/tmp/workers",
          resolveProvider: mockResolveProvider,
          scrapeCodexStatus,
        });
        const client = await connect(server);
        const result = (await client.callTool({
          name: "get_quota",
          arguments: { provider: "codex" },
        })) as CallToolResult;

        const parsed = JSON.parse(textOf(result));
        expect(parsed.provider).toBe("codex");
        expect(parsed.status).toBe("available");
        // Both windows (5h + Weekly) carried through, not just the binding one .
        expect(parsed.limits).toHaveLength(2);
        expect(parsed.limits[0]).toMatchObject({ label: "5h", kind: "five_hour", percentLeft: 99 });
        expect(parsed.limits[1]).toMatchObject({
          label: "Weekly",
          kind: "weekly",
          percentLeft: 93,
          resetAtIso: "2026-07-14T12:34:00.000Z",
        });
        // Scrape ran in the codex probe worktree, and NOT via the generic provider.run seam.
        expect(scrapeCodexStatus).toHaveBeenCalledTimes(1);
        expect(scrapeCodexStatus.mock.calls[0][0].actorDir).toBe("/tmp/workers/quota-probe-codex");
        expect(mockCodexProvider.run).not.toHaveBeenCalled();
      });

      it("reports exhausted from the exhausted /status scrape", async () => {
        const scrapeCodexStatus = vi.fn().mockResolvedValue(fx("codex-status-exhausted.txt"));
        mockGenerateContent.mockResolvedValue({
          text: () =>
            JSON.stringify({
              status: "exhausted",
              windows: [
                {
                  label: "Weekly",
                  kind: "weekly",
                  usedPercent: 100,
                  resetAtIso: "2026-07-07T12:25:00.000Z",
                },
              ],
            }),
        });
        const server = createQuotaMcpServer({
          config: { ...mockConfig, geminiApiKey: "test-gemini-key" },
          workersDir: "/tmp/workers",
          resolveProvider: mockResolveProvider,
          scrapeCodexStatus,
        });
        const client = await connect(server);
        const result = (await client.callTool({
          name: "get_quota",
          arguments: { provider: "codex" },
        })) as CallToolResult;

        const parsed = JSON.parse(textOf(result));
        expect(parsed.status).toBe("exhausted");
        expect(parsed.limits).toEqual([
          {
            label: "Weekly",
            kind: "weekly",
            percentLeft: 0,
            resetAtIso: "2026-07-07T12:25:00.000Z",
            scope: { provider: "codex" },
          },
        ]);
      });

      it("degrades to unknown (never a fabricated reading) when the scrape fails", async () => {
        const scrapeCodexStatus = vi.fn().mockRejectedValue(new Error("bwrap: no PTY"));
        const server = createQuotaMcpServer({
          config: mockConfig,
          workersDir: "/tmp/workers",
          resolveProvider: mockResolveProvider,
          scrapeCodexStatus,
        });
        const client = await connect(server);
        const result = (await client.callTool({
          name: "get_quota",
          arguments: { provider: "codex" },
        })) as CallToolResult;

        const parsed = JSON.parse(textOf(result));
        expect(parsed.status).toBe("unknown");
        expect(parsed.message).toContain("scrape failed");
      });
    });

    describe("agy and kimi custom probes", () => {
      it("probes agy /usage but fails closed without a geminiApiKey (LLM-only parsing)", async () => {
        const fx = readFileSync(join(__dirname, "fixtures", "agy-usage.txt"), "utf-8");
        const scrapeAgyUsage = vi.fn().mockResolvedValue(fx);
        const server = createQuotaMcpServer({
          config: mockConfig,
          workersDir: "/tmp/workers",
          scrapeAgyUsage,
        });
        const client = await connect(server);
        const result = (await client.callTool({
          name: "get_quota",
          arguments: { provider: "agy" },
        })) as CallToolResult;

        const parsed = JSON.parse(textOf(result));
        expect(parsed.provider).toBe("agy");
        // agy's TUI is never regex-parsed — without a key there is no reading.
        expect(parsed.status).toBe("unknown");
        expect(parsed.message).toBe("no geminiApiKey configured for LLM quota parsing");
        expect(parsed.limits).toBeUndefined();
        expect(scrapeAgyUsage.mock.calls[0][0].actorDir).toBe("/tmp/workers/quota-probe-agy");
      });

      it("degrades agy to unknown (never a fabricated reading) when the scrape fails", async () => {
        const scrapeAgyUsage = vi.fn().mockRejectedValue(new Error("could not open TTY"));
        const server = createQuotaMcpServer({
          config: mockConfig,
          workersDir: "/tmp/workers",
          scrapeAgyUsage,
        });
        const client = await connect(server);
        const result = (await client.callTool({
          name: "get_quota",
          arguments: { provider: "agy" },
        })) as CallToolResult;

        const parsed = JSON.parse(textOf(result));
        expect(parsed.status).toBe("unknown");
        expect(parsed.message).toContain("scrape failed");
      });

      it("probes kimi /usage through the pty scrape and LLM parser", async () => {
        const fx = readFileSync(join(__dirname, "fixtures", "kimi-usage-expected.txt"), "utf-8");
        const scrapeKimiUsage = vi.fn().mockResolvedValue(fx);
        mockGenerateContent.mockReset();
        mockGenerateContent.mockResolvedValue({
          text: () =>
            JSON.stringify({
              status: "available",
              windows: [
                { label: "5h", kind: "five_hour", usedPercent: 28, resetInIso: "PT3H10M" },
                {
                  label: "Weekly",
                  kind: "weekly",
                  usedPercent: 50,
                  resetInIso: "P2DT22H",
                },
              ],
            }),
        });

        const server = createQuotaMcpServer({
          config: { ...mockConfig, geminiApiKey: "test-gemini-key" },
          workersDir: "/tmp/workers",
          scrapeKimiUsage,
        });
        const client = await connect(server);
        const result = (await client.callTool({
          name: "get_quota",
          arguments: { provider: "kimi" },
        })) as CallToolResult;

        expect(scrapeKimiUsage).toHaveBeenCalledTimes(1);
        expect(scrapeKimiUsage.mock.calls[0][0].actorDir).toBe("/tmp/workers/quota-probe-kimi");
        expect(mockGenerateContent).toHaveBeenCalledTimes(1);
        const parsed = JSON.parse(textOf(result));
        expect(parsed.provider).toBe("kimi");
        expect(parsed.status).toBe("available");
        expect(parsed.limits).toMatchObject([
          { label: "5h", kind: "five_hour", percentLeft: 72 },
          { label: "Weekly", kind: "weekly", percentLeft: 50 },
        ]);
        expect(parsed.limits[0].resetAtIso).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        expect(parsed.limits[1].resetAtIso).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        expect(parsed.raw).toBe(fx);
      });

      it("degrades kimi to unknown when the pty scrape fails", async () => {
        const scrapeKimiUsage = vi.fn().mockRejectedValue(new Error("could not open TTY"));
        const server = createQuotaMcpServer({
          config: { ...mockConfig, geminiApiKey: "test-gemini-key" },
          workersDir: "/tmp/workers",
          scrapeKimiUsage,
        });
        const client = await connect(server);
        const result = (await client.callTool({
          name: "get_quota",
          arguments: { provider: "kimi" },
        })) as CallToolResult;

        const parsed = JSON.parse(textOf(result));
        expect(parsed.provider).toBe("kimi");
        expect(parsed.status).toBe("unknown");
        expect(parsed.message).toContain("kimi /usage scrape failed");
      });

      it("fails closed on kimi auth screens without raw output or LLM parsing", async () => {
        const scrapeKimiUsage = vi.fn().mockRejectedValue(new KimiAuthRequiredError());
        mockGenerateContent.mockReset();

        const server = createQuotaMcpServer({
          config: { ...mockConfig, geminiApiKey: "test-gemini-key" },
          workersDir: "/tmp/workers",
          scrapeKimiUsage,
        });
        const client = await connect(server);
        const result = (await client.callTool({
          name: "get_quota",
          arguments: { provider: "kimi" },
        })) as CallToolResult;

        expect(scrapeKimiUsage).toHaveBeenCalledOnce();
        expect(mockGenerateContent).not.toHaveBeenCalled();
        const parsed = JSON.parse(textOf(result));
        expect(parsed.provider).toBe("kimi");
        expect(parsed.status).toBe("unknown");
        expect(parsed.message).toBe("kimi CLI is not authenticated (login screen detected)");
        expect(parsed.raw).toBeUndefined();
      });

      it("fails closed before scraping kimi when the semantic evaluator has no key", async () => {
        const scrapeKimiUsage = vi.fn();
        mockGenerateContent.mockReset();

        const server = createQuotaMcpServer({
          config: mockConfig,
          workersDir: "/tmp/workers",
          scrapeKimiUsage,
        });
        const client = await connect(server);
        const result = (await client.callTool({
          name: "get_quota",
          arguments: { provider: "kimi" },
        })) as CallToolResult;

        expect(scrapeKimiUsage).not.toHaveBeenCalled();
        expect(mockGenerateContent).not.toHaveBeenCalled();
        const parsed = JSON.parse(textOf(result));
        expect(parsed.provider).toBe("kimi");
        expect(parsed.status).toBe("unknown");
        expect(parsed.message).toBe("no geminiApiKey configured for LLM quota parsing");
        expect(parsed.raw).toBeUndefined();
      });

      it("does not attempt any credential-file or HTTP OAuth dependency for kimi", async () => {
        const fx = readFileSync(join(__dirname, "fixtures", "kimi-usage-expected.txt"), "utf-8");
        const scrapeKimiUsage = vi.fn().mockResolvedValue(fx);
        mockGenerateContent.mockReset();
        mockGenerateContent.mockResolvedValue({
          text: () =>
            JSON.stringify({
              status: "available",
              windows: [{ label: "Weekly", kind: "weekly", usedPercent: 50, resetInIso: "P2D" }],
            }),
        });

        const server = createQuotaMcpServer({
          config: { ...mockConfig, geminiApiKey: "test-gemini-key" },
          workersDir: "/tmp/workers",
          scrapeKimiUsage,
        });
        const client = await connect(server);
        await client.callTool({
          name: "get_quota",
          arguments: { provider: "kimi" },
        });

        expect(scrapeKimiUsage).toHaveBeenCalledOnce();
      });

      describe("routing through QuotaCoordinatorClient (§12 item 4, issue #356, criterion 15)", () => {
        let root: string | undefined;
        let server: http.Server | undefined;

        async function listen(socketPath: string, handler: http.RequestListener): Promise<void> {
          server = http.createServer(handler);
          await new Promise<void>((resolve, reject) => {
            server?.once("error", reject);
            server?.listen(socketPath, resolve);
          });
        }

        async function stopServer(): Promise<void> {
          const running = server;
          server = undefined;
          if (!running?.listening) return;
          running.closeAllConnections?.();
          await new Promise<void>((resolve, reject) => {
            running.close((err) => (err ? reject(err) : resolve()));
          });
        }

        afterEach(async () => {
          await stopServer();
          if (root) {
            rmSync(root, { recursive: true, force: true });
            root = undefined;
          }
        });

        it("with coordinator socket present: get_quota answers from GET /v1/quota and triggers 0 probes", async () => {
          root = mkdtempSync(join(tmpdir(), "quota-mcp-crit15-live-"));
          const socketPath = join(root, "coordinator.sock");
          let coordinatorQueried = false;

          await listen(socketPath, (req, res) => {
            if (req.method === "GET" && req.url === "/v1/quota?provider=claude") {
              coordinatorQueried = true;
              res.setHeader("content-type", "application/json");
              res.end(
                JSON.stringify({
                  service: {
                    protocolMajor: COORDINATOR_PROTOCOL_MAJOR,
                    protocolMinor: COORDINATOR_PROTOCOL_MINOR,
                    serverVersion: "test",
                    serverTime: new Date(0).toISOString(),
                  },
                  provider: "claude",
                  status: "available",
                  scrapedAt: new Date(0).toISOString(),
                  limits: [
                    {
                      label: "Weekly",
                      kind: "weekly",
                      percentLeft: 75,
                    },
                  ],
                })
              );
              return;
            }
            res.statusCode = 404;
            res.end();
          });

          const coordinatorClient = new QuotaCoordinatorClient({
            socketPath,
            configuredProviders: ["claude", "codex"],
          });

          const mcpServer = createQuotaMcpServer({
            config: mockConfig,
            workersDir: "/tmp/workers",
            resolveProvider: mockResolveProvider,
            coordinatorClient,
          });

          const client = await connect(mcpServer);
          const result = (await client.callTool({
            name: "get_quota",
            arguments: { provider: "claude" },
          })) as CallToolResult;

          expect(coordinatorQueried).toBe(true);
          // Triggers 0 probes: mockClaudeProvider.run must not be called!
          expect(mockClaudeProvider.run).toHaveBeenCalledTimes(0);

          const parsed = JSON.parse(textOf(result));
          expect(parsed.status).toBe("available");
          expect(parsed.provider).toBe("claude");
          expect(parsed.limits?.[0].percentLeft).toBe(75);
        });

        it("with service cold (or socket absent): returns status unknown with freshness block, triggering 0 probes", async () => {
          root = mkdtempSync(join(tmpdir(), "quota-mcp-crit15-cold-"));
          const socketPath = join(root, "absent-coordinator.sock");

          const coordinatorClient = new QuotaCoordinatorClient({
            socketPath,
            configuredProviders: ["claude", "codex"],
          });

          const mcpServer = createQuotaMcpServer({
            config: mockConfig,
            workersDir: "/tmp/workers",
            resolveProvider: mockResolveProvider,
            coordinatorClient,
          });

          const client = await connect(mcpServer);
          const result = (await client.callTool({
            name: "get_quota",
            arguments: { provider: "claude" },
          })) as CallToolResult;

          // Triggers 0 probes: mockClaudeProvider.run must not be called!
          expect(mockClaudeProvider.run).toHaveBeenCalledTimes(0);

          // Does not return an error; returns toolOk with unknown + freshness block
          expect(result.isError).toBeFalsy();
          const parsed = JSON.parse(textOf(result));
          expect(parsed.status).toBe("unknown");
          expect(parsed.provider).toBe("claude");
          expect(parsed.freshness).toBeDefined();
          expect(parsed.freshness.stale).toBe(true);
          expect(parsed.freshness.hardStale).toBe(true);
        });

        it("admitted but unconfigured provider: returns status unsupported without error, triggering 0 probes", async () => {
          root = mkdtempSync(join(tmpdir(), "quota-mcp-crit15-unsupp-"));
          const socketPath = join(root, "coordinator.sock");

          const coordinatorClient = new QuotaCoordinatorClient({
            socketPath,
            configuredProviders: ["claude"],
          });

          const mcpServer = createQuotaMcpServer({
            config: {
              ...mockConfig,
              providers: { claude: { cliCommand: "claude" } },
            } as unknown as RusaConfig,
            workersDir: "/tmp/workers",
            resolveProvider: mockResolveProvider,
            coordinatorClient,
          });

          const client = await connect(mcpServer);
          // "codex" is admitted by provider schema / type, but not in config.providers
          const result = (await client.callTool({
            name: "get_quota",
            arguments: { provider: "codex" },
          })) as CallToolResult;

          expect(mockClaudeProvider.run).toHaveBeenCalledTimes(0);
          expect(mockCodexProvider.run).toHaveBeenCalledTimes(0);
          expect(result.isError).toBeFalsy();
          const parsed = JSON.parse(textOf(result));
          expect(parsed.status).toBe("unsupported");
          expect(parsed.provider).toBe("codex");
          expect(parsed.message).toContain("is not configured");
        });
      });

      it("parses Claude quota from newly banked /usage screen scrape fixture file", async () => {
        const fixturePath = join(__dirname, "fixtures", "claude-usage.txt");
        const content = readFileSync(fixturePath, "utf-8");

        mockGenerateContent.mockResolvedValue({
          text: () =>
            JSON.stringify({
              status: "available",
              windows: [
                {
                  label: "Session",
                  kind: "session",
                  usedPercent: 12,
                  resetInIso: "PT4H12M",
                  scope: "provider",
                },
                {
                  label: "Weekly",
                  kind: "weekly",
                  usedPercent: 45,
                  resetAtIso: "2026-07-13T02:59:00.000Z",
                  scope: "provider",
                },
              ],
            }),
        });

        const parsed = await parseClaudeQuota(content, "test-key");
        expect(parsed.status).toBe("available");
        expect(parsed.limits).toHaveLength(2);
        expect(parsed.limits?.[0]).toMatchObject({
          label: "Session",
          kind: "session",
          percentLeft: 88,
          scope: { provider: "claude" },
        });
        expect(parsed.limits?.[0].resetAtIso).toBeDefined();
        expect(parsed.limits?.[1]).toMatchObject({
          label: "Weekly",
          kind: "weekly",
          percentLeft: 55,
          resetAtIso: "2026-07-13T02:59:00.000Z",
          scope: { provider: "claude" },
        });
      });
    });

    describe("inferQuotaState ", () => {
      it("sibling_window_copy: copies resetAtIso from provider window to model window of same kind", () => {
        const nowIso = "2026-08-20T10:00:00.000Z";
        const resetIso = "2026-08-20T15:00:00.000Z";
        const rawState: ProviderQuotaSnapshot = {
          provider: "claude",
          status: "available",
          scrapedAt: nowIso,
          limits: [
            {
              label: "Session (provider)",
              kind: "session",
              percentLeft: 40,
              resetAtIso: resetIso,
              scope: "provider",
            },
            {
              label: "Session (model)",
              kind: "session",
              percentLeft: 30,
              scope: { provider: "claude", models: ["claude-fable"] },
            },
          ],
        };

        const inferred = inferQuotaState(rawState);
        expect(inferred.explanations).toHaveLength(1);
        expect(inferred.explanations?.[0]).toEqual({
          window: "Session (model)",
          field: "resetAtIso",
          rule: "sibling_window_copy",
          detail: "copied from the provider-scope session in the same scrape",
        });
        expect(inferred.limits?.[1].resetAtIso).toBe(resetIso);
      });

      it("assumed_window_starts_now: sets 5h for session/five_hour and 168h for weekly on 100% left with no reset", () => {
        const nowIso = "2026-08-20T10:00:00.000Z";
        const rawState: ProviderQuotaSnapshot = {
          provider: "claude",
          status: "available",
          scrapedAt: nowIso,
          limits: [
            {
              label: "Session",
              kind: "session",
              percentLeft: 100,
            },
            {
              label: "Weekly",
              kind: "weekly",
              percentLeft: 100,
            },
          ],
        };

        const inferred = inferQuotaState(rawState);
        expect(inferred.explanations).toHaveLength(2);
        expect(inferred.explanations?.[0].rule).toBe("assumed_window_starts_now");
        expect(inferred.explanations?.[1].rule).toBe("assumed_window_starts_now");

        const sessionReset = inferred.limits?.find((l) => l.kind === "session")?.resetAtIso;
        const weeklyReset = inferred.limits?.find((l) => l.kind === "weekly")?.resetAtIso;

        // 5 hours = 18000000ms -> 15:00:00.000Z
        expect(sessionReset).toBe("2026-08-20T15:00:00.000Z");
        // 168 hours = 7 days -> 2026-08-27T10:00:00.000Z
        expect(weeklyReset).toBe("2026-08-27T10:00:00.000Z");
      });

      it("carried_forward_bad_read: carries forward unexpired real reset on bad read", () => {
        const t0Iso = "2026-08-20T10:00:00.000Z";
        const resetIso = "2026-08-20T15:00:00.000Z";
        const previousState: ProviderQuotaSnapshot = {
          provider: "claude",
          status: "exhausted",
          scrapedAt: t0Iso,
          limits: [
            {
              label: "Session",
              kind: "session",
              percentLeft: 0,
              resetAtIso: resetIso,
            },
          ],
        };

        const t1Iso = "2026-08-20T12:00:00.000Z";
        const badReadState: ProviderQuotaSnapshot = {
          provider: "claude",
          status: "unknown",
          scrapedAt: t1Iso,
          limits: [],
        };

        const inferred = inferQuotaState(badReadState, previousState, t1Iso);
        expect(inferred.explanations).toHaveLength(1);
        expect(inferred.explanations?.[0].rule).toBe("carried_forward_bad_read");
        expect(inferred.status).toBe("exhausted");
        expect(inferred.limits?.[0].resetAtIso).toBe(resetIso);
        expect(inferred.limits?.[0].percentLeft).toBe(0);
      });

      it("carried_forward_bad_read: never promotes model-only history into provider availability", () => {
        const t0Iso = "2026-08-20T10:00:00.000Z";
        const t1Iso = "2026-08-20T12:00:00.000Z";
        const previousState: ProviderQuotaSnapshot = {
          provider: "claude",
          status: "available",
          scrapedAt: t0Iso,
          limits: [
            {
              label: "Fable weekly",
              kind: "weekly",
              percentLeft: 80,
              resetAtIso: "2026-08-27T10:00:00.000Z",
              scope: { provider: "claude", models: ["claude-fable"] },
            },
          ],
        };

        expect(
          inferQuotaState(
            { provider: "claude", status: "unknown", scrapedAt: t1Iso, limits: [] },
            previousState,
            t1Iso
          )
        ).toMatchObject({ status: "unknown", limits: [] });
      });

      it("carried_forward_bad_read: carries forward unexpired resetAtIso when subsequent parse misses reset timestamp for an active window ", () => {
        const t0Iso = "2026-08-20T10:00:00.000Z";
        const resetIso = "2026-08-20T15:00:00.000Z";
        const previousState: ProviderQuotaSnapshot = {
          provider: "claude",
          status: "available",
          scrapedAt: t0Iso,
          limits: [
            {
              label: "Session",
              kind: "session",
              percentLeft: 40,
              resetAtIso: resetIso,
              scope: "provider",
            },
          ],
        };

        const t1Iso = "2026-08-20T12:00:00.000Z";
        const partialState: ProviderQuotaSnapshot = {
          provider: "claude",
          status: "available",
          scrapedAt: t1Iso,
          limits: [
            {
              label: "Session",
              kind: "session",
              percentLeft: 50,
              scope: "provider",
            },
          ],
        };

        const inferred = inferQuotaState(partialState, previousState, t1Iso);
        expect(inferred.explanations).toHaveLength(1);
        expect(inferred.explanations?.[0].rule).toBe("carried_forward_bad_read");
        expect(inferred.limits?.[0].percentLeft).toBe(50);
        expect(inferred.limits?.[0].resetAtIso).toBe(resetIso);
      });

      it("REQUIRED HAZARD: inferred reset from assumed_window_starts_now is NEVER carried forward across bad reads", () => {
        // T0 = 10:00:00Z: Fresh window (100% left, no reset) -> assumed reset is 15:00:00Z
        const t0Iso = "2026-08-20T10:00:00.000Z";
        const stateT0: ProviderQuotaSnapshot = {
          provider: "claude",
          status: "available",
          scrapedAt: t0Iso,
          limits: [
            {
              label: "Session",
              kind: "session",
              percentLeft: 100,
            },
          ],
        };

        const inferredT0 = inferQuotaState(stateT0);
        expect(inferredT0.limits?.[0].resetAtIso).toBe("2026-08-20T15:00:00.000Z");

        // T1 = 12:00:00Z (+2h): Bad read (status: unknown)
        const t1Iso = "2026-08-20T12:00:00.000Z";
        const badReadT1: ProviderQuotaSnapshot = {
          provider: "claude",
          status: "unknown",
          scrapedAt: t1Iso,
          limits: [],
        };

        // Assert: 15:00:00Z is NOT carried forward
        const inferredT1 = inferQuotaState(badReadT1, inferredT0);
        expect(inferredT1.explanations?.some((e) => e.rule === "carried_forward_bad_read")).toBe(
          false
        );
        expect(inferredT1.limits ?? []).toHaveLength(0);

        // If T1 was a valid scrape with 100% left, reset moves with clock (12:00 + 5h = 17:00:00Z), NOT fixed at 15:00:00Z
        const stateT1Fresh: ProviderQuotaSnapshot = {
          provider: "claude",
          status: "available",
          scrapedAt: t1Iso,
          limits: [
            {
              label: "Session",
              kind: "session",
              percentLeft: 100,
            },
          ],
        };
        const inferredT1Fresh = inferQuotaState(stateT1Fresh, inferredT0);
        expect(inferredT1Fresh.limits?.[0].resetAtIso).toBe("2026-08-20T17:00:00.000Z");
      });

      it("carried_forward_bad_read: Step 3 matches explicit scope 'provider' with undefined scope", () => {
        const t0Iso = "2026-08-26T10:00:00.000Z";
        const unexpiredResetIso = "2026-08-26T15:00:00.000Z";
        const prevState: ProviderQuotaSnapshot = {
          provider: "codex",
          status: "available",
          scrapedAt: t0Iso,
          limits: [
            {
              label: "Weekly limit",
              kind: "weekly",
              percentLeft: 50,
              resetAtIso: unexpiredResetIso,
              scope: "provider",
            },
          ],
        };

        const t1Iso = "2026-08-26T11:00:00.000Z";
        // Current state parsed Weekly limit without resetAtIso and scope undefined
        const currentState: ProviderQuotaSnapshot = {
          provider: "codex",
          status: "available",
          scrapedAt: t1Iso,
          limits: [
            {
              label: "Weekly limit",
              kind: "weekly",
              percentLeft: 45,
              scope: undefined,
            },
          ],
        };

        const inferred = inferQuotaState(currentState, prevState, t1Iso);
        expect(inferred.limits?.[0].resetAtIso).toBe(unexpiredResetIso);
        expect(inferred.explanations).toEqual([
          {
            window: "Weekly limit",
            field: "resetAtIso",
            rule: "carried_forward_bad_read",
            detail: "carried forward previous unexpired window reset after missing reading",
          },
        ]);
      });

      it("carried_forward_bad_read: Step 3 never crosses canonical model window scopes", () => {
        const t0Iso = "2026-08-26T10:00:00.000Z";
        const fableResetIso = "2026-08-26T15:00:00.000Z";
        const sparkResetIso = "2026-08-26T16:00:00.000Z";
        const prevState: ProviderQuotaSnapshot = {
          provider: "claude",
          status: "available",
          scrapedAt: t0Iso,
          limits: [
            {
              label: "Fable Weekly",
              kind: "weekly",
              percentLeft: 50,
              resetAtIso: fableResetIso,
              scope: { provider: "claude", models: ["claude-fable"] },
            },
            {
              label: "Spark Weekly",
              kind: "weekly",
              percentLeft: 50,
              resetAtIso: sparkResetIso,
              scope: { provider: "claude", models: ["claude-spark"] },
            },
          ],
        };

        const t1Iso = "2026-08-26T11:00:00.000Z";
        const currentState: ProviderQuotaSnapshot = {
          provider: "claude",
          status: "available",
          scrapedAt: t1Iso,
          limits: [
            {
              label: "Spark Weekly",
              kind: "weekly",
              percentLeft: 45,
              scope: { provider: "claude", models: ["claude-spark"] },
            },
          ],
        };

        const inferred = inferQuotaState(currentState, prevState, t1Iso);
        expect(inferred.limits?.[0].resetAtIso).toBe(sparkResetIso);
      });

      it("carried_forward_bad_read: Step 3 never crosses providers", () => {
        const previousState: ProviderQuotaSnapshot = {
          provider: "claude",
          status: "available",
          limits: [
            {
              label: "Weekly",
              kind: "weekly",
              percentLeft: 50,
              resetAtIso: "2026-08-26T15:00:00.000Z",
              scope: { provider: "claude" },
            },
          ],
        };
        const currentState: ProviderQuotaSnapshot = {
          provider: "codex",
          status: "available",
          limits: [
            {
              label: "Weekly",
              kind: "weekly",
              percentLeft: 45,
              scope: { provider: "codex" },
            },
          ],
        };

        const inferred = inferQuotaState(currentState, previousState, "2026-08-26T11:00:00.000Z");
        expect(inferred.limits?.[0].resetAtIso).toBeUndefined();
      });

      it("invariant: empty explanations list => inferred_parsed_state equals parsed_state", () => {
        const rawState: ProviderQuotaSnapshot = {
          provider: "claude",
          status: "available",
          scrapedAt: "2026-08-20T10:00:00.000Z",
          limits: [
            {
              label: "Weekly",
              kind: "weekly",
              percentLeft: 40,
              resetAtIso: "2026-08-27T10:00:00.000Z",
              scope: "provider",
            },
          ],
        };

        const inferred = inferQuotaState(rawState);
        expect(inferred.explanations).toEqual([]);
        expect(inferred).toEqual({ ...rawState, explanations: [] });
      });
    });
  });
});
