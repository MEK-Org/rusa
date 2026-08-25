import { describe, expect, it } from "vitest";
import type { RusaConfig } from "../config/types.js";
import { resolveGlassGoalsConfig, resolveUnderstandingRootNodeId } from "./root-scope.js";

describe("resolveGlassGoalsConfig", () => {
  it("returns undefined when no glassGoals is configured", () => {
    expect(resolveGlassGoalsConfig({} as RusaConfig)).toBeUndefined();
  });

  it("returns nested understanding.glassGoals when configured", () => {
    const config = {
      understanding: {
        glassGoals: { username: "nested-user", firebaseServiceAccountKeyPath: "/key.json" },
      },
    } as RusaConfig;

    expect(resolveGlassGoalsConfig(config)).toEqual({
      username: "nested-user",
      firebaseServiceAccountKeyPath: "/key.json",
    });
  });

  it("returns legacy top-level glassGoals when configured", () => {
    const config = {
      glassGoals: { username: "legacy-user" },
    } as RusaConfig;

    expect(resolveGlassGoalsConfig(config)).toEqual({
      username: "legacy-user",
    });
  });

  it("prefers nested understanding.glassGoals over legacy top-level glassGoals", () => {
    const config = {
      understanding: {
        glassGoals: { username: "nested-user" },
      },
      glassGoals: { username: "legacy-user" },
    } as RusaConfig;

    expect(resolveGlassGoalsConfig(config)).toEqual({
      username: "nested-user",
    });
  });
});

describe("resolveUnderstandingRootNodeId", () => {
  it("uses the provider-neutral local root", () => {
    const config = {
      understanding: { rootNodeId: "local-root" },
    } as RusaConfig;

    expect(resolveUnderstandingRootNodeId(config)).toBe("local-root");
  });

  it("resolves nested understanding.glassGoals.rootNodeId", () => {
    const config = {
      understanding: {
        glassGoals: { username: "user", rootNodeId: "nested-gg-root" },
      },
    } as RusaConfig;

    expect(resolveUnderstandingRootNodeId(config)).toBe("nested-gg-root");
  });

  it("retains legacy glassGoals.rootNodeId as a compatibility fallback", () => {
    const config = {
      glassGoals: { username: "user", rootNodeId: "legacy-remote-root" },
    } as RusaConfig;

    expect(resolveUnderstandingRootNodeId(config)).toBe("legacy-remote-root");
  });

  it("prefers provider-neutral root over nested glassGoals root and legacy glassGoals root", () => {
    const config = {
      understanding: {
        rootNodeId: "provider-neutral-root",
        glassGoals: { username: "user", rootNodeId: "nested-gg-root" },
      },
      glassGoals: { username: "user", rootNodeId: "legacy-remote-root" },
    } as RusaConfig;

    expect(resolveUnderstandingRootNodeId(config)).toBe("provider-neutral-root");
  });

  it("prefers nested glassGoals.rootNodeId over legacy glassGoals.rootNodeId", () => {
    const config = {
      understanding: {
        glassGoals: { username: "user", rootNodeId: "nested-gg-root" },
      },
      glassGoals: { username: "user", rootNodeId: "legacy-remote-root" },
    } as RusaConfig;

    expect(resolveUnderstandingRootNodeId(config)).toBe("nested-gg-root");
  });
});
