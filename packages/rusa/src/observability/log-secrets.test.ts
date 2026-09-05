import { describe, expect, it } from "vitest";
import type { RusaConfig } from "../config/types.js";
import { collectConfigSecrets, collectEnvSecrets, SECRET_ENV_VARS } from "./log-secrets.js";

// Synthetic values only; none of these is a real credential.
const envFixture = {
  GEMINI_API_KEY: "AIzaSyFAKE-fixture-key-0000",
  GH_TOKEN: "ghp_fixtureFIXTUREfixture0000",
  PATH: "/usr/bin",
} as NodeJS.ProcessEnv;

describe("collectEnvSecrets", () => {
  it("collects the credential-bearing variables and nothing else", () => {
    expect(collectEnvSecrets(envFixture).sort()).toEqual(
      ["AIzaSyFAKE-fixture-key-0000", "ghp_fixtureFIXTUREfixture0000"].sort()
    );
  });

  it("skips empty and whitespace-only values, which would match every string", () => {
    expect(collectEnvSecrets({ GH_TOKEN: "", GITHUB_TOKEN: "   " } as NodeJS.ProcessEnv)).toEqual(
      []
    );
  });

  it("returns one entry when two variables hold the same token", () => {
    expect(
      collectEnvSecrets({ GH_TOKEN: "same-fixture-token", GITHUB_TOKEN: "same-fixture-token" })
    ).toEqual(["same-fixture-token"]);
  });

  it("names every provider and forge credential the service reads", () => {
    expect(SECRET_ENV_VARS).toContain("GEMINI_API_KEY");
    expect(SECRET_ENV_VARS).toContain("MISTRAL_API_KEY");
    expect(SECRET_ENV_VARS).toContain("GH_TOKEN");
    expect(SECRET_ENV_VARS).toContain("GITHUB_TOKEN");
  });
});

describe("collectConfigSecrets", () => {
  it("collects the credential values carried in config.yaml", () => {
    const config = {
      geminiApiKey: "AIzaSyFAKE-fixture-key-1111",
      mistralApiKey: "fixture-mistral-key-2222",
      webhook: { port: 9742, secret: "fixture-webhook-secret-1234" },
    } as RusaConfig;

    expect(collectConfigSecrets(config).sort()).toEqual(
      [
        "AIzaSyFAKE-fixture-key-1111",
        "fixture-mistral-key-2222",
        "fixture-webhook-secret-1234",
      ].sort()
    );
  });

  it("returns nothing for a config that carries no credentials", () => {
    expect(collectConfigSecrets({} as RusaConfig)).toEqual([]);
  });
});
