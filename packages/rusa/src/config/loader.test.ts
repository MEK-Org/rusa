import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { stringify as toYaml } from "yaml";
import { loadConfig } from "./loader.js";
import { DEFAULT_DEPLOY_BRANCH } from "./types.js";

function writeConfig(overrides: Record<string, unknown> = {}): string {
  const home = mkdtempSync(join(tmpdir(), "rusa-config-"));
  writeFileSync(
    join(home, "config.yaml"),
    toYaml({
      github: { account: "CodeChopsBot", pollIntervalSeconds: 300 },
      providers: { codex: { cliCommand: "codex" } },
      geminiApiKey: "test-key",
      webhook: { port: 9742, secret: "secret" },
      ...overrides,
    }),
    "utf8"
  );
  return home;
}

describe("loadConfig deployBranch", () => {
  it("defaults deployBranch to master when omitted", () => {
    const config = loadConfig(writeConfig());
    expect(config.deployBranch).toBe(DEFAULT_DEPLOY_BRANCH);
  });

  it("honors an explicit deployBranch", () => {
    const config = loadConfig(writeConfig({ deployBranch: "staging" }));
    expect(config.deployBranch).toBe("staging");
  });

  it("rejects a blank deployBranch", () => {
    expect(() => loadConfig(writeConfig({ deployBranch: "   " }))).toThrow(
      /deployBranch must be a non-empty string/
    );
  });
});

describe("loadConfig geminiApiKey (optional)", () => {
  it("loads a config that omits geminiApiKey", () => {
    // writeConfig always injects the key, so build one without it directly.
    const home = mkdtempSync(join(tmpdir(), "rusa-config-"));
    writeFileSync(
      join(home, "config.yaml"),
      toYaml({
        github: { account: "CodeChopsBot", pollIntervalSeconds: 300 },
        providers: { codex: { cliCommand: "codex" } },
        webhook: { port: 9742, secret: "secret" },
      }),
      "utf8"
    );
    const config = loadConfig(home);
    expect(config.geminiApiKey).toBeUndefined();
  });

  it("keeps an explicit geminiApiKey", () => {
    expect(loadConfig(writeConfig({ geminiApiKey: "abc" })).geminiApiKey).toBe("abc");
  });
});

describe("loadConfig rootActor.context", () => {
  it("normalizes a valid portable ledger context", () => {
    const config = loadConfig(
      writeConfig({
        rootActor: {
          provider: "codex",
          context: {
            type: "portable",
            mode: "ledger",
            compactionModel: "  gemini-test  ",
          },
        },
      })
    );

    expect(config.rootActor?.context).toEqual({
      type: "portable",
      mode: "ledger",
      compactionModel: "gemini-test",
    });
  });

  it.each([
    [{ type: "portible", mode: "tail" }, /unknown context type/],
    [{ type: "portable", mode: "typo" }, /unknown context selection/],
    [
      { type: "portable", mode: "tail", compactionModel: "gemini-test" },
      /compactionModel is meaningless for tail mode/,
    ],
    [{ type: "native", mode: "tail" }, /mode is meaningless for native context/],
  ])("rejects malformed or meaningless context %#", (context, message) => {
    expect(() => loadConfig(writeConfig({ rootActor: { provider: "codex", context } }))).toThrow(
      message
    );
  });

  it("rejects ledger mode when no Gemini key is available", () => {
    expect(() =>
      loadConfig(
        writeConfig({
          geminiApiKey: undefined,
          rootActor: {
            provider: "codex",
            context: { type: "portable", mode: "ledger" },
          },
        })
      )
    ).toThrow(/portable ledger mode needs a Gemini API key/);
  });
});

describe("loadConfig rootActor effort", () => {
  it("normalizes first-class effort and legacy Codex model qualifiers", () => {
    const explicit = loadConfig(
      writeConfig({
        rootActor: { provider: "codex", model: "gpt-5.6-sol", effort: "HIGH" },
      })
    );
    expect(explicit.rootActor).toMatchObject({
      provider: "codex",
      model: "gpt-5.6-sol",
      effort: "high",
    });

    const legacy = loadConfig(
      writeConfig({ rootActor: { provider: "codex", model: "gpt-5.6-sol extra-high" } })
    );
    expect(legacy.rootActor).toMatchObject({
      model: "gpt-5.6-sol",
      effort: "xhigh",
    });
  });

  it("rejects an effort unsupported by the selected provider", () => {
    expect(() =>
      loadConfig(
        writeConfig({
          providers: { kimi: { cliCommand: "kimi" } },
          rootActor: { provider: "kimi", model: "kimi-code", effort: "high" },
        })
      )
    ).toThrow(/does not expose a reasoning-effort control/);
  });

  it("validates effort against the CLI behind a logical provider name", () => {
    const config = loadConfig(
      writeConfig({
        providers: { strong: { cliCommand: "claude" } },
        rootActor: { provider: "strong", model: "claude-opus-4-8", effort: "MAX" },
      })
    );
    expect(config.rootActor).toMatchObject({ provider: "strong", effort: "max" });
  });
});

