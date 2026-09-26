import { describe, expect, it } from "vitest";
import {
  chatMessageWakes,
  chatSpaceResource,
  chatWakeModeFromConfig,
  tryChatSpaceResource,
  withChatWakeMode,
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

  it("reads and changes only its key in a versioned event-source config blob", () => {
    const raw = '{"version":1,"otherFeature":{"enabled":true},"chatWakeMode":"mentions"}';
    expect(chatWakeModeFromConfig(raw)).toBe("mentions");
    const all = withChatWakeMode(raw, "all");
    expect(all).toEqual(expect.any(String));
    expect(JSON.parse(all ?? "")).toEqual({
      version: 1,
      otherFeature: { enabled: true },
      chatWakeMode: "all",
    });
    const cleared = withChatWakeMode(raw, null);
    expect(cleared).toEqual(expect.any(String));
    expect(JSON.parse(cleared ?? "")).toEqual({
      version: 1,
      otherFeature: { enabled: true },
    });
  });

  it("fails closed for malformed or unknown-version config and refuses to overwrite it", () => {
    for (const raw of [
      "not JSON",
      '{"version":2,"chatWakeMode":"all"}',
      '{"version":1,"chatWakeMode":"bad"}',
    ]) {
      expect(chatWakeModeFromConfig(raw)).toBeUndefined();
      expect(() => withChatWakeMode(raw, "all")).toThrow(/malformed or unknown/);
    }
  });
});
