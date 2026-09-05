import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ContextConfig } from "../actor/actor-record.js";
import { resolveContextSelection } from "../actor/context-selection.js";
import { FakeChatClient, FakeChatSource } from "../chat/fake.js";
import type { ChatMessage } from "../chat/types.js";
import type { QuotaApiDeps } from "../dashboard/quota-api.js";
import { getRepositories } from "../db/index.js";
import { FakeIssueClient } from "../e2e/fake-issue-client.js";
import { LocalTracker } from "../e2e/local-tracker.js";
import {
  E2E_RUNS_DIR_NAME,
  PID_FILE,
  provisionE2EInstance,
  resumeE2EInstance,
} from "../e2e/provision.js";
import { startTrackerServer } from "../e2e/tracker-server.js";
import { setIssueClient } from "../gitops/issue-client.js";
import type { ProviderQuotaSnapshot } from "../mcp/quota-mcp.js";
import { HUMAN_OPERATOR } from "../mcp/stamp.js";
import { assertBwrapAvailable } from "../providers/sandbox.js";
import { type RunStartE2EHandles, runStart } from "./start.js";

/** Local issue tracker REST surface (the agent-facing "GitHub"). */
const TRACKER_PORT = 8084;
/** Control surface for injecting/observing chat (the agent-facing "Google Chat"). */
const CHAT_CONTROL_PORT = 8085;
/** Trusted control surface used when the root is driven outside the instance. */
const ROOT_CONTROL_PORT = 8086;

/** Deterministic edge values for exercising both full and exhausted quota rings. */
export function createDashboardE2EQuotaApi(now = Date.now()): QuotaApiDeps {
  const remaining = { claude: 0, codex: 100, agy: 1, kimi: 50 } as const;
  const demoHistory = {
    claude: [92, 68, 37, 12],
    codex: [96, 74, 53, 31],
    agy: [88, 61, 29, 7],
    kimi: [90, 79, 58, 42],
  } as const;
  const historyOffsetsMs = [64, 46, 28, 6].map((hours) => hours * 60 * 60 * 1000);

  const snapshot = (
    provider: keyof typeof remaining,
    weeklyRemaining: number,
    scrapedAt: number
  ): ProviderQuotaSnapshot => ({
    provider,
    status: weeklyRemaining === 0 ? "exhausted" : "available",
    scrapedAt: new Date(scrapedAt).toISOString(),
    limits: [
      {
        label: "Session",
        kind: "five_hour",
        percentLeft: 100 - weeklyRemaining,
        resetAtIso: new Date(scrapedAt + 5 * 60 * 60 * 1000).toISOString(),
        scope: "provider",
      },
      {
        label: "Weekly",
        kind: "weekly",
        percentLeft: weeklyRemaining,
        resetAtIso: new Date(scrapedAt + 7 * 24 * 60 * 60 * 1000).toISOString(),
        scope: "provider",
      },
    ],
  });

  return {
    providers: ["claude", "codex", "agy", "kimi"],
    now: () => now,
    getQuota: async (provider): Promise<ProviderQuotaSnapshot> =>
      snapshot(provider, remaining[provider], now),
    listHistory: (provider, sinceIso) =>
      demoHistory[provider]
        .map((weeklyRemaining, index) => {
          const observedAt = new Date(now - historyOffsetsMs[index]).toISOString();
          return {
            scope: "provider" as const,
            kind: "weekly",
            label: "Weekly",
            observedAt,
            percentLeft: weeklyRemaining,
            resetAtIso: null,
            controllerError: null,
            intervalSeconds: null,
          };
        })
        .filter((reading) => reading.observedAt >= sinceIso),
  };
}

