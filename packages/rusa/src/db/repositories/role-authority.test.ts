import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { runMigrations } from "../migrations/runner.js";
import { Repositories, RoleAuthorityError } from "./index.js";

describe("role-gated repository authority (#1019)", () => {
  it("allows leader role to write to both global control and local execution repositories", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);

    const repos = new Repositories(db, "leader");

    db.prepare("INSERT INTO actors (id, charter, created_at) VALUES (?, ?, ?)").run(
      "actor-1",
      "charter 1",
      new Date().toISOString()
    );

    // Leader can create obligations (global control)
    const ob = repos.obligations.create({
      title: "Test leader obligation",
      ownerId: "system:mesh",
    });
    expect(ob.id).toBeDefined();

    // Leader can grant capabilities (global control)
    repos.capabilityGrants.grant({
      actorId: "actor-1",
      capability: "test-cap",
      grantedBy: "system",
      grantedAt: new Date().toISOString(),
    });

    // Leader can write local execution state
    repos.actorRuns.start({
      id: "run-leader-1",
      actorId: "actor-1",
      startedAt: new Date().toISOString(),
      modelConfig: {
        version: 1,
        provider: "antigravity",
        model: "gemini",
      },
    });
    const run = repos.actorRuns.getById("run-leader-1");
    expect(run?.actorId).toBe("actor-1");
  });

  it("blocks follower role from mutating global control tables while allowing reads", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);

    // Seed an obligation as leader first
    const leaderRepos = new Repositories(db, "leader");
    const seeded = leaderRepos.obligations.create({
      title: "Seeded obligation",
      ownerId: "system:mesh",
    });

    // Now construct follower repositories over the same DB
    const followerRepos = new Repositories(db, "follower");

    // Follower CAN read obligations
    const readOb = followerRepos.obligations.get(seeded.id);
    expect(readOb?.id).toBe(seeded.id);

    // Follower CANNOT create obligations
    expect(() => {
      followerRepos.obligations.create({
        title: "Follower forbidden obligation",
        ownerId: "system:mesh",
      });
    }).toThrow(RoleAuthorityError);

    // Follower CANNOT change obligation terminal status
    expect(() => {
      followerRepos.obligations.setTerminalStatus(
        seeded.id,
        "done",
        new Date().toISOString(),
        "system:mesh",
        "finished"
      );
    }).toThrow(RoleAuthorityError);

    // Follower CANNOT set obligation snooze
    expect(() => {
      followerRepos.obligations.setSnooze(
        seeded.id,
        new Date(Date.now() + 60_000).toISOString(),
        "system:mesh"
      );
    }).toThrow(RoleAuthorityError);

    // Follower CANNOT upsert actors (global entity)
    expect(() => {
      followerRepos.actors.upsert({
        id: "forbidden-actor",
        charter: "forbidden charter",
        parentId: null,
        status: "active",
        createdAt: new Date().toISOString(),
      });
    }).toThrow(RoleAuthorityError);

    // Follower CANNOT create principals (global identity)
    expect(() => {
      followerRepos.principals.createUser({
        email: "forbidden@example.test",
        createdAt: new Date().toISOString(),
      });
    }).toThrow(RoleAuthorityError);

    // Follower CANNOT mutate model classes
    expect(() => {
      followerRepos.modelClasses.upsert(
        "forbidden-class",
        [{ provider: "codex", model: "gpt" }],
        new Date().toISOString()
      );
    }).toThrow(RoleAuthorityError);

    // Follower CANNOT mutate chat room
    expect(() => {
      followerRepos.chatRoom.add({
        actorId: "actor-2",
        addedBy: "system:mesh",
        addedAt: new Date().toISOString(),
      });
    }).toThrow(RoleAuthorityError);

    // Follower CANNOT record mesh chat directly
    expect(() => {
      followerRepos.meshChat.record({
        id: "chat-1",
        senderId: "actor-2",
        recipientId: "actor-1",
        body: "test chat",
        ts: new Date().toISOString(),
      });
    }).toThrow(RoleAuthorityError);

    // Follower CANNOT record mesh events
    expect(() => {
      followerRepos.meshEvents.record({
        kind: "test_event",
        actorId: "actor-2",
      });
    }).toThrow(RoleAuthorityError);

    // Follower CANNOT record raw inputs for distillation
    expect(() => {
      followerRepos.rawInputs.insert({
        id: "input-1",
        platform: "github",
        providerEventId: "ev-1",
        repo: "MEK-Org/rusa",
        issueNumber: 1,
        prNumber: null,
        author: "tester",
        content: "test input",
        metadata: null,
      });
    }).toThrow(RoleAuthorityError);

    // Follower CANNOT record quota scrapes
    expect(() => {
      followerRepos.quotaScrapes.recordRaw({
        provider: "claude",
        scrapedAt: new Date().toISOString(),
        rawOutput: "{}",
      });
    }).toThrow(RoleAuthorityError);

    // Follower CANNOT record model scrapes
    expect(() => {
      followerRepos.modelScrapes.recordRaw({
        provider: "claude",
        scrapedAt: new Date().toISOString(),
        rawOutput: "{}",
      });
    }).toThrow(RoleAuthorityError);

    // Follower CANNOT enroll in experiments
    expect(() => {
      followerRepos.experimentEnrollments.enroll({
        actorId: "actor-2",
        experiment: "test-exp",
        enrolledAt: new Date().toISOString(),
        enrolledBy: "system:mesh",
      });
    }).toThrow(RoleAuthorityError);

    // Follower CANNOT grant capabilities
    expect(() => {
      followerRepos.capabilityGrants.grant({
        actorId: "actor-2",
        capability: "forbidden-cap",
        grantedBy: "system",
        grantedAt: new Date().toISOString(),
      });
    }).toThrow(RoleAuthorityError);

    // Follower CANNOT institute mesh availability holds
    expect(() => {
      followerRepos.availabilityHolds.set({
        provider: "claude",
        origin: "mesh",
        createdBy: "system:mesh",
        createdAt: new Date().toISOString(),
      });
    }).toThrow(RoleAuthorityError);

    // Follower CANNOT subscribe to event source ownership
    expect(() => {
      followerRepos.eventSourceOwners.subscribe({
        actorId: "actor-2",
        resource: "github:MEK-Org/rusa",
        subscribedBy: "system:mesh",
        subscribedAt: new Date().toISOString(),
      });
    }).toThrow(RoleAuthorityError);

    // Follower CANNOT append inbox items
    expect(() => {
      followerRepos.inbox.append([
        {
          actorId: "actor-2",
          source: "test",
          payload: { type: "test" },
        },
      ]);
    }).toThrow(RoleAuthorityError);

    // Follower CANNOT call internal obligation priority or completion mutators
    expect(() => {
      followerRepos.obligations.setPriorityInternal(seeded.id, 100, "system:mesh");
    }).toThrow(RoleAuthorityError);

    expect(() => {
      followerRepos.obligations.movePriorityInternal(seeded.id, null, null, "system:mesh");
    }).toThrow(RoleAuthorityError);

    expect(() => {
      followerRepos.obligations.inheritRetiringActorObligationsInternal(
        "actor-1",
        "actor-2",
        "system:mesh"
      );
    }).toThrow(RoleAuthorityError);

    expect(() => {
      followerRepos.obligations.satisfyCompletionMatcher(
        seeded.id,
        { kind: "pr_merged", target: "1024", setAt: new Date().toISOString() },
        { resolutionRef: "github:MEK-Org/rusa/pulls/1024", note: "merged" }
      );
    }).toThrow(RoleAuthorityError);

    expect(() => {
      followerRepos.obligations.recordCompletionMatcherClosedUnmerged(seeded.id, {
        kind: "pr_merged",
        target: "1024",
        setAt: new Date().toISOString(),
      });
    }).toThrow(RoleAuthorityError);

    // Follower CANNOT mutate event source owners via setConfig
    expect(() => {
      followerRepos.eventSourceOwners.setConfig(
        "github:MEK-Org/rusa",
        JSON.stringify({ filter: "all" })
      );
    }).toThrow(RoleAuthorityError);

    // Follower CANNOT replace inbox entries
    expect(() => {
      (
        followerRepos.inbox as unknown as { replaceEntries: (entries: unknown[]) => void }
      ).replaceEntries([
        {
          id: "inbox-1",
          actorId: "actor-2",
          source: "test",
          payload: {},
          deliveredAt: new Date().toISOString(),
          seenAt: null,
          handledAt: null,
          handledNote: null,
        },
      ]);
    }).toThrow(RoleAuthorityError);

    // Follower CANNOT mutate referenceCache
    expect(() => {
      followerRepos.referenceCache.set({
        ref: "github:MEK-Org/rusa/pulls/1024",
        document_version: 1,
        entity_json: "{}",
        fetched_at: new Date().toISOString(),
        refresh_after: new Date().toISOString(),
      });
    }).toThrow(RoleAuthorityError);

    expect(() => {
      followerRepos.referenceCache.delete("github:MEK-Org/rusa/pulls/1024");
    }).toThrow(RoleAuthorityError);

    // Verify seeded state is completely unchanged
    const finalOb = followerRepos.obligations.get(seeded.id);
    expect(finalOb).toEqual(readOb);
  });

  it("allows follower role to write and read instance-owned local execution state", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);

    const followerRepos = new Repositories(db, "follower");

    // Follower writes local actor run
    followerRepos.actorRuns.start({
      id: "run-follower-1",
      actorId: "actor-follower-1",
      startedAt: new Date().toISOString(),
      modelConfig: {
        version: 1,
        provider: "claude",
        model: "sonnet",
      },
    });

    // Follower reads local actor run
    const run = followerRepos.actorRuns.getById("run-follower-1");
    expect(run?.actorId).toBe("actor-follower-1");

    // Follower records completion
    followerRepos.actorRuns.complete("run-follower-1", {
      endedAt: new Date().toISOString(),
      success: true,
      exitCode: 0,
      output: "Done cleanly",
    });

    const completed = followerRepos.actorRuns.getById("run-follower-1");
    expect(completed?.outcome).toBe("completed");

    // Follower records run prompt
    followerRepos.runPrompts.record("run-follower-1", "Test prompt text");
    const retained = followerRepos.runPrompts.getById("run-follower-1");
    expect(retained?.prompt).toBe("Test prompt text");
  });
});
