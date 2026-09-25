import { describe, expect, it, vi } from "vitest";
import {
  HttpJevDecisionClient,
  JEV_MAX_CANDIDATES,
  JEV_SYSTEM_ONE_URL,
  type JevFetch,
} from "./jev-decision-client.js";
import { JevInputUnavailableError } from "./responsive-interruption.js";

describe("HttpJevDecisionClient", () => {
  it("sends resolved live text only in the typed System One request", async () => {
    const calls: Array<{ url: string; init: { body: string; signal?: AbortSignal } }> = [];
    const fetch = vi.fn(async (url: string, init: { body: string; signal?: AbortSignal }) => {
      calls.push({ url, init });
      return {
        ok: true,
        status: 200,
        json: async () => ({
          model: "jev-test",
          answers: {
            interruption: {
              type: "choice",
              choice: "interrupt",
              probabilities: { interrupt: 0.93, queue: 0.07 },
              confidence: 0.93,
            },
          },
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      };
    });
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
        {
          actorId: "worker",
          question: "Given this information, should we interrupt?",
          input: {
            incomingEntryId: "incoming",
            candidateEntryIds: ["candidate"],
            candidateSource: "selected",
          },
        },
        { signal: controller.signal }
      )
    ).resolves.toEqual({ verdict: "interrupt", confidence: 0.93 });

    expect(resolve).toHaveBeenCalledWith("worker", "incoming", controller.signal);
    expect(resolve).toHaveBeenCalledWith("worker", "candidate", controller.signal);
    expect(calls).toEqual([
      { url: JEV_SYSTEM_ONE_URL, init: expect.objectContaining({ signal: controller.signal }) },
    ]);
    const [firstCall] = calls;
    expect(firstCall).toBeDefined();
    if (!firstCall) throw new Error("expected a JEV request");
    const body = JSON.parse(firstCall.init.body) as Record<string, unknown>;
    expect(body).toMatchObject({
      model: "jev-latest",
      state: {
        incoming: { id: "incoming", text: "Stop the deployment" },
        candidates: [{ id: "candidate", text: "Deploy the service" }],
        candidateSource: "selected",
      },
    });
    expect(JSON.stringify(body)).not.toContain("synthetic-key");
  });

  it("rejects malformed answers without inventing a verdict", async () => {
    const client = new HttpJevDecisionClient(
      "synthetic-key",
      async (_actorId, id) => ({ id, source: "mesh:root", type: "mesh.message", text: "text" }),
      async () => ({ ok: true, status: 200, json: async () => ({ answers: {} }) })
    );

    await expect(
      client.decide({
        actorId: "worker",
        question: "question",
        input: {
          incomingEntryId: "incoming",
          candidateEntryIds: ["candidate"],
          candidateSource: "selected",
        },
      })
    ).rejects.toThrow("invalid interruption answer");
  });

  it("rejects an incomplete documented Choice response", async () => {
    const client = new HttpJevDecisionClient(
      "synthetic-key",
      async (_actorId, id) => ({ id, source: "mesh:root", type: "mesh.message", text: "text" }),
      async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          answers: { interruption: { type: "choice", choice: "queue", confidence: 0.9 } },
        }),
      })
    );

    await expect(
      client.decide({
        actorId: "worker",
        question: "question",
        input: {
          incomingEntryId: "incoming",
          candidateEntryIds: ["candidate"],
          candidateSource: "selected",
        },
      })
    ).rejects.toThrow("invalid interruption answer");
  });

  it("rejects a Choice answer whose probabilities are not a distribution", async () => {
    const client = new HttpJevDecisionClient(
      "synthetic-key",
      async (_actorId, id) => ({ id, source: "mesh:root", type: "mesh.message", text: "text" }),
      async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          answers: {
            interruption: {
              type: "choice",
              choice: "interrupt",
              probabilities: { interrupt: -1, queue: 2 },
              confidence: 0.99,
            },
          },
        }),
      })
    );

    await expect(
      client.decide({
        actorId: "worker",
        question: "question",
        input: {
          incomingEntryId: "incoming",
          candidateEntryIds: ["candidate"],
          candidateSource: "selected",
        },
      })
    ).rejects.toThrow("invalid interruption answer");
  });

  it("sends once and fails on a throttled response, carrying no request text", async () => {
    const fetch = vi.fn<JevFetch>(async () => ({
      ok: false,
      status: 429,
      json: async () => ({}),
    }));
    const client = new HttpJevDecisionClient(
      "synthetic-key",
      async (_actorId, id) => ({
        id,
        source: "mesh:root",
        type: "mesh.message",
        text: "real text",
      }),
      fetch
    );

    const failure = await client
      .decide({
        actorId: "worker",
        question: "question",
        input: {
          incomingEntryId: "incoming",
          candidateEntryIds: ["candidate"],
          candidateSource: "selected",
        },
      })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe("JEV decision service returned HTTP 429");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("fails as input-unavailable, without a request, when the arrival has no text", async () => {
    const fetch = vi.fn<JevFetch>();
    const client = new HttpJevDecisionClient(
      "synthetic-key",
      async (_actorId, id) => ({
        id,
        source: "obligation:o",
        type: "scheduled.wake",
        text: id === "incoming" ? null : "text",
      }),
      fetch
    );
    await expect(
      client.decide({
        actorId: "worker",
        question: "question",
        input: {
          incomingEntryId: "incoming",
          candidateEntryIds: ["candidate"],
          candidateSource: "selected",
        },
      })
    ).rejects.toBeInstanceOf(JevInputUnavailableError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("sends textless candidates by type and caps how many are read", async () => {
    let body: Record<string, unknown> | undefined;
    const fetch = vi.fn<JevFetch>(async (_url, init) => {
      body = JSON.parse(init.body) as Record<string, unknown>;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          answers: {
            interruption: {
              type: "choice",
              choice: "queue",
              probabilities: { interrupt: 0.1, queue: 0.9 },
              confidence: 0.9,
            },
          },
        }),
      };
    });
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
        actorId: "worker",
        question: "question",
        input: { incomingEntryId: "incoming", candidateEntryIds, candidateSource: "pending" },
      })
    ).resolves.toEqual({ verdict: "queue", confidence: 0.9 });

    expect(resolve).toHaveBeenCalledTimes(JEV_MAX_CANDIDATES + 1);
    const state = body?.state as { candidates: unknown[]; omittedCandidates?: number };
    expect(state.candidates).toHaveLength(JEV_MAX_CANDIDATES);
    expect(state.candidates[0]).toEqual({
      id: "c0",
      source: "mesh:root",
      type: "scheduled.wake",
      text: null,
    });
    expect(state.omittedCandidates).toBe(5);
  });
});
