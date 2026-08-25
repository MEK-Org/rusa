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

describe("loadConfig github.repo (ISSUE_NUM single-repo identity)", () => {
  const withRepo = (repo: string) =>
    writeConfig({ github: { account: "CodeChopsBot", pollIntervalSeconds: 300, repo } });

  it("defaults to undefined when omitted (identity falls back to git-remote derivation)", () => {
    const config = loadConfig(
      writeConfig({ github: { account: "CodeChopsBot", pollIntervalSeconds: 300 } })
    );
    expect(config.github.repo).toBeUndefined();
  });

  it("trims and keeps a well-formed owner/name", () => {
    expect(loadConfig(withRepo("  dummy-org/dummy-repo  ")).github.repo).toBe(
      "dummy-org/dummy-repo"
    );
  });

  it.each([
    ["no slash", "rusa"],
    ["too many segments", "dummy-org/dummy-repo/extra"],
    ["whitespace in the owner", "MEK Org/rusa"],
    ["whitespace in the name", "dummy-org/meta coder"],
  ])("rejects %s", (_label, repo) => {
    // The whitespace cases are the reason this validator must stay in lockstep
    // with the quickstart prompt's: a hand-edited config never passes through
    // that prompt, so the loader is the only gate on this path. A slug like
    // "MEK Org/rusa" is not null and not a wrong-but-valid repo — it
    // reaches the poller and tracker hygiene and fails as malformed API paths,
    // far from the config that caused it.
    expect(() => loadConfig(withRepo(repo))).toThrow(/github\.repo must be in owner\/name format/);
  });

  it("rejects a blank repo before the format check", () => {
    expect(() => loadConfig(withRepo("   "))).toThrow(
      /github\.repo must be a non-empty string when set/
    );
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
  it("canonicalizes the legacy mesh location without a deployment gap", () => {
    const config = loadConfig(
      writeConfig({
        mesh: {
          quotaThrottle: {
            enabled: true,
            intervalSeconds: 75,
            maxIntervalSeconds: 3600,
            tickSeconds: 300,
          },
        },
      })
    );

    expect(config.mesh?.quotaThrottle).toEqual({
      enabled: true,
      intervalSeconds: 75,
      maxIntervalSeconds: 3600,
      tickSeconds: 300,
    });
    expect(config.quota?.throttle).toEqual(config.mesh?.quotaThrottle);
  });

  it("accepts the canonical quota location", () => {
    const config = loadConfig(
      writeConfig({
        quota: {
          databasePath: "/srv/rusa/quota.db",
          poolId: "shared-auth",
          throttle: {
            enabled: true,
            intervalSeconds: 75,
            maxIntervalSeconds: 3600,
            tickSeconds: 300,
          },
        },
      })
    );

    expect(config.quota?.throttle).toEqual({
      enabled: true,
      intervalSeconds: 75,
      maxIntervalSeconds: 3600,
      tickSeconds: 300,
    });
  });

  it("lets canonical fields override and supplement the legacy fallback", () => {
    const config = loadConfig(
      writeConfig({
        mesh: {
          quotaThrottle: {
            enabled: true,
            intervalSeconds: 75,
            maxIntervalSeconds: 3600,
            tickSeconds: 300,
          },
        },
        quota: {
          throttle: { intervalSeconds: 120, tickSeconds: 600 },
        },
      })
    );

    expect(config.quota?.throttle).toEqual({
      enabled: true,
      intervalSeconds: 120,
      maxIntervalSeconds: 3600,
      tickSeconds: 600,
    });
  });

  it("validates the effective merged throttle configuration", () => {
    expect(() =>
      loadConfig(
        writeConfig({
          mesh: { quotaThrottle: { maxIntervalSeconds: 3600 } },
          quota: { throttle: { intervalSeconds: 4000 } },
        })
      )
    ).toThrow(/quota\.throttle\.maxIntervalSeconds/);
  });

  it.each([
    [{ enabled: "yes" }, /enabled must be a boolean/],
    [{ intervalSeconds: -1 }, /intervalSeconds must be non-negative/],
    [{ intervalSeconds: 75, maxIntervalSeconds: 60 }, /maxIntervalSeconds/],
    [{ tickSeconds: 1.5 }, /tickSeconds must be a positive integer/],
  ])("rejects invalid quota throttle values %#", (quotaThrottle, message) => {
    expect(() => loadConfig(writeConfig({ mesh: { quotaThrottle } }))).toThrow(message);
    expect(() => loadConfig(writeConfig({ quota: { throttle: quotaThrottle } }))).toThrow(message);
  });
});

describe("loadConfig shared quota store", () => {
  it("accepts and trims a shared database path and pool id", () => {
    const config = loadConfig(
      writeConfig({ quota: { databasePath: "  /srv/rusa/quota.db  ", poolId: " shared-auth " } })
    );
    expect(config.quota).toEqual({ databasePath: "/srv/rusa/quota.db", poolId: "shared-auth" });
  });

  it.each([
    [{ databasePath: "" }, /quota.databasePath/],
    [{ poolId: "   " }, /quota.poolId/],
  ])("rejects invalid shared quota config %#", (quota, message) => {
    expect(() => loadConfig(writeConfig({ quota }))).toThrow(message);
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

describe("loadConfig tracker hygiene", () => {
  it("defaults closeAction to log when tracker hygiene is configured", () => {
    const config = loadConfig(
      writeConfig({ observability: { trackerHygiene: { enabled: true } } })
    );

    expect(config.observability?.trackerHygiene?.closeAction).toBe("log");
  });

  it("honors explicit closeAction close", () => {
    const config = loadConfig(
      writeConfig({ observability: { trackerHygiene: { closeAction: "close" } } })
    );

    expect(config.observability?.trackerHygiene?.closeAction).toBe("close");
  });

  it("rejects unknown closeAction values", () => {
    expect(() =>
      loadConfig(writeConfig({ observability: { trackerHygiene: { closeAction: "delete" } } }))
    ).toThrow(/trackerHygiene\.closeAction/);
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
