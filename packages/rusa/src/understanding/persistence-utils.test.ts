import type { Goal, SyncClient } from "@thkp-eng/goals-core";
import { describe, expect, it } from "vitest";
import type { RusaConfig } from "../config/types.js";
import { hydrateExternalizedBodies } from "./persistence-utils.js";

/** A goal with a single `documentContents` body entry (its text may be externalized = unset). */
function goalWithDoc(id: string, entryId: string, text: string | undefined): Goal {
  return {
    id,
    text: id,
    log: [{ id: entryId, creationTime: 1, type: "documentContents", text }],
    superGoalIds: new Set<string>(),
    subGoalIds: new Set<string>(),
  } as unknown as Goal;
}

function fakeClient(goals: Goal[]): SyncClient {
  const map = new Map(goals.map((g) => [g.id, g]));
  return { getGoals: () => map } as unknown as SyncClient;
}

const bodyText = (g: Goal): string | undefined => (g.log[0] as unknown as { text?: string }).text;

describe("hydrateExternalizedBodies (ISSUE_NUM read-MCP materialization)", () => {
  it("inlines externalized bodies, skips inline ones, leaves an unresolved miss empty", async () => {
    const ext = goalWithDoc("ext", "e-ext", undefined); // externalized: text-less
    const inline = goalWithDoc("inline", "e-inline", "already here"); // inline (distiller op)
    const miss = goalWithDoc("miss", "e-miss", ""); // externalized but unresolvable
    const requested: string[] = [];

    await hydrateExternalizedBodies(fakeClient([ext, inline, miss]), async (ids) => {
      requested.push(...ids);
      return { "e-ext": "resolved body" }; // resolve ext; omit miss
    });

    expect(bodyText(ext)).toBe("resolved body");
    expect(bodyText(inline)).toBe("already here"); // untouched (was inline)
    expect(bodyText(miss)).toBe(""); // graceful: unresolved stays empty
    expect(requested.sort()).toEqual(["e-ext", "e-miss"]); // only text-less entries requested
  });

  it("no-ops (no resolver call) when every body is already inline", async () => {
    let called = false;
    await hydrateExternalizedBodies(
      fakeClient([goalWithDoc("a", "e-a", "inline body")]),
      async () => {
        called = true;
        return {};
      }
    );
    expect(called).toBe(false);
  });
});

describe("getUnderstandingSyncClient and createUnderstandingStringsResolver config selection ", () => {
  it("getUnderstandingSyncClient returns null when unconfigured", async () => {
    const { getUnderstandingSyncClient } = await import("./persistence-utils.js");
    const client = await getUnderstandingSyncClient({} as RusaConfig);
    expect(client).toBeNull();
  });

  it("createUnderstandingStringsResolver returns empty object when unconfigured", async () => {
    const { createUnderstandingStringsResolver } = await import("./persistence-utils.js");
    const resolver = createUnderstandingStringsResolver({} as RusaConfig);
    const strings = await resolver.loadStrings(["id1"]);
    expect(strings).toEqual({});
  });
});
