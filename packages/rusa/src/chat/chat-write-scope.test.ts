import { describe, expect, it } from "vitest";
import {
  chatWriteScopes,
  gchatThreadSpace,
  holdsChatWriteSpace,
  parseChatWriteScope,
} from "./chat-write-scope.js";

describe("chat-write scopes (#1311)", () => {
  it("parses every accepted grant parameter", () => {
    expect(parseChatWriteScope("*")).toEqual({ kind: "all" });
    expect(parseChatWriteScope("spaces/A")).toEqual({ kind: "space", space: "spaces/A" });
    expect(parseChatWriteScope("A")).toEqual({ kind: "space", space: "spaces/A" });
    expect(parseChatWriteScope("spaces/A/threads/T1")).toEqual({
      kind: "thread",
      space: "spaces/A",
      thread: "spaces/A/threads/T1",
    });
  });

  it("rejects anything else", () => {
    for (const param of [
      "",
      "spaces/",
      "spaces/A/",
      "spaces/A/threads",
      "spaces/A/threads/",
      "spaces/A/threads/T1/",
      "spaces/A/threads/T1/messages/M1",
      "spaces/A/messages/M1",
      "threads/T1",
      "spaces/A B",
      "A:thread",
      "spaces/*",
    ]) {
      expect(parseChatWriteScope(param), JSON.stringify(param)).toBeUndefined();
    }
  });

  it("names a thread's space only for a canonical thread", () => {
    expect(gchatThreadSpace("spaces/A/threads/T1")).toBe("spaces/A");
    expect(gchatThreadSpace("spaces/A")).toBeUndefined();
    expect(gchatThreadSpace("threads/T1")).toBeUndefined();
  });

  it("holds a space only by an exact whole-space grant, never by * or a thread", () => {
    expect(holdsChatWriteSpace(["chat-write:spaces/A"], "spaces/A")).toBe(true);
    expect(holdsChatWriteSpace(["chat-write:A"], "spaces/A")).toBe(true);
    expect(holdsChatWriteSpace(["chat-write:*"], "spaces/A")).toBe(false);
    expect(holdsChatWriteSpace(["chat-write:spaces/A/threads/T1"], "spaces/A")).toBe(false);
    expect(holdsChatWriteSpace(["chat-write:spaces/B", "drive-read:spaces/A"], "spaces/A")).toBe(
      false
    );
  });

  it("folds grant parameters into one scope, dropping what it cannot parse", () => {
    const scopes = chatWriteScopes(["spaces/A", "B", "spaces/C/threads/T1", "spaces/D:thread"]);
    expect(scopes.allSpaces).toBe(false);
    expect([...scopes.spaces]).toEqual(["spaces/A", "spaces/B"]);
    expect([...scopes.threads]).toEqual(["spaces/C/threads/T1"]);
    expect(chatWriteScopes(["*"]).allSpaces).toBe(true);
  });
});
