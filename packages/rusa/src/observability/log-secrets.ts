import type { RusaConfig } from "../config/types.js";

/**
 * The credential values a running instance holds, gathered so the logger can
 * scrub them out of any record — including out of an error message or stack
 * frame that interpolated one by accident.
 *
 * This is deliberately a *value* list rather than a field allowlist. Field-path
 * redaction only protects the shapes someone predicted; a token that reaches a
 * `fetch` failure message reaches it through a path nobody enumerated.
 */

/**
 * Environment variables holding a credential. Read once at logger construction,
 * before any config file has been parsed, so the earliest records are covered.
 */
export const SECRET_ENV_VARS: readonly string[] = [
  "GEMINI_API_KEY",
  "RUSA_GEMINI_API_KEY",
  "MISTRAL_API_KEY",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "NODE_AUTH_TOKEN",
  "GLASS_GOALS_PASSWORD",
];

function push(into: Set<string>, value: string | undefined | null): void {
  const trimmed = value?.trim();
  if (trimmed) into.add(trimmed);
}

/** Credential values reachable from the environment. */
export function collectEnvSecrets(env: NodeJS.ProcessEnv = process.env): string[] {
  const secrets = new Set<string>();
  for (const name of SECRET_ENV_VARS) push(secrets, env[name]);
  return [...secrets];
}

/**
 * Credential values carried in the parsed config. Callers register these as
 * soon as `loadConfig` returns; records written before that are covered by
 * {@link collectEnvSecrets} alone.
 */
export function collectConfigSecrets(config: RusaConfig): string[] {
  const secrets = new Set<string>();
  push(secrets, config.geminiApiKey);
  push(secrets, config.mistralApiKey);
  push(secrets, config.webhook?.secret);
  return [...secrets];
}
