import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
import { KimiAuthRequiredError } from "../providers/kimi-usage-scrape.js";
import { clearProviderModelCatalog, setProviderModelCatalog } from "../providers/model-catalog.js";
import { buildActorBwrapArgs } from "../providers/sandbox.js";
import type { CodingProvider } from "../providers/types.js";
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
          scope: undefined,
        },
      ]);

      expect(mockGenerateContent).toHaveBeenCalled();
      const lastCallArgs = mockGenerateContent.mock.calls[0][0] as {
        model: string;
        contents: string;
        config: {
          responseSchema: {
            properties: Record<string, unknown>;
          };
        };
      };
      expect(lastCallArgs.model).toBe("gemini-3.5-flash-lite");
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
      expect(systemInstruction).toContain("For Claude:");
      expect(systemInstruction).toContain("session/week usage windows");
      expect(systemInstruction).toContain("The current local time");
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
        // `status` is the one required top-level reading — it must stay in the
        // schema even though all other headline fields moved into `limits`.
        expect(required).toEqual(["status"]);
        expect(properties.status).toBeDefined();
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
        },
      ]);
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

    it("drops an unrecognized/missing LLM kind to undefined rather than guessing ", async () => {
      mockGenerateContent.mockResolvedValue({
        text: () =>
          JSON.stringify({
            status: "available",
            windows: [{ label: "Mystery Window", kind: "bogus", usedPercent: 0 }],
          }),
      });

      const parsed = await parseClaudeQuota("Claude output here", "test-key");
      expect(parsed.limits?.[0]?.kind).toBeUndefined();
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

    it("requires the LLM to classify each window's scope ", async () => {
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
      expect(windowSchema.properties.scope?.enum).toEqual(["provider", "model"]);
      expect(windowSchema.required).toContain("scope");
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
              scope: undefined,
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
              status: "available",
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
        expect(parsed.status).toBe("available");
        expect(parsed).not.toHaveProperty("groups");

        expect(parsed.limits).toEqual([
          {
            label: "Weekly GEMINI MODELS",
            kind: "weekly",
            percentLeft: 0,
            resetAtIso: new Date(generatedAt.getTime() + (70 * 60 + 13) * 60_000).toISOString(),
            scope: "provider",
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

    it("parses agy quota fail-closed when windows are absent", async () => {
      mockGenerateContent.mockResolvedValue({
        text: () =>
          JSON.stringify({
            status: "available",
          }),
      });
      const parsed = await parseAgyQuota("agy usage output here", "test-key");
      expect(parsed.status).toBe("available");
      expect(parsed.limits).toBeUndefined();
    });

    it("scopes the agy LLM prompt to the agy quota clause", async () => {
      mockGenerateContent.mockResolvedValue({
        text: () => JSON.stringify({ status: "available", windows: [] }),
      });

      await parseAgyQuota("agy usage output here", "test-key");

      const systemInstruction = lastSystemInstruction();
      expect(systemInstruction).toContain("You are a precise quota parser");
      expect(systemInstruction).toContain("For agy:");
      expect(systemInstruction).toContain("reports quota REMAINING");
      expect(systemInstruction).toContain("usedPercent = 100 - N");
      expect(systemInstruction).toContain("The current local time");
      expect(systemInstruction).not.toContain("For Claude:");
      expect(systemInstruction).not.toContain("For Codex:");
      expect(systemInstruction).not.toContain("session/week usage windows");
      expect(systemInstruction).not.toContain("refresh requested");
    });

    it("never surfaces a non-GEMINI (CLAUDE_GPT) group — guards the ISSUE_NUM regression", async () => {
      // ISSUE_NUM (reverted here) re-added agy CLAUDE_GPT scraping that 64c6700d
      // had deliberately removed: it rewrote the agy prompt to populate a
      // `groups[]` array with a CLAUDE_GPT entry and mapped that onto the
      // snapshot. Operator's ruling — agy is gemini-only; we do not dispatch to or
      // scrape non-gemini models. This guards BOTH layers the regression
      // touched: the prompt must still tell the LLM to OMIT the CLAUDE AND GPT
      // MODELS section, and the mapping must drop any rogue CLAUDE_GPT payload
      // on the floor rather than surface it. The guard lives at the producer
      // (MCP/snapshot) layer — where ISSUE_NUM re-added the shape — not one layer
      // above at the dashboard DTO, which is why the existing dashboard test
      // never tripped.
      mockGenerateContent.mockResolvedValue({
        text: () =>
          JSON.stringify({
            status: "available",
            windows: [
              {
                label: "Weekly GEMINI MODELS",
                kind: "weekly",
                usedPercent: 20,
                resetInIso: "PT70H13M",
                scope: "provider",
              },
            ],
            // A ISSUE_NUM-shaped rogue payload: even if a future LLM emits a
            // CLAUDE_GPT group, the mapping must never let it reach the snapshot.
            groups: [
              {
                model: "CLAUDE_GPT",
                limits: [{ label: "Weekly", kind: "weekly", percentLeft: 50 }],
              },
            ],
          }),
      });

      const parsed = await parseAgyQuota("agy usage output here", "test-key");

      // Mapping layer: the banned shape never reaches the snapshot, and only the
      // GEMINI provider-scoped window survives — nothing CLAUDE_GPT.
      expect(parsed).not.toHaveProperty("groups");
      expect(parsed.limits).toEqual([
        expect.objectContaining({ label: "Weekly GEMINI MODELS", scope: "provider" }),
      ]);
      expect(JSON.stringify(parsed)).not.toContain("CLAUDE_GPT");

      // Prompt layer: the guard clause ISSUE_NUM overwrote must still be present,
      // the banned group vocabulary must be absent, and the output schema must
      // not offer the LLM a `groups` field to fill.
      const systemInstruction = lastSystemInstruction();
      expect(systemInstruction).toContain("Omit every other section (e.g. CLAUDE AND GPT MODELS)");
      expect(systemInstruction).not.toContain("CLAUDE_GPT");
      const lastCallArgs = mockGenerateContent.mock.calls[0][0] as {
        config: { responseSchema: { properties: Record<string, unknown> } };
      };
      expect(lastCallArgs.config.responseSchema.properties.groups).toBeUndefined();
    });

    it("scopes the Kimi LLM prompt to Kimi /usage and remaining-percent semantics", async () => {
      mockGenerateContent.mockResolvedValue({
        text: () => JSON.stringify({ status: "available", windows: [] }),
      });

      await parseKimiQuota("Kimi Code Platform Usage\nWeekly limit 50% left", "test-key");

      const systemInstruction = lastSystemInstruction();
      expect(systemInstruction).toContain("You are a precise quota parser");
      expect(systemInstruction).toContain("For Kimi:");
      expect(systemInstruction).toContain("interactive /usage panel");
      expect(systemInstruction).toContain("reports quota LEFT/REMAINING");
      expect(systemInstruction).toContain("usedPercent = 100 - N");
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
          },
          {
            label: "Weekly",
            kind: "weekly",
            percentLeft: 50,
            resetAtIso: new Date(generatedAt.getTime() + (2 * 24 + 22) * 3_600_000).toISOString(),
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

      const parsed = await parseAgyQuota("CLAUDE AND GPT MODELS Weekly 3% remaining", "test-key");
      const weekly = parsed.limits?.[0];
      expect(weekly?.percentLeft).toBe(3);
      expect(weekly?.scope).toBe("provider");
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

    it("fail-loud gate: allows model-scope window with percentLeft < 100 missing reset when provider sibling has reset ", async () => {
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
                scope: "model",
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
          scope: "provider",
        },
        {
          label: "Sonnet (weekly)",
          kind: "weekly",
          percentLeft: 60,
          resetAtIso: undefined,
          scope: "model",
        },
      ]);
    });

    it("fail-loud gate: fails loud when model-scope window has percentLeft < 100 and no provider sibling has reset ", async () => {
      mockGenerateContent.mockResolvedValue({
        text: () =>
          JSON.stringify({
            status: "available",
            windows: [
              {
                label: "Sonnet (weekly)",
                kind: "weekly",
                usedPercent: 40,
                scope: "model",
              },
            ],
          }),
      });

      const parsed = await parseClaudeQuota("Sonnet: 40% used", "test-key");
      expect(parsed.status).toBe("unknown");
      expect(parsed.message).toContain("percentLeft < 100");
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
          scope: undefined,
        },
      ]);
    });

    it("completeness gate: fails loud with unknown status and error message when Codex raw output contains 'Weekly limit:' but LLM omits it", async () => {
      mockGenerateContent.mockResolvedValue({
        text: () =>
          JSON.stringify({
            status: "available",
            windows: [
              {
                label: "5h limit",
                kind: "five_hour",
                usedPercent: 0,
              },
            ],
          }),
      });

      const rawCodexOutput =
        "5h limit: [████████████████████] 100% left (resets 23:32)\n" +
        "Weekly limit: [███████████████████░] 93% left (resets 12:34 on 14 Jul)";

      const parsed = await parseCodexQuota(rawCodexOutput, "test-key");
      expect(mockGenerateContent).toHaveBeenCalledTimes(2); // failed on attempt 1, retried, failed on attempt 2
      expect(parsed.status).toBe("unknown");
      expect(parsed.message).toContain("Quota parse incomplete");
      expect(parsed.message).toContain("Weekly limit:");
    });

    it("completeness gate: fails loud with unknown status when Codex raw output contains '5h limit:' but LLM omits it", async () => {
      mockGenerateContent.mockResolvedValue({
        text: () =>
          JSON.stringify({
            status: "available",
            windows: [
              {
                label: "Weekly limit",
                kind: "weekly",
                usedPercent: 7,
                resetAtIso: "2026-07-14T12:34:00.000Z",
              },
            ],
          }),
      });

      const rawCodexOutput =
        "5h limit: [████████████████████] 100% left (resets 23:32)\n" +
        "Weekly limit: [███████████████████░] 93% left (resets 12:34 on 14 Jul)";

      const parsed = await parseCodexQuota(rawCodexOutput, "test-key");
      expect(mockGenerateContent).toHaveBeenCalledTimes(2);
      expect(parsed.status).toBe("unknown");
      expect(parsed.message).toContain("Quota parse incomplete");
      expect(parsed.message).toContain("5h limit:");
    });

    it("completeness gate: retries and succeeds when LLM retry recovers omitted limit rows", async () => {
      // Attempt 1 omits weekly; Attempt 2 includes both 5h and weekly
      mockGenerateContent
        .mockResolvedValueOnce({
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
              ],
            }),
        })
        .mockResolvedValueOnce({
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
                  usedPercent: 48,
                  resetAtIso: "2026-07-14T12:34:00.000Z",
                },
              ],
            }),
        });

      const rawCodexOutput =
        "5h limit: [████████████████████] 99% left (resets 23:32)\n" +
        "Weekly limit: [███████████████████░] 52% left (resets 12:34 on 14 Jul)";

      const parsed = await parseCodexQuota(rawCodexOutput, "test-key");
      expect(mockGenerateContent).toHaveBeenCalledTimes(2);
      expect(parsed.status).toBe("available");
      expect(parsed.limits).toHaveLength(2);
      expect(parsed.limits?.[0]).toMatchObject({ label: "5h limit", percentLeft: 99 });
      expect(parsed.limits?.[1]).toMatchObject({ label: "Weekly limit", percentLeft: 52 });
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
        },
      ]);
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
          { displayLabel: "Gemini Flash", identifier: "gemini-flash", passable: false },
          {
            displayLabel: "Gemini 3.7 Flash (High)",
            identifier: "gemini-3.7-flash",
            passable: true,
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
          { displayLabel: "Gemini Flash", identifier: "gemini-flash", passable: false },
          {
            displayLabel: "Gemini 3.7 Flash (High)",
            identifier: "gemini-3.7-flash",
            passable: true,
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
          { displayLabel: "Gemini Flash", identifier: "gemini-flash", passable: false },
          {
            displayLabel: "Gemini 3.7 Flash (High)",
            identifier: "gemini-3.7-flash",
            passable: true,
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
          },
        ]);
      });

      it("full pipeline: copies reset from provider-scope window to model-scope window and persists raw and inferred states ", async () => {
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
                  scope: "model",
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
        expect(parsed.limits).toHaveLength(2);
        expect(parsed.limits[0]).toMatchObject({
          label: "Weekly",
          kind: "weekly",
          percentLeft: 60,
          resetAtIso: "2026-08-27T10:00:00.000Z",
          scope: "provider",
        });
        expect(parsed.limits[1]).toMatchObject({
          label: "Sonnet (weekly)",
          kind: "weekly",
          percentLeft: 50,
          resetAtIso: "2026-08-27T10:00:00.000Z",
          scope: "model",
        });
        expect(parsed.explanations).toEqual([
          {
            window: "Sonnet (weekly)",
            field: "resetAtIso",
            rule: "sibling_window_copy",
            detail: "copied from the provider-scope weekly in the same scrape",
          },
        ]);

        expect(scrapeStore.recordParsed).toHaveBeenCalledOnce();
        const [scrapeId, rawStateArg, inferredStateArg] = scrapeStore.recordParsed.mock.calls[0];
        expect(scrapeId).toBe("scrape-multi-1");
        // rawState has model window with undefined resetAtIso
        expect(rawStateArg.limits[1].resetAtIso).toBeUndefined();
        // inferredState has model window with copied resetAtIso
        expect(inferredStateArg.limits[1].resetAtIso).toBe("2026-08-27T10:00:00.000Z");
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
          },
          {
            label: "Weekly limit",
            kind: "weekly",
            percentLeft: 58,
            resetAtIso: "2026-07-14T12:34:00.000Z",
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
          scope: "provider",
        });
        expect(parsed.limits?.[0].resetAtIso).toBeDefined();
        expect(parsed.limits?.[1]).toMatchObject({
          label: "Weekly",
          kind: "weekly",
          percentLeft: 55,
          resetAtIso: "2026-07-13T02:59:00.000Z",
          scope: "provider",
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
              scope: "model",
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

      it("carried_forward_bad_read: carries forward unexpired previous window assessment omitted from current parse", () => {
        // T0 = 20:42:00Z: Full parse with both 5h (100%) and weekly (52%, reset 2026-08-27T02:10:00Z)
        const t0Iso = "2026-08-26T20:42:00.000Z";
        const weeklyResetIso = "2026-08-27T02:10:00.000Z";
        const prevState: ProviderQuotaSnapshot = {
          provider: "codex",
          status: "available",
          scrapedAt: t0Iso,
          limits: [
            {
              label: "5h limit",
              kind: "five_hour",
              percentLeft: 100,
              resetAtIso: "2026-08-27T01:42:00.000Z",
              scope: "provider",
            },
            {
              label: "Weekly limit",
              kind: "weekly",
              percentLeft: 52,
              resetAtIso: weeklyResetIso,
              scope: "provider",
            },
          ],
        };

        // T1 = 21:10:00Z: Flaky parse returns only 5h (100%), omitting Weekly limit entirely
        const t1Iso = "2026-08-26T21:10:00.000Z";
        const partialState: ProviderQuotaSnapshot = {
          provider: "codex",
          status: "available",
          scrapedAt: t1Iso,
          limits: [
            {
              label: "5h limit",
              kind: "five_hour",
              percentLeft: 100,
              resetAtIso: "2026-08-27T02:10:00.000Z",
              scope: "provider",
            },
          ],
        };

        const inferred = inferQuotaState(partialState, prevState, t1Iso);
        expect(inferred.limits).toHaveLength(2);
        // Surviving window is preserved
        expect(inferred.limits?.[0]).toMatchObject({
          label: "5h limit",
          kind: "five_hour",
          percentLeft: 100,
        });
        // Omitted unexpired weekly window is carried forward from prevState
        expect(inferred.limits?.[1]).toMatchObject({
          label: "Weekly limit",
          kind: "weekly",
          percentLeft: 52,
          resetAtIso: weeklyResetIso,
          scope: "provider",
        });
        expect(inferred.explanations).toEqual([
          {
            window: "Weekly limit",
            field: "resetAtIso",
            rule: "carried_forward_bad_read",
            detail:
              "carried forward previous unexpired window assessment omitted from current parse",
          },
        ]);
      });

      it("carried_forward_bad_read: does NOT carry forward expired omitted window from previous parse", () => {
        const t0Iso = "2026-08-26T10:00:00.000Z";
        const expiredWeeklyResetIso = "2026-08-26T11:00:00.000Z";
        const prevState: ProviderQuotaSnapshot = {
          provider: "codex",
          status: "available",
          scrapedAt: t0Iso,
          limits: [
            {
              label: "Weekly limit",
              kind: "weekly",
              percentLeft: 10,
              resetAtIso: expiredWeeklyResetIso,
              scope: "provider",
            },
          ],
        };

        // Scrape at 12:00:00Z (after 11:00:00Z reset has passed)
        const t1Iso = "2026-08-26T12:00:00.000Z";
        const currentState: ProviderQuotaSnapshot = {
          provider: "codex",
          status: "available",
          scrapedAt: t1Iso,
          limits: [
            {
              label: "5h limit",
              kind: "five_hour",
              percentLeft: 100,
              resetAtIso: "2026-08-26T17:00:00.000Z",
              scope: "provider",
            },
          ],
        };

        const inferred = inferQuotaState(currentState, prevState, t1Iso);
        // Expired weekly window is NOT carried forward
        expect(inferred.limits).toHaveLength(1);
        expect(inferred.limits?.[0].kind).toBe("five_hour");
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
