// @vitest-environment node
import type { SyncClient } from "@thkp-eng/goals-core";
import { afterEach, expect, it, vi } from "vitest";
import { configureGeminiUsage, type GeminiUsageRecord } from "../observability/gemini-usage.js";
import { createLogger, nullLogger } from "../observability/logger.js";

const sdk = vi.hoisted(() => ({ generateContent: vi.fn() }));
vi.mock("@google/genai", () => ({
  GoogleGenAI: class {
    models = { generateContent: sdk.generateContent };
  },
  FunctionCallingConfigMode: { ANY: "ANY" },
  Type: { OBJECT: "OBJECT", STRING: "STRING", ARRAY: "ARRAY" },
}));

import { searchNodesLlm } from "./retrieve-llm.js";

afterEach(() => configureGeminiUsage(nullLogger, "/synthetic/test"));

it("attributes every actual retrieval tool-loop turn and keeps returned model identity and counts", async () => {
  const records: GeminiUsageRecord[] = [];
  configureGeminiUsage(
    createLogger({
      format: "json",
      destination: {
        write(line) {
          records.push(JSON.parse(line).usage);
        },
      },
    }),
    "/synthetic/retrieval"
  );
  const response = (tool: string) => ({
    modelVersion: "retrieval-version",
    usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 3, totalTokenCount: 15 },
    candidates: [
      { content: { parts: [{ functionCall: { name: tool, args: { node_ids: [] } } }] } },
    ],
  });
  sdk.generateContent
    .mockResolvedValueOnce(response("unrecognized_tool"))
    .mockResolvedValueOnce(response("select_nodes"));
  const syncClient = {
    getGoals: () => new Map([["node-a", { text: "synthetic node" }]]),
  } as unknown as SyncClient;
  expect(
    await searchNodesLlm(
      syncClient,
      "private search request",
      "synthetic-key",
      "requested-retrieval"
    )
  ).toEqual([]);
  expect(sdk.generateContent).toHaveBeenCalledTimes(2);
  expect(records).toHaveLength(2);
  expect(
    records.every(
      (r) =>
        r.purpose === "understanding_retrieval" &&
        r.requestedModel === "requested-retrieval" &&
        r.model === "retrieval-version" &&
        r.counts.input === 12
    )
  ).toBe(true);
  expect(records[0].attemptId).not.toBe(records[1].attemptId);
  expect(JSON.stringify(records)).not.toContain("private search request");
});
