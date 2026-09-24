import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  carryForwardAntigravityConversation,
  ensureAntigravityPrivateState,
} from "./antigravity-paths.js";

const OWN_ID = "11111111-2222-4333-8444-555555555555";
const SIBLING_ID = "99999999-8888-4777-8666-555555555555";

describe("Antigravity private state", () => {
  const originalHome = process.env.HOME;
  let home: string;
  let hostState: string;
  let actorDir: string;
  let actorState: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "agy-paths-"));
    process.env.HOME = home;
    hostState = join(home, ".gemini", "antigravity-cli");
    actorDir = join(home, ".rusa", "workers", "actor-one");
    actorState = join(actorDir, ".antigravity-state");
    for (const id of [OWN_ID, SIBLING_ID]) {
      mkdirSync(join(hostState, "conversations"), { recursive: true });
      mkdirSync(join(hostState, "annotations"), { recursive: true });
      mkdirSync(join(hostState, "brain", id, ".system_generated", "logs"), { recursive: true });
      writeFileSync(join(hostState, "conversations", `${id}.db`), `db-${id}`);
      writeFileSync(join(hostState, "conversations", `${id}.db-wal`), `wal-${id}`);
      writeFileSync(join(hostState, "annotations", `${id}.pbtxt`), `note-${id}`);
      writeFileSync(
        join(hostState, "brain", id, ".system_generated", "logs", "transcript_full.jsonl"),
        `transcript-${id}`
      );
    }
    writeFileSync(join(hostState, "conversation_summaries.db"), "host-summaries");
    ensureAntigravityPrivateState(actorDir);
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  });

  it("seeds private records without touching existing host records", () => {
    expect(readFileSync(join(hostState, "conversation_summaries.db"), "utf8")).toBe(
      "host-summaries"
    );
    expect(readFileSync(join(actorState, "conversation_summaries.db"), "utf8")).toBe("");
    expect(readFileSync(join(actorState, "cache", "last_conversations.json"), "utf8")).toBe("{}");
    expect(readFileSync(join(hostState, "cache", "last_conversations.json"), "utf8")).toBe("{}");
    expect(existsSync(join(actorState, "brain"))).toBe(true);
  });

  it("carries forward only the actor's own persisted conversation", () => {
    expect(carryForwardAntigravityConversation(actorDir, OWN_ID)).toBe(true);

    const privateFile = (...parts: string[]) => readFileSync(join(actorState, ...parts), "utf8");
    expect(privateFile("conversations", `${OWN_ID}.db`)).toBe(`db-${OWN_ID}`);
    expect(privateFile("conversations", `${OWN_ID}.db-wal`)).toBe(`wal-${OWN_ID}`);
    expect(privateFile("annotations", `${OWN_ID}.pbtxt`)).toBe(`note-${OWN_ID}`);
    expect(privateFile("brain", OWN_ID, ".system_generated", "logs", "transcript_full.jsonl")).toBe(
      `transcript-${OWN_ID}`
    );
    expect(existsSync(join(actorState, "conversations", `${SIBLING_ID}.db`))).toBe(false);
    expect(existsSync(join(actorState, "brain", SIBLING_ID))).toBe(false);
    // Copy, not move: the host records are unchanged.
    expect(readFileSync(join(hostState, "conversations", `${OWN_ID}.db`), "utf8")).toBe(
      `db-${OWN_ID}`
    );
  });

  it("never overwrites an existing private conversation", () => {
    writeFileSync(join(actorState, "conversations", `${OWN_ID}.db`), "private-newer");

    expect(carryForwardAntigravityConversation(actorDir, OWN_ID)).toBe(false);
    expect(readFileSync(join(actorState, "conversations", `${OWN_ID}.db`), "utf8")).toBe(
      "private-newer"
    );
  });

  it("ignores ids that are not conversation ids", () => {
    expect(carryForwardAntigravityConversation(actorDir, `../conversations/${SIBLING_ID}`)).toBe(
      false
    );
    expect(carryForwardAntigravityConversation(actorDir, "not-a-conversation")).toBe(false);
  });
});
