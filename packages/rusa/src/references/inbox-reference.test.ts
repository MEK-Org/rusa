import { describe, expect, it } from "vitest";
import { gchatInboxMessageReference } from "./inbox-reference.js";

describe("gchatInboxMessageReference", () => {
  const payload = { type: "gchat.message", messageName: "spaces/A/messages/M1" };

  it("resolves a message whose entry routed at its space or at a thread of it (#1311)", () => {
    expect(gchatInboxMessageReference("gchat:spaces/A", payload)).toBe(
      "gchat:spaces/A/messages/M1"
    );
    expect(gchatInboxMessageReference("gchat:spaces/A/threads/T1", payload)).toBe(
      "gchat:spaces/A/messages/M1"
    );
  });

  it("refuses a message outside the entry's source space", () => {
    for (const source of [
      "gchat:spaces/B",
      "gchat:spaces/B/threads/T1",
      "gchat:spaces/A/messages/M1",
      "gchat:spaces",
    ]) {
      expect(gchatInboxMessageReference(source, payload), source).toBeUndefined();
    }
  });
});
