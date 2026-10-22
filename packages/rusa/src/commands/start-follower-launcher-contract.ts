/**
 * Process-local assertion emitted by a supported launcher. It deliberately
 * establishes an operator contract, not an OS-attested supervisor guarantee.
 */
export const START_FOLLOWER_UPDATE_LAUNCHER_ENV = "RUSA_START_FOLLOWER_UPDATE_LAUNCHER";
export const START_FOLLOWER_UPDATE_LAUNCHER_VERSION = "v1";

/**
 * Read the assertion once and remove it, so only the process the launcher
 * started holds it; children spawned from `process.env` never inherit it.
 */
export function consumeSupportedStartFollowerLauncherContract(): boolean {
  const value = process.env[START_FOLLOWER_UPDATE_LAUNCHER_ENV];
  delete process.env[START_FOLLOWER_UPDATE_LAUNCHER_ENV];
  return value === START_FOLLOWER_UPDATE_LAUNCHER_VERSION;
}