describe("loadConfig mistralApiKey (optional)", () => {
  it("keeps an explicit mistralApiKey", () => {
    expect(loadConfig(writeConfig({ mistralApiKey: "mistral-test" })).mistralApiKey).toBe(
      "mistral-test"
    );
  });
});

describe("loadConfig secrets files ($RUSA_HOME/secrets, ISSUE_NUM)", () => {
  function writeSecret(home: string, name: string, value: string): void {
    const dir = join(home, "secrets");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, name), value, { mode: 0o600 });
  }

  it("secrets/gemini-api-key wins over the inline geminiApiKey (trimmed) and warns about the duplicate", () => {
    const home = writeConfig({ geminiApiKey: "inline-key" });
    writeSecret(home, "gemini-api-key", "  file-key  \n");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const config = loadConfig(home);
    expect(config.geminiApiKey).toBe("file-key");
    expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/geminiApiKey.*secrets file wins/));
    // The warning never carries a secret value.
    for (const call of warnSpy.mock.calls) {
      expect(String(call[0])).not.toContain("file-key");
      expect(String(call[0])).not.toContain("inline-key");
    }
    warnSpy.mockRestore();
  });

  it("secrets/mistral-api-key wins over inline mistralApiKey without logging either value", () => {
    const home = writeConfig({ mistralApiKey: "inline-mistral" });
    writeSecret(home, "mistral-api-key", "  file-mistral  \n");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const config = loadConfig(home);
    expect(config.mistralApiKey).toBe("file-mistral");
    expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/mistralApiKey.*secrets file wins/));
    for (const call of warnSpy.mock.calls) {
      expect(String(call[0])).not.toContain("file-mistral");
      expect(String(call[0])).not.toContain("inline-mistral");
    }
    warnSpy.mockRestore();
  });

  it("secrets/webhook-secret wins over the inline webhook.secret and warns about the duplicate", () => {
    const home = writeConfig({ webhook: { port: 9742, secret: "inline-hook" } });
    writeSecret(home, "webhook-secret", "file-hook\n");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const config = loadConfig(home);
    expect(config.webhook.secret).toBe("file-hook");
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringMatching(/webhook\.secret.*secrets file wins/)
    );
    warnSpy.mockRestore();
  });

  it("uses the file value without warning when there is no inline value", () => {
    const home = mkdtempSync(join(tmpdir(), "rusa-config-"));
    writeFileSync(
      join(home, "config.yaml"),
      toYaml({
        github: { account: "CodeChopsBot", pollIntervalSeconds: 300 },
        providers: { codex: { cliCommand: "codex" } },
        webhook: { port: 9742, secret: "" },
      }),
      "utf8"
    );
    writeSecret(home, "gemini-api-key", "file-key\n");
    writeSecret(home, "mistral-api-key", "mistral-file-key\n");
    writeSecret(home, "webhook-secret", "file-hook\n");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const config = loadConfig(home);
    expect(config.geminiApiKey).toBe("file-key");
    expect(config.mistralApiKey).toBe("mistral-file-key");
    expect(config.webhook.secret).toBe("file-hook");
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("keeps the inline values when the secrets files are missing", () => {
    const config = loadConfig(writeConfig());
    expect(config.geminiApiKey).toBe("test-key");
    expect(config.mistralApiKey).toBeUndefined();
    expect(config.webhook.secret).toBe("secret");
  });

  it("leaves geminiApiKey undefined when neither inline nor file exists", () => {
    const home = mkdtempSync(join(tmpdir(), "rusa-config-"));
    writeFileSync(
      join(home, "config.yaml"),
      toYaml({
        github: { account: "CodeChopsBot", pollIntervalSeconds: 300 },
        providers: { codex: { cliCommand: "codex" } },
        webhook: { port: 9742, secret: "secret" },
      }),
      "utf8"
    );
    expect(loadConfig(home).geminiApiKey).toBeUndefined();
    expect(loadConfig(home).mistralApiKey).toBeUndefined();
  });

  it("treats an empty/whitespace-only secrets file as absent (inline value stays)", () => {
    const home = writeConfig();
    writeSecret(home, "gemini-api-key", "   \n");
    expect(loadConfig(home).geminiApiKey).toBe("test-key");
  });
});

