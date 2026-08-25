import { describe, expect, it } from "vitest";
import { ADJECTIVES, ANIMALS, generateHandle, resolveRootHandle } from "./handle-generator.js";

describe("Handle Generator", () => {
  it("displays the root as root-actor by default", () => {
    expect(generateHandle("root")).toBe("root-actor");
  });

  it("has exactly 256 adjectives and 256 animals", () => {
    expect(ADJECTIVES).toHaveLength(256);
    expect(ANIMALS).toHaveLength(256);
  });

  it("maps fixed UUIDs to stable friendly handles (golden tests)", () => {
    expect(generateHandle("b3111423-7042-482e-a96b-50b4e782603e")).toBe("burning-paca");
    expect(generateHandle("6bb88653-26ca-472e-bb2d-1060f828b658")).toBe("kinetic-deer");
    expect(generateHandle("b4b43d69-5e63-4db2-b44b-35c031096aad")).toBe("cloudy-porpoise");
  });

  it("is deterministic", () => {
    const uuid = "b3111423-7042-482e-a96b-50b4e782603e";
    const handle1 = generateHandle(uuid);
    const handle2 = generateHandle(uuid);
    expect(handle1).toBe(handle2);
    expect(handle1).toMatch(/^[a-z0-9-]+-[a-z0-9-]+$/);
  });

  it("generates different handles for different UUIDs", () => {
    const uuid1 = "b3111423-7042-482e-a96b-50b4e782603e";
    const uuid2 = "6bb88653-26ca-472e-bb2d-1060f828b658";
    const uuid3 = "b4b43d69-5e63-4db2-b44b-35c031096aad";

    const h1 = generateHandle(uuid1);
    const h2 = generateHandle(uuid2);
    const h3 = generateHandle(uuid3);

    expect(h1).not.toBe(h2);
    expect(h1).not.toBe(h3);
    expect(h2).not.toBe(h3);
  });
});

describe("resolveRootHandle", () => {
  it("defaults to root-actor when no config is given", () => {
    expect(resolveRootHandle()).toBe("root-actor");
    expect(resolveRootHandle({})).toBe("root-actor");
    expect(resolveRootHandle({ rootActor: {} })).toBe("root-actor");
  });

  it("uses the configured handle when set (e.g. a staging instance)", () => {
    expect(resolveRootHandle({ rootActor: { handle: "ember-familiar" } })).toBe("ember-familiar");
  });
});
