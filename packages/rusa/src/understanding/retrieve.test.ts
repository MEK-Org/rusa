import type { SyncClient } from "@thkp-eng/goals-core";
import { describe, expect, it } from "vitest";
import { formatNodesForPrompt, searchNodes } from "./retrieve.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

interface MockGoal {
  id: string;
  text: string;
  log: Array<{ type: string; text?: string }>;
  superGoalIds: Set<string>;
  subGoalIds: Set<string>;
}

function makeGoal(id: string, title: string, contents: string, parentIds: string[] = []): MockGoal {
  return {
    id,
    text: title,
    log: [{ type: "documentContents", text: contents }],
    superGoalIds: new Set(parentIds),
    subGoalIds: new Set(),
  };
}

function makeSyncClient(goals: MockGoal[]): SyncClient {
  const goalMap = new Map<string, MockGoal>(goals.map((g) => [g.id, g]));
  // Link subGoalIds from parent direction.
  for (const goal of goals) {
    for (const pid of goal.superGoalIds) {
      goalMap.get(pid)?.subGoalIds.add(goal.id);
    }
  }
  return { getGoals: () => goalMap } as unknown as SyncClient;
}

// ---------------------------------------------------------------------------
// Graph fixture
//
// Root (Integrated Knowledge Universe)
//  ├── Testing
//  │    └── E2E Testing         (Playwright-specific)
//  └── Deployment
//       └── Firebase Deployment (firebase deploy command)
// ---------------------------------------------------------------------------

function buildFixture() {
  const root = makeGoal("root", "Integrated Knowledge Universe", "Top-level knowledge root.");
  const testing = makeGoal(
    "testing",
    "Testing",
    "Testing strategies including unit tests, integration tests, and end-to-end tests.",
    ["root"]
  );
  const e2e = makeGoal(
    "e2e",
    "E2E Testing",
    "End-to-end testing using Playwright against the production environment.",
    ["testing"]
  );
  const deployment = makeGoal(
    "deployment",
    "Deployment",
    "Deployment pipeline and CI/CD configuration.",
    ["root"]
  );
  const firebase = makeGoal(
    "firebase",
    "Firebase Deployment",
    "Firebase hosting and Firestore rules deployment using the firebase deploy command.",
    ["deployment"]
  );
  return makeSyncClient([root, testing, e2e, deployment, firebase]);
}

// ---------------------------------------------------------------------------
// searchNodes — raw_input-style queries representing real issues
// ---------------------------------------------------------------------------

describe("searchNodes", () => {
  it("finds a directly matching leaf node for a test-related issue", () => {
    const client = buildFixture();
    const results = searchNodes(client, "Playwright e2e testing is failing in CI");
    expect(results.some((n) => n.id === "e2e")).toBe(true);
  });

  it("includes parent context via upward expansion", () => {
    const client = buildFixture();
    // "e2e" matches directly; its parent "testing" should also be included.
    const results = searchNodes(client, "Playwright end-to-end testing strategy");
    expect(results.some((n) => n.id === "testing")).toBe(true);
  });

  it("ranks directly matched nodes higher than their expanded parents", () => {
    const client = buildFixture();
    const results = searchNodes(client, "Playwright e2e tests failing in production");
    const e2eScore = results.find((n) => n.id === "e2e")?.relevanceScore ?? 0;
    const testingScore = results.find((n) => n.id === "testing")?.relevanceScore ?? 0;
    expect(e2eScore).toBeGreaterThan(testingScore);
  });

  it("finds deployment nodes for a firebase deploy issue", () => {
    const client = buildFixture();
    const results = searchNodes(client, "firebase deploy command failing on hosting");
    expect(results.some((n) => n.id === "firebase")).toBe(true);
    expect(results.some((n) => n.id === "deployment")).toBe(true);
  });

  it("does not return irrelevant nodes", () => {
    const client = buildFixture();
    const results = searchNodes(client, "quantum entanglement photon spin");
    expect(results).toHaveLength(0);
  });

  it("returns empty for an empty query", () => {
    const client = buildFixture();
    expect(searchNodes(client, "")).toHaveLength(0);
    expect(searchNodes(client, "   ")).toHaveLength(0);
  });

  it("respects maxResults limit", () => {
    const client = buildFixture();
    // A broad query that would match many nodes.
    const results = searchNodes(client, "testing deployment firebase Playwright integration", 2);
    expect(results.length).toBeLessThanOrEqual(2);
  });

  it("returns relevanceScore > 0 for all results", () => {
    const client = buildFixture();
    const results = searchNodes(client, "Playwright end-to-end deployment pipeline");
    expect(results.every((n) => n.relevanceScore > 0)).toBe(true);
  });

  it("includes title and contents in results", () => {
    const client = buildFixture();
    const results = searchNodes(client, "Firebase deployment command");
    const firebase = results.find((n) => n.id === "firebase");
    expect(firebase).toBeDefined();
    expect(firebase?.title).toBe("Firebase Deployment");
    expect(firebase?.contents).toContain("firebase deploy");
  });
});