describe("loadConfig GitHub ingestion mode", () => {
  it("accepts poll ingestion mode", () => {
    expect(
      loadConfig(writeConfig({ github: { account: "CodeChopsBot", ingestionMode: "poll" } })).github
        .ingestionMode
    ).toBe("poll");
  });

  it("rejects an unknown ingestion mode", () => {
    expect(() =>
      loadConfig(writeConfig({ github: { account: "CodeChopsBot", ingestionMode: "socket" } }))
    ).toThrow(/github\.ingestionMode/);
  });
});

describe("loadConfig github.repos (multi-repo identity and subscriptions)", () => {
  it("defaults to undefined when omitted", () => {
    const config = loadConfig(
      writeConfig({ github: { account: "CodeChopsBot", pollIntervalSeconds: 300 } })
    );
    expect(config.github.repos).toBeUndefined();
  });

  it("trims and keeps a well-formed owner/name list", () => {
    const config = loadConfig(
      writeConfig({
        github: {
          account: "CodeChopsBot",
          repos: ["  dummy-org/dummy-repo  ", "other-org/other-repo"],
        },
      })
    );
    expect(config.github.repos).toEqual(["dummy-org/dummy-repo", "other-org/other-repo"]);
  });

  it("loads successfully with bare repos and no orgs", () => {
    const config = loadConfig(
      writeConfig({
        github: {
          account: "CodeChopsBot",
          repos: ["example-org/example-repo"],
        },
      })
    );
    expect(config.github.repos).toEqual(["example-org/example-repo"]);
    expect(config.github.orgs).toBeUndefined();
  });

  it("rejects non-array repos value", () => {
    expect(() =>
      loadConfig(
        writeConfig({
          github: {
            account: "CodeChopsBot",
            repos: "example-org/example-repo" as unknown as string[],
          },
        })
      )
    ).toThrow(/github\.repos must be an array of repository names in owner\/name format/);
  });

  it.each([
    ["no slash", "rusa"],
    ["too many segments", "dummy-org/dummy-repo/extra"],
    ["whitespace in the owner", "dummy org/rusa"],
    ["whitespace in the name", "dummy-org/sample repo"],
    ["blank string", "   "],
  ])("rejects invalid repo %s", (_label, repo) => {
    expect(() =>
      loadConfig(
        writeConfig({
          github: {
            account: "CodeChopsBot",
            repos: [repo],
          },
        })
      )
    ).toThrow(/github\.repos must be an array of repository names in owner\/name format/);
  });
});

