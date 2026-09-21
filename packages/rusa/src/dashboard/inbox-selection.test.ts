import { describe, expect, it } from "vitest";
import type { InboxEntry } from "../repositories/inbox-repository.js";
import { compareInboxPriority, selectPrioritizedInboxItem } from "./inbox-selection.js";

function makeEntry(
  id: string,
  deliveredAtIso: string,
  priority?: "responsive",
  type = "message"
): InboxEntry {
  return {
    id,
    actorId: "actor-1",
    source: "chat",
    deliveredAt: new Date(deliveredAtIso),
    seenAt: null,
    handledAt: null,
    handledNote: null,
    payload: {
      type,
      ...(priority ? { priority } : {}),
      content: `Message ${id}`,
    },
  };
}

describe("inbox-selection", () => {
  describe("compareInboxPriority", () => {
    it("orders responsive items before normal items even if normal arrived earlier", () => {
      const normalEarlier = makeEntry("normal-early", "2026-09-01T10:00:00.000Z");
      const responsiveLater = makeEntry(
        "responsive-late",
        "2026-09-01T11:00:00.000Z",
        "responsive"
      );

      expect(compareInboxPriority(responsiveLater, normalEarlier)).toBeLessThan(0);
      expect(compareInboxPriority(normalEarlier, responsiveLater)).toBeGreaterThan(0);
    });

    it("orders earlier items first when responsiveness is equal", () => {
      const normalEarly = makeEntry("normal-early", "2026-09-01T10:00:00.000Z");
      const normalLate = makeEntry("normal-late", "2026-09-01T11:00:00.000Z");

      expect(compareInboxPriority(normalEarly, normalLate)).toBeLessThan(0);
      expect(compareInboxPriority(normalLate, normalEarly)).toBeGreaterThan(0);

      const responsiveEarly = makeEntry("resp-early", "2026-09-01T10:00:00.000Z", "responsive");
      const responsiveLate = makeEntry("resp-late", "2026-09-01T11:00:00.000Z", "responsive");

      expect(compareInboxPriority(responsiveEarly, responsiveLate)).toBeLessThan(0);
      expect(compareInboxPriority(responsiveLate, responsiveEarly)).toBeGreaterThan(0);
    });

    it("tiebreaks by id ascending when priority and timestamp are equal", () => {
      const a = makeEntry("entry-a", "2026-09-01T10:00:00.000Z");
      const b = makeEntry("entry-b", "2026-09-01T10:00:00.000Z");

      expect(compareInboxPriority(a, b)).toBeLessThan(0);
      expect(compareInboxPriority(b, a)).toBeGreaterThan(0);
    });
  });

  describe("selectPrioritizedInboxItem", () => {
    it("returns null for empty entries", () => {
      expect(selectPrioritizedInboxItem([])).toBeNull();
    });

    it("handles single-item case with moreCount = 0", () => {
      const single = makeEntry("single", "2026-09-01T10:00:00.000Z");
      const result = selectPrioritizedInboxItem([single]);
      expect(result).not.toBeNull();
      expect(result?.item.id).toBe("single");
      expect(result?.moreCount).toBe(0);
    });

    it("selects responsive first then earliest, and computes (+N more) count", () => {
      const normal1 = makeEntry("norm-1", "2026-09-01T09:00:00.000Z");
      const normal2 = makeEntry("norm-2", "2026-09-01T09:30:00.000Z");
      const resp1 = makeEntry("resp-1", "2026-09-01T10:00:00.000Z", "responsive");
      const resp2 = makeEntry("resp-2", "2026-09-01T08:00:00.000Z", "responsive");

      // resp2 arrived at 08:00, resp1 arrived at 10:00. Both responsive.
      // norm1 arrived at 09:00, norm2 arrived at 09:30.
      // Order should be: resp2, resp1, norm1, norm2.
      // Top item must be resp2. Total = 4, moreCount = 3.
      const result = selectPrioritizedInboxItem([normal1, resp1, normal2, resp2]);
      expect(result).not.toBeNull();
      expect(result?.item.id).toBe("resp-2");
      expect(result?.moreCount).toBe(3);
    });

    it("respects totalCount parameter when page size differs from total unhandled count", () => {
      const norm1 = makeEntry("norm-1", "2026-09-01T09:00:00.000Z");
      const resp1 = makeEntry("resp-1", "2026-09-01T10:00:00.000Z", "responsive");

      // 2 items loaded, but total unhandled is 11.
      // Top item is resp1, moreCount should be 11 - 1 = 10.
      const result = selectPrioritizedInboxItem([norm1, resp1], 11);
      expect(result).not.toBeNull();
      expect(result?.item.id).toBe("resp-1");
      expect(result?.moreCount).toBe(10);
    });
  });
});
