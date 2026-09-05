import { describe, expect, it } from "vitest";
import type { RusaConfig } from "../config/types.js";
import {
  collectConfigSecretEntries,
  collectConfigSecrets,
  collectEnvSecretEntries,
  collectEnvSecrets,
  SECRET_ENV_VARS,
  unscrubbableSecretSources,
} from "./log-secrets.js";

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

describe("unscrubbableSecretSources", () => {
  it("names a configured credential too short to remove from log text", () => {
    const config = { webhook: { port: 8080, secret: "ab" } } as RusaConfig;

    expect(unscrubbableSecretSources(collectConfigSecretEntries(config))).toEqual([
      { source: "webhook.secret", length: 2 },
    ]);
  });

  it("reports the source and the length, never the value", () => {
    const short = unscrubbableSecretSources([{ source: "geminiApiKey", value: "xy" }]);

    expect(JSON.stringify(short)).not.toContain("xy");
  });

  it("says nothing about credentials the scrubber can handle", () => {
    const config = {
      geminiApiKey: "AIzaSyFAKE-fixture-key-0000",
      webhook: { port: 8080, secret: "fixture-webhook-secret-0000" },
    } as RusaConfig;

    expect(unscrubbableSecretSources(collectConfigSecretEntries(config))).toEqual([]);
  });

  it("reports a source once even when it appears twice", () => {
    const short = unscrubbableSecretSources([
      { source: "GH_TOKEN", value: "ab" },
      { source: "GH_TOKEN", value: "cd" },
    ]);

    expect(short).toEqual([{ source: "GH_TOKEN", length: 2 }]);
  });
});

describe("labeled secret entries", () => {
  it("carries the environment variable each credential came from", () => {
    expect(collectEnvSecretEntries(envFixture)).toEqual([
      { source: "GEMINI_API_KEY", value: "AIzaSyFAKE-fixture-key-0000" },
      { source: "GH_TOKEN", value: "ghp_fixtureFIXTUREfixture0000" },
    ]);
  });

  it("carries the config key each credential came from", () => {
    const config = {
      mistralApiKey: "fixture-mistral-key-0000",
      webhook: { port: 8080, secret: "fixture-webhook-secret-0000" },
    } as RusaConfig;

    expect(collectConfigSecretEntries(config)).toEqual([
      { source: "mistralApiKey", value: "fixture-mistral-key-0000" },
      { source: "webhook.secret", value: "fixture-webhook-secret-0000" },
    ]);
  });
});
