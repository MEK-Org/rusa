import { join } from "node:path";
import openBrowser from "open";
import { HaltSwitch } from "../actor/halt-switch.js";
import { resolveRootHandle } from "../actor/handle-generator.js";
import { loadConfig, type RusaConfig, resolveHome } from "../config/index.js";
import { MeshEventEmitter } from "../dashboard/mesh-event-emitter.js";
import { getRepositories, initDb } from "../db/index.js";
import { importLegacyActorState } from "../db/legacy-actor-import.js";
import { providerCapabilityName } from "../providers/registry.js";
import { ReferenceCacheService } from "../references/cache-service.js";
import { startDashboardServer } from "../webhook/server.js";

/**
 * Launch the standalone dashboard: serve the Flutter UI plus the read-only mesh
 * Data API + SSE backed by the persisted actor repository and `mesh_events` db.
 * Unlike `rusa start`, no mesh runs in this process, so there is no live
 * model output — the stream only carries events written by a separate running
 * mesh against the same home (mostly historical viewing). `start`/`dev` serve
 * the same dashboard with live data.
 */
export async function runDashboard(): Promise<void> {
  const mcHome = resolveHome();

  console.log(`
🚀 Rusa Dashboard v0.1.0
${"━".repeat(26)}
`);
  console.log(`Loading config from ${mcHome}/config.yaml`);

  let config: RusaConfig;
  try {
    config = loadConfig(mcHome);
  } catch (err) {
    console.error(`❌ ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
    return;
  }

  const dashboardPort = config.dashboard?.port ?? 8080;
  const dashboardBindHost = config.dashboard?.bindHost ?? "127.0.0.1";
  // Open the persisted database so the Data API serves real mesh data.
  const database = initDb(mcHome);
  importLegacyActorState({
    mcHome,
    db: database,
    repositories: getRepositories(),
    providerCapabilityName: (providerName) => providerCapabilityName(providerName, config),
  });
  // No provider clients run in this process, but the repository-backed cache
  // still serves fresh/stale rows a live `rusa start` process persisted.
  const referenceCache = new ReferenceCacheService({
    repo: getRepositories().referenceCache,
    logger: {
      info: (event, data) =>
        console.log(`[reference-cache] ${event}`, data ? JSON.stringify(data) : ""),
      error: (event, data) =>
        console.warn(`[reference-cache] error: ${event}`, data ? JSON.stringify(data) : ""),
    },
  });
  const actors = getRepositories().actors;
  const rootRecord = actors.list().find((record) => record.parentId === null);
  // The HALT sentinel is a plain file against the same home, so this read-only
  // viewer can surface the halt state even though no mesh runs in this process.
  const haltSwitch = new HaltSwitch(join(mcHome, "HALT"));
  const dashboardServer = await startDashboardServer({
    port: dashboardPort,
    bindHost: dashboardBindHost,
    mesh: {
      actors,
      meshEvents: getRepositories().meshEvents,
      meshChat: getRepositories().meshChat,
      obligations: getRepositories().obligations,
      referenceCache,
      // No mesh runs here, so this emitter never fires live_output; it exists so
      // the SSE endpoint is available (it will carry events only if this process
      // recorded them, which it does not — viewing is via the JSON endpoints).
      emitter: new MeshEventEmitter(),
      // Read-only: stat the shared HALT sentinel. No live actors here, so
      // `runningThreadIds` is intentionally omitted → every thread reads idle.
      isHalted: () => haltSwitch.hasActiveHalt(),
      geminiApiKey: config.geminiApiKey,
      rootIdentity: {
        id: rootRecord?.id,
        handle: resolveRootHandle(config),
        avatarPath: config.rootActor?.avatar,
      },
    },
    dashboardConfig: { quotaProviders: config.dashboard?.quotaProviders },
    iuReportsApi: { mcHome },
  });

  const tailscaleHostname = config.dashboard?.tailscaleHostname;
  const dashboardUrl = tailscaleHostname
    ? `https://${tailscaleHostname}`
    : `http://${dashboardBindHost === "0.0.0.0" || dashboardBindHost === "127.0.0.1" ? "localhost" : dashboardBindHost}:${dashboardPort}`;
  console.log(`
Dashboard available at ${dashboardUrl}`);

  await openBrowser(dashboardUrl);

  const shutdown = async () => {
    console.log(`
🛑 Shutting down dashboard...`);
    try {
      await dashboardServer.close();
      console.log("✓ Dashboard server closed. Goodbye!");
    } catch {
      // Server may already be closed
    }
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}
