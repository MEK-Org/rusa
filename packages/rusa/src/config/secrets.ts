import { lstatSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";

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

/**
 * Containment validation for generic read-only secret capability grants (issue #542).
 *
 * Requirements:
 * 1. The filename must resolve to a regular file directly inside the secrets directory.
 * 2. Reject path traversal (e.g. "..", path separators).
 * 3. Reject absolute paths.
 * 4. Reject missing or unknown files (fail loudly at grant time).
 * 5. Reject symlinks that escape the secrets directory.
 * 6. Reject non-regular files (directories, sockets, devices, fifos).
 *
 * Throws an Error with an actionable message on any containment failure.
 * Returns the resolved canonical path to the regular file.
 */
export function assertSecretContainment(filename: string, secretsDir: string): string {
  if (!filename || typeof filename !== "string" || !filename.trim()) {
    throw new Error("secret filename is required");
  }
  if (isAbsolute(filename) || filename.startsWith("/") || filename.startsWith("\\")) {
    throw new Error(`secret filename must not be an absolute path: "${filename}"`);
  }
  // The rule is exactly "a plain basename": no `.`/`..` component and no
  // separator, which is what makes traversal impossible. (Two dots INSIDE a
  // name, e.g. `foo..bar`, are an ordinary filename and are allowed.)
  if (filename === "." || filename === ".." || filename.includes("/") || filename.includes("\\")) {
    throw new Error(`path traversal is not allowed in secret filename: "${filename}"`);
  }
  if (basename(filename) !== filename) {
    throw new Error(`secret filename must be directly inside the secrets directory: "${filename}"`);
  }

  // One syscall decides whether the directory is there: `realpathSync` throws
  // for a missing (or unreadable) directory, and that is reported as the
  // secret file not existing — the caller asked about a file, not about the
  // directory layout.
  let realSecretsDir: string;
  try {
    realSecretsDir = realpathSync(secretsDir);
  } catch {
    throw new Error(
      `secret file does not exist: "${filename}" (secrets directory not found: "${secretsDir}")`
    );
  }

  const filePath = join(realSecretsDir, filename);

  try {
    lstatSync(filePath);
  } catch {
    throw new Error(`secret file does not exist: "${filename}"`);
  }

  let realFilePath: string;
  try {
    realFilePath = realpathSync(filePath);
  } catch {
    throw new Error(`secret file does not exist or broken symlink: "${filename}"`);
  }

  if (dirname(realFilePath) !== realSecretsDir) {
    throw new Error(`secret symlink escapes secrets directory: "${filename}" -> "${realFilePath}"`);
  }

  const st = statSync(realFilePath);
  if (!st.isFile()) {
    throw new Error(`secret must resolve to a regular file: "${filename}"`);
  }

  return realFilePath;
}
