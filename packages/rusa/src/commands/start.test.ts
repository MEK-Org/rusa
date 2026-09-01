import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stringify as toYaml } from "yaml";
import { Actor, type RunAbandon } from "../actor/actor.js";
import type { ActorMesh } from "../actor/actor-mesh.js";
import { HaltSwitch } from "../actor/halt-switch.js";
import { abandonedRunHadStarted } from "../actor/mesh-events.js";
import { GeminiPortableContextCompactor } from "../actor/portable-context-compactor.js";
import { FakeChatClient, FakeChatSource } from "../chat/fake.js";
import { type ParsedChatMessage, toChatMessage } from "../chat/normalize.js";
import { closeDb, getRepositories } from "../db/index.js";
import type { GitHubPollingIssueClient, IssueClient } from "../gitops/issue-client.js";
import { resetIssueClient, setIssueClient } from "../gitops/issue-client.js";
import { stampAuthor } from "../mcp/stamp.js";
import { setProviderModelCatalog } from "../providers/model-catalog.js";
import { WebhookSilenceDetector } from "../webhook/silence-detector.js";

const worktreeMock = vi.hoisted(() => ({
  getRemoteUrl: vi.fn(() => "https://github.com/dummy-org/dummy-repo.git" as string | null),
}));

const e2eInstanceManagerMock = vi.hoisted(() => ({
  up: vi.fn(async () => ({ state: "up", port: 8083 })),
  down: vi.fn(() => ({ state: "down", port: 8083 })),
  status: vi.fn(() => ({ state: "down", port: 8083 })),
  stopForActorRetirement: vi.fn(),
  stopForMeshShutdown: vi.fn(),
}));

vi.mock("../actor/e2e-instance-manager.js", async (importActual) => {
  const actual = await importActual<typeof import("../actor/e2e-instance-manager.js")>();
  return {
    ...actual,
    E2EInstanceManager: class {
      up = e2eInstanceManagerMock.up;
      down = e2eInstanceManagerMock.down;
      status = e2eInstanceManagerMock.status;
      stopForActorRetirement = e2eInstanceManagerMock.stopForActorRetirement;
      stopForMeshShutdown = e2eInstanceManagerMock.stopForMeshShutdown;
    },
  };
});

vi.mock("../gitops/worktree.js", async (importActual) => {
  const actual = await importActual<typeof import("../gitops/worktree.js")>();
  return {
    ...actual,
    getRemoteUrl: worktreeMock.getRemoteUrl,
  };
});
const serviceInstanceMock = vi.hoisted(() => ({
  resolveRepoRoot: vi.fn(),
  actualResolveRepoRoot: null as unknown as (repoPath?: string) => string,
}));

vi.mock("./service-instance.js", async (importActual) => {
  const actual = await importActual<typeof import("./service-instance.js")>();
  serviceInstanceMock.actualResolveRepoRoot = actual.resolveRepoRoot;
  serviceInstanceMock.resolveRepoRoot.mockImplementation(actual.resolveRepoRoot);
  return {
    ...actual,
    resolveRepoRoot: serviceInstanceMock.resolveRepoRoot,
  };
});

const pollerMock = vi.hoisted(() => ({
  startGitHubEventPoller: vi.fn(() => ({
    close: vi.fn(),
  })),
}));

vi.mock("../github/poller.js", async (importActual) => {
  const actual = await importActual<typeof import("../github/poller.js")>();
  return {
    ...actual,
    startGitHubEventPoller: pollerMock.startGitHubEventPoller,
  };
});

const gitHttpServerMock = vi.hoisted(() => {
  const servers: {
    close: ReturnType<typeof vi.fn>;
    closeAllConnections: ReturnType<typeof vi.fn>;
  }[] = [];
  const startGitHttpServer = vi.fn(() => {
    const server = {
      closeAllConnections: vi.fn(),
      close: vi.fn((callback?: () => void) => {
        callback?.();
        return server;
      }),
    };
    servers.push(server);
    return server;
  });
  return { servers, startGitHttpServer };
});

const sandboxMock = vi.hoisted(() => ({
  assertBwrapAvailable: vi.fn(),
}));

vi.mock("../gitops/git-http-server.js", () => ({
  startGitHttpServer: gitHttpServerMock.startGitHttpServer,
}));

vi.mock("../providers/sandbox.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../providers/sandbox.js")>()),
  assertBwrapAvailable: sandboxMock.assertBwrapAvailable,
}));

// `runStart` fires the boot/daily model-catalog probe as
// `void refreshConfiguredProviderModelCatalogs(...)`, which drives the real `codex` and `agy`
// binaries — codex through a real tmux PTY against the host's shared `~/.codex`. Nothing awaits
// it, so an unmocked unit run starts external CLI trees that outlive the test (#88).
const modelScrapeMock = vi.hoisted(() => ({
  refreshConfiguredProviderModelCatalogs: vi.fn(async (_deps: { signal?: AbortSignal }) => {}),
}));

vi.mock("../providers/model-scrape.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../providers/model-scrape.js")>()),
  refreshConfiguredProviderModelCatalogs: modelScrapeMock.refreshConfiguredProviderModelCatalogs,
}));

import {
  getShutdownExitCode,
  isLegacyWorktreeKey,
  mechanicallySubscribeCreatedResource,
  reactToQueuedInboxEntries,
  runStart,
  shouldBindDashboardServer,
  shouldBindWebhookServer,
} from "./start.js";

class MockIssueClient implements Partial<IssueClient & GitHubPollingIssueClient> {
  reactionsAdded: { repo: string; subject: number; reaction: string }[] = [];
  commentReactionsAdded: { repo: string; commentId: number; reaction: string; scope?: string }[] =
    [];

  async addReaction(repo: string, subject: number, reaction: string): Promise<void> {
    this.reactionsAdded.push({ repo, subject, reaction });
  }

  async addCommentReaction(
    repo: string,
    commentId: number,
    reaction: string,
    scope?: string
  ): Promise<void> {
    this.commentReactionsAdded.push({ repo, commentId, reaction, scope });
  }

  async listUpdatedIssuesAndPullRequests(): Promise<[]> {
    return [];
  }

  async listUpdatedIssueComments(): Promise<[]> {
    return [];
  }
}

describe("start command tests", () => {
  it("logs a failed queued-inbox reaction once without retrying", async () => {
    const failure = new Error("reaction unavailable");
    const addCommentReaction = vi.fn().mockRejectedValue(failure);
    const warn = vi.fn();

    reactToQueuedInboxEntries(
      {
        addReaction: vi.fn(),
        addCommentReaction,
      },
      [
        {
          id: "entry",
          actorId: "actor",
          source: "github_issue:dummy-org/dummy-repo#123",
          deliveredAt: new Date("2026-07-26T00:00:00Z"),
          seenAt: new Date("2026-07-26T00:00:01Z"),
          handledAt: null,
          handledNote: null,
          payload: {
            type: "issue_comment.created",
            commentId: 1288,
          },
        },
      ],
      warn
    );
    await vi.waitFor(() => expect(warn).toHaveBeenCalledOnce());

    expect(addCommentReaction).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      "[webhook] queued inbox reaction failed: reaction unavailable"
    );
  });

  it("uses non-zero exit code for deploy-triggered graceful shutdown", () => {
    expect(getShutdownExitCode("deploy")).toBe(1);
  });

  it("keeps clean zero exit code for non-deploy shutdown", () => {
    expect(getShutdownExitCode(null)).toBe(0);
  });

  it("identifies legacy slot-named worktrees for eager cleanup", () => {
    expect(isLegacyWorktreeKey("wt-001")).toBe(true);
    expect(isLegacyWorktreeKey("wt-003")).toBe(true);
    expect(isLegacyWorktreeKey("deploy")).toBe(false);
    expect(isLegacyWorktreeKey("issue-42")).toBe(false);
  });

  it("mechanically subscribes only created resources anchored in root config", () => {
    const subscribeEventSource = vi.fn();
    const log = vi.fn();
    const mesh = { subscribeEventSource };
    const configuredRoots = ["github:configured-org"];

    for (const actorId of ["root", "worker"]) {
      mechanicallySubscribeCreatedResource(
        mesh,
        configuredRoots,
        "github:configured-org/repo/issues/72",
        actorId,
        log
      );
      mechanicallySubscribeCreatedResource(
        mesh,
        configuredRoots,
        "github:other-org/repo/issues/72",
        actorId,
        log
      );
    }

    expect(subscribeEventSource.mock.calls).toEqual([
      ["github:configured-org/repo/issues/72", "root", "root"],
      ["github:configured-org/repo/issues/72", "worker", "worker"],
    ]);
    expect(log).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining(
        "github:other-org/repo/issues/72 to root skipped: not anchored in config"
      )
    );
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining(
        "github:other-org/repo/issues/72 to worker skipped: not anchored in config"
      )
    );
  });

  it("binds the webhook server only in webhook ingestion mode outside e2e", () => {
    expect(shouldBindWebhookServer({ e2eMode: false, ingestionMode: undefined })).toBe(true);
    expect(shouldBindWebhookServer({ e2eMode: false, ingestionMode: "webhook" })).toBe(true);
    expect(shouldBindWebhookServer({ e2eMode: false, ingestionMode: "poll" })).toBe(false);
    expect(shouldBindWebhookServer({ e2eMode: true, ingestionMode: "webhook" })).toBe(false);
  });

  it("binds the dashboard in e2e only when explicitly enabled", () => {
    expect(
      shouldBindDashboardServer({
        e2eMode: false,
        e2eDashboard: false,
        noDashboardServer: false,
      })
    ).toBe(true);
    expect(
      shouldBindDashboardServer({
        e2eMode: true,
        e2eDashboard: false,
        noDashboardServer: false,
      })
    ).toBe(false);
    expect(
      shouldBindDashboardServer({
        e2eMode: true,
        e2eDashboard: true,
        noDashboardServer: false,
      })
    ).toBe(true);
    expect(
      shouldBindDashboardServer({
        e2eMode: true,
        e2eDashboard: true,
        noDashboardServer: true,
      })
    ).toBe(false);
  });
});