describe("loadConfig github.orgs (event source organization derivation)", () => {
  it("defaults to undefined when omitted", () => {
    const config = loadConfig(writeConfig({ github: { account: "CodeChopsBot" } }));
    expect(config.github.orgs).toBeUndefined();
  });

  it("trims and keeps valid org objects", () => {
    const config = loadConfig(
      writeConfig({
        github: { account: "CodeChopsBot", orgs: [{ org: "  org-1  " }, { org: "org-2" }] },
      })
    );
    expect(config.github.orgs).toEqual([{ org: "org-1" }, { org: "org-2" }]);
  });

  it("parses and normalizes object entries with org and excludedRepos", () => {
    const config = loadConfig(
      writeConfig({
        github: {
          account: "CodeChopsBot",
          orgs: [{ org: "  example-org  ", excludedRepos: ["  example-org/sample-repo  "] }],
        },
      })
    );
    expect(config.github.orgs).toEqual([
      { org: "example-org", excludedRepos: ["example-org/sample-repo"] },
    ]);
  });

  it("loads successfully with bare orgs and no repos", () => {
    const config = loadConfig(
      writeConfig({
        github: {
          account: "CodeChopsBot",
          orgs: [{ org: "example-org" }],
        },
      })
    );
    expect(config.github.orgs).toEqual([{ org: "example-org" }]);
    expect(config.github.repos).toBeUndefined();
  });

  it("loads successfully with both repos and orgs configured", () => {
    const config = loadConfig(
      writeConfig({
        github: {
          account: "CodeChopsBot",
          repos: ["special-org/special-repo"],
          orgs: [{ org: "example-org", excludedRepos: ["example-org/sample-repo"] }],
        },
      })
    );
    expect(config.github.repos).toEqual(["special-org/special-repo"]);
    expect(config.github.orgs).toEqual([
      { org: "example-org", excludedRepos: ["example-org/sample-repo"] },
    ]);
  });

  it("rejects invalid github.orgs values", () => {
    expect(() =>
      loadConfig(
        writeConfig({
          github: { account: "CodeChopsBot", orgs: "not-an-array" as unknown as string[] },
        })
      )
    ).toThrow(/github\.orgs must be an array/);

    expect(() =>
      loadConfig(writeConfig({ github: { account: "CodeChopsBot", orgs: ["valid"] } }))
    ).toThrow(/github\.orgs entries must be org objects/);

    expect(() =>
      loadConfig(
        writeConfig({ github: { account: "CodeChopsBot", orgs: [{ org: "invalid/org" }] } })
      )
    ).toThrow(/github\.orgs org object must specify a valid organization name/);

    expect(() =>
      loadConfig(
        writeConfig({
          github: {
            account: "CodeChopsBot",
            orgs: [{ name: "unsupported-alias" } as unknown as { org: string }],
          },
        })
      )
    ).toThrow(/github\.orgs org object must specify a valid organization name/);

    expect(() =>
      loadConfig(
        writeConfig({
          github: {
            account: "CodeChopsBot",
            orgs: [{ org: "valid-org", excludedRepos: ["invalid-repo-without-slash"] }],
          },
        })
      )
    ).toThrow(
      /github\.orgs excludedRepos must be an array of repository names in owner\/name format/
    );

    expect(() =>
      loadConfig(
        writeConfig({
          github: {
            account: "CodeChopsBot",
            orgs: [{ org: "valid-org", excludedRepos: ["other-org/repo"] }],
          },
        })
      )
    ).toThrow(/github\.orgs excludedRepos entries must belong to their configured organization/);
  });
});

describe("loadConfig removed targets field", () => {
  it("rejects top-level targets with migration guidance", () => {
    expect(() =>
      loadConfig(
        writeConfig({
          targets: [{ repo: "dummy-org/repo", localPath: "/tmp/repo" }],
        })
      )
    ).toThrow(/top-level targets is no longer supported; use github\.repos and github\.orgs/);
  });
});

describe("loadConfig removed eventSources field", () => {
  it("rejects explicit root eventSources with migration guidance", () => {
    expect(() =>
      loadConfig(
        writeConfig({
          eventSources: [{ kind: "github_repo", repo: "dummy-org/repo" }],
        })
      )
    ).toThrow(/top-level eventSources is no longer supported; use github\.repos and github\.orgs/);
  });
});

describe("loadConfig github.workerTokenPath (optional, worker-sandbox credential split)", () => {
  it("defaults to undefined when omitted (workers see the host gh credential, unchanged)", () => {
    const config = loadConfig(
      writeConfig({ github: { account: "CodeChopsBot", pollIntervalSeconds: 300 } })
    );
    expect(config.github.workerTokenPath).toBeUndefined();
  });

  it("trims and keeps an explicit workerTokenPath", () => {
    const config = loadConfig(
      writeConfig({
        github: {
          account: "CodeChopsBot",
          pollIntervalSeconds: 300,
          workerTokenPath: "  /home/svc/.rusa/worker-github-token  ",
        },
      })
    );
    expect(config.github.workerTokenPath).toBe("/home/svc/.rusa/worker-github-token");
  });

  it("rejects a blank workerTokenPath", () => {
    expect(() =>
      loadConfig(
        writeConfig({
          github: { account: "CodeChopsBot", pollIntervalSeconds: 300, workerTokenPath: "   " },
        })
      )
    ).toThrow(/github\.workerTokenPath must be a non-empty string/);
  });
});

describe("loadConfig github.pollIntervalSeconds (optional, poller-defaulted)", () => {
  it("loads with the key absent — the poller owns the default, so this is not an error ", () => {
    const config = loadConfig(writeConfig({ github: { account: "CodeChopsBot" } }));
    expect(config.github.pollIntervalSeconds).toBeUndefined();
  });

  it("rejects a non-numeric value, which the poller's `??` cannot catch", () => {
    expect(() =>
      loadConfig(
        writeConfig({
          github: { account: "CodeChopsBot", pollIntervalSeconds: "300" as unknown as number },
        })
      )
    ).toThrow(/github\.pollIntervalSeconds must be a positive number of seconds when set/);
  });

  it("rejects zero, which would be a hot poll loop stated explicitly", () => {
    expect(() =>
      loadConfig(writeConfig({ github: { account: "CodeChopsBot", pollIntervalSeconds: 0 } }))
    ).toThrow(/github\.pollIntervalSeconds must be a positive number of seconds when set/);
  });
});