/**
 * `e2e am-up` — provision a disposable instance and run the **actor mesh**
 * (`runStart`) against it, with the GitHub and chat edges swapped for fakes and
 * real coding providers above the seam (exploratory testing, not faked LLMs).
 *
 * Differs from the v2 {@link runE2EUp}: no scheduler/observe loop, no DB-model
 * seeding, no worktree workspace init — the mesh is event-driven and workers
 * clone for themselves. We drive it by:
 *  - filing issues/comments/reviews on the local tracker REST API (`:8084`),
 *    whose mutations wake the root in-process via `emitGitHubEvent`; and
 *  - posting chat messages to the control API (`:8085`), which feeds the
 *    `FakeChatSource`; the root's outbound chat is captured on `FakeChatClient`
 *    and readable at `GET :8085/chat/outbox`.
 *
 * Teardown + root removal is via `e2e am-down --root <root>`.
 */
export async function runActorMeshE2EUp(opts: {
  root?: string;
  baseConfigHome?: string;
  rootDriver?: "provider" | "external";
  rootControlPort?: number;
  resume?: boolean;
}): Promise<void> {
  try {
    assertBwrapAvailable();
  } catch (err) {
    console.error(`❌ ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  // Provision OUTSIDE /tmp. Sandboxed workers run under bwrap with `--tmpfs /tmp`,
  // which replaces /tmp with a fresh empty mount — so anything the instance puts
  // under /tmp (the bare remote, the gitconfig with the clone `insteadOf`) is
  // invisible to a worker. Rooting under $HOME keeps it ro-bound and visible, so
  // a worker can clone the synthetic repo via the rewritten URL.
  const runsDir = join(homedir(), E2E_RUNS_DIR_NAME);
  mkdirSync(runsDir, { recursive: true });
  if (opts.resume && !opts.root) {
    throw new Error("--resume requires --root");
  }
  const instanceRoot = opts.root ?? mkdtempSync(join(runsDir, "run-"));

  // Provision with the actor-mesh edges enabled: a root actor (agy, built-in
  // charter) and a chat config (the real fields are unused — fakes are injected
  // below — but their presence activates the chat MCP server + inbound path).
  const instance = opts.resume
    ? resumeE2EInstance(instanceRoot)
    : provisionE2EInstance({
        root: instanceRoot,
        baseConfigHome: opts.baseConfigHome,
        // External control does not invoke a root provider, but children still
        // use the real provider catalog and credentials seeded below.
        rootActor: { provider: opts.rootDriver === "external" ? "fake" : "claude" },
        chat: {
          projectId: "e2e",
          subscription: "e2e",
          pubsubKeyPath: "/dev/null",
          gchatConfigDir: "/tmp/rusa-e2e-gchat",
          errorChat: "spaces/e2e-errors",
        },
      });
  const { root: rootDir, home, config, repo } = instance;
  const bot = config.github.account ?? "quickstart-user";

  // Resolve clones of the synthetic repo to the local bare remote, so a worker
  // that `git clone`s the GitHub URL transparently hits our throwaway origin.
  if (!opts.resume) {
    appendFileSync(
      join(rootDir, "gitconfig"),
      [
        `[url "${instance.remotePath}"]`,
        `\tinsteadOf = https://github.com/${repo}`,
        `\tinsteadOf = https://github.com/${repo}.git`,
        `\tinsteadOf = git@github.com:${repo}.git`,
        "",
      ].join("\n"),
      "utf8"
    );
  }

  writeFileSync(join(rootDir, PID_FILE), String(process.pid), "utf8");

  console.log(`\n🧪 Rusa e2e — actor mesh\n${"━".repeat(30)}\n`);
  console.log(`E2E_ROOT=${rootDir}`);
  console.log(`E2E_HOME=${home}`);
  console.log(`E2E_REMOTE=${instance.remotePath}`);
  console.log(`E2E_SCRATCH=${instance.scratchPath}`);

  // Fakes for the two human-facing edges.
  const chatClient = new FakeChatClient();
  const chatSource = new FakeChatSource();

  // Local tracker behind the FakeIssueClient. Its mutations emit GitHub-shaped
  // events; we forward them to the root once runStart hands us the sink.
  let emitGitHubEvent: RunStartE2EHandles["emitGitHubEvent"] | null = null;
  const tracker = new LocalTracker({
    repo,
    baseUrl: `http://localhost:${TRACKER_PORT}`,
    botAccount: bot,
    onEvent: async (event, payload) => {
      await emitGitHubEvent?.(event, payload);
    },
    remotePath: instance.remotePath,
  });
  // Must precede runStart, which captures the client at getIssueClient().
  setIssueClient(new FakeIssueClient(tracker, bot));

  let trackerServer: { close: () => Promise<void> } | null = null;
  let chatServer: Server | null = null;
  let rootControlServer: Server | null = null;

  // Fire-and-forget: runStart keeps the process alive (its mcp/control servers
  // are active handles). onReady fires once every edge is wired.
  void runStart({
    e2e: {
      chatClient,
      chatSource,
      rootDriver: opts.rootDriver,
      dashboard: true,
      quotaApi: createDashboardE2EQuotaApi(),
      remoteGitDir: instance.remotePath,
      onReady: (handles) => {
        emitGitHubEvent = handles.emitGitHubEvent;
        void startTrackerServer({ port: TRACKER_PORT, tracker }).then((s) => {
          trackerServer = s;
        });
        chatServer = startChatControlServer({ port: CHAT_CONTROL_PORT, chatSource, chatClient });
        if (handles.externalRoot) {
          rootControlServer = startRootControlServer({
            port: opts.rootControlPort ?? ROOT_CONTROL_PORT,
            handles,
            home,
          });
        }
        printDriveHelp({
          rootDir,
          repo,
          dashboardPort: config.dashboard?.port ?? 8083,
          rootControlPort: handles.externalRoot
            ? (opts.rootControlPort ?? ROOT_CONTROL_PORT)
            : undefined,
        });
      },
    },
  });

  // Belt-and-suspenders: close our extra servers on shutdown (runStart's own
  // SIGTERM handler exits the process, which also frees them).
  const closeExtra = () => {
    void trackerServer?.close();
    chatServer?.close();
    rootControlServer?.close();
  };
  process.on("exit", closeExtra);
}

