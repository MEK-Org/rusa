/**
 * The one place this process decides which directory holds the Codex login
 * (#782). `providers.codex.home` names a dedicated directory, so a canary can
 * run on its own login without moving anything else under the user's home.
 * Unset, everything keeps `~/.codex`.
 *
 * Every host-side consumer resolves through here: the auth broker, worker
 * launch, the `/status` and `/model` probes, the quota coordinator, and the
 * actor, host-job and E2E sandboxes that hide the login.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import type { RusaConfig } from "../config/types.js";

let configuredHome: string | undefined;

/** `providers.codex.home` from a loaded config (the loader has validated it). */
export function codexHomeFromConfig(config: Pick<RusaConfig, "providers">): string | undefined {
  return config.providers?.codex?.home;
}

/** Set this process's Codex home, once at boot from config. `undefined` restores the default. */
export function configureCodexHome(home: string | undefined): void {
  configuredHome = home;
}

/** The configured Codex home, or `undefined` when the default `~/.codex` applies. */
export function configuredCodexHome(): string | undefined {
  return configuredHome;
}

/** The directory holding the canonical Codex login: the configured home, else `<hostHome>/.codex`. */
export function codexHomeDir(hostHome: string = homedir()): string {
  return configuredHome ?? join(hostHome, ".codex");
}
