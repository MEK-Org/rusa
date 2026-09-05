import type { RusaConfig } from "../config/types.js";
import { MIN_SCRUBBABLE_SECRET_LENGTH } from "./logger.js";

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

/**
 * One credential and where it came from. The source is carried so a credential
 * the scrubber cannot handle can be reported by name; the value never leaves
 * this module except into the logger's scrub set.
 */
export interface SecretSource {
  /** Config key or environment variable the value came from. */
  source: string;
  value: string;
}

function push(into: SecretSource[], source: string, value: string | undefined | null): void {
  const trimmed = value?.trim();
  if (trimmed) into.push({ source, value: trimmed });
}

function values(entries: readonly SecretSource[]): string[] {
  return [...new Set(entries.map((entry) => entry.value))];
}

/** Credential values reachable from the environment, with their variable names. */
export function collectEnvSecretEntries(env: NodeJS.ProcessEnv = process.env): SecretSource[] {
  const entries: SecretSource[] = [];
  for (const name of SECRET_ENV_VARS) push(entries, name, env[name]);
  return entries;
}

/** Credential values reachable from the environment. */
export function collectEnvSecrets(env: NodeJS.ProcessEnv = process.env): string[] {
  return values(collectEnvSecretEntries(env));
}

/**
 * Credential values carried in the parsed config. Callers register these as
 * soon as `loadConfig` returns; records written before that are covered by
 * {@link collectEnvSecrets} alone.
 */
export function collectConfigSecretEntries(config: RusaConfig): SecretSource[] {
  const entries: SecretSource[] = [];
  push(entries, "geminiApiKey", config.geminiApiKey);
  push(entries, "mistralApiKey", config.mistralApiKey);
  push(entries, "webhook.secret", config.webhook?.secret);
  return entries;
}

/** Credential values carried in the parsed config. */
export function collectConfigSecrets(config: RusaConfig): string[] {
  return values(collectConfigSecretEntries(config));
}

/**
 * The registered credentials too short for the scrubber to remove from free
 * text — see {@link MIN_SCRUBBABLE_SECRET_LENGTH}.
 *
 * Value redaction has a floor, and a floor is a gap. Rather than document the
 * gap and leave it silent, the caller reports each one at boot so an operator
 * learns that this particular credential is not protected outside a
 * credential-named field, while it is still cheap to lengthen it. Only the
 * source name and the length are returned; the value stays here.
 */
export function unscrubbableSecretSources(
  entries: readonly SecretSource[]
): { source: string; length: number }[] {
  const reported = new Set<string>();
  const short: { source: string; length: number }[] = [];
  for (const { source, value } of entries) {
    if (value.length >= MIN_SCRUBBABLE_SECRET_LENGTH) continue;
    if (reported.has(source)) continue;
    reported.add(source);
    short.push({ source, length: value.length });
  }
  return short;
}
