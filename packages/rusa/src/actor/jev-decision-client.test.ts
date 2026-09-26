// @vitest-environment node
// The daemon is a Node process; under jsdom the SDK would see browser globals
// and refuse to hold a credential.
import type { Fetch } from "@typesafe-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import {
  HttpJevDecisionClient,
  INTERRUPTION_CRITERIA,
  JEV_MAX_CANDIDATES,
} from "./jev-decision-client.js";
import { createJevInboxTextResolver } from "./jev-inbox-text-resolver.js";
import {
  JevInputUnavailableError,
  RESPONSIVE_INTERRUPTION_QUESTION,
  ShadowResponsiveInterruptionClassifier,
} from "./responsive-interruption.js";

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
  sender: "root",
  timestamp: "2026-09-26T12:00:00.000Z",
});

describe("HttpJevDecisionClient", () => {
  it("sends resolved live text only in the typed System One request", async () => {
    const fetch = vi.fn<Fetch>(async () => answer("interrupt", 0.93));
    const resolve = vi.fn(async (_actorId: string, id: string) => ({
      id,
      source: "mesh:root",
      type: "mesh.message",
      text: id === "incoming" ? "Stop the deployment" : "Deploy the service",
      sender: "root",
      timestamp: id === "incoming" ? "2026-09-26T12:00:06.000Z" : "2026-09-26T12:00:00.000Z",
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
        incoming: {
          id: "incoming",
          text: "Stop the deployment",
          sender: "root",
          timestamp: "2026-09-26T12:00:06.000Z",
        },
        candidates: [
          {
            id: "candidate",
            text: "Deploy the service",
            sender: "root",
            timestamp: "2026-09-26T12:00:00.000Z",
            candidateSource: "selected",
          },
        ],
        candidateSource: "selected",
      },
      questions: {
        interruption: {
          type: "choice",
          instructions: "Given this information, should we interrupt?",
          criteria: INTERRUPTION_CRITERIA,
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
      sender: null,
      timestamp: null,
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
      sender: null,
      timestamp: null,
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
      sender: null,
      timestamp: null,
      candidateSource: "pending",
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

describe("INTERRUPTION_CRITERIA", () => {
  it("is the operator-approved choice wording, verbatim (#710)", () => {
    expect(INTERRUPTION_CRITERIA).toEqual({
      interrupt: "the arriving item relates to the current work, or its relationship is uncertain.",
      queue: "the arriving item is clearly unrelated to the current work.",
    });
  });
});

/**
 * #710 regressions. Each pair is one sender writing twice, six seconds apart,
 * where the second message corrects or cancels the first. The model can only
 * see that relationship if the request carries who sent each message, when,
 * and whether the earlier one is current work or unread context. The resolver,
 * client and classifier are the production ones; only the chat edge and the
 * HTTP transport are faked.
 */
describe("JEV interruption regressions (#710)", () => {
  const SENDER = "Operator";

  async function decidePair(pair: {
    earlier: string;
    later: string;
    candidateSource: "selected" | "pending";
    answer: { choice: string; confidence: number };
  }) {
    const messages: Record<string, { text: string; createTime: string }> = {
      "spaces/S/messages/earlier": { text: pair.earlier, createTime: "2026-09-26T17:00:00.000Z" },
      "spaces/S/messages/later": { text: pair.later, createTime: "2026-09-26T17:00:06.000Z" },
    };
    const rows = new Map(
      ["earlier", "later"].map((id) => [
        id,
        {
          id,
          actorId: "actor",
          source: "gchat:spaces/S",
          deliveredAt: new Date("2026-09-26T17:00:07.000Z"),
          seenAt: null,
          handledAt: null,
          handledNote: null,
          payload: { type: "gchat.message", messageName: `spaces/S/messages/${id}` },
        },
      ])
    );
    const resolve = createJevInboxTextResolver({
      inbox: { read: (_actorId, entryId) => rows.get(entryId) ?? null },
      chatClient: {
        getMessage: async (name: string) => ({
          name,
          sender: { name: "users/1", displayName: SENDER },
          ...messages[name],
        }),
        getSpace: vi.fn(),
      },
    });
    const fetch = vi.fn<Fetch>(async () => answer(pair.answer.choice, pair.answer.confidence));
    const classifier = new ShadowResponsiveInterruptionClassifier({
      threshold: 0.5,
      client: new HttpJevDecisionClient("synthetic-key", resolve, fetch),
    });
    const decision = await classifier.evaluate({
      actorId: "actor",
      incomingEntryId: "later",
      selectedEntryIds: pair.candidateSource === "selected" ? ["earlier"] : [],
      pendingEntryIds: pair.candidateSource === "pending" ? ["earlier"] : [],
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body)) as {
      state: Record<string, unknown>;
      questions: { interruption: { instructions: string; criteria: unknown } };
    };
    return { decision, body };
  }

  it("lets the model see that 'On second thought' cancels the same sender's message 6 s earlier", async () => {
    const { decision, body } = await decidePair({
      earlier: "This is a test of the jev stuff",
      later: "On second thought let's not test it",
      candidateSource: "selected",
      answer: { choice: "interrupt", confidence: 0.77 },
    });

    expect(body.questions.interruption).toMatchObject({
      instructions: RESPONSIVE_INTERRUPTION_QUESTION,
      criteria: INTERRUPTION_CRITERIA,
    });
    expect(body.state).toMatchObject({
      incoming: {
        id: "later",
        text: "On second thought let's not test it",
        sender: SENDER,
        timestamp: "2026-09-26T17:00:06.000Z",
      },
      candidates: [
        {
          id: "earlier",
          text: "This is a test of the jev stuff",
          sender: SENDER,
          timestamp: "2026-09-26T17:00:00.000Z",
          candidateSource: "selected",
        },
      ],
      candidateSource: "selected",
    });
    // 0.77 is the selected-mode interrupt from the #710 offline run that 0.8 missed.
    expect(decision).toMatchObject({
      outcome: "interrupt",
      verdict: "interrupt",
      confidence: 0.77,
    });
    // The audit stays ids-only: no text, sender or source time reaches it.
    const audit = JSON.stringify(decision);
    for (const leaked of ["second thought", "jev stuff", SENDER, "17:00:0"]) {
      expect(audit).not.toContain(leaked);
    }
  });

  it("lets the model see that a one-word 'lands*' corrects the same sender's message 6 s earlier", async () => {
    // The earlier message's ending is from the observed pair; its opening is synthetic.
    const { decision, body } = await decidePair({
      earlier: "Keep shadow mode on for now, and disable the jev integration until that fails.",
      later: "lands*",
      candidateSource: "pending",
      answer: { choice: "interrupt", confidence: 0.99 },
    });

    expect(body.state).toMatchObject({
      incoming: {
        id: "later",
        text: "lands*",
        sender: SENDER,
        timestamp: "2026-09-26T17:00:06.000Z",
      },
      candidates: [
        {
          id: "earlier",
          text: "Keep shadow mode on for now, and disable the jev integration until that fails.",
          sender: SENDER,
          timestamp: "2026-09-26T17:00:00.000Z",
          candidateSource: "pending",
        },
      ],
      candidateSource: "pending",
    });
    expect(decision).toMatchObject({ outcome: "interrupt", verdict: "interrupt" });
    const audit = JSON.stringify(decision);
    for (const leaked of ["lands*", "jev integration", SENDER, "17:00:0"]) {
      expect(audit).not.toContain(leaked);
    }
  });
});
