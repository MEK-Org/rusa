// @vitest-environment node
// The daemon is a Node process; under jsdom the SDK would see browser globals
// and refuse to hold a credential.
import type { Fetch } from "@typesafe-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import { HttpJevDecisionClient, JEV_MAX_CANDIDATES } from "./jev-decision-client.js";
import { JevInputUnavailableError } from "./responsive-interruption.js";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const answer = (choice: string, confidence: number) =>
  json({
    model: "jev-test",
    answers: { interruption: { type: "choice", choice, confidence } },
    usage: { input_tokens: 1, output_tokens: 1 },
  });

const request = (candidateEntryIds: string[] = ["candidate"]) => ({
  actorId: "worker",
  question: "question",
  input: {
    incomingEntryId: "incoming",
    candidateEntryIds,
    candidateSource: "selected" as const,
  },
});

const text = async (_actorId: string, id: string) => ({
  id,
  source: "mesh:root",
  type: "mesh.message",
  text: "text",
});

describe("HttpJevDecisionClient", () => {
  it("sends resolved live text only in the typed System One request", async () => {
    const fetch = vi.fn<Fetch>(async () => answer("interrupt", 0.93));
    const resolve = vi.fn(async (_actorId: string, id: string) => ({
      id,
      source: "mesh:root",
      type: "mesh.message",
      text: id === "incoming" ? "Stop the deployment" : "Deploy the service",
    }));
    const client = new HttpJevDecisionClient("synthetic-key", resolve, fetch);
    const controller = new AbortController();

    await expect(
      client.decide(
        { ...request(), question: "Given this information, should we interrupt?" },
        { signal: controller.signal }
      )
    ).resolves.toEqual({ verdict: "interrupt", confidence: 0.93 });

    expect(resolve).toHaveBeenCalledWith("worker", "incoming", controller.signal);
    expect(resolve).toHaveBeenCalledWith("worker", "candidate", controller.signal);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(init?.signal?.aborted).toBe(false);
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      model: "jev-latest",
      state: {
        incoming: { id: "incoming", text: "Stop the deployment" },
        candidates: [{ id: "candidate", text: "Deploy the service" }],
        candidateSource: "selected",
      },
      questions: {
        interruption: {
          type: "choice",
          instructions: "Given this information, should we interrupt?",
          criteria: { interrupt: expect.any(String), queue: expect.any(String) },
        },
      },
    });
    expect(String(init?.body)).not.toContain("synthetic-key");
  });

  it("ignores TYPESAFE_BASE_URL, so the credential goes only to TypeSafe", async () => {
    vi.stubEnv("TYPESAFE_BASE_URL", "https://elsewhere.invalid");
    try {
      const fetch = vi.fn<Fetch>(async () => answer("queue", 0.9));
      await new HttpJevDecisionClient("synthetic-key", text, fetch).decide(request());
      expect(fetch.mock.calls[0]?.[0]).toBe("https://api.typesafe.ai/v1/systemone");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("rejects malformed answers without inventing a verdict", async () => {
    const client = new HttpJevDecisionClient("synthetic-key", text, async () =>
      json({ answers: {} })
    );
    await expect(client.decide(request())).rejects.toThrow("invalid interruption answer");
  });

  it("rejects an answer without a confidence", async () => {
    const client = new HttpJevDecisionClient("synthetic-key", text, async () =>
      json({ answers: { interruption: { type: "choice", choice: "queue" } } })
    );
    await expect(client.decide(request())).rejects.toThrow("invalid interruption answer");
  });

  it("rejects a choice that was not offered", async () => {
    const client = new HttpJevDecisionClient("synthetic-key", text, async () =>
      answer("maybe", 0.99)
    );
    await expect(client.decide(request())).rejects.toThrow("invalid interruption answer");
  });

  it("sends once and fails on a throttled response, carrying no request text", async () => {
    const fetch = vi.fn<Fetch>(async () => json({}, 429));
    const client = new HttpJevDecisionClient("synthetic-key", text, fetch);

    const failure = await client.decide(request()).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe("JEV decision service returned HTTP 429");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("fails as input-unavailable, reading no candidate and sending nothing, when the arrival has no text", async () => {
    const fetch = vi.fn<Fetch>();
    const resolve = vi.fn(async (_actorId: string, id: string) => ({
      id,
      source: "obligation:o",
      type: "scheduled.wake",
      text: id === "incoming" ? null : "text",
    }));
    const client = new HttpJevDecisionClient("synthetic-key", resolve, fetch);

    await expect(client.decide(request())).rejects.toBeInstanceOf(JevInputUnavailableError);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith("worker", "incoming", undefined);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("sends textless candidates by type and caps how many are read", async () => {
    const fetch = vi.fn<Fetch>(async () => answer("queue", 0.9));
    const resolve = vi.fn(async (_actorId: string, id: string) => ({
      id,
      source: "mesh:root",
      type: id === "c0" ? "scheduled.wake" : "mesh.message",
      text: id === "c0" ? null : `text ${id}`,
    }));
    const candidateEntryIds = Array.from({ length: JEV_MAX_CANDIDATES + 5 }, (_, i) => `c${i}`);
    const client = new HttpJevDecisionClient("synthetic-key", resolve, fetch);

    await expect(
      client.decide({
        ...request(candidateEntryIds),
        input: { incomingEntryId: "incoming", candidateEntryIds, candidateSource: "pending" },
      })
    ).resolves.toEqual({ verdict: "queue", confidence: 0.9 });

    expect(resolve).toHaveBeenCalledTimes(JEV_MAX_CANDIDATES + 1);
    const body = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body)) as {
      state: { candidates: unknown[]; omittedCandidates?: number };
    };
    expect(body.state.candidates).toHaveLength(JEV_MAX_CANDIDATES);
    expect(body.state.candidates[0]).toEqual({
      id: "c0",
      source: "mesh:root",
      type: "scheduled.wake",
      text: null,
    });
    expect(body.state.omittedCandidates).toBe(5);
  });

  it("aborts the in-flight request when the signal is cancelled", async () => {
    const controller = new AbortController();
    const fetch = vi.fn<Fetch>(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
          controller.abort();
        })
    );
    const client = new HttpJevDecisionClient("synthetic-key", text, fetch);

    await expect(client.decide(request(), { signal: controller.signal })).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
