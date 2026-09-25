import { describe, expect, it, vi } from "vitest";
import { HttpJevDecisionClient, JEV_SYSTEM_ONE_URL } from "./jev-decision-client.js";

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
      async (_actorId, id) => ({ id, source: "mesh:root", text: "text" }),
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
      async (_actorId, id) => ({ id, source: "mesh:root", text: "text" }),
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
});
