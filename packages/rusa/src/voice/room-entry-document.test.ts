import { describe, expect, it } from "vitest";
import { parseRoomEntryDocument, ROOM_ENTRY_LIMITS } from "./room-entry-document.js";

describe("stored Room entry bounds (#829)", () => {
  it("rejects a stored document with too many leases", () => {
    const leases = Array.from({ length: ROOM_ENTRY_LIMITS.maxLeases + 1 }, (_, i) => ({
      clientId: `tab-${i}`,
      generation: `g-${i}`,
      sessionKey: "digest",
      renewedAt: 0,
    }));
    expect(() =>
      parseRoomEntryDocument(JSON.stringify({ version: 1, leases, recipients: [] }))
    ).toThrow();
  });

  it("rejects a stored document with too many recipients", () => {
    const recipients = Array.from({ length: ROOM_ENTRY_LIMITS.maxRecipients + 1 }, (_, i) => ({
      actorId: `actor-${i}`,
      status: "pending",
    }));
    expect(() =>
      parseRoomEntryDocument(JSON.stringify({ version: 1, leases: [], recipients }))
    ).toThrow();
  });

  it("rejects oversized stored bytes even when JSON whitespace is discarded", () => {
    const json = `${" ".repeat(ROOM_ENTRY_LIMITS.maxDocumentBytes)}{"version":1,"leases":[],"recipients":[]}`;
    expect(() => parseRoomEntryDocument(json)).toThrow();
  });
});
