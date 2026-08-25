import { describe, expect, it } from "vitest";
import { FakeChatClient } from "./fake.js";
import { listAllChatSpaces } from "./spaces.js";
import type { ChatClient, ChatSpacePage } from "./types.js";

function clientListing(listSpaces: ChatClient["listSpaces"]): ChatClient {
  const fake = new FakeChatClient();
  return Object.assign(fake, { listSpaces }) as ChatClient;
}

describe("listAllChatSpaces ", () => {
  it("walks the page chain to its end and returns every space", async () => {
    const client = new FakeChatClient();
    for (let i = 0; i < 250; i++) client.spaces.push({ name: `spaces/S${i}` });

    const membership = await listAllChatSpaces(client);

    expect(membership.complete).toBe(true);
    expect(membership.spaces).toHaveLength(250);
    expect(membership.spaces[249].name).toBe("spaces/S249");
    expect(membership.error).toBeUndefined();
  });

  it("reports a member of nothing as a completed walk, not as a failure", async () => {
    const membership = await listAllChatSpaces(new FakeChatClient());

    expect(membership).toEqual({ spaces: [], complete: true });
  });

  it("does not report a failed walk as an empty membership", async () => {
    // The failure to avoid: `[]` from a broken enumeration reads identically to
    // "this identity is in no spaces", and a caller would report chat as outside
    // the read set for a run that simply could not look.
    const client = clientListing(async () => {
      throw new Error("403 caller lacks chat.spaces.readonly");
    });

    const membership = await listAllChatSpaces(client);

    expect(membership.complete).toBe(false);
    expect(membership.spaces).toEqual([]);
    expect(membership.error).toContain("chat.spaces.readonly");
  });

  it("keeps what it read when the walk fails partway, but still calls it incomplete", async () => {
    let calls = 0;
    const client = clientListing(async (): Promise<ChatSpacePage> => {
      calls++;
      if (calls === 1) return { spaces: [{ name: "spaces/AAA" }], nextPageToken: "2" };
      throw new Error("network reset");
    });

    const membership = await listAllChatSpaces(client);

    expect(membership.complete).toBe(false);
    expect(membership.error).toContain("network reset");
  });

  it("stops at the page ceiling rather than following a token loop forever", async () => {
    // A server that always hands back a token would otherwise hang the run.
    let calls = 0;
    const client = clientListing(async (): Promise<ChatSpacePage> => {
      calls++;
      return { spaces: [{ name: `spaces/P${calls}` }], nextPageToken: "always" };
    });

    const membership = await listAllChatSpaces(client);

    expect(membership.complete).toBe(false);
    expect(membership.error).toContain("pages with more spaces remaining");
    expect(calls).toBeLessThanOrEqual(50);
  });

  it("dedups spaces repeated across pages", async () => {
    let calls = 0;
    const client = clientListing(async (): Promise<ChatSpacePage> => {
      calls++;
      if (calls === 1) return { spaces: [{ name: "spaces/AAA" }], nextPageToken: "2" };
      return { spaces: [{ name: "spaces/AAA" }, { name: "spaces/BBB" }] };
    });

    const membership = await listAllChatSpaces(client);

    expect(membership.complete).toBe(true);
    expect(membership.spaces.map((s) => s.name)).toEqual(["spaces/AAA", "spaces/BBB"]);
  });

  it("returns direct messages and group chats, not only named spaces", async () => {
    // The carve-out this replaced filtered the read set down to one space up
    // front. Membership is now the scope; what belongs in a durable node is a
    // per-message judgment made later.
    const client = new FakeChatClient();
    client.spaces.push(
      { name: "spaces/AAA", spaceType: "SPACE", displayName: "org" },
      { name: "spaces/DM1", spaceType: "DIRECT_MESSAGE" },
      { name: "spaces/GC1", spaceType: "GROUP_CHAT" }
    );

    const membership = await listAllChatSpaces(client);

    expect(membership.spaces.map((s) => s.spaceType)).toEqual([
      "SPACE",
      "DIRECT_MESSAGE",
      "GROUP_CHAT",
    ]);
  });
});
