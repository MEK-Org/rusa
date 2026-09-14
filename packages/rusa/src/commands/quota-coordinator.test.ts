import { describe, expect, it } from "vitest";
import type { RusaConfig } from "../config/types.js";
import { coordinatorProviderLanes } from "./quota-coordinator.js";

describe("coordinatorProviderLanes", () => {
  it("preserves configured read lanes while collecting only supported probes", () => {
    const config = {
      providers: {
        claude: { cliCommand: "claude" },
        experimental: { cliCommand: "experimental" },
      },
    } as unknown as RusaConfig;

    expect(coordinatorProviderLanes(config)).toEqual({
      configuredProviders: ["claude", "experimental"],
      collectionProviders: ["claude"],
    });
  });

  it("keeps the established all-provider default when no provider is configured", () => {
    expect(coordinatorProviderLanes({ providers: {} } as unknown as RusaConfig)).toEqual({
      configuredProviders: undefined,
      collectionProviders: ["claude", "codex", "agy", "kimi"],
    });
  });
});