describe("runStart webhook event routing (Phase 4)", () => {
  const legacyRootThread = {
    id: "root",
    charter: "root",
    parentId: null,
    status: "active" as const,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
  let homeDir = "";
  let originalEnv: string | undefined;
  let originalExit: typeof process.exit;
  let shutdownFn: (() => Promise<void>) | undefined;
  let requestRunCalls: { actorId: string; reason: string }[] = [];

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), "rusa-start-test-"));
    originalEnv = process.env.RUSA_HOME;
    process.env.RUSA_HOME = homeDir;

    originalExit = process.exit;
    // @ts-expect-error
    process.exit = vi.fn();
    shutdownFn = undefined;
    requestRunCalls = [];
    gitHttpServerMock.startGitHttpServer.mockClear();
    gitHttpServerMock.servers.length = 0;
    sandboxMock.assertBwrapAvailable.mockReset();
    modelScrapeMock.refreshConfiguredProviderModelCatalogs.mockClear();
    pollerMock.startGitHubEventPoller.mockClear();
    for (const method of Object.values(e2eInstanceManagerMock)) method.mockClear();
    serviceInstanceMock.resolveRepoRoot.mockImplementation(
      serviceInstanceMock.actualResolveRepoRoot
    );

    // Mock Actor.prototype.requestRun to record calls and do nothing else
    vi.spyOn(Actor.prototype, "requestRun").mockImplementation(function (
      this: Actor,
      reason: unknown
    ) {
      const reasonStr =
        typeof reason === "string"
          ? reason
          : typeof reason === "object" &&
              reason !== null &&
              "kind" in reason &&
              (reason as { kind: unknown }).kind === "inbox"
            ? "inbox_changed"
            : typeof reason === "object" && reason !== null && "body" in reason
              ? String((reason as { body: unknown }).body)
              : JSON.stringify(reason);
      requestRunCalls.push({ actorId: this.id, reason: reasonStr });
    });

    // Create a minimal config.yaml
    const config = {
      github: {
        account: "mock-bot",
      },
      providers: {
        antigravity: { cliCommand: "agy" },
      },
      rootActor: {
        provider: "antigravity",
      },
      geminiApiKey: "fake-gemini-key",
    };
    writeFileSync(join(homeDir, "config.yaml"), toYaml(config), "utf8");
    // Most startup tests exercise the upgrade/restart path used by current prod.
    // Fresh-install UUID selection is covered directly by resolveRootThreadId.
    writeFileSync(
      join(homeDir, "threads.json"),
      JSON.stringify({
        threads: [
          {
            id: "root",
            charter: "root",
            parentId: null,
            status: "active",
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      }),
      "utf8"
    );
  });

  afterEach(async () => {
    if (shutdownFn) {
      try {
        await shutdownFn();
      } catch {
        /* best effort */
      }
    }
    resetIssueClient();
    closeDb();
    process.exit = originalExit;
    if (homeDir) {
      try {
        rmSync(homeDir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
    if (originalEnv !== undefined) {
      process.env.RUSA_HOME = originalEnv;
    } else {
      delete process.env.RUSA_HOME;
    }
  });

  describe("worker fallback is root-only ", () => {
    it("never wires an actor-level fallback for a worker, even when root has one configured", async () => {
      const config = {
        github: { account: "mock-bot" },
        providers: {
          antigravity: { cliCommand: "agy" },
          claude: { cliCommand: "claude" },
          kimi: { cliCommand: "kimi" },
        },
        rootActor: {
          // Root retains its own fallback (ISSUE_NUM keeps this root-only).
          provider: "claude",
          fallbackModel: "claude-sonnet-5",
        },
        geminiApiKey: "fake-key",
      };
      writeFileSync(join(homeDir, "config.yaml"), toYaml(config), "utf8");

      const registryPath = join(homeDir, "threads.json");
      writeFileSync(
        registryPath,
        JSON.stringify({
          threads: [
            legacyRootThread,
            {
              id: "test-kimi-worker",
              charter: "test",
              provider: "kimi",
              status: "active",
            },
          ],
        }),
        "utf8"
      );

      let mesh: ActorMesh | undefined;
      const readyPromise = new Promise<void>((resolve) => {
        runStart({
          e2e: {
            onReady: (handles) => {
              mesh = handles.mesh;
              shutdownFn = handles.shutdown;
              resolve();
            },
          },
        });
      });
      await readyPromise;

      if (!mesh) throw new Error("mesh not ready");
      const workerActor = mesh.get("test-kimi-worker");
      expect(workerActor).toBeDefined();
      const kimiActorOpts = (
        workerActor as unknown as { opts: { fallback?: { models: string[] } } }
      ).opts;

      // Workers never get an actor-level fallback — quota exhaustion is a
      // signal to the parent now, not something the worker self-heals from.
      expect(kimiActorOpts.fallback).toBeUndefined();
    });

    it("boot wires the obligation store's actor guard, so it is not inert", async () => {
      // Deliberately asserted through a real `runStart`, not by injecting the
      // probe. The defect this pins was precisely that the production container
      // is built from a Database alone and nobody supplied one, so the guard
      // read as if it applied while never running. A test that constructed the
      // repository itself would have passed throughout.
      writeFileSync(
        join(homeDir, "threads.json"),
        JSON.stringify({
          threads: [
            { id: "root", charter: "root", parentId: null, isRoot: true, status: "active" },
            {
              id: "live-worker",
              charter: "worker",
              parentId: "root",
              provider: "kimi",
              status: "active",
            },
            {
              id: "retired-worker",
              charter: "worker",
              parentId: "root",
              provider: "kimi",
              status: "retired",
            },
          ],
        }),
        "utf8"
      );

      await new Promise<void>((resolve) => {
        runStart({
          e2e: {
            onReady: (handles) => {
              shutdownFn = handles.shutdown;
              resolve();
            },
          },
        });
      });

      // Read the live id back out of the registry boot actually loaded, rather
      // than assuming the file we wrote survived `resolveRootThreadId`.
      const threads = JSON.parse(readFileSync(join(homeDir, "threads.json"), "utf8")) as {
        threads: Array<{ id: string; status: string }>;
      };
      const liveId = threads.threads.find((t) => t.status === "active")?.id;
      expect(liveId).toBeDefined();

      const obligations = getRepositories().obligations;
      expect(() =>
        obligations.create({ title: "fine", ownerId: String(liveId), intent: "fine" })
      ).not.toThrow();
      for (const ownerId of ["never-existed", "retired-worker"]) {
        expect(
          () => obligations.create({ title: "drift", ownerId, intent: "drift" }),
          ownerId
        ).toThrow(/actor owner does not exist/);
      }
      // The operator is not an actor and must still be ownable — the whole
      // human-decision contract depends on it.
      expect(() =>
        obligations.create({ title: "decide", ownerId: "human:operator", intent: "decide" })
      ).not.toThrow();
    });
  });

  it("drives the boot model-catalog probe through the injected fake, not a real CLI", async () => {
    const readyPromise = new Promise<void>((resolve) => {
      runStart({
        e2e: {
          onReady: (handles) => {
            shutdownFn = handles.shutdown;
            resolve();
          },
        },
      });
    });
    await readyPromise;

    // Regression guard for #88. The boot probe is unconditional, so this asserts the mock above is
    // actually engaged: drop it and the count stays 0 while the suite silently goes back to
    // spawning real codex/agy trees that no test awaits.
    expect(modelScrapeMock.refreshConfiguredProviderModelCatalogs).toHaveBeenCalled();
  });

  it("shutdown aborts the in-flight model probe and waits for it to settle", async () => {
    // Regression guard for #89. The probe is fired without being retained, so the interval
    // handle says nothing about one already running: `clearInterval` only stops the *next*
    // probe. Two separate things have to hold at shutdown, and each assertion below pins one.
    let probeSignal: AbortSignal | undefined;
    let probeSettled = false;
    modelScrapeMock.refreshConfiguredProviderModelCatalogs.mockImplementationOnce(
      async (deps: { signal?: AbortSignal }) => {
        probeSignal = deps.signal;
        // Stands in for a probe blocked on a real CLI tree: it settles only when told to.
        await new Promise<void>((resolve) => {
          deps.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        probeSettled = true;
      }
    );

    const readyPromise = new Promise<void>((resolve) => {
      runStart({
        e2e: {
          onReady: (handles) => {
            shutdownFn = handles.shutdown;
            resolve();
          },
        },
      });
    });
    await readyPromise;

    // The probe is still running at this point — nothing has resolved it.
    expect(probeSignal).toBeDefined();
    expect(probeSignal?.aborted).toBe(false);
    expect(probeSettled).toBe(false);

    const shutdown = shutdownFn;
    shutdownFn = undefined;
    await shutdown?.();

    // (1) The probe was reachable. This is the assertion that goes red against the old
    // shape: with no `signal` at the call site the probe cannot be stopped at all, and
    // with the signal but no `modelProbeAbort.abort()` shutdown blocks on it forever.
    expect(probeSignal?.aborted).toBe(true);
    // (2) By the time shutdown returns, the probe has finished rather than been left
    // running. Stated plainly for the next reader: this does *not* pin the
    // `await modelProbeInFlight` in `shutdown` — remove that await and this still passes,
    // because the half-dozen `await`s that follow it (mcp/webhook/dashboard close) each
    // flush the microtask queue and let the prober's `finally` run anyway. The await is
    // there to make the ordering a guarantee instead of a by-product of what happens to
    // be awaited after it; no test can distinguish the two today.
    expect(probeSettled).toBe(true);
  });

  it("warns at boot when the self-update tool mounts without errorChat configured", async () => {
    const warns: string[] = [];
    const warnSpy = vi.spyOn(console, "warn").mockImplementation((...args) => {
      warns.push(args.join(" "));
    });

    const readyPromise = new Promise<void>((resolve) => {
      runStart({
        e2e: {
          onReady: (handles) => {
            shutdownFn = handles.shutdown;
            resolve();
          },
        },
      });
    });
    await readyPromise;
    warnSpy.mockRestore();

    expect(warns).toContain("[update] no errorChat configured — lifecycle pings disabled");
  });

  it("warns at boot when the self-update tool mounts with errorChat configured but no chat client", async () => {
    writeFileSync(
      join(homeDir, "config.yaml"),
      toYaml({
        github: { account: "mock-bot" },
        providers: { antigravity: { cliCommand: "agy" } },
        rootActor: { provider: "antigravity" },
        geminiApiKey: "fake-gemini-key",
        chat: { errorChat: "spaces/operator-dm" },
      }),
      "utf8"
    );

    const warns: string[] = [];
    const warnSpy = vi.spyOn(console, "warn").mockImplementation((...args) => {
      warns.push(args.join(" "));
    });

    const readyPromise = new Promise<void>((resolve) => {
      runStart({
        e2e: {
          onReady: (handles) => {
            shutdownFn = handles.shutdown;
            resolve();
          },
        },
      });
    });
    await readyPromise;
    warnSpy.mockRestore();

    expect(warns).toContain("[update] chat client unavailable — lifecycle pings disabled");
    expect(warns).not.toContain("[update] no errorChat configured — lifecycle pings disabled");
  });

  it("does not warn at boot when self-update tool mounts with both errorChat and chat client present", async () => {
    const chatClient = new FakeChatClient();
    const chatSource = new FakeChatSource();
    writeFileSync(
      join(homeDir, "config.yaml"),
      toYaml({
        github: { account: "mock-bot" },
        providers: { antigravity: { cliCommand: "agy" } },
        rootActor: { provider: "antigravity" },
        geminiApiKey: "fake-gemini-key",
        chat: { errorChat: "spaces/operator-dm" },
      }),
      "utf8"
    );

    const warns: string[] = [];
    const warnSpy = vi.spyOn(console, "warn").mockImplementation((...args) => {
      warns.push(args.join(" "));
    });

    const readyPromise = new Promise<void>((resolve) => {
      runStart({
        e2e: {
          chatClient,
          chatSource,
          onReady: (handles) => {
            shutdownFn = handles.shutdown;
            resolve();
          },
        },
      });
    });
    await readyPromise;
    warnSpy.mockRestore();

    expect(warns.some((w) => w.startsWith("[update]"))).toBe(false);
  });

  it("adds a live capability grant to the cached provider config for the next run", async () => {
    writeFileSync(
      join(homeDir, "threads.json"),
      JSON.stringify({
        threads: [
          legacyRootThread,
          {
            id: "live-worker",
            charter: "test live grants",
            parentId: "root",
            status: "active",
            createdAt: "2026-08-07T00:00:00.000Z",
          },
        ],
      }),
      "utf8"
    );

    let mesh: ActorMesh | undefined;
    await new Promise<void>((resolve) => {
      runStart({
        e2e: {
          onReady: (handles) => {
            mesh = handles.mesh;
            shutdownFn = handles.shutdown;
            resolve();
          },
        },
      });
    });

    if (!mesh) throw new Error("mesh not ready");
    const worker = mesh.get("live-worker");
    if (!worker) throw new Error("worker not rehydrated");
    const actorOptions = (
      worker as unknown as { opts: { mcpServers: Array<{ name: string; url: string }> } }
    ).opts;
    expect(actorOptions.mcpServers.some((server) => server.name === "understanding-write")).toBe(
      false
    );

    mesh.grantCapability("live-worker", "understanding-write", "root");

    expect(actorOptions.mcpServers.some((server) => server.name === "understanding-write")).toBe(
      true
    );
  });

  it("mounts the actor-bound obligations MCP for root and rehydrated workers", async () => {
    writeFileSync(
      join(homeDir, "threads.json"),
      JSON.stringify({
        threads: [
          legacyRootThread,
          {
            id: "obligation-worker",
            charter: "test obligation reads",
            parentId: "root",
            status: "active",
            createdAt: "2026-08-14T00:00:00.000Z",
          },
        ],
      }),
      "utf8"
    );

    let mesh: ActorMesh | undefined;
    let root: Actor | undefined;
    await new Promise<void>((resolve) => {
      runStart({
        e2e: {
          onReady: (handles) => {
            mesh = handles.mesh;
            root = handles.root as Actor;
            shutdownFn = handles.shutdown;
            resolve();
          },
        },
      });
    });

    if (!mesh || !root) throw new Error("mesh not ready");
    const worker = mesh.get("obligation-worker");
    if (!worker) throw new Error("worker not rehydrated");
    type WithMcpServers = { opts: { mcpServers: Array<{ name: string }> } };
    const names = (actor: unknown) =>
      (actor as unknown as WithMcpServers).opts.mcpServers.map((server) => server.name);

    expect(names(root)).toContain("obligations");
    expect(names(worker)).toContain("obligations");
  });

  it("wires the abandoned-run terminal hook on both production actor factories ", async () => {
    // The hook only closes the mesh's in-flight accounting if the PRODUCTION
    // factories pass it. Both are edited by hand and neither is covered by the
    // Actor-level contract tests, so this asserts on what runStart actually
    // built — reaching the real closure rather than an injected one.
    writeFileSync(
      join(homeDir, "threads.json"),
      JSON.stringify({
        threads: [
          legacyRootThread,
          {
            id: "abandon-worker",
            charter: "test terminal wiring",
            parentId: "root",
            status: "active",
            createdAt: "2026-08-08T00:00:00.000Z",
          },
        ],
      }),
      "utf8"
    );

    let mesh: ActorMesh | undefined;
    let root: Actor | undefined;
    await new Promise<void>((resolve) => {
      runStart({
        e2e: {
          onReady: (handles) => {
            mesh = handles.mesh;
            root = handles.root as Actor;
            shutdownFn = handles.shutdown;
            resolve();
          },
        },
      });
    });

    if (!mesh || !root) throw new Error("mesh not ready");
    const worker = mesh.get("abandon-worker");
    if (!worker) throw new Error("worker not rehydrated");

    type WithAbandonHook = { opts: { onRunAbandoned?: (abandon: RunAbandon) => void } };
    const workerHook = (worker as unknown as WithAbandonHook).opts.onRunAbandoned;
    const rootHook = (root as unknown as WithAbandonHook).opts.onRunAbandoned;
    expect(workerHook).toBeTypeOf("function");
    expect(rootHook).toBeTypeOf("function");

    workerHook?.({ reason: "start-cancelled", started: false });
    rootHook?.({ reason: "coalesced", started: true });

    const abandoned = getRepositories()
      .meshEvents.listEventsByActors(["abandon-worker", "root"], {
        limit: 50,
        kinds: ["run_abandoned"],
      })
      .events.map((event) => ({
        actorId: event.actorId,
        detail: event.detail,
        // Read back through the same helper the consumers use, so this asserts the
        // fact a reader can actually recover — not merely that some payload string
        // was persisted.
        started: abandonedRunHadStarted(event.payload),
      }));

    expect(abandoned).toContainEqual({
      actorId: "abandon-worker",
      detail: "start-cancelled",
      started: false,
    });
    expect(abandoned).toContainEqual({ actorId: "root", detail: "coalesced", started: true });
  });

  it("mounts a live calendar-read grant for root on the next run", async () => {
    let mesh: ActorMesh | undefined;
    let root: Actor | undefined;
    await new Promise<void>((resolve) => {
      runStart({
        e2e: {
          onReady: (handles) => {
            mesh = handles.mesh;
            root = handles.root as Actor;
            shutdownFn = handles.shutdown;
            resolve();
          },
        },
      });
    });

    if (!mesh || !root) throw new Error("mesh not ready");
    const actorOptions = (
      root as unknown as { opts: { mcpServers: Array<{ name: string; url: string }> } }
    ).opts;
    expect(actorOptions.mcpServers.some((server) => server.name === "calendar-read")).toBe(false);

    mesh.grantCapability("root", "calendar-read:account:person@example.com", "root");

    expect(actorOptions.mcpServers.some((server) => server.name === "calendar-read")).toBe(true);

    mesh.revokeCapability("root", "calendar-read:account:person@example.com", "root");
    await vi.waitFor(() => {
      expect(actorOptions.mcpServers.some((server) => server.name === "calendar-read")).toBe(false);
    });
  });

  it("mounts a durable root calendar-read grant during startup", async () => {
    writeFileSync(
      join(homeDir, "capability-grants.json"),
      JSON.stringify({
        grants: [
          {
            actorId: "root",
            capability: "calendar-read:person@example.com",
            grantedBy: "root",
            grantedAt: "2026-08-07T00:00:00.000Z",
          },
        ],
      }),
      "utf8"
    );

    let root: Actor | undefined;
    await new Promise<void>((resolve) => {
      runStart({
        e2e: {
          onReady: (handles) => {
            root = handles.root as Actor;
            shutdownFn = handles.shutdown;
            resolve();
          },
        },
      });
    });

    if (!root) throw new Error("root not ready");
    const actorOptions = (
      root as unknown as { opts: { mcpServers: Array<{ name: string; url: string }> } }
    ).opts;
    expect(actorOptions.mcpServers.some((server) => server.name === "calendar-read")).toBe(true);
  });

  it("mounts, revokes, and startup-mounts root email-send grants", async () => {
    writeFileSync(
      join(homeDir, "capability-grants.json"),
      JSON.stringify({
        grants: [
          {
            actorId: "root",
            capability: "email-send:startup@example.com",
            grantedBy: "root",
            grantedAt: "2026-08-07T00:00:00.000Z",
          },
        ],
      }),
      "utf8"
    );

    let mesh: ActorMesh | undefined;
    let root: Actor | undefined;
    await new Promise<void>((resolve) => {
      runStart({
        e2e: {
          onReady: (handles) => {
            mesh = handles.mesh;
            root = handles.root as Actor;
            shutdownFn = handles.shutdown;
            resolve();
          },
        },
      });
    });

    if (!mesh || !root) throw new Error("mesh not ready");
    const actorOptions = (
      root as unknown as { opts: { mcpServers: Array<{ name: string; url: string }> } }
    ).opts;
    expect(actorOptions.mcpServers.some((server) => server.name === "email-send")).toBe(true);

    mesh.revokeCapability("root", "email-send:startup@example.com", "root");
    await vi.waitFor(() => {
      expect(actorOptions.mcpServers.some((server) => server.name === "email-send")).toBe(false);
    });

    mesh.grantCapability("root", "email-send:next@example.com", "root");
    expect(actorOptions.mcpServers.some((server) => server.name === "email-send")).toBe(true);
  });

  it("mounts a live drive-read grant for root on the next run", async () => {
    let mesh: ActorMesh | undefined;
    let root: Actor | undefined;
    await new Promise<void>((resolve) => {
      runStart({
        e2e: {
          onReady: (handles) => {
            mesh = handles.mesh;
            root = handles.root as Actor;
            shutdownFn = handles.shutdown;
            resolve();
          },
        },
      });
    });

    if (!mesh || !root) throw new Error("mesh not ready");
    const actorOptions = (
      root as unknown as { opts: { mcpServers: Array<{ name: string; url: string }> } }
    ).opts;
    expect(actorOptions.mcpServers.some((server) => server.name === "drive-read")).toBe(false);

    mesh.grantCapability("root", "drive-read", "root");

    expect(actorOptions.mcpServers.some((server) => server.name === "drive-read")).toBe(true);

    mesh.revokeCapability("root", "drive-read", "root");
    await vi.waitFor(() => {
      expect(actorOptions.mcpServers.some((server) => server.name === "drive-read")).toBe(false);
    });
  });

  it("leaves the git bridge server off by default", async () => {
    const issueClient = new MockIssueClient();
    setIssueClient(issueClient as unknown as IssueClient);

    const readyPromise = new Promise<void>((resolve) => {
      runStart({
        e2e: {
          onReady: (handles) => {
            shutdownFn = handles.shutdown;
            resolve();
          },
        },
      });
    });

    await readyPromise;

    expect(gitHttpServerMock.startGitHttpServer).not.toHaveBeenCalled();
  });

  it("starts and closes the git bridge server when gitBridge is enabled", async () => {
    const issueClient = new MockIssueClient();
    setIssueClient(issueClient as unknown as IssueClient);
    writeFileSync(
      join(homeDir, "config.yaml"),
      toYaml({
        github: { account: "mock-bot" },
        providers: { antigravity: { cliCommand: "agy" } },
        rootActor: { provider: "antigravity" },
        geminiApiKey: "fake-gemini-key",
        gitBridge: true,
        gitBridgePort: 9097,
      }),
      "utf8"
    );

    const readyPromise = new Promise<void>((resolve) => {
      runStart({
        e2e: {
          onReady: (handles) => {
            shutdownFn = handles.shutdown;
            resolve();
          },
        },
      });
    });

    await readyPromise;

    expect(gitHttpServerMock.startGitHttpServer).toHaveBeenCalledWith(homeDir, 9097, {
      bindHost: "127.0.0.1",
    });
    const server = gitHttpServerMock.servers[0];
    expect(server).toBeDefined();

    await shutdownFn?.();
    shutdownFn = undefined;

    expect(server.closeAllConnections).toHaveBeenCalled();
    expect(server.close).toHaveBeenCalled();
  });

  it("checks bwrap availability by default before starting workers", async () => {
    const issueClient = new MockIssueClient();
    setIssueClient(issueClient as unknown as IssueClient);

    const readyPromise = new Promise<void>((resolve) => {
      runStart({
        e2e: {
          onReady: (handles) => {
            shutdownFn = handles.shutdown;
            resolve();
          },
        },
      });
    });

    await readyPromise;

    expect(sandboxMock.assertBwrapAvailable).toHaveBeenCalledOnce();
  });

  it("skips the bwrap availability check under container-boundary sandbox", async () => {
    const issueClient = new MockIssueClient();
    setIssueClient(issueClient as unknown as IssueClient);
    writeFileSync(
      join(homeDir, "config.yaml"),
      toYaml({
        github: { account: "mock-bot" },
        providers: { antigravity: { cliCommand: "agy" } },
        rootActor: { provider: "antigravity" },
        geminiApiKey: "fake-gemini-key",
        sandbox: "container-boundary",
      }),
      "utf8"
    );

    const readyPromise = new Promise<void>((resolve) => {
      runStart({
        e2e: {
          onReady: (handles) => {
            shutdownFn = handles.shutdown;
            resolve();
          },
        },
      });
    });

    await readyPromise;

    expect(sandboxMock.assertBwrapAvailable).not.toHaveBeenCalled();
  });

  it("exits loudly when bwrap is required but unavailable", async () => {
    sandboxMock.assertBwrapAvailable.mockImplementationOnce(() => {
      throw new Error("bubblewrap (bwrap) is required but not installed.");
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    await runStart();

    expect(process.exit).toHaveBeenCalledWith(1);
    expect(consoleError).toHaveBeenCalledWith(
      "❌ bubblewrap (bwrap) is required but not installed."
    );
    consoleError.mockRestore();
  });

  it("routes events to live subscriber when subscribed", async () => {
    let emitGitHubEvent:
      | ((event: string, payload: Record<string, unknown>, deliveryId?: string) => Promise<void>)
      | undefined;
    let mesh: ActorMesh | undefined;

    const issueClient = new MockIssueClient();
    setIssueClient(issueClient as unknown as IssueClient);

    const readyPromise = new Promise<void>((resolve) => {
      runStart({
        e2e: {
          onReady: (handles) => {
            mesh = handles.mesh;
            emitGitHubEvent = handles.emitGitHubEvent;
            shutdownFn = handles.shutdown;
            resolve();
          },
        },
      });
    });

    await readyPromise;

    expect(mesh).toBeDefined();
    expect(emitGitHubEvent).toBeDefined();
    if (!mesh || !emitGitHubEvent) {
      throw new Error("Mesh or emitGitHubEvent not ready");
    }

    // Spawn a worker t1 and subscribe it to repository
    const workerId = mesh.spawn({
      charter: "worker tasks",
      parentId: "root",
      provider: "antigravity",
      model: "Gemini 3.7 Flash (High)",
    });
    // Real topology : root retains the covering org source it delegates
    // slices from — the retired subscriber's event bubbles to root via that
    // source, not via the removed catch-all .
    mesh.subscribeEventSource({ kind: "github_org", org: "dummy-org" }, "root", "root");
    mesh.subscribeEventSource(
      { kind: "github_repo", repo: "dummy-org/dummy-repo" },
      workerId,
      "root"
    );

    // Emit event with repo
    await emitGitHubEvent(
      "issue_comment",
      {
        action: "created",
        repository: { full_name: "dummy-org/dummy-repo" },
        comment: { id: 123 },
        issue: { number: 456 },
        sender: { login: "someone-else" },
      },
      "delivery-903"
    );

    // The subscriber is live, so it should be woken
    expect(requestRunCalls).toHaveLength(1);
    expect(requestRunCalls[0]).toEqual({
      actorId: workerId,
      reason: "{}",
    });
    const inbox = getRepositories().inbox.list(workerId);
    expect(inbox.entries).toHaveLength(1);
    expect(inbox.entries[0]).toMatchObject({
      actorId: workerId,
      source: "github:dummy-org/dummy-repo/issues/456",
      seenAt: null,
      handledAt: null,
      payload: {
        type: "issue_comment.created",
        commentId: 123,
      },
    });

    // Persistence alone is not a receipt. The first accepted inbox run claims
    // the entry and emits the best-effort reaction.
    expect(issueClient.commentReactionsAdded).toEqual([]);
    mesh.actorQueued(workerId, { responsive: false, mode: "ordinary" });
    expect(issueClient.commentReactionsAdded).toEqual([
      { repo: "dummy-org/dummy-repo", commentId: 123, reaction: "eyes", scope: "issue" },
    ]);
    expect(
      getRepositories().inbox.read(workerId, inbox.entries[0]?.id ?? "")?.seenAt
    ).not.toBeNull();

    // GitHub retries carry the same X-GitHub-Delivery id. The durable row makes
    // that retry a no-op: no duplicate entry and no duplicate actor wake.
    await emitGitHubEvent(
      "issue_comment",
      {
        action: "created",
        repository: { full_name: "dummy-org/dummy-repo" },
        comment: { id: 123 },
        issue: { number: 456 },
        sender: { login: "someone-else" },
      },
      "delivery-903"
    );
    const redelivery = getRepositories().inbox.list(workerId);
    expect(redelivery.entries).toHaveLength(1);
    expect(requestRunCalls).toHaveLength(1);
    // A retry cannot re-claim seen work and does not duplicate the reaction.
    mesh.actorQueued(workerId, { responsive: false, mode: "ordinary" });
    expect(issueClient.commentReactionsAdded).toHaveLength(1);
  });

  it("suppresses webhook events from github.orgs excludedRepos before inbox delivery", async () => {
    writeFileSync(
      join(homeDir, "config.yaml"),
      toYaml({
        github: {
          account: "mock-bot",
          orgs: [{ org: "dummy-org", excludedRepos: ["dummy-org/private-repo"] }],
        },
        providers: { antigravity: { cliCommand: "agy" } },
        rootActor: { provider: "antigravity" },
        geminiApiKey: "fake-gemini-key",
      }),
      "utf8"
    );
    let emitGitHubEvent:
      | ((event: string, payload: Record<string, unknown>) => Promise<void>)
      | undefined;
    await new Promise<void>((resolve) => {
      runStart({
        e2e: {
          onReady: (handles) => {
            emitGitHubEvent = handles.emitGitHubEvent;
            shutdownFn = handles.shutdown;
            resolve();
          },
        },
      });
    });
    if (!emitGitHubEvent) throw new Error("emitGitHubEvent not ready");

    await emitGitHubEvent("issues", {
      action: "opened",
      repository: { full_name: "dummy-org/private-repo" },
      issue: { number: 1 },
      sender: { login: "operator" },
    });

    expect(getRepositories().inbox.list("root").entries).toHaveLength(0);
    expect(requestRunCalls).toHaveLength(0);
  });

  it("routes the production low-water check to root as responsive system.disk work without DMing the error chat", async () => {
    const chatClient = new FakeChatClient();
    const chatSource = new FakeChatSource();
    writeFileSync(
      join(homeDir, "config.yaml"),
      toYaml({
        github: { account: "mock-bot" },
        providers: { antigravity: { cliCommand: "agy" } },
        rootActor: { provider: "antigravity" },
        geminiApiKey: "fake-gemini-key",
        chat: { errorChat: "spaces/operator-dm" },
        observability: {
          diskAlert: { enabled: true, thresholdBytes: Number.MAX_SAFE_INTEGER },
        },
      }),
      "utf8"
    );

    let emitSystemDiskCheck: (() => Promise<void>) | undefined;
    await new Promise<void>((resolve) => {
      runStart({
        e2e: {
          chatClient,
          chatSource,
          onReady: (handles) => {
            emitSystemDiskCheck = handles.emitSystemDiskCheck;
            shutdownFn = handles.shutdown;
            resolve();
          },
        },
      });
    });

    if (!emitSystemDiskCheck) throw new Error("disk check not ready");
    await emitSystemDiskCheck();

    expect(getRepositories().inbox.list("root").entries).toEqual([
      expect.objectContaining({
        actorId: "root",
        source: "system:events",
        payload: expect.objectContaining({
          type: "system.disk",
          priority: "responsive",
          volume: "/",
        }),
      }),
    ]);
    expect(requestRunCalls).toContainEqual({
      actorId: "root",
      reason: JSON.stringify({ priority: "responsive" }),
    });
    expect(chatClient.sent).toEqual([]);
  });

  it("seeds root's system subscription from observability.diskAlert alone", async () => {
    writeFileSync(
      join(homeDir, "config.yaml"),
      toYaml({
        github: { account: "mock-bot" },
        providers: { antigravity: { cliCommand: "agy" } },
        rootActor: { provider: "antigravity" },
        observability: { diskAlert: { enabled: false } },
      }),
      "utf8"
    );

    let mesh: ActorMesh | undefined;
    await new Promise<void>((resolve) => {
      runStart({
        e2e: {
          onReady: (handles) => {
            mesh = handles.mesh;
            shutdownFn = handles.shutdown;
            resolve();
          },
        },
      });
    });

    expect(mesh?.listSubscriptions()).toContainEqual(
      expect.objectContaining({
        actorId: "root",
        resource: "system:events",
        subscribedBy: "root",
      })
    );
  });

  it("adds mechanical eyes for ordinary comments on queued run", async () => {
    let emitGitHubEvent:
      | ((event: string, payload: Record<string, unknown>, deliveryId?: string) => Promise<void>)
      | undefined;
    let mesh: ActorMesh | undefined;

    const issueClient = new MockIssueClient();
    setIssueClient(issueClient as unknown as IssueClient);

    const readyPromise = new Promise<void>((resolve) => {
      runStart({
        e2e: {
          onReady: (handles) => {
            mesh = handles.mesh;
            emitGitHubEvent = handles.emitGitHubEvent;
            shutdownFn = handles.shutdown;
            resolve();
          },
        },
      });
    });

    await readyPromise;
    expect(mesh).toBeDefined();
    expect(emitGitHubEvent).toBeDefined();
    if (!mesh || !emitGitHubEvent) throw new Error("Mesh or emitGitHubEvent not ready");

    // A covering source is required for emitGitHubEvent to persist inbox work.
    mesh.subscribeEventSource({ kind: "github_org", org: "dummy-org" }, "root", "root");

    await emitGitHubEvent("issue_comment", {
      action: "created",
      repository: { full_name: "dummy-org/dummy-repo" },
      comment: { id: 124, body: "ordinary update" },
      issue: { number: 457 },
      sender: { login: "someone-else" },
    });

    mesh.actorQueued("root", { responsive: false, mode: "ordinary" });

    expect(issueClient.commentReactionsAdded).toEqual([
      { repo: "dummy-org/dummy-repo", commentId: 124, reaction: "eyes", scope: "issue" },
    ]);
  });

  it("persists GitHub events without adding mechanical eyes while halted", async () => {
    new HaltSwitch(join(homeDir, "HALT")).halt("test halt");
    let emitGitHubEvent:
      | ((event: string, payload: Record<string, unknown>, deliveryId?: string) => Promise<void>)
      | undefined;
    let mesh: ActorMesh | undefined;
    const issueClient = new MockIssueClient();
    setIssueClient(issueClient as unknown as IssueClient);

    const readyPromise = new Promise<void>((resolve) => {
      runStart({
        e2e: {
          onReady: (handles) => {
            mesh = handles.mesh;
            emitGitHubEvent = handles.emitGitHubEvent;
            shutdownFn = handles.shutdown;
            resolve();
          },
        },
      });
    });
    await readyPromise;
    if (!mesh || !emitGitHubEvent) throw new Error("mesh not ready");
    mesh.subscribeEventSource({ kind: "github_org", org: "dummy-org" }, "root", "root");

    await emitGitHubEvent(
      "issue_comment",
      {
        action: "created",
        repository: { full_name: "dummy-org/dummy-repo" },
        comment: { id: 1291, body: "queued work" },
        issue: { number: 1291 },
        sender: { login: "someone-else" },
      },
      "halted-delivery"
    );

    const haltedInbox = getRepositories().inbox.list("root").entries;
    expect(haltedInbox).toHaveLength(1);
    expect(haltedInbox[0]?.seenAt).toBeNull();
    expect(issueClient.commentReactionsAdded).toEqual([]);
  });

  it("adds Google Chat eyes only when an actor run is queued for the delivery", async () => {
    const chatClient = new FakeChatClient();
    const chatSource = new FakeChatSource();
    writeFileSync(
      join(homeDir, "config.yaml"),
      toYaml({
        github: { account: "mock-bot" },
        providers: {
          antigravity: { cliCommand: "agy" },
          claude: { cliCommand: "claude" },
          codex: { cliCommand: "codex" },
        },
        rootActor: { provider: "antigravity" },
        chat: {
          projectId: "test",
          subscription: "test",
          pubsubKeyPath: "/dev/null",
          gchat: "all",
        },
        geminiApiKey: "fake-gemini-key",
      }),
      "utf8"
    );

    let mesh: ActorMesh | undefined;
    await new Promise<void>((resolve) => {
      runStart({
        e2e: {
          chatClient,
          chatSource,
          onReady: (handles) => {
            mesh = handles.mesh;
            shutdownFn = handles.shutdown;
            resolve();
          },
        },
      });
    });
    if (!mesh) throw new Error("mesh not ready");

    const messageName = "spaces/test/messages/ordinary-1";
    await chatSource.emit({
      name: messageName,
      spaceName: "spaces/test",
      spaceType: "DIRECT_MESSAGE",
      senderName: "users/operator",
      senderDisplayName: "Operator",
      text: "ordinary update",
      mentionsSelf: false,
      isDirectMessage: true,
    });

    const [entry] = getRepositories().inbox.list("root").entries;
    expect(entry?.seenAt).toBeNull();
    expect(entry?.payload).toMatchObject({
      type: "gchat.message",
      priority: "responsive",
      messageName,
      spaceName: "spaces/test",
    });
    expect(entry?.payload).not.toHaveProperty("text");
    expect(entry?.payload).not.toHaveProperty("body");
    expect(chatClient.reactions).toEqual([]);

    mesh.actorQueued("root", { responsive: true, mode: "ordinary" });
    await vi.waitFor(() => {
      expect(chatClient.reactions).toEqual([{ messageName, emoji: "👀" }]);
    });
    expect(getRepositories().inbox.list("root").entries[0]?.seenAt).not.toBeNull();
  });

  it("handles scoped/timed halt commands mechanically and requires resume before replacement", async () => {
    const chatClient = new FakeChatClient();
    const chatSource = new FakeChatSource();
    const config = {
      github: { account: "mock-bot" },
      providers: {
        antigravity: { cliCommand: "agy" },
        claude: { cliCommand: "claude" },
        codex: { cliCommand: "codex" },
      },
      rootActor: { provider: "antigravity" },
      chat: {
        projectId: "test",
        subscription: "test",
        pubsubKeyPath: "/dev/null",
        gchat: "all",
      },
      geminiApiKey: "fake-gemini-key",
    };
    writeFileSync(join(homeDir, "config.yaml"), toYaml(config), "utf8");
    const readyPromise = new Promise<void>((resolve) => {
      runStart({
        e2e: {
          chatClient,
          chatSource,
          onReady: (handles) => {
            shutdownFn = handles.shutdown;
            resolve();
          },
        },
      });
    });
    await readyPromise;
    const message = (text: string, name: string) =>
      chatSource.emit({
        name,
        spaceName: "spaces/test",
        spaceType: "DIRECT_MESSAGE",
        senderName: "users/operator",
        senderDisplayName: "Operator",
        text,
        mentionsSelf: false,
        isDirectMessage: true,
      });
    const until = new Date(Date.now() + 60_000).toISOString();

    await message(`/halt provider:claude,codex until:${until}`, "messages/halt-1");
    const halt = new HaltSwitch(join(homeDir, "HALT"));
    expect(halt.isHalted("claude")).toBe(true);
    expect(halt.isHalted("codex")).toBe(true);
    expect(halt.isHalted("antigravity")).toBe(false);

    await message("/halt provider:antigravity", "messages/halt-2");
    expect(chatClient.sent.at(-1)?.text).toContain("Cannot halt while a current halt");
    expect(halt.isHalted("antigravity")).toBe(false);

    await message("/resume", "messages/resume");
    expect(halt.isHalted()).toBe(false);
  });

  async function waitUntil(predicate: () => boolean, message: string): Promise<void> {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(message);
  }

  it("constructs the root actor with a non-empty addDirs equal to the resolved repo root", async () => {
    let mesh: ActorMesh | undefined;
    const config = {
      github: { account: "mock-bot" },
      providers: { antigravity: { cliCommand: "agy" } },
      rootActor: { provider: "antigravity" },
      geminiApiKey: "fake-gemini-key",
    };
    writeFileSync(join(homeDir, "config.yaml"), toYaml(config), "utf8");

    const readyPromise = new Promise<void>((resolve) => {
      runStart({
        e2e: {
          onReady: (handles) => {
            mesh = handles.mesh;
            shutdownFn = handles.shutdown;
            resolve();
          },
        },
      });
    });

    await readyPromise;
    expect(mesh).toBeDefined();
    const rootActor = mesh?.get("root");
    expect(rootActor).toBeDefined();

    const { resolveRepoRoot } = await import("./service-instance.js");
    const expectedRoot = resolveRepoRoot();
    expect((rootActor as unknown as { opts: { addDirs?: string[] } }).opts.addDirs).toEqual([
      expectedRoot,
    ]);
  });

  it("runs a configured portable root stateless and injects its own recent context", async () => {
    let mesh: ActorMesh | undefined;
    writeFileSync(
      join(homeDir, "config.yaml"),
      toYaml({
        github: { account: "mock-bot" },
        providers: { antigravity: { cliCommand: "agy" } },
        rootActor: {
          provider: "antigravity",
          context: { type: "portable", mode: "tail" },
        },
        geminiApiKey: "fake-gemini-key",
      }),
      "utf8"
    );
    const rootAgentDir = join(homeDir, "root-agent");
    mkdirSync(rootAgentDir, { recursive: true });
    writeFileSync(
      join(rootAgentDir, "session.json"),
      JSON.stringify({ sessionId: "stale-native" }),
      {
        encoding: "utf8",
        flag: "w",
      }
    );

    const logSpy = vi.spyOn(console, "log");
    await new Promise<void>((resolve) => {
      runStart({
        e2e: {
          onReady: (handles) => {
            mesh = handles.mesh;
            shutdownFn = handles.shutdown;
            resolve();
          },
        },
      });
    });

    if (!mesh) throw new Error("mesh not ready");
    expect(mesh.registry.get("root")?.context).toEqual({ type: "portable", mode: "tail" });
    const rootActor = mesh.get("root");
    if (!rootActor) throw new Error("root actor not ready");
    const actorOpts = (
      rootActor as unknown as {
        opts: {
          loadSessionId: () => string | undefined;
          saveSessionId: (id: string) => void;
          buildPrompt: () => { prompt: string; injectRecord?: { runCount: number } };
        };
      }
    ).opts;

    expect(actorOpts.loadSessionId()).toBeUndefined();
    actorOpts.saveSessionId("must-not-persist");
    expect(mesh.registry.get("root")?.sessionId).toBeUndefined();
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("session=portable/tail (stateless)")
    );
    expect(JSON.parse(readFileSync(join(rootAgentDir, "session.json"), "utf8"))).toEqual({
      sessionId: "stale-native",
    });

    mesh.recordEvent({
      kind: "run_end",
      actorId: "root",
      success: true,
      body: "PORTABLE_ROOT_CONTEXT_MARKER",
    });
    const built = actorOpts.buildPrompt();
    expect(built.prompt).toContain("PORTABLE_ROOT_CONTEXT_MARKER");
    expect(built.injectRecord?.runCount).toBe(1);
  });

  it("applies the existing ledger API-key requirement to a portable root", async () => {
    let ready = false;
    writeFileSync(
      join(homeDir, "config.yaml"),
      toYaml({
        github: { account: "mock-bot" },
        providers: { antigravity: { cliCommand: "agy" } },
        rootActor: {
          provider: "antigravity",
          context: { type: "portable", mode: "ledger" },
        },
      }),
      "utf8"
    );

    await runStart({
      e2e: {
        onReady: () => {
          ready = true;
        },
      },
    });

    expect(ready).toBe(false);
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it("compacts root ledger state and records the lifecycle event after a run", async () => {
    let mesh: ActorMesh | undefined;
    const compactSpy = vi
      .spyOn(GeminiPortableContextCompactor.prototype, "compact")
      .mockImplementation(async ({ state, messages, now }) => ({
        state: {
          ...state,
          generation: state.generation + 1,
          updatedAt: now,
          lastFoldedMessageEventId: messages.at(-1)?.id ?? null,
        },
        quarantined: [],
        operations: 0,
      }));
    writeFileSync(
      join(homeDir, "config.yaml"),
      toYaml({
        github: { account: "mock-bot" },
        providers: { antigravity: { cliCommand: "agy" } },
        rootActor: {
          provider: "antigravity",
          context: { type: "portable", mode: "ledger" },
        },
        geminiApiKey: "fake-gemini-key",
      }),
      "utf8"
    );

    await new Promise<void>((resolve) => {
      runStart({
        e2e: {
          onReady: (handles) => {
            mesh = handles.mesh;
            shutdownFn = handles.shutdown;
            resolve();
          },
        },
      });
    });

    if (!mesh) throw new Error("mesh not ready");
    mesh.recordEvent({
      kind: "message_received",
      actorId: "root",
      body: "Remember this root instruction.",
      payload: JSON.stringify({ from: "operator" }),
    });
    const rootActor = mesh.get("root");
    if (!rootActor) throw new Error("root actor not ready");
    const onRunEnd = (
      rootActor as unknown as {
        opts: {
          onRunEnd?: (result: {
            success: boolean;
            output: string;
            exitCode: number;
          }) => Promise<void>;
        };
      }
    ).opts.onRunEnd;
    await onRunEnd?.({ success: true, output: "root completed", exitCode: 0 });

    expect(compactSpy).toHaveBeenCalledOnce();
    const state = JSON.parse(
      readFileSync(join(homeDir, "portable-context", "root.json"), "utf8")
    ) as { generation: number; lastFoldedMessageEventId: string | null };
    expect(state.generation).toBe(1);
    expect(state.lastFoldedMessageEventId).toBeTruthy();
    const compacted = getRepositories().meshEvents.listEventsByActors(["root"], {
      kinds: ["portable_context_compacted"],
      limit: 10,
    }).events;
    expect(compacted).toHaveLength(1);
    expect(compacted[0]?.detail).toContain("generation 1");
    compactSpy.mockRestore();
  });

  it("does not infer polling scope from git remote when github config has no scope", async () => {
    let sigintListener: NodeJS.SignalsListener | undefined;
    const processOnSpy = vi.spyOn(process, "on").mockImplementation((event, listener) => {
      if (event === "SIGINT") {
        sigintListener = listener as NodeJS.SignalsListener;
      }
      return process;
    });

    const issueClient = new MockIssueClient();
    setIssueClient(issueClient as unknown as IssueClient);

    writeFileSync(
      join(homeDir, "config.yaml"),
      toYaml({
        github: { account: "mock-bot", ingestionMode: "poll", pollIntervalSeconds: 300 },
        providers: { antigravity: { cliCommand: "agy" } },
        rootActor: { provider: "antigravity" },
        geminiApiKey: "fake-gemini-key",
      }),
      "utf8"
    );

    try {
      void runStart({ noDashboardServer: true });
      await waitUntil(() => sigintListener !== undefined, "start did not install shutdown handler");

      // Verify poller was NOT started
      expect(pollerMock.startGitHubEventPoller).not.toHaveBeenCalled();

      sigintListener?.("SIGINT");
    } finally {
      processOnSpy.mockRestore();
    }
  });

  it("uses github.repos if configured, starting the poller even if resolveRepoRoot throws", async () => {
    let sigintListener: NodeJS.SignalsListener | undefined;
    const processOnSpy = vi.spyOn(process, "on").mockImplementation((event, listener) => {
      if (event === "SIGINT") {
        sigintListener = listener as NodeJS.SignalsListener;
      }
      return process;
    });

    // Mock resolveRepoRoot to throw
    serviceInstanceMock.resolveRepoRoot.mockImplementation(() => {
      throw new Error("Quickstart container simulation: no git repository found");
    });

    const issueClient = new MockIssueClient();
    setIssueClient(issueClient as unknown as IssueClient);

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    writeFileSync(
      join(homeDir, "config.yaml"),
      toYaml({
        github: {
          account: "mock-bot",
          ingestionMode: "poll",
          pollIntervalSeconds: 300,
          repos: ["custom-owner/custom-repo"],
        },
        providers: { antigravity: { cliCommand: "agy" } },
        rootActor: { provider: "antigravity" },
        geminiApiKey: "fake-gemini-key",
      }),
      "utf8"
    );

    try {
      void runStart({ noDashboardServer: true });
      await waitUntil(() => sigintListener !== undefined, "start did not install shutdown handler");

      // Verify that startGitHubEventPoller was started with the custom repo
      expect(pollerMock.startGitHubEventPoller).toHaveBeenCalledWith(
        expect.objectContaining({ repos: ["custom-owner/custom-repo"] })
      );

      // Verify that we logged the repoRoot resolve error, but NOT a repoName error
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("Could not infer the git repository root")
      );
      expect(errorSpy).not.toHaveBeenCalledWith(
        expect.stringContaining("Could not determine the repository name")
      );

      sigintListener?.("SIGINT");
    } finally {
      processOnSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it("ignores git remote identity and polls only explicitly configured github.repos", async () => {
    let sigintListener: NodeJS.SignalsListener | undefined;
    const processOnSpy = vi.spyOn(process, "on").mockImplementation((event, listener) => {
      if (event === "SIGINT") {
        sigintListener = listener as NodeJS.SignalsListener;
      }
      return process;
    });

    worktreeMock.getRemoteUrl.mockReturnValue("https://github.com/primary-org/primary-repo.git");

    const issueClient = new MockIssueClient();
    setIssueClient(issueClient as unknown as IssueClient);

    writeFileSync(
      join(homeDir, "config.yaml"),
      toYaml({
        github: {
          account: "mock-bot",
          ingestionMode: "poll",
          pollIntervalSeconds: 300,
          repos: ["extra-org/extra-repo"],
        },
        providers: { antigravity: { cliCommand: "agy" } },
        rootActor: { provider: "antigravity" },
        geminiApiKey: "fake-gemini-key",
      }),
      "utf8"
    );

    try {
      void runStart({ noDashboardServer: true });
      await waitUntil(() => sigintListener !== undefined, "start did not install shutdown handler");

      expect(pollerMock.startGitHubEventPoller).toHaveBeenCalledWith(
        expect.objectContaining({ repos: ["extra-org/extra-repo"] })
      );

      sigintListener?.("SIGINT");
    } finally {
      processOnSpy.mockRestore();
      worktreeMock.getRemoteUrl.mockReturnValue("https://github.com/dummy-org/dummy-repo.git");
    }
  });

  it("does not start poller when poll mode has neither github.repos nor github.orgs", async () => {
    let sigintListener: NodeJS.SignalsListener | undefined;
    const processOnSpy = vi.spyOn(process, "on").mockImplementation((event, listener) => {
      if (event === "SIGINT") {
        sigintListener = listener as NodeJS.SignalsListener;
      }
      return process;
    });

    // Mock resolveRepoRoot to throw (no git)
    serviceInstanceMock.resolveRepoRoot.mockImplementation(() => {
      throw new Error("Quickstart container simulation: no git repository found");
    });

    const issueClient = new MockIssueClient();
    setIssueClient(issueClient as unknown as IssueClient);

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    writeFileSync(
      join(homeDir, "config.yaml"),
      toYaml({
        github: { account: "mock-bot", ingestionMode: "poll", pollIntervalSeconds: 300 },
        providers: { antigravity: { cliCommand: "agy" } },
        rootActor: { provider: "antigravity" },
        geminiApiKey: "fake-gemini-key",
      }),
      "utf8"
    );

    try {
      void runStart({ noDashboardServer: true });
      await waitUntil(() => sigintListener !== undefined, "start did not install shutdown handler");

      // Verify that startGitHubEventPoller was NOT called
      expect(pollerMock.startGitHubEventPoller).not.toHaveBeenCalled();

      expect(errorSpy).not.toHaveBeenCalledWith(
        expect.stringContaining("Could not determine the primary repository")
      );

      sigintListener?.("SIGINT");
    } finally {
      processOnSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it("syncs configured root event sources on boot", async () => {
    let mesh: ActorMesh | undefined;
    const config = {
      github: {
        account: "mock-bot",
        repos: ["dummy-org/dummy-repo"],
      },
      providers: {
        antigravity: { cliCommand: "agy" },
        claude: { cliCommand: "claude" },
      },
      rootActor: {
        provider: "antigravity",
      },
      chat: {
        projectId: "test",
        subscription: "test",
        pubsubKeyPath: "/dev/null",
      },
      geminiApiKey: "fake-gemini-key",
    };
    writeFileSync(join(homeDir, "config.yaml"), toYaml(config), "utf8");

    const readyPromise = new Promise<void>((resolve) => {
      runStart({
        e2e: {
          onReady: (handles) => {
            mesh = handles.mesh;
            shutdownFn = handles.shutdown;
            resolve();
          },
        },
      });
    });

    await readyPromise;
    if (!mesh) {
      throw new Error("Mesh not ready");
    }

    expect(mesh.listSubscriptions()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          actorId: "root",
          subscribedBy: "root",
          resource: "github:dummy-org/dummy-repo",
        }),
        expect.objectContaining({
          actorId: "root",
          subscribedBy: "root",
          resource: "gchat:spaces",
        }),
      ])
    );
  });

  it("drops the event with no receipt when no subscription covers the repo ", async () => {
    let emitGitHubEvent:
      | ((event: string, payload: Record<string, unknown>) => Promise<void>)
      | undefined;

    const issueClient = new MockIssueClient();
    setIssueClient(issueClient as unknown as IssueClient);

    const readyPromise = new Promise<void>((resolve) => {
      runStart({
        e2e: {
          onReady: (handles) => {
            emitGitHubEvent = handles.emitGitHubEvent;
            shutdownFn = handles.shutdown;
            resolve();
          },
        },
      });
    });

    await readyPromise;
    if (!emitGitHubEvent) {
      throw new Error("emitGitHubEvent not ready");
    }

    // Emit event with unsubscribed repo
    await emitGitHubEvent("issue_comment", {
      action: "created",
      repository: { full_name: "uncovered-org/some-other-repo" },
      comment: { id: 123 },
      issue: { number: 456 },
      sender: { login: "someone-else" },
    });

    // No configured/delegated source covers the repo: out-of-scope for this
    // instance, dropped at the router  — root is NOT woken as a catch-all.
    expect(requestRunCalls).toHaveLength(0);

    // No durable notification was persisted, so there can be no queued-run receipt.
    expect(issueClient.commentReactionsAdded).toEqual([]);
  });

  it("directed-delivers a bot-authored HTML directive to the target without coverage", async () => {
    let emitGitHubEvent:
      | ((event: string, payload: Record<string, unknown>) => Promise<void>)
      | undefined;
    let mesh: ActorMesh | undefined;

    const issueClient = new MockIssueClient();
    setIssueClient(issueClient as unknown as IssueClient);

    const readyPromise = new Promise<void>((resolve) => {
      runStart({
        e2e: {
          onReady: (handles) => {
            mesh = handles.mesh;
            emitGitHubEvent = handles.emitGitHubEvent;
            shutdownFn = handles.shutdown;
            resolve();
          },
        },
      });
    });

    await readyPromise;
    if (!mesh || !emitGitHubEvent) {
      throw new Error("Mesh or emitGitHubEvent not ready");
    }
    const workerId = mesh.spawn({
      charter: "directed worker",
      parentId: "root",
      provider: "antigravity",
      model: "Gemini 3.7 Flash (High)",
    });

    await emitGitHubEvent("issue_comment", {
      action: "created",
      repository: { full_name: "uncovered-org/uncovered" },
      comment: { id: 123, body: `ready\n<!-- mesh:deliver ${workerId} -->` },
      issue: { number: 456 },
      sender: { login: "mock-bot" },
    });

    expect(requestRunCalls).toEqual([{ actorId: workerId, reason: "{}" }]);
    mesh.actorQueued(workerId, { responsive: false, mode: "ordinary" });
    expect(issueClient.commentReactionsAdded).toEqual([
      { repo: "uncovered-org/uncovered", commentId: 123, reaction: "eyes", scope: "issue" },
    ]);
  });

  it("ignores an external-sender directive and routes normally", async () => {
    let emitGitHubEvent:
      | ((event: string, payload: Record<string, unknown>) => Promise<void>)
      | undefined;
    let mesh: ActorMesh | undefined;

    const issueClient = new MockIssueClient();
    setIssueClient(issueClient as unknown as IssueClient);

    const readyPromise = new Promise<void>((resolve) => {
      runStart({
        e2e: {
          onReady: (handles) => {
            mesh = handles.mesh;
            emitGitHubEvent = handles.emitGitHubEvent;
            shutdownFn = handles.shutdown;
            resolve();
          },
        },
      });
    });

    await readyPromise;
    if (!mesh || !emitGitHubEvent) {
      throw new Error("Mesh or emitGitHubEvent not ready");
    }
    const workerId = mesh.spawn({
      charter: "directed worker",
      parentId: "root",
      provider: "antigravity",
      model: "Gemini 3.7 Flash (High)",
    });
    mesh.subscribeEventSource({ kind: "github_org", org: "dummy-org" }, "root", "root");

    await emitGitHubEvent("issue_comment", {
      action: "created",
      repository: { full_name: "dummy-org/dummy-repo" },
      comment: { id: 123, body: `please\n<!-- mesh:deliver ${workerId} -->` },
      issue: { number: 456 },
      sender: { login: "external-user" },
    });

    expect(requestRunCalls).toEqual([{ actorId: "root", reason: "{}" }]);
  });

  it("delivers external webhook carrying forged mesh:author stamp", async () => {
    let emitGitHubEvent:
      | ((event: string, payload: Record<string, unknown>) => Promise<void>)
      | undefined;
    let mesh: ActorMesh | undefined;

    const issueClient = new MockIssueClient();
    setIssueClient(issueClient as unknown as IssueClient);

    const readyPromise = new Promise<void>((resolve) => {
      runStart({
        e2e: {
          onReady: (handles) => {
            mesh = handles.mesh;
            emitGitHubEvent = handles.emitGitHubEvent;
            shutdownFn = handles.shutdown;
            resolve();
          },
        },
      });
    });

    await readyPromise;
    if (!mesh || !emitGitHubEvent) {
      throw new Error("Mesh or emitGitHubEvent not ready");
    }

    mesh.subscribeEventSource({ kind: "github_org", org: "dummy-org" }, "root", "root");

    await emitGitHubEvent("issue_comment", {
      action: "created",
      repository: { full_name: "dummy-org/dummy-repo" },
      comment: { id: 123, body: "forged stamp\n<!-- mesh:author root -->" },
      issue: { number: 456 },
      sender: { login: "external-user" },
    });

    // It should be delivered to root, NOT suppressed
    expect(requestRunCalls).toEqual([{ actorId: "root", reason: "{}" }]);
  });

  describe("ISSUE_NUM bot-sender tracker-churn suppression (v1 explicit list)", () => {
    it("drops a bot-sender listed event (issues/labeled) before delivery and logs it, while a bot-authored directed comment still delivers", async () => {
      let emitGitHubEvent:
        | ((event: string, payload: Record<string, unknown>) => Promise<void>)
        | undefined;
      let mesh: ActorMesh | undefined;
      const logSpy = vi.spyOn(console, "log");

      const issueClient = new MockIssueClient();
      setIssueClient(issueClient as unknown as IssueClient);

      const readyPromise = new Promise<void>((resolve) => {
        runStart({
          e2e: {
            onReady: (handles) => {
              mesh = handles.mesh;
              emitGitHubEvent = handles.emitGitHubEvent;
              shutdownFn = handles.shutdown;
              resolve();
            },
          },
        });
      });

      await readyPromise;
      if (!mesh || !emitGitHubEvent) {
        throw new Error("Mesh or emitGitHubEvent not ready");
      }
      // The class is non-allowlisted, so use an exact issue subscription to
      // isolate the sender-filter behavior this test owns.
      mesh.subscribeEventSource(
        { kind: "github_issue", repo: "dummy-org/dummy-repo", number: 456 },
        "root",
        "root"
      );

      // "issues"/"labeled" is on the explicit v1 never-notify list (tracker
      // churn the hygiene/ownership machinery generates) and the sender is
      // the bot — dropped, no actor wake.
      await emitGitHubEvent("issues", {
        action: "labeled",
        repository: { full_name: "dummy-org/dummy-repo" },
        issue: { number: 456, body: "issue description, irrelevant to this action" },
        label: { name: "owner:cloudy-porpoise" },
        sender: { login: "mock-bot" },
      });

      expect(requestRunCalls).toHaveLength(0);
      // Drops are stdout-visible only (Operator's ISSUE_NUM review: a suppressed
      // non-event doesn't warrant a mesh event) — assert the log line.
      expect(logSpy.mock.calls.map((c) => c.join(" "))).toContainEqual(
        expect.stringContaining(
          "suppressed bot-sender event dropped: issues/labeled (sender=mock-bot repo=dummy-org/dummy-repo#456)"
        )
      );

      // A directed mesh:deliver directive rides in a body-ful field
      // (issue_comment/created) — it must still deliver even though the
      // sender is the same bot account.
      const workerId = mesh.spawn({
        charter: "directed worker",
        parentId: "root",
        provider: "antigravity",
        model: "Gemini 3.7 Flash (High)",
      });
      await emitGitHubEvent("issue_comment", {
        action: "created",
        repository: { full_name: "dummy-org/dummy-repo" },
        comment: { id: 789, body: `ready\n<!-- mesh:deliver ${workerId} -->` },
        issue: { number: 456 },
        sender: { login: "mock-bot" },
      });

      expect(requestRunCalls).toEqual([{ actorId: workerId, reason: "{}" }]);
    });

    it("delivers the same listed event to an exact subscriber when the sender is not the bot", async () => {
      let emitGitHubEvent:
        | ((event: string, payload: Record<string, unknown>) => Promise<void>)
        | undefined;
      let mesh: ActorMesh | undefined;

      const issueClient = new MockIssueClient();
      setIssueClient(issueClient as unknown as IssueClient);

      const readyPromise = new Promise<void>((resolve) => {
        runStart({
          e2e: {
            onReady: (handles) => {
              mesh = handles.mesh;
              emitGitHubEvent = handles.emitGitHubEvent;
              shutdownFn = handles.shutdown;
              resolve();
            },
          },
        });
      });

      await readyPromise;
      if (!mesh || !emitGitHubEvent) {
        throw new Error("Mesh or emitGitHubEvent not ready");
      }
      mesh.subscribeEventSource(
        { kind: "github_issue", repo: "dummy-org/dummy-repo", number: 456 },
        "root",
        "root"
      );

      await emitGitHubEvent("issues", {
        action: "labeled",
        repository: { full_name: "dummy-org/dummy-repo" },
        issue: { number: 456 },
        label: { name: "owner:cloudy-porpoise" },
        sender: { login: "someone-else" },
      });

      expect(requestRunCalls).toEqual([{ actorId: "root", reason: "{}" }]);
    });

    it("still delivers a bot-sender body-ful unstamped event — the stamp tier governs, not this rule", async () => {
      let emitGitHubEvent:
        | ((event: string, payload: Record<string, unknown>) => Promise<void>)
        | undefined;
      let mesh: ActorMesh | undefined;

      const issueClient = new MockIssueClient();
      setIssueClient(issueClient as unknown as IssueClient);

      const readyPromise = new Promise<void>((resolve) => {
        runStart({
          e2e: {
            onReady: (handles) => {
              mesh = handles.mesh;
              emitGitHubEvent = handles.emitGitHubEvent;
              shutdownFn = handles.shutdown;
              resolve();
            },
          },
        });
      });

      await readyPromise;
      if (!mesh || !emitGitHubEvent) {
        throw new Error("Mesh or emitGitHubEvent not ready");
      }
      mesh.subscribeEventSource({ kind: "github_org", org: "dummy-org" }, "root", "root");

      // issue_comment/created is body-ful, so this rule never engages — but
      // the comment carries no author stamp at all, so the existing
      // stamp-tier logic (a null stampedAuthor) still delivers it.
      await emitGitHubEvent("issue_comment", {
        action: "created",
        repository: { full_name: "dummy-org/dummy-repo" },
        comment: { id: 123, body: "plain unstamped comment from the bot account" },
        issue: { number: 456 },
        sender: { login: "mock-bot" },
      });

      expect(requestRunCalls).toEqual([{ actorId: "root", reason: "{}" }]);
    });

    it("delivers a bot-sender event NOT on the list — a merged PR must notify (github_branch deploy flows depend on merge-adjacent events)", async () => {
      let emitGitHubEvent:
        | ((event: string, payload: Record<string, unknown>) => Promise<void>)
        | undefined;
      let mesh: ActorMesh | undefined;

      const issueClient = new MockIssueClient();
      setIssueClient(issueClient as unknown as IssueClient);

      const readyPromise = new Promise<void>((resolve) => {
        runStart({
          e2e: {
            onReady: (handles) => {
              mesh = handles.mesh;
              emitGitHubEvent = handles.emitGitHubEvent;
              shutdownFn = handles.shutdown;
              resolve();
            },
          },
        });
      });

      await readyPromise;
      if (!mesh || !emitGitHubEvent) {
        throw new Error("Mesh or emitGitHubEvent not ready");
      }
      mesh.subscribeEventSource({ kind: "github_org", org: "dummy-org" }, "root", "root");

      // pull_request/closed (a merge) is deliberately NOT suppressed: humans
      // merge PRs, and staging-deploy flows subscribe to merge-adjacent
      // events. Unknown/unlisted event types deliver by default.
      await emitGitHubEvent("pull_request", {
        action: "closed",
        repository: { full_name: "dummy-org/dummy-repo" },
        pull_request: { number: 456, merged: true, body: "pr body" },
        sender: { login: "mock-bot" },
      });

      expect(requestRunCalls).toEqual([{ actorId: "root", reason: "{}" }]);
    });
  });

  describe("ISSUE_NUM sender-independent event-class suppression", () => {
    it("drops check_run.created before delivery, regardless of sender", async () => {
      let emitGitHubEvent:
        | ((event: string, payload: Record<string, unknown>) => Promise<void>)
        | undefined;
      let mesh: ActorMesh | undefined;
      const logSpy = vi.spyOn(console, "log");

      const issueClient = new MockIssueClient();
      setIssueClient(issueClient as unknown as IssueClient);

      const readyPromise = new Promise<void>((resolve) => {
        runStart({
          e2e: {
            onReady: (handles) => {
              mesh = handles.mesh;
              emitGitHubEvent = handles.emitGitHubEvent;
              shutdownFn = handles.shutdown;
              resolve();
            },
          },
        });
      });

      await readyPromise;
      if (!mesh || !emitGitHubEvent) {
        throw new Error("Mesh or emitGitHubEvent not ready");
      }
      mesh.subscribeEventSource({ kind: "github_org", org: "dummy-org" }, "root", "root");

      await emitGitHubEvent("check_run", {
        action: "created",
        repository: { full_name: "dummy-org/dummy-repo" },
        check_run: { id: 123, name: "unit" },
        sender: { login: "github-actions[bot]" },
      });

      expect(requestRunCalls).toHaveLength(0);
      expect(logSpy.mock.calls.map((c) => c.join(" "))).toContainEqual(
        expect.stringContaining(
          "never-delivered event dropped: check_run/created (sender=github-actions[bot] repo=dummy-org/dummy-repo)"
        )
      );
    });

    it("drops check_run.completed and a green check suite, and still delivers a red one", async () => {
      let emitGitHubEvent:
        | ((event: string, payload: Record<string, unknown>) => Promise<void>)
        | undefined;
      let mesh: ActorMesh | undefined;

      const issueClient = new MockIssueClient();
      setIssueClient(issueClient as unknown as IssueClient);

      const readyPromise = new Promise<void>((resolve) => {
        runStart({
          e2e: {
            onReady: (handles) => {
              mesh = handles.mesh;
              emitGitHubEvent = handles.emitGitHubEvent;
              shutdownFn = handles.shutdown;
              resolve();
            },
          },
        });
      });

      await readyPromise;
      if (!mesh || !emitGitHubEvent) {
        throw new Error("Mesh or emitGitHubEvent not ready");
      }
      mesh.subscribeEventSource({ kind: "github_org", org: "dummy-org" }, "root", "root");

      await emitGitHubEvent("check_run", {
        action: "completed",
        repository: { full_name: "dummy-org/dummy-repo" },
        check_run: { id: 123, name: "unit", conclusion: "success" },
        sender: { login: "github-actions[bot]" },
      });

      expect(requestRunCalls).toHaveLength(0);

      // Green is a status transition the gate already tracks, and it arrives
      // once per re-run — the churn this filter exists to stop.
      await emitGitHubEvent("check_suite", {
        action: "completed",
        repository: { full_name: "dummy-org/dummy-repo" },
        check_suite: { id: 456, conclusion: "success" },
        sender: { login: "github-actions[bot]" },
      });

      expect(requestRunCalls).toHaveLength(0);

      // Red means somebody has work, so this is not a blanket drop of the kind.
      await emitGitHubEvent("check_suite", {
        action: "completed",
        repository: { full_name: "dummy-org/dummy-repo" },
        check_suite: { id: 457, conclusion: "failure" },
        sender: { login: "github-actions[bot]" },
      });

      expect(requestRunCalls).toEqual([{ actorId: "root", reason: "{}" }]);
    });

    it("wakes a check suite's owner: the PR's when it has one, the repo's when it does not", async () => {
      let emitGitHubEvent:
        | ((event: string, payload: Record<string, unknown>) => Promise<void>)
        | undefined;
      let mesh: ActorMesh | undefined;

      const readyPromise = new Promise<void>((resolve) => {
        runStart({
          e2e: {
            onReady: (handles) => {
              mesh = handles.mesh;
              emitGitHubEvent = handles.emitGitHubEvent;
              shutdownFn = handles.shutdown;
              resolve();
            },
          },
        });
      });

      await readyPromise;
      if (!mesh || !emitGitHubEvent) {
        throw new Error("Mesh or emitGitHubEvent not ready");
      }

      const prWorker = mesh.spawn({
        charter: "pr tasks",
        parentId: "root",
        provider: "antigravity",
        model: "Gemini 3.7 Flash (High)",
      });
      mesh.subscribeEventSource(
        { kind: "github_pr", repo: "dummy-org/dummy-repo", number: 77 },
        prWorker,
        "root"
      );
      mesh.subscribeEventSource(
        { kind: "github_repo", repo: "dummy-org/dummy-repo" },
        "root",
        "root"
      );

      // Carries a PR: its owner is woken, and the repo owner is not.
      await emitGitHubEvent("check_suite", {
        action: "completed",
        repository: { full_name: "dummy-org/dummy-repo" },
        check_suite: {
          id: 500,
          conclusion: "failure",
          pull_requests: [{ number: 77 }],
          head_branch: "steward/whatever",
        },
        sender: { login: "github-actions[bot]" },
      });

      expect(requestRunCalls).toEqual([{ actorId: prWorker, reason: "{}" }]);
      requestRunCalls.length = 0;

      // No PR and nobody on the branch: it climbs to the repo owner rather
      // than reaching everybody or nobody.
      await emitGitHubEvent("check_suite", {
        action: "completed",
        repository: { full_name: "dummy-org/dummy-repo" },
        check_suite: { id: 501, conclusion: "failure", pull_requests: [] },
        sender: { login: "github-actions[bot]" },
      });

      expect(requestRunCalls).toEqual([{ actorId: "root", reason: "{}" }]);
      requestRunCalls.length = 0;

      // A PR nobody owns: red CI must not fall on the floor, so it climbs to
      // the repo owner. This is the half that breaks if `check_suite.completed`
      // stops being allowed past `mayBubbleToParent`.
      await emitGitHubEvent("check_suite", {
        action: "completed",
        repository: { full_name: "dummy-org/dummy-repo" },
        check_suite: { id: 502, conclusion: "failure", pull_requests: [{ number: 999 }] },
        sender: { login: "github-actions[bot]" },
      });

      expect(requestRunCalls).toEqual([{ actorId: "root", reason: "{}" }]);
    });
  });

  it("records inbound timestamp before self-suppression and emits no queued-run receipt", async () => {
    let emitGitHubEvent:
      | ((event: string, payload: Record<string, unknown>) => Promise<void>)
      | undefined;
    let mesh: ActorMesh | undefined;
    const order: string[] = [];
    const recordSpy = vi
      .spyOn(WebhookSilenceDetector.prototype, "recordInboundEvent")
      .mockImplementation(() => {
        order.push("record-inbound");
      });
    const issueClient = new MockIssueClient();
    issueClient.addCommentReaction = async (
      repo: string,
      commentId: number,
      reaction: string,
      scope?: string
    ) => {
      order.push("ack-react");
      issueClient.commentReactionsAdded.push({ repo, commentId, reaction, scope });
    };
    setIssueClient(issueClient as unknown as IssueClient);

    const readyPromise = new Promise<void>((resolve) => {
      runStart({
        e2e: {
          onReady: (handles) => {
            mesh = handles.mesh;
            emitGitHubEvent = handles.emitGitHubEvent;
            shutdownFn = handles.shutdown;
            resolve();
          },
        },
      });
    });

    await readyPromise;
    if (!mesh || !emitGitHubEvent) {
      throw new Error("Mesh or emitGitHubEvent not ready");
    }
    mesh.subscribeEventSource({ kind: "github_org", org: "dummy-org" }, "root", "root");

    await emitGitHubEvent("issue_comment", {
      action: "created",
      repository: { full_name: "dummy-org/dummy-repo" },
      comment: {
        id: 123,
        body: `bot echo\n${stampAuthor("root", "dummy-org/dummy-repo", 456, "root-actor")}`,
      },
      issue: { number: 456 },
      sender: { login: "mock-bot" },
    });

    expect(order).toEqual(["record-inbound"]);
    expect(requestRunCalls).toHaveLength(0);
    recordSpy.mockRestore();
  });

  it("routes to root when repo is absent", async () => {
    let emitGitHubEvent:
      | ((event: string, payload: Record<string, unknown>) => Promise<void>)
      | undefined;

    const readyPromise = new Promise<void>((resolve) => {
      runStart({
        e2e: {
          onReady: (handles) => {
            emitGitHubEvent = handles.emitGitHubEvent;
            shutdownFn = handles.shutdown;
            resolve();
          },
        },
      });
    });

    await readyPromise;
    if (!emitGitHubEvent) {
      throw new Error("emitGitHubEvent not ready");
    }

    // Emit event with no repository field
    await emitGitHubEvent("push", {
      action: "built",
      sender: { login: "someone-else" },
    });

    expect(requestRunCalls).toHaveLength(0);
  });

  it("bubbles an allowlisted event past a retired subscriber to the covering ancestor source ", async () => {
    let emitGitHubEvent:
      | ((event: string, payload: Record<string, unknown>) => Promise<void>)
      | undefined;
    let mesh: ActorMesh | undefined;

    const readyPromise = new Promise<void>((resolve) => {
      runStart({
        e2e: {
          onReady: (handles) => {
            mesh = handles.mesh;
            emitGitHubEvent = handles.emitGitHubEvent;
            shutdownFn = handles.shutdown;
            resolve();
          },
        },
      });
    });

    await readyPromise;
    expect(mesh).toBeDefined();
    expect(emitGitHubEvent).toBeDefined();
    if (!mesh || !emitGitHubEvent) {
      throw new Error("Mesh or emitGitHubEvent not ready");
    }

    const workerId = mesh.spawn({
      charter: "worker tasks",
      parentId: "root",
      provider: "antigravity",
      model: "Gemini 3.7 Flash (High)",
    });
    // Real topology : root retains the covering org source it delegates
    // slices from — the retired subscriber's event bubbles to root via that
    // source, not via the removed catch-all .
    mesh.subscribeEventSource({ kind: "github_org", org: "dummy-org" }, "root", "root");
    mesh.subscribeEventSource(
      { kind: "github_repo", repo: "dummy-org/dummy-repo" },
      workerId,
      "root"
    );

    // Retire worker (no longer live)
    mesh.retire(workerId);

    // Emit event. The conclusion has to be one that wakes somebody: this test
    // is about the bubbling walk, but a green suite is now dropped before it
    // reaches routing, which would make the walk untestable through this event.
    await emitGitHubEvent("check_suite", {
      action: "completed",
      repository: { full_name: "dummy-org/dummy-repo" },
      check_suite: { id: 123, conclusion: "failure" },
      sender: { login: "someone-else" },
    });

    expect(requestRunCalls).toHaveLength(1);
    expect(requestRunCalls[0]).toEqual({
      actorId: "root",
      reason: "{}",
    });
  });

  it("routes issue vs PR events correctly using the unified/split webhook derivation", async () => {
    let emitGitHubEvent:
      | ((event: string, payload: Record<string, unknown>) => Promise<void>)
      | undefined;
    let mesh: ActorMesh | undefined;

    const readyPromise = new Promise<void>((resolve) => {
      runStart({
        e2e: {
          onReady: (handles) => {
            mesh = handles.mesh;
            emitGitHubEvent = handles.emitGitHubEvent;
            shutdownFn = handles.shutdown;
            resolve();
          },
        },
      });
    });

    await readyPromise;
    if (!mesh || !emitGitHubEvent) {
      throw new Error("Mesh or emitGitHubEvent not ready");
    }

    const issueWorker = mesh.spawn({
      charter: "issue tasks",
      parentId: "root",
      provider: "antigravity",
      model: "Gemini 3.7 Flash (High)",
    });
    const prWorker = mesh.spawn({
      charter: "pr tasks",
      parentId: "root",
      provider: "antigravity",
      model: "Gemini 3.7 Flash (High)",
    });

    mesh.subscribeEventSource(
      { kind: "github_issue", repo: "dummy-org/dummy-repo", number: 123 },
      issueWorker,
      "root"
    );
    mesh.subscribeEventSource(
      { kind: "github_pr", repo: "dummy-org/dummy-repo", number: 456 },
      prWorker,
      "root"
    );

    // 1. True issue comment -> github_issue
    await emitGitHubEvent("issue_comment", {
      action: "created",
      repository: { full_name: "dummy-org/dummy-repo" },
      comment: { id: 100 },
      issue: { number: 123 }, // pull_request is absent
      sender: { login: "someone-else" },
    });

    expect(requestRunCalls).toContainEqual({
      actorId: issueWorker,
      reason: "{}",
    });

    // Reset requestRunCalls
    requestRunCalls.length = 0;

    // 2. PR comment (issue_comment with issue.pull_request present) -> github_pr
    await emitGitHubEvent("issue_comment", {
      action: "created",
      repository: { full_name: "dummy-org/dummy-repo" },
      comment: { id: 200 },
      issue: { number: 456, pull_request: {} }, // issue.pull_request is set
      sender: { login: "someone-else" },
    });

    expect(requestRunCalls).toContainEqual({
      actorId: prWorker,
      reason: "{}",
    });

    // Reset requestRunCalls
    requestRunCalls.length = 0;

    // 3. Pull request event (pull_request payload present) -> github_pr
    await emitGitHubEvent("pull_request", {
      action: "opened",
      repository: { full_name: "dummy-org/dummy-repo" },
      pull_request: { number: 456 },
      sender: { login: "someone-else" },
    });

    expect(requestRunCalls).toContainEqual({
      actorId: prWorker,
      reason: "{}",
    });
    // ISSUE_NUM: this test does real webhook event-emitter wiring; a loaded CI
    // runner occasionally exceeds the 5s default and reds the bless PR. Give it
  }, 15000);

  it("requires provider and model on spawn and refuses unresolvable configurations loudly (ISSUE_NUM, ISSUE_NUM)", async () => {
    let mesh: ActorMesh | undefined;
    const config = {
      github: {
        account: "mock-bot",
      },
      providers: {
        antigravity: { cliCommand: "agy" },
        claude: { cliCommand: "claude" },
      },
      rootActor: {
        provider: "antigravity",
      },
      geminiApiKey: "fake-gemini-key",
    };
    writeFileSync(join(homeDir, "config.yaml"), toYaml(config), "utf8");

    const readyPromise = new Promise<void>((resolve) => {
      runStart({
        e2e: {
          onReady: (handles) => {
            mesh = handles.mesh;
            shutdownFn = handles.shutdown;
            resolve();
          },
        },
      });
    });

    await readyPromise;
    expect(mesh).toBeDefined();
    if (!mesh) throw new Error("Mesh not ready");
    const activeMesh = mesh;

    // 1. Positive test: explicit unresolvable provider -> spawn throws loudly
    expect(() => {
      activeMesh.spawn({
        charter: "unresolvable provider worker",
        parentId: "root",
        provider: "unconfigured-provider",
        model: "some-model",
      });
    }).toThrow(/unconfigured-provider/);

    // Assert that the actor record in the registry is retired/errored
    const list1 = activeMesh.registry.list();
    const failedWorker = list1.find((r) => r.charter === "unresolvable provider worker");
    expect(failedWorker).toBeDefined();
    expect(failedWorker?.status).toBe("retired");

    if (!failedWorker) throw new Error("failedWorker should be defined");

    // Assert that the failed worker is NOT live
    expect(activeMesh.get(failedWorker.id)).toBeUndefined();

    // 2. Positive test: explicit empty model slug -> spawn throws loudly
    expect(() => {
      activeMesh.spawn({
        charter: "unresolvable model worker",
        parentId: "root",
        provider: "antigravity",
        model: "   ", // spaces/empty model
      });
    }).toThrow(/model is required/);

    // 3. an issue: omitting provider or model is refused at the boundary
    expect(() => {
      activeMesh.spawn({
        charter: "missing provider worker",
        parentId: "root",
        provider: "",
        model: "Gemini 3.7 Flash (High)",
      });
    }).toThrow(/provider is required/);

    expect(() => {
      activeMesh.spawn({
        charter: "missing model worker",
        parentId: "root",
        provider: "antigravity",
        model: "",
      });
    }).toThrow(/model is required/);

    // 4. Catalog validation hardening: invalid model pin rejected against resolved provider
    setProviderModelCatalog("antigravity", [
      {
        identifier: "Gemini 3.7 Flash (High)",
        displayLabel: "Gemini 3.7 Flash (High)",
        passable: true,
      },
    ]);
    setProviderModelCatalog("claude", [
      {
        identifier: "Claude 3.5 Sonnet",
        displayLabel: "Claude 3.5 Sonnet",
        passable: true,
      },
    ]);
    expect(() => {
      activeMesh.spawn({
        charter: "invalid model pin worker",
        parentId: "root",
        provider: "antigravity",
        model: "bad-unsupported-model",
      });
    }).toThrow(/model pin validation failed/);

    // 5. Positive test: explicit-and-VALID provider/model -> succeeds
    const validWorkerId = activeMesh.spawn({
      charter: "valid worker",
      parentId: "root",
      provider: "antigravity",
      model: "Gemini 3.7 Flash (High)",
    });
    expect(activeMesh.get(validWorkerId)).toBeDefined();
    const validWorkerRecord = activeMesh.registry.get(validWorkerId);
    expect(validWorkerRecord?.status).toBe("active");
    expect(activeMesh.registry.get("root")?.handles?.some((h) => h.id === validWorkerId)).toBe(
      true
    );

    // 6. Cross-provider move validates against TARGET provider's catalog and resolves target provider
    const portableWorkerId = activeMesh.spawn({
      charter: "portable worker",
      parentId: "root",
      provider: "claude",
      model: "Claude 3.5 Sonnet",
      context: { type: "portable", mode: "ledger" },
    });
    expect(activeMesh.registry.get(portableWorkerId)?.provider).toBe("claude");
    expect(activeMesh.registry.get(portableWorkerId)?.model).toBe("Claude 3.5 Sonnet");

    // Unconfigured target provider is rejected before state change, record untouched
    expect(() => {
      activeMesh.setActorModel(
        portableWorkerId,
        "Gemini 3.7 Flash (High)",
        "root",
        "unconfigured-provider"
      );
    }).toThrow(/unconfigured-provider/);
    expect(activeMesh.registry.get(portableWorkerId)?.provider).toBe("claude");
    expect(activeMesh.registry.get(portableWorkerId)?.model).toBe("Claude 3.5 Sonnet");

    // Valid target provider + model succeeds
    activeMesh.setActorModel(portableWorkerId, "Gemini 3.7 Flash (High)", "root", "antigravity");
    expect(activeMesh.registry.get(portableWorkerId)?.provider).toBe("antigravity");
    expect(activeMesh.registry.get(portableWorkerId)?.model).toBe("Gemini 3.7 Flash (High)");

    // Invalid model for target provider fails validation
    expect(() => {
      activeMesh.setActorModel(
        portableWorkerId,
        "bad-model-for-antigravity",
        "root",
        "antigravity"
      );
    }).toThrow(/model pin validation failed/);
    expect(activeMesh.registry.get(portableWorkerId)?.model).toBe("Gemini 3.7 Flash (High)");
  });

  it("routes delegated chat spaces to the delegatee while others bubble to root", async () => {
    const chatClient = new FakeChatClient();
    const chatSource = new FakeChatSource();
    writeFileSync(
      join(homeDir, "config.yaml"),
      toYaml({
        github: { account: "mock-bot" },
        providers: {
          antigravity: { cliCommand: "agy" },
        },
        rootActor: { provider: "antigravity" },
        chat: {
          projectId: "test",
          subscription: "test",
          pubsubKeyPath: "/dev/null",
          gchat: "all",
        },
        geminiApiKey: "fake-gemini-key",
      }),
      "utf8"
    );

    let mesh: ActorMesh | undefined;
    const readyPromise = new Promise<void>((resolve) => {
      runStart({
        e2e: {
          chatClient,
          chatSource,
          onReady: (handles) => {
            mesh = handles.mesh;
            shutdownFn = handles.shutdown;
            resolve();
          },
        },
      });
    });

    await readyPromise;
    if (!mesh) throw new Error("mesh not ready");

    const childId = mesh.spawn({
      charter: "child",
      parentId: "root",
      provider: "antigravity",
      model: "Gemini 3.7 Flash (High)",
    });
    mesh.delegateEventSource({ kind: "chat_space", space: "spaces/delegated" }, childId, "root");

    await chatSource.emit({
      name: "msg-delegated",
      spaceName: "spaces/delegated",
      spaceType: "DIRECT_MESSAGE",
      senderName: "users/operator",
      senderDisplayName: "Operator",
      text: "hello delegated",
      mentionsSelf: false,
      isDirectMessage: true,
    });

    await chatSource.emit({
      name: "msg-other",
      spaceName: "spaces/other",
      spaceType: "DIRECT_MESSAGE",
      senderName: "users/operator",
      senderDisplayName: "Operator",
      text: "hello root",
      mentionsSelf: false,
      isDirectMessage: true,
    });

    const childEntries = getRepositories().inbox.list(childId).entries;
    const rootEntries = getRepositories().inbox.list("root").entries;

    const childSpaceNames = childEntries.map((e) => e.payload?.spaceName).filter(Boolean);
    const rootSpaceNames = rootEntries.map((e) => e.payload?.spaceName).filter(Boolean);

    expect(childSpaceNames).toEqual(["spaces/delegated"]);
    expect(rootSpaceNames).toContain("spaces/other");
    expect(rootSpaceNames).not.toContain("spaces/delegated");
  });

  it("implies root event sources from github, chat, and observability stanzas", async () => {
    writeFileSync(
      join(homeDir, "config.yaml"),
      toYaml({
        github: {
          account: "mock-bot",
          repos: ["custom-org/custom-repo"],
          orgs: [{ org: "target-org" }, { org: "extra-org", excludedRepos: ["extra-org/secret"] }],
        },
        providers: {
          antigravity: { cliCommand: "agy" },
        },
        rootActor: { provider: "antigravity" },
        chat: {
          projectId: "test",
          subscription: "test",
          pubsubKeyPath: "/dev/null",
          // Outbound grants do not narrow the root's inbound event source.
          gchat: ["spaces/OUTBOUND_ONLY"],
        },
        observability: {
          diskAlert: {
            enabled: true,
          },
        },
        geminiApiKey: "fake-gemini-key",
      }),
      "utf8"
    );

    let mesh: ActorMesh | undefined;
    const readyPromise = new Promise<void>((resolve) => {
      runStart({
        e2e: {
          onReady: (handles) => {
            mesh = handles.mesh;
            shutdownFn = handles.shutdown;
            resolve();
          },
        },
      });
    });

    await readyPromise;
    if (!mesh) throw new Error("mesh not ready");

    const subscriptions = mesh.listSubscriptions();
    expect(subscriptions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          actorId: "root",
          subscribedBy: "root",
          resource: "github:custom-org/custom-repo",
        }),
        expect.objectContaining({
          actorId: "root",
          subscribedBy: "root",
          resource: "github:target-org",
        }),
        expect.objectContaining({
          actorId: "root",
          subscribedBy: "root",
          resource: "github:extra-org",
        }),
        expect.objectContaining({
          actorId: "root",
          subscribedBy: "root",
          resource: "gchat:spaces",
        }),
        expect.objectContaining({
          actorId: "root",
          subscribedBy: "root",
          resource: "system:events",
        }),
      ])
    );
  });

  it("drops inbound chat messages from spaces listed in chat.excludedSpaces ", async () => {
    const chatClient = new FakeChatClient();
    const chatSource = new FakeChatSource();
    writeFileSync(
      join(homeDir, "config.yaml"),
      toYaml({
        github: { account: "mock-bot" },
        providers: {
          antigravity: { cliCommand: "agy" },
        },
        rootActor: { provider: "antigravity" },
        chat: {
          projectId: "test",
          subscription: "test",
          pubsubKeyPath: "/dev/null",
          gchat: "all",
          excludedSpaces: ["spaces/AAAA_STAGING"],
        },
        geminiApiKey: "fake-gemini-key",
      }),
      "utf8"
    );

    let mesh: ActorMesh | undefined;
    const readyPromise = new Promise<void>((resolve) => {
      runStart({
        e2e: {
          chatClient,
          chatSource,
          onReady: (handles) => {
            mesh = handles.mesh;
            shutdownFn = handles.shutdown;
            resolve();
          },
        },
      });
    });

    await readyPromise;
    if (!mesh) throw new Error("mesh not ready");

    // Emit in excluded space
    await chatSource.emit({
      name: "msg-excluded",
      spaceName: "spaces/AAAA_STAGING",
      spaceType: "DIRECT_MESSAGE",
      senderName: "users/operator",
      senderDisplayName: "Operator",
      text: "hello excluded",
      mentionsSelf: false,
      isDirectMessage: true,
    });

    // Emit in non-excluded space
    await chatSource.emit({
      name: "msg-allowed",
      spaceName: "spaces/PROD",
      spaceType: "DIRECT_MESSAGE",
      senderName: "users/operator",
      senderDisplayName: "Operator",
      text: "hello allowed",
      mentionsSelf: false,
      isDirectMessage: true,
    });

    const rootEntries = getRepositories().inbox.list("root").entries;
    const rootSpaceNames = rootEntries.map((e) => e.payload?.spaceName).filter(Boolean);

    expect(rootSpaceNames).toContain("spaces/PROD");
    expect(rootSpaceNames).not.toContain("spaces/AAAA_STAGING");
  });

  it("routes two-person rooms and true DMs responsively while larger rooms remain mention-gated", async () => {
    const chatClient = new FakeChatClient();
    const chatSource = new FakeChatSource();
    writeFileSync(
      join(homeDir, "config.yaml"),
      toYaml({
        github: { account: "mock-bot" },
        providers: { antigravity: { cliCommand: "agy" } },
        rootActor: { provider: "antigravity" },
        chat: {
          projectId: "test",
          subscription: "test",
          pubsubKeyPath: "/dev/null",
          gchat: "all",
        },
        geminiApiKey: "fake-gemini-key",
      }),
      "utf8"
    );

    await new Promise<void>((resolve) => {
      runStart({
        e2e: {
          chatClient,
          chatSource,
          onReady: (handles) => {
            shutdownFn = handles.shutdown;
            resolve();
          },
        },
      });
    });

    const self = "users/self";
    const human = "users/human";
    const parsed = (name: string, spaceName: string): ParsedChatMessage => ({
      name,
      spaceName,
      senderName: human,
      senderType: "HUMAN",
      text: "no mention",
      mentionedUserNames: [],
    });

    await chatSource.emit(
      toChatMessage(parsed("messages/pseudo-dm", "spaces/two"), self, "SPACE", [
        { name: self, type: "BOT" },
        { name: human, type: "HUMAN" },
      ])
    );
    await chatSource.emit(
      toChatMessage(parsed("messages/group", "spaces/group"), self, "SPACE", [
        { name: self, type: "BOT" },
        { name: human, type: "HUMAN" },
        { name: "users/another", type: "HUMAN" },
      ])
    );
    await chatSource.emit(
      toChatMessage(parsed("messages/dm", "spaces/dm"), self, "DIRECT_MESSAGE")
    );

    const entries = getRepositories().inbox.list("root").entries;
    expect(entries.map((entry) => entry.payload?.messageName)).toEqual([
      "messages/dm",
      "messages/pseudo-dm",
    ]);
    expect(entries.every((entry) => entry.payload?.priority === "responsive")).toBe(true);
  });

  it("propagates delivery failures back to the chat source for redelivery", async () => {
    const chatClient = new FakeChatClient();
    const chatSource = new FakeChatSource();
    writeFileSync(
      join(homeDir, "config.yaml"),
      toYaml({
        github: { account: "mock-bot" },
        providers: { antigravity: { cliCommand: "agy" } },
        rootActor: { provider: "antigravity" },
        chat: { projectId: "test", subscription: "test", pubsubKeyPath: "/dev/null", gchat: "all" },
        geminiApiKey: "fake-gemini-key",
      }),
      "utf8"
    );

    let mesh: ActorMesh | undefined;
    const readyPromise = new Promise<void>((resolve) => {
      runStart({
        e2e: {
          chatClient,
          chatSource,
          onReady: (handles) => {
            mesh = handles.mesh;
            shutdownFn = handles.shutdown;
            resolve();
          },
        },
      });
    });

    await readyPromise;
    if (!mesh) throw new Error("mesh not ready");

    // Force deliverEvent to reject
    const originalDeliver = mesh.deliverEvent.bind(mesh);
    let rejected = false;
    mesh.deliverEvent = async (..._args) => {
      rejected = true;
      throw new Error("Simulated delivery failure");
    };

    await expect(
      chatSource.emit({
        name: "msg-fail",
        spaceName: "spaces/fail",
        spaceType: "DIRECT_MESSAGE",
        senderName: "users/operator",
        senderDisplayName: "Operator",
        text: "hello failure",
        mentionsSelf: false,
        isDirectMessage: true,
      })
    ).rejects.toThrow("Simulated delivery failure");
    expect(rejected).toBe(true);

    mesh.deliverEvent = originalDeliver;
  });

  it("rehydrates active workers on boot and retires unresolvable ones without blocking others", async () => {
    // Write threads.json directly in homeDir to simulate persisted registry on boot
    const threads = {
      threads: [
        legacyRootThread,
        {
          id: "t1",
          charter: "bad rehydrate worker",
          parentId: "root",
          provider: "unconfigured-provider",
          status: "active",
          createdAt: "2026-01-01T00:00:00Z",
        },
        {
          id: "t2",
          charter: "good rehydrate worker",
          parentId: "root",
          provider: "antigravity",
          status: "active",
          createdAt: "2026-01-01T00:00:00Z",
        },
      ],
    };
    writeFileSync(join(homeDir, "threads.json"), JSON.stringify(threads), "utf8");

    let mesh: ActorMesh | undefined;

    const readyPromise = new Promise<void>((resolve) => {
      runStart({
        e2e: {
          onReady: (handles) => {
            mesh = handles.mesh;
            shutdownFn = handles.shutdown;
            resolve();
          },
        },
      });
    });

    await readyPromise;
    expect(mesh).toBeDefined();
    if (!mesh) throw new Error("Mesh not ready");

    // Assert that bad rehydrate worker (t1) is NOT live, and registry marked it retired
    expect(mesh.get("t1")).toBeUndefined();
    const t1Record = mesh.registry.get("t1");
    expect(t1Record).toBeDefined();
    expect(t1Record?.status).toBe("retired");

    // Assert that good rehydrate worker (t2) IS live, and registry left it active
    expect(mesh.get("t2")).toBeDefined();
    const t2Record = mesh.registry.get("t2");
    expect(t2Record).toBeDefined();
    expect(t2Record?.status).toBe("active");
  });

  it("provides unscoped chat-read MCP server to all spawned workers when chatClient is configured (#59)", async () => {
    const chatClient = new FakeChatClient();
    writeFileSync(
      join(homeDir, "config.yaml"),
      toYaml({
        github: { account: "mock-bot" },
        providers: {
          antigravity: { cliCommand: "agy" },
        },
        rootActor: { provider: "antigravity" },
        chat: {
          projectId: "test",
          subscription: "test",
          pubsubKeyPath: "/dev/null",
          gchat: "all",
        },
        geminiApiKey: "fake-gemini-key",
      }),
      "utf8"
    );

    let mesh: ActorMesh | undefined;
    const readyPromise = new Promise<void>((resolve) => {
      runStart({
        e2e: {
          chatClient,
          onReady: (handles) => {
            mesh = handles.mesh;
            shutdownFn = handles.shutdown;
            resolve();
          },
        },
      });
    });

    await readyPromise;
    if (!mesh) throw new Error("mesh not ready");

    const workerId = mesh.spawn({
      charter: "chat-reader worker",
      parentId: "root",
      provider: "antigravity",
      model: "Gemini 3.7 Flash (High)",
    });

    const actor = mesh.get(workerId) as unknown as {
      opts: { mcpServers: Array<{ name: string; url: string }> };
    };
    expect(actor).toBeDefined();
    const chatReadSpecs = actor.opts.mcpServers.filter((s) => s.name === "chat-read");
    expect(chatReadSpecs).toHaveLength(1);
    const initialChatReadUrl = chatReadSpecs[0].url;

    // Grant a write capability and verify chat-read is retained without duplication
    mesh.grantCapability(workerId, "chat-write:spaces/AAAA", "root");
    const updatedChatReadSpecs = actor.opts.mcpServers.filter((s) => s.name === "chat-read");
    expect(updatedChatReadSpecs).toHaveLength(1);
    expect(updatedChatReadSpecs[0].url).toBe(initialChatReadUrl);

    const updatedServerNames = actor.opts.mcpServers.map((s) => s.name);
    expect(updatedServerNames).toContain("chat-write");

    // Scoped chat-read is no longer a grantable capability (all actors have implicit unscoped read)
    const liveMesh = mesh;
    expect(() => liveMesh.grantCapability(workerId, "chat-read:spaces/BBBB", "root")).toThrow(
      "not a grantable capability: chat-read:spaces/BBBB"
    );

    // Revoking write capability preserves the default chat-read server intact
    mesh.revokeCapability(workerId, "chat-write:spaces/AAAA", "root");
    const afterRevokeSpecs = actor.opts.mcpServers.filter((s) => s.name === "chat-read");
    expect(afterRevokeSpecs).toHaveLength(1);
    expect(afterRevokeSpecs[0].url).toBe(initialChatReadUrl);
  });
});
