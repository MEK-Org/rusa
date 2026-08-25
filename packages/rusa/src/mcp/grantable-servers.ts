import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CalendarClientProvider } from "../calendar/calendar-client.js";
import type { ChatClient } from "../chat/types.js";
import type { DriveClient } from "../drive/drive-client.js";
import type { GmailClient } from "../email/gmail-client.js";
import type { McpServerSpec } from "../providers/types.js";
import {
  CALENDAR_READ_MCP_NAME,
  CALENDAR_WRITE_MCP_NAME,
  type CalendarReadObservation,
  type CalendarWriteObservation,
  createCalendarReadMcpServer,
  createCalendarWriteMcpServer,
} from "./calendar-mcp.js";
import { CHAT_WRITE_MCP_NAME, createChatWriteMcpServer } from "./chat-mcp.js";
import {
  createDistillerServer,
  DISTILLER_MCP_NAME,
  type DistillerMcpDeps,
} from "./distiller-mcp.js";
import {
  createDriveReadMcpServer,
  DRIVE_READ_MCP_NAME,
  type DriveReadObservation,
} from "./drive-mcp.js";
import {
  createE2EInstanceServer,
  E2E_INSTANCE_MCP_NAME,
  type E2EInstanceMcpDeps,
} from "./e2e-instance-mcp.js";
import { createEmailSendMcpServer, EMAIL_SEND_MCP_NAME } from "./email-mcp.js";
import { createHostJobsServer, HOST_JOBS_MCP_NAME, type HostJobsMcpDeps } from "./host-jobs-mcp.js";
import {
  createUnderstandingWriteServer,
  UNDERSTANDING_WRITE_MCP_NAME,
  type UnderstandingMcpDeps,
} from "./understanding-mcp.js";

/**
 * Factory for a grantable per-actor MCP server. The wiring calls it with the
 * grantee's `selfId` (baked into the server instance) when mounting a granted
 * capability on top of that actor's default tool set.
 */
export type GrantableServerFactory = (
  selfId: string,
  params: string[],
  options?: { isFenced?: () => boolean }
) => McpServer;

/** Dependencies the grantable servers need, each scoped to that server boundary. */
export interface GrantableServerDeps {
  distiller: DistillerMcpDeps;
  understanding: UnderstandingMcpDeps;
  rootNodeId?: string;
  hostJobs: HostJobsMcpDeps;
  e2eInstance: E2EInstanceMcpDeps;
  gmailClient: GmailClient;
  onEmailSend: (actorId: string, to: string, cc: string[]) => void;
  calendarClients: CalendarClientProvider;
  onCalendarRead?: (actorId: string, observation: CalendarReadObservation) => void;
  onCalendarWrite?: (actorId: string, observation: CalendarWriteObservation) => void;
  chatClient?: ChatClient;
  onChatWrite?: (actorId: string) => void;
  /** Workdir for a grantee actor; confines chat-write attachment `filePath`s. */
  actorRootFor?: (actorId: string) => string;
  driveClients: DriveClient;
  onDriveRead?: (actorId: string, observation: DriveReadObservation) => void;
}

/**
 * The PRODUCTION allow-list of grantable MCP capabilities : the only
 * capabilities the root may grant to an actor (by id), keyed by capability name,
 * with the factory the wiring mounts for a grantee. `start.ts` passes the key set
 * to the mesh as `grantableCapabilities`; a grant of any name not present here is
 * rejected.
 *
 * SECURITY GATE (phase 1a → 1b): this stayed EMPTY until claude-worker FS
 * isolation (ISSUE_NUM/ISSUE_NUM) landed — without it, an unsandboxed claude worker could
 * harvest another actor's endpoint token from shared /tmp or tamper
 * `~/.rusa`, defeating the actor-identity the grant rests on. ISSUE_NUM is MERGED,
 * so registering a real capability is now legitimate; `grantable-servers.test.ts`
 * locks the contents so any future addition is a conscious decision.
 *
 * Phase 1b registers `understanding-write` (the glass-goals write tools), granted
 * to the single IU steward. ISSUE_NUM adds `distiller`, another scoped IU-steward
 * capability for host-routed distill cursor operations. ISSUE_NUM adds `host-jobs`,
 * a per-actor grantable host-plane job runner. ISSUE_NUM adds `chat-write`, a space-scoped
 * outbound chat capability. ISSUE_NUM adds `calendar-read`, scoped to explicit
 * calendar IDs; ISSUE_NUM adds its identity-verified whole-account form. ISSUE_NUM
 * adds `email-send`, scoped to explicit recipients.
 */
