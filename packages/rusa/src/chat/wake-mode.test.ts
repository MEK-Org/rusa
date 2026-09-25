import { describe, expect, it } from "vitest";
import {
  chatMessageWakes,
  chatSpaceResource,
  InMemoryChatWakeModeStore,
  tryChatSpaceResource,
} from "./wake-mode.js";

describe("chat wake mode (#692)", () => {
  const dm = { isDirectMessage: true, mentionsSelf: false };
  const dmMention = { isDirectMessage: true, mentionsSelf: true };
  const space = { isDirectMessage: false, mentionsSelf: false };
  const spaceMention = { isDirectMessage: false, mentionsSelf: true };

  it("keeps the built-in default when no mode is set", () => {
    expect(chatMessageWakes(dm, undefined)).toBe(true);
    expect(chatMessageWakes(space, undefined)).toBe(false);
    expect(chatMessageWakes(spaceMention, undefined)).toBe(true);
  });

  it("wakes on every message under `all` and only on a mention under `mentions`", () => {
    expect(chatMessageWakes(space, "all")).toBe(true);
    expect(chatMessageWakes(dm, "all")).toBe(true);
    expect(chatMessageWakes(dm, "mentions")).toBe(false);
    expect(chatMessageWakes(dmMention, "mentions")).toBe(true);
    expect(chatMessageWakes(spaceMention, "mentions")).toBe(true);
  });

  it("names one space canonically and refuses anything else", () => {
    expect(chatSpaceResource("spaces/AAA")).toBe("gchat:spaces/AAA");
    expect(chatSpaceResource("AAA")).toBe("gchat:spaces/AAA");
    expect(chatSpaceResource("gchat:spaces/AAA")).toBe("gchat:spaces/AAA");
    expect(() => chatSpaceResource("gchat:spaces")).toThrow(/one space/);
    expect(() => chatSpaceResource("gchat:spaces/AAA/threads/T")).toThrow(/one space/);
    expect(() => chatSpaceResource("github:dummy-org/dummy-repo")).toThrow(/one space/);
  });

  it("tryChatSpaceResource safely parses valid space names and returns undefined otherwise", () => {
    expect(tryChatSpaceResource("spaces/AAA")).toBe("gchat:spaces/AAA");
    expect(tryChatSpaceResource("AAA")).toBe("gchat:spaces/AAA");
    expect(tryChatSpaceResource("gchat:spaces/AAA")).toBe("gchat:spaces/AAA");
    expect(tryChatSpaceResource("gchat:spaces")).toBeUndefined();
    expect(tryChatSpaceResource("gchat:spaces/AAA/threads/T")).toBeUndefined();
    expect(tryChatSpaceResource("github:dummy-org/dummy-repo")).toBeUndefined();
    expect(tryChatSpaceResource("malformed space name")).toBeUndefined();
    expect(tryChatSpaceResource("")).toBeUndefined();
  });

  it("stores and clears per space in memory", () => {
    const store = new InMemoryChatWakeModeStore();
    const setting = { resource: "gchat:spaces/A", mode: "all" as const };
    store.set(setting);
    expect(store.get("gchat:spaces/A")).toEqual(setting);
    expect(store.get("gchat:spaces/B")).toBeUndefined();
    store.clear("gchat:spaces/A");
    expect(store.get("gchat:spaces/A")).toBeUndefined();
  });
});
