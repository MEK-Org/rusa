import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { RusaConfig } from "../config/types.js";
import { closeDb, getRepositories, initDb } from "../db/index.js";

let mockedDistillationError: Error | null = null;
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
  FunctionCallingConfigMode: {
    ANY: "ANY",
    AUTO: "AUTO",
    NONE: "NONE",
  },
}));

const { runDistillation, scheduleDistillationIfNeeded } = await import("./distill.js");

let mcHome = "";
const mockSyncClient = {
  getGoals: vi.fn().mockReturnValue(new Map()),
  modifyGoal: vi.fn(),
  archiveGoal: vi.fn(),
};

beforeEach(() => {
  closeDb();
  mockGenerateContent.mockReset();
  mockGenerateContent.mockImplementation(async () => {
    if (mockedDistillationError) {
      throw mockedDistillationError;
    }
    // Default: immediately call finish_task so the loop completes successfully.
    return {
      candidates: [
        {
          content: {
            role: "model",
            parts: [{ functionCall: { name: "finish_task", args: { summary: "Done" } } }],
          },
        },
      ],
    };
  });

  mockSyncClient.getGoals.mockReturnValue(new Map());
  mockSyncClient.modifyGoal.mockReset();
  mockSyncClient.archiveGoal.mockReset();

  mcHome = mkdtempSync(join(tmpdir(), "rusa-distill-test-"));
  initDb(mcHome);
  mockedDistillationError = null;
});

afterEach(() => {
  closeDb();
  if (mcHome) {
    rmSync(mcHome, { recursive: true, force: true });
    mcHome = "";
  }
});

function makeConfig(): RusaConfig {
  return {
    github: { account: "rusa-bot", pollIntervalSeconds: 300 },
    providers: {
      codex: { cliCommand: "codex" },
      gemini: { cliCommand: "agy" },
    },
    geminiApiKey: "test-key",
    webhook: { port: 0, secret: "test-secret" },
  };
}

it("marks raw inputs as processed and creates domains immediately", async () => {
  getRepositories().rawInputs.insert({
    id: "ri-1",
    platform: "github",
    providerEventId: "evt-1",
    repo: "dummy-org/dummy-repo",
    issueNumber: 58,
    prNumber: null,
    author: "user",
    content: "Please start tracking a new domain for this topic.",
    metadata: null,
  });

  const result = await runDistillation(
    makeConfig(),
    mockSyncClient as unknown as Parameters<typeof runDistillation>[1]
  );
  expect(result.outcome).toBe("completed");
  expect(result.inputsProcessed).toBe(1);
  expect(getRepositories().rawInputs.getUnprocessed().length).toBe(0);
});

it("processes distillation inputs in batches and reports the remainder", async () => {
  for (let i = 1; i <= 55; i++) {
    getRepositories().rawInputs.insert({
      id: `ri-batch-${i}`,
      platform: "github",
      providerEventId: `evt-batch-${i}`,
      repo: "dummy-org/dummy-repo",
      issueNumber: null,
      prNumber: null,
      author: "user",
      content: `batched content ${i}`,
      metadata: null,
    });
  }

  const result = await runDistillation(
    makeConfig(),
    mockSyncClient as unknown as Parameters<typeof runDistillation>[1]
  );

  expect(result.outcome).toBe("completed");
  expect(result.inputsProcessed).toBe(50);
  expect(result.remainingAfterBatch).toBe(5);
  expect(getRepositories().rawInputs.countPendingDistillation()).toBe(5);
  expect(getRepositories().rawInputs.getUnprocessed()).toHaveLength(5);
});

it("returns skipped outcome when Gemini API key is missing", async () => {
  getRepositories().rawInputs.insert({
    id: "ri-no-key",
    platform: "github",
    providerEventId: "evt-no-key",
    repo: "dummy-org/dummy-repo",
    issueNumber: 73,
    prNumber: null,
    author: "user",
    content: "test",
    metadata: null,
  });

  const result = await runDistillation(
    { ...makeConfig(), geminiApiKey: "" },
    mockSyncClient as unknown as Parameters<typeof runDistillation>[1]
  );
  expect(result.outcome).toBe("skipped");
  expect(result.runSummary).toBe("Skipped: missing Gemini API key");
});

