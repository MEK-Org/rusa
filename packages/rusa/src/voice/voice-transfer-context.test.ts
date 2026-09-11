import { describe, expect, it } from "vitest";
import type { MeshChat } from "../db/repositories/mesh-chat-repository.js";
import {
  MAX_VOICE_TRANSFER_CONTEXT_MESSAGES,
  MAX_VOICE_TRANSFER_MESSAGE_CHARS,
  renderVoiceTransferContext,
} from "./voice-transfer-context.js";

function message(index: number, body = `body ${index}`): MeshChat {
  return {
    id: `m-${index}`,
    ts: `2026-09-10T00:00:${String(index).padStart(2, "0")}.000Z`,
    senderId: index % 2 === 0 ? "human:operator" : "actor-a",
    recipientId: index % 2 === 0 ? "actor-a" : "human:operator",
    body,
    sessionId: "session-a",
  };
}

describe("renderVoiceTransferContext", () => {
  it("renders the query-bounded chronological rows plus the optional note", () => {
    const context = renderVoiceTransferContext(
      Array.from({ length: MAX_VOICE_TRANSFER_CONTEXT_MESSAGES }, (_, index) => message(index + 3)),
      "continue with the deployment check"
    );

    expect(context).toContain("body 3");
    expect(context.indexOf("body 3")).toBeLessThan(context.indexOf("body 14"));
    expect(context).toContain("Actor handoff note:");
    expect(context).toContain("continue with the deployment check");
  });

  it("clips a long row rather than letting it make context unbounded", () => {
    const context = renderVoiceTransferContext([message(1, "x".repeat(900))]);
    expect(context).toContain("x".repeat(MAX_VOICE_TRANSFER_MESSAGE_CHARS - 1));
    expect(context).toContain("…");
    expect(context).not.toContain("x".repeat(MAX_VOICE_TRANSFER_MESSAGE_CHARS + 1));
  });
});