describe("loadConfig profiles", () => {
  it("applies the quickstart profile", () => {
    const config = loadConfig(writeConfig({ profile: "quickstart" }));

    expect(config.profile).toBe("quickstart");
    expect(config.sandbox).toBe("container-boundary");
    expect(config.dashboard?.port).toBe(8080);
    expect(config.dashboard?.bindHost).toBe("0.0.0.0");
    expect(config.gitBridge).toBe(true);
    expect(config.gitBridgePort).toBe(8085);
    expect(config.gitBridgeBindHost).toBe("0.0.0.0");
    expect(config.github.ingestionMode).toBe("poll");
  });

  it("keeps prod sandbox and bind defaults when no profile is configured", () => {
    const config = loadConfig(writeConfig());

    expect(config.profile).toBeUndefined();
    expect(config.sandbox).toBe("bwrap");
    expect(config.gitBridge).toBe(false);
    expect(config.gitBridgeBindHost).toBe("127.0.0.1");
  });

  it("lets explicit config override the quickstart profile", () => {
    const config = loadConfig(
      writeConfig({
        profile: "quickstart",
        github: { account: "CodeChopsBot", pollIntervalSeconds: 300, ingestionMode: "webhook" },
        sandbox: "bwrap",
        dashboard: { port: 9090, bindHost: "127.0.0.1" },
        gitBridge: false,
        gitBridgeBindHost: "127.0.0.1",
      })
    );

    expect(config.sandbox).toBe("bwrap");
    expect(config.dashboard?.bindHost).toBe("127.0.0.1");
    expect(config.gitBridge).toBe(false);
    expect(config.gitBridgeBindHost).toBe("127.0.0.1");
    expect(config.github.ingestionMode).toBe("webhook");
  });

  it("applies a CLI profile option over the config file", () => {
    const config = loadConfig(writeConfig(), { profile: "quickstart" });

    expect(config.profile).toBe("quickstart");
    expect(config.sandbox).toBe("container-boundary");
    expect(config.gitBridge).toBe(true);
    expect(config.github.ingestionMode).toBe("poll");
  });

  it("rejects an unknown profile", () => {
    expect(() => loadConfig(writeConfig({ profile: "enterprise" }))).toThrow(
      /unknown profile "enterprise"/
    );
  });

  it("rejects an unknown sandbox mode", () => {
    expect(() => loadConfig(writeConfig({ sandbox: "none" }))).toThrow(/config.yaml: sandbox/);
  });
});

describe("loadConfig dashboard quota providers", () => {
  it("defaults each provider primaryWindow to weekly when dashboard is configured", () => {
    const config = loadConfig(writeConfig({ dashboard: { port: 8080 } }));

    expect(config.dashboard?.quotaProviders).toEqual({
      claude: { primaryWindow: "weekly" },
      codex: { primaryWindow: "weekly" },
      agy: { primaryWindow: "weekly" },
      kimi: { primaryWindow: "weekly" },
    });
  });

  it("preserves per-provider primaryWindow overrides", () => {
    const config = loadConfig(
      writeConfig({
        dashboard: {
          port: 8080,
          quotaProviders: {
            claude: { primaryWindow: "session" },
            codex: { primaryWindow: "weekly" },
          },
        },
      })
    );

    expect(config.dashboard?.quotaProviders?.claude?.primaryWindow).toBe("session");
    expect(config.dashboard?.quotaProviders?.codex?.primaryWindow).toBe("weekly");
    expect(config.dashboard?.quotaProviders?.agy?.primaryWindow).toBe("weekly");
  });

  it("accepts kimi quota provider config", () => {
    const config = loadConfig(
      writeConfig({
        dashboard: {
          port: 8080,
          quotaProviders: { kimi: { primaryWindow: "weekly" } },
        },
      })
    );
    expect(config.dashboard?.quotaProviders?.kimi?.primaryWindow).toBe("weekly");
  });
});

