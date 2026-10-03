import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { runMigrations } from "../db/migrations/runner.js";
import { SqliteInboxRepository } from "../db/repositories/sqlite-inbox-repository.js";
import { readAcceptedHumanInput } from "./accepted-human-input.js";

function setupInbox() {
  const db = new Database(":memory:");
  runMigrations(db);
  const inbox = new SqliteInboxRepository(db);
  return { db, inbox };
}

describe("accepted-human-input resolver", () => {
  it("resolves valid direct typed and voice inputs", () => {
    const { db, inbox } = setupInbox();
    try {
      const [typed] = inbox.append([
        {
          actorId: "actor-1",
          source: "mesh:human-alice",
          payload: {
            type: "human.message",
            messageId: "msg-1",
            fromId: "human-alice",
            sessionId: "text-session-1",
            replyBinding: {
              principalId: "human-alice",
              sessionId: "text-session-1",
              leaseBound: false,
            },
          },
        },
      ]);
      const res = readAcceptedHumanInput(inbox, "actor-1", typed.id);
      expect(res.binding).toEqual({
        principalId: "human-alice",
        sessionId: "text-session-1",
        leaseBound: false,
        textSessionId: "text-session-1",
      });
      // origin return is removed
      expect((res as Record<string, unknown>).origin).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it("permits explicit reference to caller's own HANDLED input (delayed task completion)", () => {
    const { db, inbox } = setupInbox();
    try {
      const [entry] = inbox.append([
        {
          actorId: "actor-1",
          source: "mesh:human-alice",
          payload: {
            type: "human.message",
            messageId: "msg-1",
            fromId: "human-alice",
            sessionId: "text-session-1",
            replyBinding: {
              principalId: "human-alice",
              sessionId: "text-session-1",
              leaseBound: false,
            },
          },
        },
      ]);
      inbox.markHandled("actor-1", [entry.id]);
      const handledEntry = inbox.read("actor-1", entry.id);
      expect(handledEntry?.handledAt).not.toBeNull();

      // An explicit reference to the caller's own handled input must succeed
      const res = readAcceptedHumanInput(inbox, "actor-1", entry.id);
      expect(res.binding.principalId).toBe("human-alice");
      expect(res.binding.sessionId).toBe("text-session-1");
    } finally {
      db.close();
    }
  });

  describe("consolidated synthetic resolver tests", () => {
    it.each([
      {
        name: "missing replyBinding",
        payload: {
          type: "human.message",
          messageId: "msg-1",
          fromId: "human-alice",
          sessionId: "text-session-1",
        },
        error: "human input binding is missing or unprovable",
      },
      {
        name: "non-boolean leaseBound in replyBinding",
        payload: {
          type: "human.message",
          messageId: "msg-1",
          fromId: "human-alice",
          sessionId: "text-session-1",
          replyBinding: {
            principalId: "human-alice",
            sessionId: "text-session-1",
            leaseBound: "yes",
          },
        },
        error: "human input lease binding is unprovable",
      },
      {
        name: "non-human payload type",
        payload: {
          type: "mesh.message",
          messageId: "msg-1",
          fromId: "human-alice",
          sessionId: "text-session-1",
          replyBinding: {
            principalId: "human-alice",
            sessionId: "text-session-1",
            leaseBound: false,
          },
        },
        error: "reply reference must prove an accepted human input",
      },
      {
        name: "conflicting source vs fromId",
        source: "mesh:human-bob",
        payload: {
          type: "human.message",
          messageId: "msg-1",
          fromId: "human-alice",
          sessionId: "text-session-1",
          replyBinding: {
            principalId: "human-alice",
            sessionId: "text-session-1",
            leaseBound: false,
          },
        },
        error: "human input has conflicting provenance",
      },
      {
        name: "conflicting replyBinding principalId vs fromId",
        payload: {
          type: "human.message",
          messageId: "msg-1",
          fromId: "human-alice",
          sessionId: "text-session-1",
          replyBinding: {
            principalId: "human-bob",
            sessionId: "text-session-1",
            leaseBound: false,
          },
        },
        error: "human input has conflicting provenance",
      },
      {
        name: "unheld replyBinding sessionId mismatch",
        payload: {
          type: "human.message",
          messageId: "msg-1",
          fromId: "human-alice",
          sessionId: "text-session-1",
          replyBinding: {
            principalId: "human-alice",
            sessionId: "different-session",
            leaseBound: false,
          },
        },
        error: "human input has conflicting provenance",
      },
    ])("rejects direct payload with $name", ({ source, payload, error }) => {
      const { db, inbox } = setupInbox();
      try {
        const [entry] = inbox.append([
          {
            actorId: "actor-1",
            source: source ?? "mesh:human-alice",
            payload,
          },
        ]);
        expect(() => readAcceptedHumanInput(inbox, "actor-1", entry.id)).toThrow(error);
      } finally {
        db.close();
      }
    });

    it("rejects voice transfer with conflicting provenance", () => {
      const { db, inbox } = setupInbox();
      try {
        const [source] = inbox.append([
          {
            actorId: "actor-1",
            source: "mesh:human-alice",
            payload: {
              type: "human.voice",
              messageId: "msg-1",
              fromId: "human-alice",
              sessionId: "voice-1",
              replyBinding: {
                principalId: "human-alice",
                sessionId: "voice-1",
                leaseBound: true,
              },
            },
          },
        ]);
        const [transfer] = inbox.append([
          {
            actorId: "actor-2",
            source: "voice:transfer:actor-1",
            payload: {
              type: "voice.transfer",
              fromId: "actor-1",
              sessionId: "voice-1",
              context: "test",
              replyInput: { actorId: "foreign-actor", entryId: source.id },
              replyBinding: {
                principalId: "human-alice",
                sessionId: "voice-1",
                leaseBound: true,
              },
            },
          },
        ]);
        expect(() => readAcceptedHumanInput(inbox, "actor-2", transfer.id)).toThrow(
          "voice handoff has conflicting input provenance"
        );
      } finally {
        db.close();
      }
    });

    it("detects cyclic and excessive-depth transfer chains", () => {
      const { db, inbox } = setupInbox();
      try {
        const [entryA] = inbox.append([
          {
            actorId: "actor-A",
            source: "voice:transfer:actor-B",
            payload: {
              type: "voice.transfer",
              fromId: "actor-B",
              sessionId: "voice-1",
              context: "test",
              replyInput: { actorId: "actor-B", entryId: "entry-B" },
              replyBinding: {
                principalId: "human-alice",
                sessionId: "voice-1",
                leaseBound: true,
              },
            },
          },
        ]);
        inbox.append([
          {
            id: "entry-B",
            actorId: "actor-B",
            source: "voice:transfer:actor-A",
            payload: {
              type: "voice.transfer",
              fromId: "actor-A",
              sessionId: "voice-1",
              context: "test",
              replyInput: { actorId: "actor-A", entryId: entryA.id },
              replyBinding: {
                principalId: "human-alice",
                sessionId: "voice-1",
                leaseBound: true,
              },
            },
          },
        ]);
        expect(() => readAcceptedHumanInput(inbox, "actor-A", entryA.id)).toThrow(
          "voice handoff source reference is cyclic or too deep"
        );
      } finally {
        db.close();
      }
    });

    it("prospective depth guard detects chains that would exceed depth limit", () => {
      const { db, inbox } = setupInbox();
      try {
        let prevId: string | null = null;
        let prevActor = "actor-0";
        // Create a root human input
        const [root] = inbox.append([
          {
            actorId: prevActor,
            source: "mesh:human-alice",
            payload: {
              type: "human.voice",
              messageId: "msg-root",
              fromId: "human-alice",
              sessionId: "voice-1",
              replyBinding: {
                principalId: "human-alice",
                sessionId: "voice-1",
                leaseBound: true,
              },
            },
          },
        ]);
        prevId = root.id;

        // Create 98 transfer hops (depth 99 total when resolved)
        for (let i = 1; i <= 99; i++) {
          const actor = `actor-${i}`;
          const [t] = inbox.append([
            {
              actorId: actor,
              source: `voice:transfer:${prevActor}`,
              payload: {
                type: "voice.transfer",
                fromId: prevActor,
                sessionId: "voice-1",
                context: `hop ${i}`,
                replyInput: { actorId: prevActor, entryId: prevId },
                replyBinding: {
                  principalId: "human-alice",
                  sessionId: "voice-1",
                  leaseBound: true,
                },
              },
            },
          ]);
          prevId = t.id;
          prevActor = actor;
        }

        // prevId at actor-99 has 99 hops of transfer.
        // Direct resolution of actor-99 entry has ancestors.length = 99 (< 100), so it succeeds.
        expect(() => readAcceptedHumanInput(inbox, prevActor, prevId)).not.toThrow();

        // But prospectively adding one more hop (ancestors = ["prospective"]) will hit depth 100:
        expect(() =>
          readAcceptedHumanInput(inbox, prevActor, prevId, ["prospective-transfer"])
        ).toThrow("voice handoff source reference is cyclic or too deep");
      } finally {
        db.close();
      }
    });
  });
});