// ---------------------------------------------------------------------------
// formatNodesForPrompt
// ---------------------------------------------------------------------------

describe("formatNodesForPrompt", () => {
  it("returns empty string for empty node list", () => {
    expect(formatNodesForPrompt([])).toBe("");
  });

  it("includes the section header", () => {
    const client = buildFixture();
    const nodes = searchNodes(client, "Playwright testing");
    const prompt = formatNodesForPrompt(nodes);
    expect(prompt).toContain("## Integrated Understanding");
  });

  it("includes node titles as headings", () => {
    const client = buildFixture();
    const nodes = searchNodes(client, "Playwright end-to-end testing");
    const prompt = formatNodesForPrompt(nodes);
    expect(prompt).toContain("### E2E Testing");
  });

  it("includes node contents", () => {
    const client = buildFixture();
    const nodes = searchNodes(client, "Firebase deployment");
    const prompt = formatNodesForPrompt(nodes);
    expect(prompt).toContain("firebase deploy");
  });
});

// Body-only terms (ISSUE_NUM read-MCP materialization regression). The read MCP serves the local
// would-be graph with externalized bodies HYDRATED in; these lock that a term living only in a
// node's body (not its title) surfaces once the body is materialized, and that an un-materialized
// (empty) body scores 0 on contents — the bug the hydration fixes.
describe("searchNodes — body-only terms", () => {
  it("finds a node whose query terms live only in the (materialized) body, not the title", () => {
    const client = makeSyncClient([
      makeGoal("n1", "Generic Title", "The quasar nebula subsystem handles ingestion."),
      makeGoal("n2", "Unrelated", "nothing relevant here"),
    ]);
    expect(searchNodes(client, "quasar nebula").map((n) => n.id)).toContain("n1");
  });

  it("regression: an EMPTY (un-materialized) body scores 0 on contents → not found", () => {
    const client = makeSyncClient([makeGoal("n1", "Generic Title", "")]);
    expect(searchNodes(client, "quasar nebula").map((n) => n.id)).not.toContain("n1");
  });
});

describe("searchNodes — root-scoped visibility ", () => {
  it("excludes rootNodeId itself and unreachable orphan nodes from search results", () => {
    const root = makeGoal("root", "Integrated Knowledge Universe", "Root testing strategy.");
    const testing = makeGoal("testing", "Testing Strategy", "Unit and E2E testing.", ["root"]);
    const orphan = makeGoal("orphan", "Orphan Testing", "Unlinked testing doc.");
    const client = makeSyncClient([root, testing, orphan]);

    // When rootNodeId is passed:
    const results = searchNodes(client, "testing", 10, 1, "root");
    const ids = results.map((r) => r.id);

    expect(ids).toContain("testing");
    // Excludes the root node itself
    expect(ids).not.toContain("root");
    // Excludes unreachable orphan nodes
    expect(ids).not.toContain("orphan");
  });
});