describe("loadConfig quota throttle", () => {
  it("rejects the removed mesh location with the replacement path", () => {
    expect(() =>
      loadConfig(
        writeConfig({
          mesh: {
            quotaThrottle: {
              enabled: true,
              maxIntervalSeconds: 3600,
            },
          },
        })
      )
    ).toThrow(/mesh\.quotaThrottle has moved to quota\.throttle/);
  });

  it("requires shared persistence when adaptive pacing is enabled", () => {
    expect(() =>
      loadConfig(
        writeConfig({
          quota: {
            throttle: { enabled: true, maxIntervalSeconds: 3600 },
          },
        })
      )
    ).toThrow(/quota\.databasePath is required/);
  });

  it("accepts the canonical quota location", () => {
    const config = loadConfig(
      writeConfig({
        quota: {
          databasePath: "/srv/rusa/quota.db",
          throttle: {
            enabled: true,
            maxIntervalSeconds: 3600,
            tickSeconds: 300,
          },
        },
      })
    );

    expect(config.quota?.throttle).toEqual({
      enabled: true,
      maxIntervalSeconds: 3600,
      tickSeconds: 300,
    });
  });

  it.each([
    [{ enabled: "yes" }, /enabled must be a boolean/],
    [{ maxIntervalSeconds: 0 }, /maxIntervalSeconds/],
    [{ tickSeconds: 1.5 }, /tickSeconds must be a positive integer/],
  ])("rejects invalid quota throttle values %#", (quotaThrottle, message) => {
    expect(() => loadConfig(writeConfig({ quota: { throttle: quotaThrottle } }))).toThrow(message);
  });
});

describe("loadConfig shared quota store", () => {
  it("accepts and trims a shared database path", () => {
    const config = loadConfig(writeConfig({ quota: { databasePath: "  /srv/rusa/quota.db  " } }));
    expect(config.quota).toEqual({ databasePath: "/srv/rusa/quota.db" });
  });

  it("rejects a blank shared database path", () => {
    expect(() => loadConfig(writeConfig({ quota: { databasePath: "" } }))).toThrow(
      /quota.databasePath/
    );
  });

  it("rejects the removed pool namespace", () => {
    expect(() =>
      loadConfig(writeConfig({ quota: { databasePath: "/srv/rusa/quota.db", poolId: "shared" } }))
    ).toThrow(/quota.poolId has been removed/);
  });
});

describe("loadConfig understanding root", () => {
  it("accepts and trims a provider-neutral root node id", () => {
    const config = loadConfig(writeConfig({ understanding: { rootNodeId: "  local-root  " } }));

    expect(config.understanding?.rootNodeId).toBe("local-root");
  });

  it("rejects a blank provider-neutral root node id", () => {
    expect(() => loadConfig(writeConfig({ understanding: { rootNodeId: "   " } }))).toThrow(
      /understanding\.rootNodeId must be a non-empty string/
    );
  });
});

describe("loadConfig providers.<name>.fallbackModel is rejected ", () => {
  it("throws naming the ruling and issue when a provider carries fallbackModel", () => {
    expect(() =>
      loadConfig(
        writeConfig({
          providers: {
            codex: { cliCommand: "codex" },
            claude: { cliCommand: "claude", fallbackModel: "claude-sonnet-5" },
          },
        })
      )
    ).toThrow(/providers\.claude\.fallbackModel is no longer supported/);
  });

  it("still accepts rootActor.fallbackModel (root-only, unaffected)", () => {
    const config = loadConfig(
      writeConfig({
        rootActor: { provider: "codex", fallbackModel: "codex-fallback" },
      })
    );
    expect(config.rootActor?.fallbackModel).toBe("codex-fallback");
  });
});

describe("loadConfig voice (ISSUE_NUM, optional)", () => {
  it("loads a config that omits the voice section", () => {
    expect(loadConfig(writeConfig()).voice).toBeUndefined();
  });

  it("trims and honors explicit voice overrides", () => {
    const config = loadConfig(
      writeConfig({
        voice: { transcriptionModel: "  gemini-x ", ttsModel: "gemini-tts", voiceName: "Puck" },
      })
    );
    expect(config.voice).toEqual({
      transcriptionModel: "gemini-x",
      ttsModel: "gemini-tts",
      voiceName: "Puck",
    });
  });

  it("rejects a blank voice field", () => {
    expect(() => loadConfig(writeConfig({ voice: { voiceName: "   " } }))).toThrow(
      /voice\.voiceName must be a non-empty string/
    );
  });

  it("rejects a non-mapping voice section", () => {
    expect(() => loadConfig(writeConfig({ voice: "Charon" }))).toThrow(/voice must be a mapping/);
  });
});

