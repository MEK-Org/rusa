import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * The host secrets directory: `$RUSA_HOME/secrets/` (0700), one file per
 * secret (0600) — see ISSUE_NUM. Rotation = replace a file. The sandbox tmpfs-masks
 * this WHOLE directory for every sandboxed worker (nothing in it is
 * worker-legitimate by default); a granted secret is ro-bound back over its
 * masked path, so the in-sandbox path of a granted secret is the SAME
 * well-known path as on the host (e.g. `$RUSA_HOME/secrets/gemini-api-key`).
 */
export const SECRETS_DIRNAME = "secrets";

/** Secret file consumed into `config.geminiApiKey` (wins over the inline key). */
export const GEMINI_API_KEY_SECRET_FILENAME = "gemini-api-key";
/** Secret file consumed into `config.mistralApiKey` (wins over the inline key). */
export const MISTRAL_API_KEY_SECRET_FILENAME = "mistral-api-key";
/** Secret file consumed into `config.webhook.secret` (wins over the inline value). */
export const WEBHOOK_SECRET_FILENAME = "webhook-secret";
/** Secret file replacing the `.env` `GLASS_GOALS_PASSWORD` (file preferred, env fallback). */
export const GLASS_GOALS_PASSWORD_SECRET_FILENAME = "glass-goals-password";

/**
 * Resolve the rusa home directory.
 * Priority: RUSA_HOME env var > ~/.rusa
 */
export function resolveHome(): string {
  return process.env.RUSA_HOME ?? join(homedir(), ".rusa");
}

/** The host secrets directory path for `mcHome` (defaults to {@link resolveHome}). */
export function secretsDirPath(mcHome?: string): string {
  return join(mcHome ?? resolveHome(), SECRETS_DIRNAME);
}

/**
 * Read a host secret from `$RUSA_HOME/secrets/<name>`: trimmed contents,
 * or `undefined` when the file is missing/unreadable/empty. Never throws and
 * never logs the value.
 */
export function readHostSecret(name: string, mcHome?: string): string | undefined {
  try {
    const value = readFileSync(join(secretsDirPath(mcHome), name), "utf-8").trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Write a host secret to `$RUSA_HOME/secrets/<name>` (dir 0700, file
 * 0600). Returns the file path (for operator-facing logs — callers must never
 * log the value).
 */
export function writeHostSecret(name: string, value: string, mcHome?: string): string {
  const dir = secretsDirPath(mcHome);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, name);
  writeFileSync(path, `${value}\n`, { mode: 0o600 });
  return path;
}

/**
 * The glass-goals password, preferring the secrets file and falling back to the
 * legacy `GLASS_GOALS_PASSWORD` env var (loaded from `.env` by older installs).
 * `undefined` when neither source has a value — callers keep their existing
 * fail-soft behavior.
 */
export function resolveGlassGoalsPassword(mcHome?: string): string | undefined {
  return (
    readHostSecret(GLASS_GOALS_PASSWORD_SECRET_FILENAME, mcHome) ??
    (process.env.GLASS_GOALS_PASSWORD || undefined)
  );
}