/** HTTP controller for an externally driven root. Every mutation uses RootControlService. */
export function startRootControlServer(opts: {
  port: number;
  handles: RunStartE2EHandles;
  home?: string;
}): Server {
  const send = (res: import("node:http").ServerResponse, code: number, body: unknown) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const externalRoot = opts.handles.externalRoot;
    if (!externalRoot) {
      send(res, 409, { error: "root is provider-driven" });
      return;
    }
    if (req.method === "GET" && url.pathname === "/actors") {
      send(res, 200, { actors: opts.handles.mesh.list() });
      return;
    }
    const actorMatch = url.pathname.match(/^\/actors\/([^/]+)$/);
    if (req.method === "GET" && actorMatch) {
      const id = decodeURIComponent(actorMatch[1]);
      const record = opts.handles.mesh.actors.get(id);
      if (!record) {
        send(res, 404, { error: "actor not found" });
        return;
      }
      send(res, 200, {
        ...record,
        running: opts.handles.mesh.runningThreadIds().has(id),
        queued: opts.handles.mesh.queuedThreadIds().has(id),
      });
      return;
    }
    const contextMatch = url.pathname.match(/^\/actors\/([^/]+)\/context$/);
    if (req.method === "GET" && contextMatch) {
      if (!opts.home) {
        send(res, 409, { error: "portable context inspection is not configured" });
        return;
      }
      const id = decodeURIComponent(contextMatch[1]);
      if (!opts.handles.mesh.actors.get(id)) {
        send(res, 404, { error: "actor not found" });
        return;
      }
      const path = join(opts.home, "portable-context", `${id}.json`);
      const events = getRepositories()
        .meshEvents.listEventsByActors([id], { limit: 20 })
        .events.filter(
          (event) =>
            event.kind === "run_queued" ||
            event.kind === "run_start" ||
            event.kind === "run_end" ||
            event.kind === "portable_context_compacted"
        )
        .reverse();
      send(res, 200, {
        state: existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null,
        events,
      });
      return;
    }
    if (req.method === "GET" && url.pathname === "/options") {
      send(res, 200, { providers: opts.handles.rootControl.providers });
      return;
    }
    if (req.method === "GET" && url.pathname === "/root/wakes") {
      send(res, 200, { wakes: externalRoot.listWakes() });
      return;
    }
    if (req.method === "GET" && url.pathname === "/root/inbox") {
      send(
        res,
        200,
        opts.handles.inboxStore.list(opts.handles.rootControl.rootId, { status: "unhandled" })
      );
      return;
    }
    if (req.method !== "POST") {
      send(res, 404, { error: "not found" });
      return;
    }
    readJsonRequest(req)
      .then((body) => {
        if (url.pathname === "/actors") {
          const contextMode = body.contextMode ?? "native";
          const compactionModel =
            typeof body.compactionModel === "string" && body.compactionModel.trim()
              ? body.compactionModel.trim()
              : undefined;
          // Same door as the prod spawn paths , so the E2E rig cannot drift
          // into accepting a selection production would refuse, or vice versa.
          let context: ContextConfig | undefined;
          try {
            context = resolveContextSelection(contextMode, { compactionModel });
          } catch (err) {
            send(res, 400, { error: err instanceof Error ? err.message : String(err) });
            return;
          }
          const id = opts.handles.rootControl.spawnChild(
            {
              charter: typeof body.charter === "string" ? body.charter : "",
              modelConfig: {
                provider: typeof body.provider === "string" ? body.provider : "",
                model: typeof body.model === "string" ? body.model : "",
                effort: typeof body.effort === "string" ? body.effort : undefined,
              },
              title: typeof body.title === "string" ? body.title : undefined,
              context,
            },
            "e2e-controller"
          );
          // Echo back what was actually stored on the record, read out of the
          // resolved config rather than off the request, so the rig asserts on
          // the spawn's real shape instead of on its own input.
          send(
            res,
            201,
            context?.type === "portable"
              ? { id, contextMode: context.mode, compactionModel: context.compactionModel }
              : { id }
          );
          return;
        }
        if (url.pathname === "/root/wakes/ack") {
          const ids = stringArray(body.ids);
          send(res, 200, { acknowledged: externalRoot.acknowledge(ids) });
          return;
        }
        if (url.pathname === "/root/inbox/ack") {
          const ids = stringArray(body.ids);
          const note = typeof body.note === "string" ? body.note : undefined;
          send(res, 200, {
            acknowledged: opts.handles.inboxStore.markHandled(
              opts.handles.rootControl.rootId,
              ids,
              undefined,
              note
            ),
          });
          return;
        }
        const inboxAckMatch = url.pathname.match(/^\/actors\/([^/]+)\/inbox\/ack$/);
        if (inboxAckMatch) {
          const id = decodeURIComponent(inboxAckMatch[1]);
          const note = typeof body.note === "string" ? body.note : undefined;
          send(res, 200, {
            acknowledged: opts.handles.inboxStore.markHandled(
              id,
              stringArray(body.ids),
              undefined,
              note
            ),
          });
          return;
        }
        const retireMatch = url.pathname.match(/^\/actors\/([^/]+)\/retire$/);
        if (retireMatch) {
          const id = decodeURIComponent(retireMatch[1]);
          opts.handles.rootControl.retireChild(id, "e2e-controller");
          send(res, 200, { id, status: "retired" });
          return;
        }
        const messageMatch = url.pathname.match(/^\/actors\/([^/]+)\/messages$/);
        if (messageMatch) {
          const text = typeof body.body === "string" ? body.body : "";
          opts.handles.rootControl.sendMessage(
            decodeURIComponent(messageMatch[1]),
            text,
            "e2e-controller"
          );
          send(res, 200, { ok: true });
          return;
        }
        if (url.pathname === "/obligations") {
          // The external driver IS the operator, so the creator is the shared
          // HUMAN_OPERATOR id — the same server-side binding the actor MCP does
          // with its own actor id, never a value read off the request.
          const obligation = getRepositories().obligations.create({
            ownerId: String(body.ownerId ?? ""),
            parentId: body.parentId == null ? null : String(body.parentId),
            intent: body.intent == null ? null : String(body.intent),
            title: String(body.title ?? ""),
            externalRef: body.externalRef == null ? null : String(body.externalRef),
            priority: typeof body.priority === "number" ? body.priority : null,
            creatorId: HUMAN_OPERATOR,
          });
          send(res, 200, { obligation });
          return;
        }
        const statusMatch = url.pathname.match(/^\/obligations\/([^/]+)\/status$/);
        if (statusMatch) {
          const obligation = getRepositories().obligations.setTerminalStatus(
            decodeURIComponent(statusMatch[1]),
            body.status === "cancelled" ? "cancelled" : "done",
            typeof body.note === "string" ? body.note : null,
            typeof body.resolutionRef === "string" ? body.resolutionRef : null
          );
          send(res, 200, { obligation });
          return;
        }
        const reassignMatch = url.pathname.match(/^\/obligations\/([^/]+)\/reassign$/);
        if (reassignMatch) {
          const obligation = getRepositories().obligations.reassign(
            decodeURIComponent(reassignMatch[1]),
            String(body.ownerId ?? "")
          );
          send(res, 200, { obligation });
          return;
        }
        const reparentMatch = url.pathname.match(/^\/obligations\/([^/]+)\/reparent$/);
        if (reparentMatch) {
          const obligation = getRepositories().obligations.reparent(
            decodeURIComponent(reparentMatch[1]),
            body.parentId == null ? null : String(body.parentId)
          );
          send(res, 200, { obligation });
          return;
        }
        send(res, 404, { error: "not found" });
      })
      .catch((err) => {
        send(res, 400, { error: err instanceof Error ? err.message : String(err) });
      });
  });
  server.listen(opts.port, "127.0.0.1");
  return server;
}