describe("loadConfig chat", () => {
  it("preserves gchat allowed spaces (Refs ISSUE_NUM)", () => {
    const home = writeConfig({
      chat: {
        projectId: "test-project",
        subscription: "test-sub",
        gchat: ["spaces/AAAA"],
      },
    });
    const config = loadConfig(home);
    // Assert on round-tripped config so dropping the key fails the test (toEqual ignores undefined keys)
    const roundTripped = JSON.parse(JSON.stringify(config.chat));
    expect(roundTripped).toHaveProperty("gchat", ["spaces/AAAA"]);
  });

  it("leaves gchat undefined if absent, allowing start.ts to fall back to unrestricted (Refs ISSUE_NUM)", () => {
    const home = writeConfig({
      chat: {
        projectId: "test-project",
        subscription: "test-sub",
      },
    });
    const config = loadConfig(home);
    const roundTripped = JSON.parse(JSON.stringify(config.chat));
    expect(roundTripped).not.toHaveProperty("gchat");
  });

  it("allows 'all' for gchat (Refs ISSUE_NUM)", () => {
    const home = writeConfig({
      chat: {
        projectId: "test-project",
        subscription: "test-sub",
        gchat: "all",
      },
    });
    const config = loadConfig(home);
    expect(config.chat?.gchat).toBe("all");
  });

  it("throws on invalid gchat values (Refs ISSUE_NUM)", () => {
    const invalidValues = ["ALL", "spaces/AAAA", [], ["bad"], ["spaces/A", "bad"]];
    for (const val of invalidValues) {
      const home = writeConfig({
        chat: {
          projectId: "test-project",
          subscription: "test-sub",
          gchat: val,
        },
      });
      expect(() => loadConfig(home)).toThrow(
        /chat\.gchat must be "all" or a non-empty array of spaces/
      );
    }
  });
});

