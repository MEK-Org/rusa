/**
 * Process-local assertion emitted by a supported launcher. It deliberately
 * establishes an operator contract, not an OS-attested supervisor guarantee.
 */
export const START_FOLLOWER_UPDATE_LAUNCHER_ENV = "RUSA_START_FOLLOWER_UPDATE_LAUNCHER";
export const START_FOLLOWER_UPDATE_LAUNCHER_VERSION = "v1";

export function hasSupportedStartFollowerLauncherContract(): boolean {
  return process.env[START_FOLLOWER_UPDATE_LAUNCHER_ENV] === START_FOLLOWER_UPDATE_LAUNCHER_VERSION;
}
