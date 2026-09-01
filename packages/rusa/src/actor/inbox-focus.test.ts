import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../db/migrations/runner.js";
import { ActorRunRepository } from "../db/repositories/actor-run-repository.js";
import { InboxFocusRepository } from "../db/repositories/inbox-focus-repository.js";
import { InboxRepository } from "../db/repositories/inbox-repository.js";
import { MeshChatRepository } from "../db/repositories/mesh-chat-repository.js";
import { ObligationRepository } from "../db/repositories/obligation-repository.js";
import { InboxFocusResolver } from "./inbox-focus.js";
import type { InboxEntry } from "./inbox-store.js";

describe("InboxFocusResolver", () => {
  let runs: ActorRunRepository;
  let inbox: InboxRepository;
  let focus: InboxFocusRepository;
  let obligations: ObligationRepository;
  let chat: MeshChatRepository;
  let resolver: InboxFocusResolver;

  beforeEach(() => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    runs = new ActorRunRepository(db);
    inbox = new InboxRepository(db);
    focus = new InboxFocusRepository(db);
    obligations = new ObligationRepository(db, (id) => id === "actor-a");
    chat = new MeshChatRepository(db);
    resolver = new InboxFocusResolver(focus, obligations, chat);

    obligations.create({ id: "root-work", ownerId: "actor-a", title: "Root work" });
    obligations.create({
      id: "issue-work",
      parentId: "root-work",
      ownerId: "actor-a",
      title: "Issue work",
      intent: "bounded intent ".repeat(80),
      externalRef: "github:MEK-Org/rusa/issues/143",
    });
    obligations.create({
      id: "sibling-work",
      parentId: "root-work",
      ownerId: "actor-a",
      title: "Sibling work",
      externalRef: "github:MEK-Org/rusa/issues/141",
    });
  });

  function append(
    entries: Array<{ id: string; source: string; payload: Record<string, unknown> }>
  ) {
    return inbox.append(
      entries.map((entry) => ({
        ...entry,
        actorId: "actor-a",
        payload: entry.payload as { type: string; [key: string]: unknown },
      }))
    );
  }

  it("infers the narrowest obligation on one ancestor chain and returns bounded context", () => {
    chat.record({
      id: "decision",
      senderId: "root",
      recipientId: "actor-a",
      body: `Proceed with the invariant core. ${"detail ".repeat(80)}`,
    });
    obligations.attachArtifact("issue-work", "mesh:messages/decision", {
      attachedBy: "actor-a",
      label: "human decision ".repeat(20),
    });
    const entries = append([
      {
        id: "head",
        source: "obligation:root-work",
        payload: { type: "obligation.ready_head", obligationId: "root-work" },
      },
      {
        id: "issue",
        source: "github:MEK-Org/rusa/issues/143",
        payload: { type: "issues.edited" },
      },
    ]);
    runs.start({ id: "run-1", actorId: "actor-a" });

    const result = resolver.select({ runId: "run-1", actorId: "actor-a", entries });

    expect(result).toMatchObject({
      primaryObligationId: "issue-work",
      resolution: "inferred",
      related: true,
      diagnostics: [],
      context: {
        obligation: { id: "issue-work" },
        parent: { id: "root-work" },
        grandparent: null,
      },
    });
    expect(result.context?.liveSiblings.items.map((item) => item.id)).toEqual([
      "issue-work",
      "sibling-work",
    ]);
    expect(result.context?.artifacts.items[0]).toMatchObject({
      ref: "mesh:messages/decision",
      labelTruncated: true,
      excerptTruncated: true,
    });
    expect(result.context?.obligation.intent?.length).toBe(480);
    expect(result.context?.obligation.intentTruncated).toBe(true);
    expect(result.context?.artifacts.items[0]?.excerpt?.length).toBe(240);
    expect(focus.getByRunId("run-1")).toMatchObject({
      primaryObligationId: "issue-work",
      entryIds: ["head", "issue"],
    });
  });

  it("uses explicit focus for a general message and makes that association durable", () => {
    const [entry] = append([
      { id: "general", source: "mesh:root", payload: { type: "mesh.message" } },
    ]);
    runs.start({ id: "run-2", actorId: "actor-a" });

    expect(
      resolver.select({
        runId: "run-2",
        actorId: "actor-a",
        entries: [entry] as InboxEntry[],
        explicitObligationId: "issue-work",
      })
    ).toMatchObject({
      primaryObligationId: "issue-work",
      resolution: "explicit",
      related: true,
    });
    expect(focus.listEntryObligationIds("actor-a", "general")).toEqual(["issue-work"]);
  });

  it("records unrelated inference as an observe-first ambiguity without rejecting selection", () => {
    const entries = append([
      {
        id: "one",
        source: "github:MEK-Org/rusa/issues/143",
        payload: { type: "issues.edited" },
      },
      {
        id: "two",
        source: "github:MEK-Org/rusa/issues/141",
        payload: { type: "issues.edited" },
      },
    ]);
    runs.start({ id: "run-3", actorId: "actor-a" });

    const result = resolver.select({ runId: "run-3", actorId: "actor-a", entries });

    expect(result.primaryObligationId).toBeNull();
    expect(result.resolution).toBe("ambiguous");
    expect(result.diagnostics[0]).toContain("supply obligation_id");
    expect(focus.getByRunId("run-3")).toMatchObject({
      primaryObligationId: null,
      resolution: "ambiguous",
    });
  });

  it("reports unrelated explicit selections but defers rejection to enforcement rollout", () => {
    const [entry] = append([
      {
        id: "sibling",
        source: "github:MEK-Org/rusa/issues/141",
        payload: { type: "issues.edited" },
      },
    ]);
    runs.start({ id: "run-4", actorId: "actor-a" });

    const result = resolver.select({
      runId: "run-4",
      actorId: "actor-a",
      entries: [entry],
      explicitObligationId: "issue-work",
    });

    expect(result.related).toBe(false);
    expect(result.diagnostics[0]).toContain("outside issue-work");
    expect(result.primaryObligationId).toBe("issue-work");
  });

  it("rejects an explicit focus that is terminal or missing", () => {
    obligations.setTerminalStatus("sibling-work", "done");
    const [entry] = append([
      { id: "general", source: "mesh:root", payload: { type: "mesh.message" } },
    ]);
    runs.start({ id: "run-5", actorId: "actor-a" });

    expect(() =>
      resolver.select({
        runId: "run-5",
        actorId: "actor-a",
        entries: [entry],
        explicitObligationId: "sibling-work",
      })
    ).toThrow("live obligation not found");
  });
});