it("returns structured failed outcome when model call throws", async () => {
  mockedDistillationError = new Error("rate limit");
  getRepositories().rawInputs.insert({
    id: "ri-err",
    platform: "github",
    providerEventId: "evt-err",
    repo: "dummy-org/dummy-repo",
    issueNumber: 73,
    prNumber: null,
    author: "user",
    content: "test",
    metadata: null,
  });

  const result = await runDistillation(
    makeConfig(),
    mockSyncClient as unknown as Parameters<typeof runDistillation>[1]
  ).catch((e: unknown) => {
    const err = e as Error;
    return { outcome: "failed", error: err.message };
  });
  expect(result.outcome).toBe("failed");
  if ("error" in result) {
    expect(result.error).toBe("rate limit");
  }
});

it("does not mark inputs processed when an apply operation throws ", async () => {
  // Turn 1: the model creates a node; the underlying write throws (e.g. SQLite locked /
  // unique constraint / Firestore). Turn 2: the model calls finish_task. Before ISSUE_NUM the
  // thrown error was swallowed, the model saw {status:"ok"}, and the run marked the input
  // processed anyway — silent data loss. Now the run must fail and leave the input pending.
  // Throw only for the model's create_node write (matched by its title), so the run's
  // setup writes (e.g. creating the conceptual root) still succeed and we isolate the
  // apply-time failure.
  mockSyncClient.modifyGoal.mockImplementation((arg: { text?: string }) => {
    if (arg?.text === "A New Conceptual Topic") {
      throw new Error("SQLITE_BUSY: database is locked");
    }
  });
  mockGenerateContent.mockResolvedValueOnce({
    candidates: [
      {
        content: {
          role: "model",
          parts: [
            {
              functionCall: {
                name: "create_node",
                args: {
                  rationale: "capture a new concept",
                  title: "A New Conceptual Topic",
                  contents: "Body of the new node.",
                },
              },
            },
          ],
        },
      },
    ],
  });
  // Turn 2 falls through to the default mock implementation → finish_task.

  getRepositories().rawInputs.insert({
    id: "ri-apply-throw",
    platform: "github",
    providerEventId: "evt-apply-throw",
    repo: "dummy-org/dummy-repo",
    issueNumber: 99,
    prNumber: null,
    author: "user",
    content: "Something worth distilling into a node.",
    metadata: null,
  });

  const result = await runDistillation(
    makeConfig(),
    mockSyncClient as unknown as Parameters<typeof runDistillation>[1]
  );

  expect(result.outcome).toBe("failed");
  expect(result.inputsProcessed).toBe(0);
  // The input stays pending so the next run retries it — no silent drop.
  expect(getRepositories().rawInputs.getUnprocessed().length).toBe(1);
});

/**
 * A node whose body is a single `documentContents` entry — the shape
 * `getNodeContents` reads, and the reason an `append` that writes only the
 * fragment silently replaces the body .
 */
function goalWithContents(id: string, title: string, contents: string) {
  return {
    id,
    text: title,
    superGoalIds: new Set<string>(),
    subGoalIds: new Set<string>(),
    log: [{ id: `e-${id}`, creationTime: 1, type: "documentContents", text: contents }],
  };
}

/** The body the applier actually wrote for `nodeId`, or undefined if it never wrote one. */
function writtenContents(nodeId: string): string | undefined {
  const calls = mockSyncClient.modifyGoal.mock.calls as unknown as [
    { id?: string; logEntry?: { type?: string; text?: string } },
  ][];
  const match = calls
    .map(([delta]) => delta)
    .filter((d) => d?.id === nodeId && d?.logEntry?.type === "documentContents")
    .pop();
  return match?.logEntry?.text;
}

async function runWithSingleOp(
  args: Record<string, unknown>,
  inputId: string,
  opName = "update_node_contents"
) {
  mockGenerateContent.mockResolvedValueOnce({
    candidates: [
      {
        content: {
          role: "model",
          parts: [{ functionCall: { name: opName, args } }],
        },
      },
    ],
  });
  // Turn 2 falls through to the default mock implementation → finish_task.
  getRepositories().rawInputs.insert({
    id: inputId,
    platform: "manual",
    providerEventId: `evt-${inputId}`,
    repo: null,
    issueNumber: null,
    prNumber: null,
    author: "user",
    content: "Something worth folding into an existing node.",
    metadata: null,
  });
  return runDistillation(
    makeConfig(),
    mockSyncClient as unknown as Parameters<typeof runDistillation>[1]
  );
}

