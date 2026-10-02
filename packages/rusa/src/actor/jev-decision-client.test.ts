// @vitest-environment node
// The daemon is a Node process; under jsdom the SDK would see browser globals
// and refuse to hold a credential.
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APITimeoutError, type Fetch } from "@typesafe-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import {
  HttpJevDecisionClient,
  JEV_MAX_CANDIDATES,
  type JevQueryAuditRecord,
} from "./jev-decision-client.js";
import { createJevInboxTextResolver } from "./jev-inbox-text-resolver.js";
import {
  JevInputUnavailableError,
  RESPONSIVE_INTERRUPTION_QUESTION,
  ShadowResponsiveInterruptionClassifier,
} from "./responsive-interruption.js";

function readJevQueryAuditLog(path: string): JevQueryAuditRecord[] {
  if (!existsSync(path)) return [];
  const content = readFileSync(path, "utf8");
  return content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as JevQueryAuditRecord);
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const answer = (noul: number) =>
  json({
    model: "jev-test",
    answers: { interruption: { type: "noul", noul } },
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
    const fetch = vi.fn<Fetch>(async () => answer(0.93));
    const resolve = vi.fn(async (_actorId: string, id: string) => ({
      id,
      source: "mesh:root",
      type: "mesh.message",
      text: id === "incoming" ? "Stop the deployment" : "Deploy the service",
      sender: "root",
      timestamp: id === "incoming" ? "2026-09-26T12:00:06.000Z" : "2026-09-26T12:00:00.000Z",
    }));
    const client = new HttpJevDecisionClient("synthetic-key", resolve, { fetch });
    const controller = new AbortController();

    await expect(
      client.decide(
        { ...request(), question: "Given this information, should we interrupt?" },
        { signal: controller.signal }
      )
    ).resolves.toEqual({ interruptProbability: 0.93 });

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
          type: "noul",
          instructions: "Given this information, should we interrupt?",
        },
      },
    });
    expect(String(init?.body)).not.toContain("synthetic-key");
  });

  it("ignores TYPESAFE_BASE_URL, so the credential goes only to TypeSafe", async () => {
    vi.stubEnv("TYPESAFE_BASE_URL", "https://elsewhere.invalid");
    try {
      const fetch = vi.fn<Fetch>(async () => answer(0.1));
      await new HttpJevDecisionClient("synthetic-key", text, { fetch }).decide(request());
      expect(fetch.mock.calls[0]?.[0]).toBe("https://api.typesafe.ai/v1/systemone");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("rejects malformed answers without inventing a verdict", async () => {
    const client = new HttpJevDecisionClient("synthetic-key", text, {
      fetch: async () => json({ answers: {} }),
    });
    await expect(client.decide(request())).rejects.toThrow("invalid interruption answer");
  });

  it("rejects an answer without a probability", async () => {
    const client = new HttpJevDecisionClient("synthetic-key", text, {
      fetch: async () => json({ answers: { interruption: { type: "noul" } } }),
    });
    await expect(client.decide(request())).rejects.toThrow("invalid interruption answer");
  });

  it.each([null, true, "0.9", -0.1, 1.1])("rejects invalid probability %s", async (noul) => {
    const client = new HttpJevDecisionClient("synthetic-key", text, {
      fetch: async () => json({ answers: { interruption: { type: "noul", noul } } }),
    });
    await expect(client.decide(request())).rejects.toThrow("invalid interruption answer");
  });

  it("rejects the old choice response even if it has a noul field", async () => {
    const client = new HttpJevDecisionClient("synthetic-key", text, {
      fetch: async () =>
        json({
          answers: {
            interruption: { type: "choice", choice: "interrupt", confidence: 0.9, noul: 0.9 },
          },
        }),
    });
    await expect(client.decide(request())).rejects.toThrow("invalid interruption answer");
  });

  it("sends once and fails on a throttled response, carrying no request text", async () => {
    const fetch = vi.fn<Fetch>(async () => json({}, 429));
    const client = new HttpJevDecisionClient("synthetic-key", text, { fetch });

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
    const client = new HttpJevDecisionClient("synthetic-key", resolve, { fetch });

    await expect(client.decide(request())).rejects.toBeInstanceOf(JevInputUnavailableError);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith("worker", "incoming", undefined);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("sends textless candidates by type and caps how many are read", async () => {
    const fetch = vi.fn<Fetch>(async () => answer(0.1));
    const resolve = vi.fn(async (_actorId: string, id: string) => ({
      id,
      source: "mesh:root",
      type: id === "c0" ? "scheduled.wake" : "mesh.message",
      text: id === "c0" ? null : `text ${id}`,
      sender: null,
      timestamp: null,
    }));
    const candidateEntryIds = Array.from({ length: JEV_MAX_CANDIDATES + 5 }, (_, i) => `c${i}`);
    const client = new HttpJevDecisionClient("synthetic-key", resolve, { fetch });

    await expect(
      client.decide({
        ...request(candidateEntryIds),
        input: { incomingEntryId: "incoming", candidateEntryIds, candidateSource: "pending" },
      })
    ).resolves.toEqual({ interruptProbability: 0.1 });

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

  it("sends nothing when the signal fires while sources are being read", async () => {
    const controller = new AbortController();
    const fetch = vi.fn<Fetch>(async () => answer(0.1));
    // A source read that ignores the signal, like the real source clients.
    const resolve = vi.fn(async (actorId: string, id: string) => {
      if (id === "candidate") controller.abort();
      return text(actorId, id);
    });
    const client = new HttpJevDecisionClient("synthetic-key", resolve, { fetch });

    await expect(client.decide(request(), { signal: controller.signal })).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not cancel a request already sent when the signal fires", async () => {
    const controller = new AbortController();
    let transportSignal: AbortSignal | undefined;
    const fetch = vi.fn<Fetch>(async (_url, init) => {
      transportSignal = init?.signal ?? undefined;
      controller.abort();
      return answer(0.42);
    });
    const client = new HttpJevDecisionClient("synthetic-key", text, { fetch });

    await expect(client.decide(request(), { signal: controller.signal })).resolves.toEqual({
      interruptProbability: 0.42,
    });
    expect(transportSignal?.aborted).toBe(false);
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
  const DISPLAY_NAME = "Operator";
  const STABLE_SENDER = "users/1";

  async function decidePair(pair: {
    earlier: string;
    later: string;
    candidateSource: "selected" | "pending";
    probability: number;
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
          sender: { name: "users/1", displayName: DISPLAY_NAME },
          ...messages[name],
        }),
        getSpace: vi.fn(),
      },
    });
    const fetch = vi.fn<Fetch>(async () => answer(pair.probability));
    const classifier = new ShadowResponsiveInterruptionClassifier({
      threshold: 0.5,
      client: new HttpJevDecisionClient("synthetic-key", resolve, { fetch }),
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
      questions: { interruption: { type: string; instructions: string } };
    };
    return { decision, body };
  }

  it("lets the model see that 'On second thought' cancels the same sender's message 6 s earlier", async () => {
    const { decision, body } = await decidePair({
      earlier: "This is a test of the jev stuff",
      later: "On second thought let's not test it",
      candidateSource: "selected",
      probability: 0.77,
    });

    expect(body.questions.interruption).toMatchObject({
      instructions: RESPONSIVE_INTERRUPTION_QUESTION,
      type: "noul",
    });
    expect(body.state).toMatchObject({
      incoming: {
        id: "later",
        text: "On second thought let's not test it",
        sender: STABLE_SENDER,
        timestamp: "2026-09-26T17:00:06.000Z",
      },
      candidates: [
        {
          id: "earlier",
          text: "This is a test of the jev stuff",
          sender: STABLE_SENDER,
          timestamp: "2026-09-26T17:00:00.000Z",
          candidateSource: "selected",
        },
      ],
      candidateSource: "selected",
    });
    // Synthetic probability: the live API is exercised separately from unit tests.
    expect(decision).toMatchObject({
      outcome: "interrupt",
      interruptProbability: 0.77,
    });
    // The audit stays ids-only: no text, sender or source time reaches it.
    const audit = JSON.stringify(decision);
    for (const leaked of ["second thought", "jev stuff", DISPLAY_NAME, STABLE_SENDER, "17:00:0"]) {
      expect(audit).not.toContain(leaked);
    }
  });

  it("lets the model see that a one-word 'lands*' corrects the same sender's message 6 s earlier", async () => {
    // The earlier message's ending is from the observed pair; its opening is synthetic.
    const { decision, body } = await decidePair({
      earlier: "Keep shadow mode on for now, and disable the jev integration until that fails.",
      later: "lands*",
      candidateSource: "pending",
      probability: 0.99,
    });

    expect(body.state).toMatchObject({
      incoming: {
        id: "later",
        text: "lands*",
        sender: STABLE_SENDER,
        timestamp: "2026-09-26T17:00:06.000Z",
      },
      candidates: [
        {
          id: "earlier",
          text: "Keep shadow mode on for now, and disable the jev integration until that fails.",
          sender: STABLE_SENDER,
          timestamp: "2026-09-26T17:00:00.000Z",
          candidateSource: "pending",
        },
      ],
      candidateSource: "pending",
    });
    expect(decision).toMatchObject({ outcome: "interrupt", interruptProbability: 0.99 });
    const audit = JSON.stringify(decision);
    for (const leaked of ["lands*", "jev integration", DISPLAY_NAME, STABLE_SENDER, "17:00:0"]) {
      expect(audit).not.toContain(leaked);
    }
  });

  describe("query audit log (Matt 2026-09-30 request)", () => {
    it("captures full query at send boundary with byte-for-byte fidelity and writes to private audit log file", async () => {
      const dir = mkdtempSync(join(tmpdir(), "rusa-jev-audit-test-"));
      try {
        const auditPath = join(dir, "audit", "jev-queries.jsonl");
        const fetch = vi.fn<Fetch>(async () => answer(0.91));
        const client = new HttpJevDecisionClient("synthetic-jev-key-secret", text, {
          fetch,
          auditPath,
        });

        const req = {
          ...request(["candidate-1", "candidate-2"]),
          evaluationId: "eval-42-test",
          question: "Should we interrupt the current work for the arriving item?",
        };

        const result = await client.decide(req);
        expect(result).toEqual({ interruptProbability: 0.91 });

        // Read log from disk using readJevQueryAuditLog
        const diskEntries = readJevQueryAuditLog(auditPath);
        expect(diskEntries).toHaveLength(1);
        const record = diskEntries[0];
        expect(record.evaluationId).toBe("eval-42-test");
        expect(record.actorId).toBe("worker");
        expect(record.incomingEntryId).toBe("incoming");
        expect(record.decision).toEqual({ interruptProbability: 0.91 });
        expect(record.error).toBeNull();
        expect(typeof record.timestamp).toBe("string");

        // Assert byte-for-byte query fidelity between recorded query and actual fetch body
        expect(fetch).toHaveBeenCalledTimes(1);
        const sentHttpBody = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body)) as Record<
          string,
          unknown
        >;
        expect(record.query).toEqual(sentHttpBody);
        expect(record.query.model).toBe("jev-latest");
        expect(record.query.questions).toMatchObject({
          interruption: {
            instructions: "Should we interrupt the current work for the arriving item?",
            type: "noul",
          },
        });

        // Assert file was written with private file permissions (0o600)
        const fileStat = statSync(auditPath);
        expect(fileStat.mode & 0o777).toBe(0o600);

        // Assert no credentials leak into the audit record or file
        const rawFileContent = readFileSync(auditPath, "utf8");
        expect(rawFileContent).not.toContain("synthetic-jev-key-secret");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("preserves full sent query and failure evidence when the provider request fails", async () => {
      const dir = mkdtempSync(join(tmpdir(), "rusa-jev-audit-test-"));
      try {
        const auditPath = join(dir, "audit", "jev-queries.jsonl");
        const fetch = vi.fn<Fetch>(async () => {
          return new Response(JSON.stringify({ error: "gateway timeout" }), { status: 504 });
        });
        const client = new HttpJevDecisionClient("synthetic-key", text, { fetch, auditPath });

        const req = {
          ...request(["candidate-1"]),
          evaluationId: "eval-fail-test",
          question: "Should we interrupt?",
        };

        await expect(client.decide(req)).rejects.toThrow(/HTTP 504/);

        // File must still capture the full query sent and the failure evidence
        const diskEntries = readJevQueryAuditLog(auditPath);
        expect(diskEntries).toHaveLength(1);
        const failedRecord = diskEntries[0];
        expect(failedRecord.evaluationId).toBe("eval-fail-test");
        expect(failedRecord.decision).toBeNull();
        expect(failedRecord.error).toContain("504");
        expect(failedRecord.query.model).toBe("jev-latest");
        expect(failedRecord.query.state).toBeDefined();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("does not block delivery if writing to the audit file fails", async () => {
      // Point to an invalid path that cannot be written
      const auditPath = "/dev/null/impossible/path/jev-queries.jsonl";
      const fetch = vi.fn<Fetch>(async () => answer(0.85));
      const client = new HttpJevDecisionClient("synthetic-key", text, { fetch, auditPath });

      const req = {
        ...request(["candidate-1"]),
        evaluationId: "eval-write-err-test",
        question: "Should we interrupt?",
      };

      // Must succeed without throwing due to audit write failure
      const result = await client.decide(req);
      expect(result).toEqual({ interruptProbability: 0.85 });
    });
  });
});

/**
 * #813 regressions. A real loopback server sends response headers and part of
 * the body, then stalls. The SDK buffers by draining `response.clone()`, and on
 * Node 24 aborting that fetch mid-body leaves a rejection inside the tee that
 * nothing handles: the process exits. Neither the policy deadline nor the SDK's
 * own request timeout may be able to reach that path.
 */
describe("stalled response body (#813)", () => {
  async function stalledBodyServer() {
    let requests = 0;
    const server = createServer((req, res) => {
      requests += 1;
      req.resume();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.write('{"model":"jev-test","answers":');
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const target = `http://127.0.0.1:${port}/v1/systemone`;
    return {
      fetch: ((_url, init) => globalThis.fetch(target, init)) as Fetch,
      requests: () => requests,
      close: () => {
        server.closeAllConnections();
        server.close();
      },
    };
  }

  /** Counts rejections that nothing handled, for as long as `run` takes. */
  async function unhandledRejectionsDuring(run: () => Promise<void>): Promise<unknown[]> {
    const seen: unknown[] = [];
    const listener = (reason: unknown) => seen.push(reason);
    process.on("unhandledRejection", listener);
    try {
      await run();
      // A floating rejection is reported after the microtask queue drains.
      await new Promise((resolve) => setTimeout(resolve, 200));
    } finally {
      process.off("unhandledRejection", listener);
    }
    return seen;
  }

  it("records a timeout without an unhandled rejection when the deadline fires mid-body", async () => {
    const server = await stalledBodyServer();
    try {
      const classifier = new ShadowResponsiveInterruptionClassifier({
        threshold: 0.8,
        timeoutMs: 300,
        client: new HttpJevDecisionClient("synthetic-key", text, { fetch: server.fetch }),
      });
      let decision: unknown;
      const unhandled = await unhandledRejectionsDuring(async () => {
        decision = await classifier.evaluate({
          actorId: "worker",
          incomingEntryId: "incoming",
          selectedEntryIds: ["candidate"],
          pendingEntryIds: [],
        });
      });

      expect(server.requests()).toBe(1);
      expect(decision).toMatchObject({ outcome: "queue", reason: "timeout" });
      expect(unhandled).toEqual([]);
    } finally {
      server.close();
    }
  });

  it("fails with a timeout error and no unhandled rejection when the SDK's own timeout fires mid-body", async () => {
    const server = await stalledBodyServer();
    try {
      const client = new HttpJevDecisionClient("synthetic-key", text, {
        fetch: server.fetch,
        requestTimeoutMs: 300,
      });
      let error: unknown;
      const unhandled = await unhandledRejectionsDuring(async () => {
        error = await client.decide(request()).catch((err: unknown) => err);
      });

      expect(server.requests()).toBe(1);
      expect(error).toBeInstanceOf(APITimeoutError);
      expect(unhandled).toEqual([]);
    } finally {
      server.close();
    }
  }, 15_000);
});