describe("loadConfig understanding and glassGoals ", () => {
  it("loads nested understanding.glassGoals configuration", () => {
    const home = writeConfig({
      understanding: {
        rootNodeId: "local-anchor",
        glassGoals: {
          username: "user@example.com",
          firebaseServiceAccountKeyPath: "/path/to/key.json",
          rootNodeId: "gg-root",
        },
      },
    });
    const config = loadConfig(home);
    expect(config.understanding).toEqual({
      rootNodeId: "local-anchor",
      glassGoals: {
        username: "user@example.com",
        firebaseServiceAccountKeyPath: "/path/to/key.json",
        rootNodeId: "gg-root",
      },
    });
    expect(config.glassGoals).toBeUndefined();
  });

  it("loads legacy top-level glassGoals configuration for backwards compatibility", () => {
    const home = writeConfig({
      glassGoals: {
        username: "legacy-user@example.com",
        firebaseServiceAccountKeyPath: "/path/to/legacy-key.json",
        rootNodeId: "legacy-root",
      },
    });
    const config = loadConfig(home);
    expect(config.glassGoals).toEqual({
      username: "legacy-user@example.com",
      firebaseServiceAccountKeyPath: "/path/to/legacy-key.json",
      rootNodeId: "legacy-root",
    });
    expect(config.understanding).toBeUndefined();
  });

  it("allows both legacy and nested glassGoals when they are identical", () => {
    const home = writeConfig({
      glassGoals: {
        username: "same-user@example.com",
        firebaseServiceAccountKeyPath: "/path/to/key.json",
        rootNodeId: "same-root",
      },
      understanding: {
        glassGoals: {
          username: "same-user@example.com",
          firebaseServiceAccountKeyPath: "/path/to/key.json",
          rootNodeId: "same-root",
        },
      },
    });
    const config = loadConfig(home);
    expect(config.understanding?.glassGoals?.username).toBe("same-user@example.com");
    expect(config.glassGoals?.username).toBe("same-user@example.com");
  });

  it("rejects conflicting glassGoals configurations across top-level and nested sections", () => {
    const home = writeConfig({
      glassGoals: {
        username: "user-a@example.com",
      },
      understanding: {
        glassGoals: {
          username: "user-b@example.com",
        },
      },
    });
    expect(() => loadConfig(home)).toThrow(
      /conflicting glassGoals configurations present in both top-level glassGoals and understanding\.glassGoals/
    );
  });

  it("rejects conflicting firebaseServiceAccountKeyPath between legacy and nested glassGoals", () => {
    const home = writeConfig({
      glassGoals: {
        username: "user@example.com",
        firebaseServiceAccountKeyPath: "/path/a.json",
      },
      understanding: {
        glassGoals: {
          username: "user@example.com",
          firebaseServiceAccountKeyPath: "/path/b.json",
        },
      },
    });
    expect(() => loadConfig(home)).toThrow(
      /conflicting glassGoals configurations present in both top-level glassGoals and understanding\.glassGoals/
    );
  });

  it("rejects non-mapping understanding section", () => {
    const home = writeConfig({ understanding: "not-a-mapping" });
    expect(() => loadConfig(home)).toThrow(/understanding must be a mapping when set/);
  });

  it("rejects blank understanding.rootNodeId", () => {
    const home = writeConfig({ understanding: { rootNodeId: "   " } });
    expect(() => loadConfig(home)).toThrow(
      /understanding\.rootNodeId must be a non-empty string when set/
    );
  });

  it("loads understanding.mount configuration", () => {
    const home = writeConfig({
      understanding: {
        mount: {
          enabled: true,
        },
      },
    });
    const config = loadConfig(home);
    expect(config.understanding?.mount).toEqual({
      enabled: true,
    });
  });

  it("rejects non-mapping understanding.mount", () => {
    const home = writeConfig({ understanding: { mount: "true" } });
    expect(() => loadConfig(home)).toThrow(/understanding\.mount must be a mapping when set/);
  });

  it("rejects non-boolean understanding.mount.enabled", () => {
    const home = writeConfig({ understanding: { mount: { enabled: "yes" } } });
    expect(() => loadConfig(home)).toThrow(
      /understanding\.mount\.enabled must be a boolean when set/
    );
  });

  it("rejects understanding.mount.enabled under container-boundary sandbox", () => {
    const home = writeConfig({
      sandbox: "container-boundary",
      understanding: { mount: { enabled: true } },
    });
    expect(() => loadConfig(home)).toThrow(
      /understanding\.mount\.enabled requires sandbox: "bwrap"/
    );
  });

  it("rejects blank glassGoals username", () => {
    const homeNested = writeConfig({ understanding: { glassGoals: { username: "   " } } });
    expect(() => loadConfig(homeNested)).toThrow(
      /understanding\.glassGoals\.username must be a non-empty string when set/
    );

    const homeLegacy = writeConfig({ glassGoals: { username: "   " } });
    expect(() => loadConfig(homeLegacy)).toThrow(
      /glassGoals\.username must be a non-empty string when set/
    );
  });

  it("rejects blank glassGoals firebaseServiceAccountKeyPath", () => {
    const home = writeConfig({
      understanding: {
        glassGoals: {
          username: "user@example.com",
          firebaseServiceAccountKeyPath: "   ",
        },
      },
    });
    expect(() => loadConfig(home)).toThrow(
      /understanding\.glassGoals\.firebaseServiceAccountKeyPath must be a non-empty string when set/
    );
  });

  it("rejects blank glassGoals rootNodeId", () => {
    const home = writeConfig({
      understanding: {
        glassGoals: {
          username: "user@example.com",
          rootNodeId: "   ",
        },
      },
    });
    expect(() => loadConfig(home)).toThrow(
      /understanding\.glassGoals\.rootNodeId must be a non-empty string when set/
    );
  });
});

describe("loadConfig chat.excludedSpaces ", () => {
  it("accepts valid excludedSpaces array and trims entries", () => {
    const home = writeConfig({
      chat: {
        projectId: "test",
        subscription: "test",
        pubsubKeyPath: "/dev/null",
        excludedSpaces: [" spaces/AAAA ", "spaces/BBBB"],
      },
    });
    const config = loadConfig(home);
    expect(config.chat?.excludedSpaces).toEqual(["spaces/AAAA", "spaces/BBBB"]);
  });

  it("accepts empty excludedSpaces array", () => {
    const home = writeConfig({
      chat: {
        projectId: "test",
        subscription: "test",
        pubsubKeyPath: "/dev/null",
        excludedSpaces: [],
      },
    });
    const config = loadConfig(home);
    expect(config.chat?.excludedSpaces).toEqual([]);
  });

  it.each([
    ["non-array", "spaces/AAAA"],
    ["missing spaces/ prefix", ["AAAA"]],
    ["empty space id", ["spaces/"]],
    ["too many segments", ["spaces/AAAA/messages/123"]],
    ["non-string element", [123]],
  ])("rejects invalid excludedSpaces (%s)", (_label, excludedSpaces) => {
    const home = writeConfig({
      chat: {
        projectId: "test",
        subscription: "test",
        pubsubKeyPath: "/dev/null",
        excludedSpaces,
      },
    });
    expect(() => loadConfig(home)).toThrow(
      /chat\.excludedSpaces must be an array of spaces\/\.\.\. strings/
    );
  });
});