export function buildGrantableServers(
  deps: GrantableServerDeps
): Map<string, GrantableServerFactory> {
  const map = new Map<string, GrantableServerFactory>([
    [
      DISTILLER_MCP_NAME,
      (_selfId, _params, options) => createDistillerServer(deps.distiller, options),
    ],
    [
      UNDERSTANDING_WRITE_MCP_NAME,
      (_selfId, _params, options) =>
        createUnderstandingWriteServer(deps.understanding, deps.rootNodeId, options),
    ],
    [
      HOST_JOBS_MCP_NAME,
      (selfId, _params, options) => createHostJobsServer(deps.hostJobs, selfId, options),
    ],
    [
      E2E_INSTANCE_MCP_NAME,
      (selfId, _params, options) => createE2EInstanceServer(deps.e2eInstance, selfId, options),
    ],
    [
      EMAIL_SEND_MCP_NAME,
      (selfId, params, options) =>
        createEmailSendMcpServer(selfId, deps.gmailClient, {
          allowedRecipients: params,
          onSend: (actorId, delivery) => deps.onEmailSend(actorId, delivery.to, delivery.cc),
          isFenced: options?.isFenced,
        }),
    ],
    [
      CALENDAR_READ_MCP_NAME,
      (selfId, params, options) => {
        const allowedAccounts = params
          .filter((param) => param.startsWith("account:"))
          .map((param) => param.slice("account:".length))
          .filter(Boolean);
        const allowedCalendars = params.filter((param) => !param.startsWith("account:"));
        return createCalendarReadMcpServer(selfId, deps.calendarClients, {
          allowedCalendars,
          allowedAccounts,
          onRead: deps.onCalendarRead,
          isFenced: options?.isFenced,
        });
      },
    ],
    [
      CALENDAR_WRITE_MCP_NAME,
      (selfId, params, options) => {
        const allowedCalendars = params.filter((param) => !param.startsWith("account:"));
        return createCalendarWriteMcpServer(selfId, deps.calendarClients, {
          allowedCalendars,
          onWrite: deps.onCalendarWrite,
          isFenced: options?.isFenced,
        });
      },
    ],
    [
      DRIVE_READ_MCP_NAME,
      (selfId, params, options) => {
        return createDriveReadMcpServer(selfId, deps.driveClients, {
          allowedFolders: params,
          onRead: deps.onDriveRead,
          isFenced: options?.isFenced,
        });
      },
    ],
  ]);
  if (deps.chatClient) {
    map.set(CHAT_WRITE_MCP_NAME, (selfId, params, options) => {
      // params are e.g. ["spaces/AAAA", "spaces/BBBB"] from "chat-write:spaces/AAAA" etc.
      // Or if they were granted "*", we can support that, though typically spaces are passed.
      const allowedSpaces = params.map((p) => (p.startsWith("spaces/") ? p : `spaces/${p}`));
      if (!deps.chatClient) throw new Error("chatClient is required for chat-write capability");
      const workDir = deps.actorRootFor?.(selfId);
      return createChatWriteMcpServer(selfId, deps.chatClient, {
        allowedSpaces,
        onWrite: deps.onChatWrite,
        isFenced: options?.isFenced,
        ...(workDir ? { workDir } : {}),
      });
    });
  }
  return map;
}

/**
 * Mount the MCP servers represented by an actor's active grants. Parameterized
 * grants share one endpoint per base capability, with every parameter passed to
 * that endpoint's factory. Re-adding an existing server replaces its factory
 * while preserving its URL, so a live actor's next provider run gets the newly
 * widened capability without disrupting an in-flight transport.
 */