it("update_node_contents append preserves the existing body ", async () => {
  // The regression: the applier ignored `action` and wrote the fragment as the whole
  // body, so an append — the value the prompt steers toward — discarded the node.
  mockSyncClient.getGoals.mockReturnValue(
    new Map([["n-append", goalWithContents("n-append", "An Existing Node", "Existing body.")]])
  );

  const result = await runWithSingleOp(
    {
      rationale: "fold this window's finding into the section that owns it",
      node_id: "n-append",
      action: "append",
      text: "New fragment.",
    },
    "ri-append"
  );

  expect(result.outcome).toBe("completed");
  expect(writtenContents("n-append")).toBe("Existing body.\n\nNew fragment.");
});

it("update_node_contents replace overwrites the existing body ", async () => {
  mockSyncClient.getGoals.mockReturnValue(
    new Map([["n-replace", goalWithContents("n-replace", "An Existing Node", "Existing body.")]])
  );

  const result = await runWithSingleOp(
    {
      rationale: "the section is superseded outright",
      node_id: "n-replace",
      action: "replace",
      text: "Wholly new body.",
    },
    "ri-replace"
  );

  expect(result.outcome).toBe("completed");
  expect(writtenContents("n-replace")).toBe("Wholly new body.");
});

it("splice_node_contents splices text in place ", async () => {
  mockSyncClient.getGoals.mockReturnValue(
    new Map([
      [
        "n-splice",
        goalWithContents(
          "n-splice",
          "An Existing Node",
          "Header.\n\nStatus: open. Waiting on decision.\n\nFooter."
        ),
      ],
    ])
  );

  const result = await runWithSingleOp(
    {
      rationale: "update status in place",
      node_id: "n-splice",
      old_text: "Status: open. Waiting on decision.",
      new_text: "Status: resolved as keep-rank.",
    },
    "ri-splice",
    "splice_node_contents"
  );

  expect(result.outcome).toBe("completed");
  expect(writtenContents("n-splice")).toBe("Header.\n\nStatus: resolved as keep-rank.\n\nFooter.");
});

it("splice_node_contents replace_all updates all matching anchors", async () => {
  mockSyncClient.getGoals.mockReturnValue(
    new Map([
      [
        "n-splice-all",
        goalWithContents("n-splice-all", "An Existing Node", "Alpha tag. Beta tag. Gamma tag."),
      ],
    ])
  );

  const result = await runWithSingleOp(
    {
      rationale: "replace all tag labels",
      node_id: "n-splice-all",
      old_text: "tag",
      new_text: "item",
      replace_all: true,
    },
    "ri-splice-all",
    "splice_node_contents"
  );

  expect(result.outcome).toBe("completed");
  expect(writtenContents("n-splice-all")).toBe("Alpha item. Beta item. Gamma item.");
});

it("ignores tool calls returned as text JSON and retries", async () => {
  // First response: text-based tool call (should be detected and ignored)
  mockGenerateContent.mockResolvedValueOnce({
    candidates: [
      {
        content: {
          role: "model",
          parts: [{ text: JSON.stringify({ name: "searchNodes", arguments: { query: "test" } }) }],
        },
      },
    ],
  } as unknown);

  // Second response: proper native finish_task call
  mockGenerateContent.mockResolvedValueOnce({
    candidates: [
      {
        content: {
          role: "model",
          parts: [{ functionCall: { name: "finish_task", args: { summary: "Done" } } }],
        },
      },
    ],
  } as unknown);

  getRepositories().rawInputs.insert({
    id: "ri-text-tool",
    platform: "manual",
    providerEventId: "evt-text-tool",
    repo: null,
    issueNumber: null,
    prNumber: null,
    author: "user",
    content: "test input",
    metadata: null,
  });

  const result = await runDistillation(
    makeConfig(),
    mockSyncClient as unknown as Parameters<typeof runDistillation>[1]
  );
  expect(result.outcome).toBe("completed");
  expect(result.events.some((e) => e.includes("Detected tool call in text (ignored"))).toBe(true);
});

it("scheduleDistillationIfNeeded schedules a task when none exists", () => {
  expect(getRepositories().maintenance.hasPendingDistillationTask()).toBe(false);
  const taskId = scheduleDistillationIfNeeded();
  expect(taskId).not.toBeNull();
  expect(getRepositories().maintenance.hasPendingDistillationTask()).toBe(true);
});