function readJsonRequest(
  req: import("node:http").IncomingMessage
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      try {
        const value = JSON.parse(raw || "{}") as unknown;
        if (!value || typeof value !== "object" || Array.isArray(value)) {
          reject(new Error("JSON object body required"));
          return;
        }
        resolve(value as Record<string, unknown>);
      } catch {
        reject(new Error("invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error("ids must be an array of strings");
  }
  return value;
}

/** Build a normalized inbound chat message for the fake source. */
function fakeChatMessage(seq: number, text: string, dm: boolean): ChatMessage {
  const space = dm ? "spaces/e2e-dm" : "spaces/e2e-room";
  return {
    name: `${space}/messages/m${seq}`,
    spaceName: space,
    spaceType: dm ? "DIRECT_MESSAGE" : "SPACE",
    senderName: "users/operator",
    senderDisplayName: "Operator",
    text,
    mentionsSelf: !dm, // a room message must @mention to trigger; a DM always does
    isDirectMessage: dm,
  };
}

/**
 * Tiny HTTP control surface for the chat edge:
 *  - `POST /chat/send  {"text": "...", "dm": true}` → deliver an inbound message
 *    (wakes the root). `dm` defaults to true; a room message sets mentionsSelf.
 *  - `GET  /chat/outbox` → `{ sent, reactions }` the root produced.
 */
export function startChatControlServer(opts: {
  port: number;
  chatSource: FakeChatSource;
  chatClient: FakeChatClient;
}): Server {
  let seq = 0;
  const server = createServer((req, res) => {
    const send = (code: number, body: unknown) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.method === "GET" && req.url === "/chat/outbox") {
      send(200, { sent: opts.chatClient.sent, reactions: opts.chatClient.reactions });
      return;
    }
    if (req.method === "POST" && req.url === "/chat/send") {
      let raw = "";
      req.on("data", (c) => {
        raw += c;
      });
      req.on("end", () => {
        void (async () => {
          try {
            const { text, dm } = JSON.parse(raw || "{}") as { text?: string; dm?: boolean };
            if (!text) return send(400, { error: "text is required" });
            const msg = fakeChatMessage(++seq, text, dm !== false);
            // Deliver AND make readable. The source only wakes the actor; the
            // chat-read MCP answers `get_message`/`list_messages` out of
            // `FakeChatClient.messages`, which nothing was populating. So a
            // woken root followed its inbox item to the source, got "message
            // not found", and — correctly, per the grounding discipline —
            // refused to guess and asked the operator to resend. The edge
            // looked wired and was write-only.
            opts.chatClient.messages.push({
              name: msg.name,
              text: msg.text,
              sender: { name: msg.senderName, displayName: msg.senderDisplayName },
              createTime: new Date().toISOString(),
            });
            await opts.chatSource.emit(msg);
            send(200, { ok: true, delivered: msg.name });
          } catch (err) {
            send(500, { error: err instanceof Error ? err.message : String(err) });
          }
        })();
      });
      return;
    }
    send(404, { error: "not found" });
  });
  server.listen(opts.port);
  return server;
}

function printDriveHelp(opts: {
  rootDir: string;
  repo: string;
  dashboardPort: number;
  rootControlPort?: number;
}): void {
  const tracker = `http://localhost:${TRACKER_PORT}`;
  const chat = `http://localhost:${CHAT_CONTROL_PORT}`;
  console.log(`TRACKER_URL=${tracker}`);
  console.log(`CHAT_CONTROL_URL=${chat}`);
  console.log(`DASHBOARD_URL=http://127.0.0.1:${opts.dashboardPort}`);
  if (opts.rootControlPort) {
    const rootControl = `http://localhost:${opts.rootControlPort}`;
    console.log(`ROOT_CONTROL_URL=${rootControl}`);
    console.log(`  curl -s ${rootControl}/options | jq`);
    console.log(`\nObserve pending root work:`);
    console.log(`  curl -s ${rootControl}/root/wakes | jq`);
    console.log(`\nSpawn a root child without invoking a root provider:`);
    console.log(
      `  curl -s -XPOST ${rootControl}/actors -d '{"charter":"...","provider":"<configured key>","model":"<model>","contextMode":"ledger"}'`
    );
    console.log(`\nMessage it and inspect its durable context:`);
    console.log(`  curl -s -XPOST ${rootControl}/actors/<id>/messages -d '{"body":"..."}'`);
    console.log(`  curl -s ${rootControl}/actors/<id>/context | jq`);
    console.log(`\nRetire a root descendant:`);
    console.log(`  curl -s -XPOST ${rootControl}/actors/<id>/retire -d '{}'`);
  }
  console.log(`\nDM the bot (wakes the root):`);
  console.log(`  curl -s -XPOST ${chat}/chat/send -d '{"text":"hey, what are you working on?"}'`);
  console.log(`\nSee what the bot said/reacted on chat:`);
  console.log(`  curl -s ${chat}/chat/outbox | jq`);
  console.log(`\nFile an issue (wakes the root via the GitHub edge):`);
  console.log(
    `  curl -s -XPOST ${tracker}/repos/${opts.repo}/issues -d '{"title":"...","body":"..."}'`
  );
  console.log(`\nObserve: tail this process's stdout (the actor firehose),`);
  console.log(`  inspect ${join(opts.rootDir, "home", "data", "mesh.db")}, or query ${tracker}.`);
  console.log(`\nTear down:  pnpm e2e am-down --root ${opts.rootDir}\n`);
  console.log(`Instance ready. Ctrl-C for graceful shutdown (root kept; am-down removes it).\n`);
}