export function mountGrantedServers(
  actorId: string,
  activeCapabilities: readonly string[],
  grantableServers: Map<string, GrantableServerFactory>,
  mcpHttp: {
    addServer: (name: string, factory: () => McpServer) => string;
  },
  options?: { isFenced?: (actorId: string) => boolean }
): McpServerSpec[] {
  const baseToParams = new Map<string, string[]>();
  for (const capability of activeCapabilities) {
    const parts = capability.split(":");
    const baseCapability = parts[0];
    const param = parts.length > 1 ? parts.slice(1).join(":") : undefined;
    if (!baseToParams.has(baseCapability)) baseToParams.set(baseCapability, []);
    if (param !== undefined) {
      const params = baseToParams.get(baseCapability);
      if (params) params.push(param);
    }
  }

  const mounted: McpServerSpec[] = [];
  for (const [baseCapability, params] of baseToParams.entries()) {
    const factory = grantableServers.get(baseCapability);
    if (!factory) continue;
    const isFenced = options?.isFenced;
    const url = mcpHttp.addServer(`${actorId}:${baseCapability}`, () => {
      const opts = isFenced ? { isFenced: () => isFenced(actorId) } : undefined;
      return opts ? factory(actorId, params, opts) : factory(actorId, params);
    });
    mounted.push({ name: baseCapability, url });
  }
  return mounted;
}

const revokeMutexes = new Map<string, Promise<void>>();

/**
 * Handles capability revocation by unmounting or re-mounting the grantable server.
 * This ensures that active transports are closed when capabilities narrow.
 */
export async function handleCapabilityRevoked(
  actorId: string,
  capability: string,
  getActiveCapabilities: () => string[],
  grantableServers: Map<string, GrantableServerFactory>,
  mcpHttp: {
    removeServer: (name: string) => Promise<void>;
    addServer: (name: string, factory: () => McpServer) => string;
  }
): Promise<void> {
  const currentLock = revokeMutexes.get(actorId) ?? Promise.resolve();
  const nextLock = currentLock.then(async () => {
    let baseCapability = capability;
    if (capability.startsWith("chat-write:")) {
      baseCapability = "chat-write";
    } else if (capability.startsWith("calendar-read:")) {
      baseCapability = "calendar-read";
    } else if (capability.startsWith("calendar-write:")) {
      baseCapability = "calendar-write";
    } else if (capability.startsWith("email-send:")) {
      baseCapability = "email-send";
    } else if (capability.startsWith("drive-read:")) {
      baseCapability = "drive-read";
    }

    if (
      baseCapability === "chat-write" ||
      baseCapability === "calendar-read" ||
      baseCapability === "calendar-write" ||
      baseCapability === "email-send" ||
      baseCapability === "drive-read"
    ) {
      const prefix = `${baseCapability}:`;
      const activeGrants = getActiveCapabilities().filter((c) => c.startsWith(prefix));
      if (activeGrants.length === 0) {
        await mcpHttp.removeServer(`${actorId}:${baseCapability}`);
      } else {
        const params = activeGrants
          .map((c) => {
            const parts = c.split(":");
            return parts.length > 1 ? parts.slice(1).join(":") : undefined;
          })
          .filter((s): s is string => s !== undefined);
        const factory = grantableServers.get(baseCapability);
        if (factory) {
          await mcpHttp.removeServer(`${actorId}:${baseCapability}`);
          mcpHttp.addServer(`${actorId}:${baseCapability}`, () => factory(actorId, params));
        }
      }
    } else {
      await mcpHttp.removeServer(`${actorId}:${capability}`);
    }
  });

  const safeLock = nextLock.catch(() => {});
  revokeMutexes.set(actorId, safeLock);
  safeLock.finally(() => {
    if (revokeMutexes.get(actorId) === safeLock) {
      revokeMutexes.delete(actorId);
    }
  });
  await nextLock;
}
