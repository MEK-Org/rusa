import { execFileSync, execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  CAPABILITY_GRANTS_FILENAME,
  FileCapabilityGrantStore,
} from "../actor/capability-grants.js";
import { hostJobAuditArtifactDir } from "../actor/host-job-audit-artifact.js";
import { loadConfig } from "../config/loader.js";
import { SECRETS_DIRNAME } from "../config/secrets.js";

export type SandboxAuthMode = "copilot" | "claude" | "codex" | "antigravity" | "kimi";

export interface ActorBwrapResult {
  args: string[];
  commandPrefix: string[];
  tempPaths: string[];
}
const THKP_NPM_REGISTRY = "https://registry.npmjs.org/";
export const SANDBOX_SCOPED_NPMRC_PATH = "/tmp/rusa-npmrc";
const PNPM_STORE_VERSION = "v10";

let _pnpmStorePath: string | null = null;
export function resolvePnpmStorePath(): string {
  if (!_pnpmStorePath || process.env.NODE_ENV === "test") {
    _pnpmStorePath = alignPnpmStorePath(execSync("pnpm store path", { encoding: "utf8" }).trim());
  }
  return _pnpmStorePath;
}

function alignPnpmStorePath(storePath: string): string {
  const version = basename(storePath);
  if (version && /^v\d+$/.test(version) && version !== PNPM_STORE_VERSION) {
    return join(dirname(storePath), PNPM_STORE_VERSION);
  }
  return storePath;
}

export function assertBwrapAvailable(): void {
  try {
    execFileSync("bwrap", ["--version"], { stdio: "pipe" });
  } catch {
    throw new Error(
      "bubblewrap (bwrap) is required but not installed. " +
        "Install it before starting the rusa service (e.g. apt install bubblewrap)."
    );
  }

  // Guard: Probe that a login shell inside the sandbox (invoked with bash -lc)
  // is capable of running `node` and `pnpm`. Without this, the worker's shell
  // will fail to resolve build toolchain executables due to path resetting.
  try {
    const tempDir = mkdtempSync(join(tmpdir(), "mc-bwrap-probe-"));
    try {
      const result = buildActorBwrapArgs(tempDir);
      execFileSync(
        "bwrap",
        buildActorBwrapCommand(result, "/bin/bash", ["-lc", "node --version && pnpm --version"]),
        { stdio: "pipe" }
      );
    } finally {
      teardownFlutterOverlay(tempDir);
      rmSync(tempDir, { recursive: true, force: true });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Bubblewrap sandbox health check failed: node or pnpm is not available inside a login shell (bash -lc). ` +
        `This usually indicates a toolchain path mapping issue or profile-wiped PATH. Details: ${msg}`
    );
  }
}

let _nodePath: string | null = null;
function getNodePath(): string {
  if (!_nodePath) {
    _nodePath = realpathIfExists(execSync("which node", { encoding: "utf8" }).trim());
  }
  return _nodePath;
}

let _corepackPath: string | null = null;
export function getCorepackPath(): string {
  if (!_corepackPath) {
    _corepackPath = execSync("which corepack", { encoding: "utf8" }).trim();
  }
  return _corepackPath;
}

let _pnpmPath: string | null = null;
function getPnpmPath(): string {
  if (!_pnpmPath) {
    _pnpmPath = execSync("which pnpm", { encoding: "utf8" }).trim();
  }
  return _pnpmPath;
}

/** Exported for reuse by the host-jobs runner  — one PATH-resolution seam. */
export function buildToolchainPath(): string {
  const entries = [
    dirname(getNodePath()),
    dirname(getCorepackPath()),
    dirname(getPnpmPath()),
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    ...(process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin").split(":"),
  ];
  return [...new Set(entries.filter((entry) => entry.length > 0))].join(":");
}

let _ghConfigPath: string | null = null;
function getGhConfigPath(): string {
  if (!_ghConfigPath) {
    _ghConfigPath = join(getHostConfigDir(), "gh");
  }
  return _ghConfigPath;
}

function getHostHomeDir(): string {
  return process.env.HOME ?? "/root";
}

function getHostConfigDir(): string {
  return process.env.XDG_CONFIG_HOME ?? join(getHostHomeDir(), ".config");
}

function getCopilotHomeConfigPath(): string {
  return join(getHostHomeDir(), ".copilot");
}

function getCopilotXdgConfigPaths(): string[] {
  const configDir = getHostConfigDir();
  return [join(configDir, "github-copilot"), join(configDir, "copilot")];
}

const SANDBOX_HOME = "/tmp/rusa-home";

/**
 * Fixed in-sandbox path a claude worker reads its `--mcp-config` from . The
 * host source lives in `tmpdir()` (shadowed from every sibling by their own
 * `--tmpfs /tmp`, so no cross-actor token harvest) and is `--ro-bind`-ed here for
 * the owning sandbox to read. It sits on the owner's private tmpfs `/tmp`, so it
 * is invisible to siblings too. claude.ts passes this same constant as the
 * `--mcp-config` argument when sandboxed.
 */
export const SANDBOX_MCP_CONFIG_PATH = "/tmp/rusa-mcp-config.json";
export const SANDBOX_KIMI_MCP_CONFIG_PATH = "/tmp/kimi-home/mcp.json";

/**
 * In-sandbox path codex writes its session rollouts to: `$CODEX_HOME/sessions`,
 * and CODEX_HOME is pinned to `/tmp` (ISSUE_NUM's EROFS fix).
 */
const SANDBOX_CODEX_SESSIONS_PATH = "/tmp/sessions";

/**
 * Per-actor host directory that persists a codex actor's session rollouts ACROSS
 * wakes . Lives on host `/tmp` — shadowed from every sibling by their own
 * `--tmpfs /tmp` (the ISSUE_NUM/ISSUE_NUM sibling-shadow property), so a sibling codex
 * actor cannot read another's conversation — and `--bind`-ed into the owner's
 * sandbox at {@link SANDBOX_CODEX_SESSIONS_PATH}. Unlike the auth temp (a secret,
 * copy-and-discarded per run), this is the actor's MEMORY: it is deliberately
 * NOT swept on run-end, retire, or boot, giving codex revive/redeploy continuity
 * parity with claude's persistent `~/.claude`. Only an actual machine reboot
 * clears it (host `/tmp`), after which the dangling registry sessionId falls back
 * to a fresh run (handled in codex.ts). Keyed by the actor id (= dir basename),
 * matching the `rusa-auth-codex-<id>` convention.
 */
export function codexRolloutStoreDir(actorDir: string): string {
  return join("/tmp", `rusa-codex-sessions-${basename(realpathIfExists(actorDir))}`);
}

/**
 * Per-actor host directory that persists a kimi actor's session store ACROSS
 * invocations and wakes (ISSUE_NUM + follow-up), mirroring {@link codexRolloutStoreDir}.
 * kimi (0.23.6) keeps its session transcripts under `$KIMI_CODE_HOME/sessions` AND a
 * sibling `$KIMI_CODE_HOME/session_index.jsonl` that maps a session id to its workdir
 * bucket; `kimi -r <id>` reads the index to resolve the id before scanning the bucket.
 * KIMI_CODE_HOME is pinned to the per-invocation sandbox tmpfs `/tmp/kimi-home`, so both
 * vanished when each invocation's bwrap exited and a later `kimi -r <id>` resume failed
 * with `Session "<id>" not found` — breaking every multi-turn sandboxed kimi actor.
 * ISSUE_NUM persisted `sessions/` alone, but the id->bucket lookup reads the sibling index
 * first, so resume still failed until the index is persisted too (isolated by the
 * provider-agnostic-context steward's real-`-r` E2E). This dir holds the whole persistent
 * slice — a `sessions/` subdir and `session_index.jsonl` — laid out like KIMI_CODE_HOME so
 * each can be `--bind`-ed into place. It lives on host `/tmp` (shadowed from every sibling
 * by their own `--tmpfs /tmp`, so a sibling kimi actor cannot read another's transcript).
 * Like the codex rollout store — and unlike the per-run auth copies (credentials/oauth,
 * copy-and-discard) — this is the actor's MEMORY: NOT swept on run-end/retire/redeploy,
 * only a host reboot clears it (host `/tmp`). Keyed by actor id (= dir basename).
 */
export function kimiSessionStoreDir(actorDir: string): string {
  return join("/tmp", `rusa-kimi-sessions-${basename(realpathIfExists(actorDir))}`);
}

/**
 * Subdirectory of `$RUSA_HOME` holding the synthesized worker-scoped gh
 * config (see {@link syncWorkerGhConfigDir}). Distinct from the host's real
 * gh config dir — never confuse the two.
 */
const WORKER_GH_CONFIG_DIRNAME = "worker-gh";

/**
 * Filename quickstart/operators use for the host's write-capable classic
 * token (see docs/quickstart.md "GitHub Token Resolution Order" and
 * `issue-client.ts`'s `resolveToken`). Sandboxed workers must never see this
 * file once `github.workerTokenPath` is configured — see
 * {@link injectWorkerGithubCredential}.
 */
const HOST_WRITE_TOKEN_FILENAME = "github-token";

let _workerGhVisibilityLogged = false;

/**
 * Best-effort `user` field for the synthesized hosts.yml. Purely cosmetic —
 * gh CLI uses it for display only; the `oauth_token` is what actually
 * authenticates — so a resolution failure here is not a security concern.
 * Read from the host's real gh hosts.yml so this stays account-portable
 * instead of a hardcoded persona name.
 */
function resolveWorkerGhUser(): string {
  try {
    const hostHostsPath = join(getGhConfigPath(), "hosts.yml");
    if (existsSync(hostHostsPath)) {
      const parsed = parseYaml(readFileSync(hostHostsPath, "utf8")) as
        | Record<string, { user?: string }>
        | undefined;
      const user = parsed?.["github.com"]?.user;
      if (typeof user === "string" && user.trim()) return user.trim();
    }
  } catch {
    // Best effort — the field is cosmetic; fall through to the placeholder.
  }
  return "rusa-worker";
}

const moduleDir = dirname(fileURLToPath(import.meta.url));

/**
 * Resolve the path to the gh failure-hint wrapper script .
 * Checks source and bundled paths relative to the current module.
 */
export function resolveGhWrapperScriptPath(): string | null {
  const candidates = [
    resolve(moduleDir, "../../scripts/gh-hint-wrapper.sh"),
    resolve(moduleDir, "../scripts/gh-hint-wrapper.sh"),
    resolve(moduleDir, "scripts/gh-hint-wrapper.sh"),
    resolve(moduleDir, "gh-hint-wrapper.sh"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

/**
 * Synthesize (refreshed on every sandboxed-worker spawn, so a rotated PAT
 * takes effect on the actor's next run with no service restart) the
 * worker-scoped gh config dir at `<mcHome>/worker-gh/`: a `hosts.yml`
 * carrying ONLY the read-mostly fine-grained PAT, plus a minimal `config.yml`
 * — shaped like what `gh auth login --with-token` writes (inspected from the
 * host's real `~/.config/gh/`, never logged or committed). `--ro-bind`-ed
 * over the sandbox's `~/.config/gh` by {@link injectWorkerGithubCredential}.
 * The token value is never written to a log or thrown into an Error message.
 */
function syncWorkerGhConfigDir(mcHome: string, tokenPath: string): string {
  const token = readFileSync(tokenPath, "utf8").trim();
  if (!token) {
    throw new Error(
      `github.workerTokenPath ("${tokenPath}") is empty. Refusing to spawn sandboxed actors ` +
        "with no worker GitHub credential (fail-closed — see ISSUE_NUM's boot-gate precedent: a " +
        "silent fallback to the host's write-capable token would defeat the credential split)."
    );
  }

  const configDir = join(mcHome, WORKER_GH_CONFIG_DIRNAME);
  mkdirSync(configDir, { recursive: true, mode: 0o700 });

  const user = resolveWorkerGhUser();
  writeFileSync(
    join(configDir, "hosts.yml"),
    stringifyYaml({
      "github.com": {
        user,
        oauth_token: token,
        git_protocol: "https",
        users: { [user]: { oauth_token: token } },
      },
    }),
    { mode: 0o600 }
  );
  writeFileSync(
    join(configDir, "config.yml"),
    stringifyYaml({
      git_protocol: "https",
      editor: "",
      // Sandboxed workers are non-interactive by construction (CI=1,
      // GIT_TERMINAL_PROMPT=0 above) — disable gh's own interactive prompts too
      // so a stray `gh` invocation fails fast instead of hanging.
      prompt: "disabled",
      pager: "",
      http_unix_socket: "",
      browser: "",
      version: "1",
    }),
    { mode: 0o600 }
  );

  const wrapperScript = resolveGhWrapperScriptPath();
  if (wrapperScript) {
    const binDir = join(configDir, "bin");
    mkdirSync(binDir, { recursive: true, mode: 0o755 });
    const wrapperDest = join(binDir, "gh");
    copyFileSync(wrapperScript, wrapperDest);
    chmodSync(wrapperDest, 0o755);
  }

  return configDir;
}

/**
 * GitHub credential split for sandboxed workers (opt-in via
 * `github.workerTokenPath`, ISSUE_NUM/ISSUE_NUM-adjacent). Called only for real
 * worker actors — see the `basename(actorParent) === "workers"` guard at the
 * call site — never for root (unsandboxed in production) or the E2E
 * `root-agent` sandboxed test double, so root behavior is untouched either
 * way.
 *
 * Unset: no-op, but logs once, loudly, so the exposure is visible in the
 * service log even when nobody reads the config doc comment.
 *
 * Set: binds a synthesized gh config carrying ONLY the read-mostly PAT over
 * the sandbox's `~/.config/gh` (so `gh` and `gh auth git-credential` — which
 * `~/.gitconfig` routes git push through — resolve the scoped token), scrubs
 * `GH_TOKEN`/`GITHUB_TOKEN` (they would override hosts.yml resolution in both
 * gh CLI and `issue-client.ts`'s `resolveToken`), and shadows the host's
 * write-capable token file out of the sandbox's read scope. A configured but
 * missing PAT file is fail-closed: throws rather than silently leaving the
 * sandbox on the host credential.
 */
function injectWorkerGithubCredential(args: string[], mcHome: string): string | undefined {
  let workerTokenPath: string | undefined;
  try {
    workerTokenPath = loadConfig().github.workerTokenPath;
  } catch {
    // Config not found/invalid — default to inert/no-op, matching
    // injectGitBridgeEnv's discipline below. In production this is
    // unreachable: the service already loaded config successfully at start.ts
    // boot before any actor could spawn.
  }

  if (!workerTokenPath) {
    if (!_workerGhVisibilityLogged) {
      _workerGhVisibilityLogged = true;
      console.warn(
        "[sandbox] github.workerTokenPath is not set: sandboxed workers see the host's " +
          "real GitHub credential (full write scope). Set github.workerTokenPath to a " +
          "read-mostly fine-grained PAT file to scope worker GitHub access down — see " +
          "docs/quickstart.md."
      );
    }
    return undefined;
  }

  if (!existsSync(workerTokenPath)) {
    throw new Error(
      `github.workerTokenPath is set to "${workerTokenPath}" but that file does not exist. ` +
        "Refusing to spawn sandboxed actors (fail-closed — see ISSUE_NUM's boot-gate precedent): " +
        "silently falling back to the host's write-capable token would defeat the credential " +
        "split. Place the read-only PAT file at that path (mode 0600), or unset " +
        "github.workerTokenPath to explicitly accept the host-credential exposure."
    );
  }

  const realHome = getHostHomeDir();
  const workerGhConfigDir = syncWorkerGhConfigDir(mcHome, workerTokenPath);
  args.push("--ro-bind", workerGhConfigDir, join(realHome, ".config", "gh"));

  args.push("--unsetenv", "GH_TOKEN");
  args.push("--unsetenv", "GITHUB_TOKEN");

  // The host's write-capable classic token file (if any) is otherwise visible
  // to the sandbox via the broad `--ro-bind / /` sweep at the top of this
  // function — shadow just that file with /dev/null rather than tmpfs'ing the
  // whole mcHome dir (which would also hide config.yaml and sibling worker
  // dirs this actor legitimately needs to read). Same file-granularity shadow
  // discipline as the host-job audit-artifact tmpfs above, one level narrower.
  const hostWriteTokenPath = join(mcHome, HOST_WRITE_TOKEN_FILENAME);
  if (existsSync(hostWriteTokenPath)) {
    args.push("--ro-bind", "/dev/null", hostWriteTokenPath);
  }

  // Intercept gh write failures with failure-hint wrapper
  const workerGhBin = join(workerGhConfigDir, "bin", "gh");
  if (existsSync(workerGhBin)) {
    const sandboxGhWrapperDir = "/tmp/gh-wrapper/bin";
    args.push("--dir", "/tmp/gh-wrapper");
    args.push("--dir", sandboxGhWrapperDir);
    args.push("--ro-bind", workerGhBin, `${sandboxGhWrapperDir}/gh`);
    return sandboxGhWrapperDir;
  }

  return undefined;
}

/**
 * Google user-OAuth token shadow for sandboxed workers . The codebase
 * centralizes all Google user tokens (Chat, Gmail, Drive, Calendar) under the
 * single `~/.config/gchat` directory, so that is the only host path we shadow.
 * Workers have no legitimate need for raw Google tokens; chat/calendar/drive
 * access is mediated by capability-gated MCP servers on the host plane.
 *
 * We `--tmpfs`-shadow the directory after ensuring the mount point exists. This
 * hides any real `token.json`, `client.json`, `gmail-token.json`,
 * `drive-token.json`, `calendar-token.json`, etc. from the sandbox. It is
 * fail-closed in the sense that a bwrap failure to apply the shadow aborts the
 * spawn; there is no opt-out or fallback that leaves the real dir visible.
 */
function injectGoogleCredentialShadow(args: string[]): void {
  const gchatConfigDir = join(getHostConfigDir(), "gchat");

  // Only shadow if the directory actually exists on the host. If it does not,
  // there is nothing to hide at the default path, and creating a synthetic
  // mountpoint would be inert. A configured non-default `gchatConfigDir` is
  // out of scope for this sandbox-level shadow (residual noted in ISSUE_NUM).
  if (!existsSync(gchatConfigDir)) return;

  ensureTargetParentDirs(args, gchatConfigDir);
  args.push("--dir", gchatConfigDir);
  args.push("--tmpfs", gchatConfigDir);
}

/**
 * Host-secrets masking for sandboxed workers . `$RUSA_HOME/secrets/`
 * is tmpfs-shadowed UNCONDITIONALLY — unlike `$RUSA_HOME` itself (which
 * workers legitimately read for config + sibling dirs), nothing in the secrets
 * dir is worker-legitimate by default — and `GLASS_GOALS_PASSWORD` is scrubbed
 * from the environment (defense against a stale `EnvironmentFile=` on the unit).
 *
 * When the spawning actor holds an ACTIVE `secret:gemini-api-key` grant, the
 * real `secrets/gemini-api-key` file is `--ro-bind`-ed back OVER its masked path
 * (the bind must come AFTER the `--tmpfs` of the directory — bwrap applies
 * mounts in argument order), so the grantee reads the key at the same well-known
 * path as on the host. `secret:mistral-api-key` does the same for
 * `secrets/mistral-api-key` and also exports the OCR tool's required
 * `MISTRAL_API_KEY`. Grants are read straight from the grant-store JSON under
 * `$RUSA_HOME` (the sandbox layer never imports the mesh — same discipline
 * as `loadConfig()` in {@link injectWorkerGithubCredential}), keyed by the actor
 * id (= the worker dir's basename, see start.ts `join(workersDir, actorId)`).
 * Evaluated per-spawn, so grant/revoke takes effect on the actor's next run.
 * Fail-closed to MASKED: any read/parse error means "no grant", never "leaked".
 */
export function deriveSecretEnvVar(filename: string): string {
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(filename)) {
    throw new Error(
      `Invalid secret filename for env-var derivation: "${filename}". Must be lower-kebab-case.`
    );
  }
  return filename.toUpperCase().replace(/-/g, "_");
}

function injectSecretsMasking(
  args: string[],
  commandPrefix: string[],
  mcHome: string,
  actorId: string
): void {
  const secretsDir = join(mcHome, SECRETS_DIRNAME);
  // The tmpfs mount point must exist under the ro-bound `/` — create it (0700)
  // so the mask holds even on a host that has no secrets yet (same discipline as
  // the host-job audit-artifact tmpfs in buildMeshActorBwrapArgs).
  mkdirSync(secretsDir, { recursive: true, mode: 0o700 });
  args.push("--tmpfs", secretsDir);
  args.push("--unsetenv", "GLASS_GOALS_PASSWORD");

  // Unset all host env vars that correspond to a secret file to prevent host-shell leaks.
  try {
    for (const file of readdirSync(secretsDir)) {
      if (/^[a-z0-9]+(-[a-z0-9]+)*$/.test(file)) {
        args.push("--unsetenv", deriveSecretEnvVar(file));
      }
    }
  } catch {
    // If we can't read the dir, just proceed (tmpfs mask is already in place).
  }

  let activeGrants: string[] = [];
  try {
    const grants = new FileCapabilityGrantStore(join(mcHome, CAPABILITY_GRANTS_FILENAME));
    activeGrants = grants.activeFor(actorId);
  } catch {
    // Fail-closed: an unreadable/invalid grant store means "no grant" (the
    // secrets dir stays fully masked), never a leaked secret.
  }

  const secretGrants = activeGrants
    .filter((g) => g.startsWith("secret:"))
    .map((g) => g.slice("secret:".length));

  const grantedSecretPaths: { name: string; path: string; varName: string }[] = [];

  for (const secretName of secretGrants) {
    const secretPath = join(secretsDir, secretName);
    if (existsSync(secretPath)) {
      const varName = deriveSecretEnvVar(secretName);
      // ORDER MATTERS: after the `--tmpfs` above, so the single-file bind punches
      // the real key back through the directory mask.
      args.push("--ro-bind", secretPath, secretPath);
      grantedSecretPaths.push({ name: secretName, path: secretPath, varName });
    }
  }

  if (grantedSecretPaths.length > 0) {
    const scriptParts: string[] = [];
    const bindArgs: string[] = [];

    for (let i = 0; i < grantedSecretPaths.length; i++) {
      const s = grantedSecretPaths[i];
      const pos = i + 1;
      scriptParts.push(
        `${s.varName}=$(/bin/cat -- "$${pos}") || exit $?; [ -n "$${s.varName}" ] || exit 1; export ${s.varName};`
      );
      bindArgs.push(s.path);
    }

    scriptParts.push(`shift ${grantedSecretPaths.length}; exec "$@"`);

    commandPrefix.push(
      "/bin/sh",
      "-c",
      scriptParts.join(" "),
      "rusa-secrets-entrypoint",
      ...bindArgs
    );
  }
}

function addReadonlyBindIfExists(args: string[], source: string, target: string): void {
  if (existsSync(source)) {
    args.push("--ro-bind", source, target);
  }
}

function addWritableBindIfExists(args: string[], source: string, target: string): void {
  if (existsSync(source)) {
    args.push("--bind", source, target);
  }
}

/**
 * `--dir` every ancestor of `target` so a later `--bind`/`--ro-bind` onto a
 * shadowed (freshly `--tmpfs`'d) tree has somewhere to mount — bwrap does NOT
 * auto-vivify a bind target's parent directories under a fresh tmpfs. Exported
 * for reuse by the host-jobs runner , whose deny-by-default manifest
 * punches allow-listed paths back through a `--tmpfs`-shadowed `$HOME` the same
 * way this module shadows `isolationRoot`.
 */
export function ensureTargetParentDirs(args: string[], target: string): void {
  const parts = dirname(target).split("/").filter(Boolean);
  let current = "";
  for (const part of parts) {
    current += `/${part}`;
    args.push("--dir", current);
  }
}

/** Exported for reuse by the host-jobs runner  — symlink-resolving path compare. */
export function realpathIfExists(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function stripNpmrcValue(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function resolveNpmrcEnvReference(value: string): string | null {
  const match = value.match(/^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/);
  if (!match) return value;
  return process.env[match[1]]?.trim() || null;
}

function resolveScopedNpmReadToken(): string | null {
  const envToken = process.env.NODE_AUTH_TOKEN?.trim();
  if (envToken) return envToken;

  const npmrcPath = join(getHostHomeDir(), ".npmrc");
  if (!existsSync(npmrcPath)) return null;

  try {
    const npmrc = readFileSync(npmrcPath, "utf-8");
    for (const rawLine of npmrc.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#") || line.startsWith(";")) continue;
      const match = line.match(/^\/\/registry\.npmjs\.org\/:_authToken\s*=\s*(.+)$/);
      if (!match) continue;
      const token = resolveNpmrcEnvReference(stripNpmrcValue(match[1]));
      return token && !/[\r\n]/.test(token) ? token : null;
    }
  } catch {
    return null;
  }

  return null;
}

function createScopedNpmrcTemp(): string | null {
  const token = resolveScopedNpmReadToken();
  if (!token) return null;

  const npmrcPath = join(tmpdir(), `rusa-npmrc-${randomUUID()}`);
  writeFileSync(
    npmrcPath,
    `@thkp-eng:registry=${THKP_NPM_REGISTRY}\n//registry.npmjs.org/:_authToken=${token}\n`,
    { mode: 0o600 }
  );
  return npmrcPath;
}

export function injectScopedNpmReadTokenEnv(
  args: string[],
  tempPaths: string[],
  targetNpmrcPath: string
): void {
  const npmrcPath = createScopedNpmrcTemp();
  if (!npmrcPath) return;

  if (targetNpmrcPath.startsWith(`${SANDBOX_HOME}/`)) {
    ensureTargetParentDirs(args, targetNpmrcPath);
  }
  args.push("--ro-bind", npmrcPath, targetNpmrcPath);
  args.push("--setenv", "NPM_CONFIG_USERCONFIG", targetNpmrcPath);
  args.push("--setenv", "npm_config_userconfig", targetNpmrcPath);

  const hostNpmrcPath = join(getHostHomeDir(), ".npmrc");
  if (targetNpmrcPath !== hostNpmrcPath && existsSync(hostNpmrcPath)) {
    args.push("--ro-bind", npmrcPath, hostNpmrcPath);
  }

  tempPaths.push(npmrcPath);
}

/**
 * The provider auth/state dir(s) that must be WRITABLE inside a mesh actor's
 * sandbox (token refresh, conversation logs, session state). Everything else a
 * provider reads — git identity, ssh keys, gh config, and read-only provider
 * config (copilot/codex) — is already visible at its real path via the `--ro-bind
 * / /` mount, so it needs no explicit bind. Returns real host paths, bound rw
 * in-place by {@link buildMeshActorBwrapArgs}.
 */
function providerWritableStateDirs(authMode: SandboxAuthMode | undefined): string[] {
  const home = getHostHomeDir();
  switch (authMode) {
    case "antigravity":
      // agy caches its OAuth token + writes conversations/logs under ~/.gemini.
      return [join(home, ".gemini")];
    case "claude":
      // Claude CLI refreshes OAuth creds in ~/.claude and rewrites ~/.claude.json
      // (project state) on every run.
      return [join(home, ".claude"), join(home, ".claude.json")];
    case "kimi":
      // KIMI_CODE_HOME=/tmp/kimi-home in buildMeshActorBwrapArgs handles all writes;
      // no host dir needs to be writable.
      return [];
    case "codex":
      // Codex CLI stores auth in ~/.codex/auth.json and config in ~/.codex/config.toml.
      // Inside the sandbox we set CODEX_HOME=/tmp and bind temporary config/auth files
      // to /tmp/config.toml and /tmp/auth.json, so no writable host state directory is required.
      return [];
    case "copilot":
      return [getCopilotHomeConfigPath(), ...getCopilotXdgConfigPaths()];
    default:
      // undefined: auth is read-only at its real path (visible
      // via the ro-bind of /), so no writable bind is required.
      return [];
  }
}

/**
 * Mesh-actor bwrap layout (the simplified, write-scoped model): keeps the REAL
 * home (read-only via `--ro-bind / /`), so every tool finds `~/.gitconfig`,
 * `~/.ssh`, and `~/.config/gh` at their real paths with no remapping and no
 * synthetic HOME. The resolved node/corepack/pnpm directories are prepended to
 * PATH so repo build tooling is available even when the inherited service PATH
 * omits fnm's toolchain dir. Writes are scoped to exactly four places: the
 * actor's own dir, the shared pnpm CAS, the provider's state dir, and `/tmp`.
 */
function buildMeshActorBwrapArgs(o: {
  actorDir: string;
  authMode?: SandboxAuthMode;
  mcpConfigPath?: string;
  isE2eRoot?: boolean;
  understandingMount?: string;
}): ActorBwrapResult {
  const pnpmStore = realpathIfExists(resolvePnpmStorePath());
  mkdirSync(pnpmStore, { recursive: true });
  const realActorDir = realpathIfExists(o.actorDir);
  const tempPaths: string[] = [];
  const commandPrefix: string[] = [];

  const args: string[] = [
    "--unshare-all",
    "--share-net",
    "--die-with-parent",
    // Read everything (incl. other actors' repos), with narrow tmpfs shadows for
    // host-plane-only stores below; the real home stays visible so tools resolve
    // ~/.gitconfig, ~/.ssh, ~/.config/gh without any remapping.
    "--ro-bind",
    "/",
    "/",
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    // Writable ephemeral scratch. Tools' temp/cert/cache writes are steered here
    // via TMPDIR/TMP/TEMP/XDG_CACHE_HOME so they don't hit the read-only home.
    "--tmpfs",
    "/tmp",
    "--dir",
    "/tmp/cache",
  ];

  if (o.understandingMount) {
    args.push("--dir", "/tmp/understanding");
    args.push("--ro-bind", o.understandingMount, "/tmp/understanding");
  }

  // Bind the toolchain directory onto /usr/local/bin and the sibling lib directory onto
  // /usr/local/lib to survive `bash -lc` login shells.
  // /etc/profile:4-9 does an unconditional assignment that resets the inherited PATH,
  // listing /usr/local/bin first/second. By shadowing /usr/local/bin, node and its
  // toolchain are automatically on the PATH for login shells too.
  const toolchainBin = dirname(getNodePath());
  args.push("--ro-bind", toolchainBin, "/usr/local/bin");
  const toolchainLib = join(dirname(toolchainBin), "lib");
  if (existsSync(toolchainLib)) {
    args.push("--ro-bind", toolchainLib, "/usr/local/lib");
  }

  const actorParent = dirname(realActorDir);
  const mcHome =
    basename(actorParent) === "workers"
      ? dirname(actorParent)
      : o.isE2eRoot
        ? actorParent
        : undefined;
  if (mcHome) {
    const auditArtifactDir = hostJobAuditArtifactDir(mcHome);
    mkdirSync(auditArtifactDir, { recursive: true, mode: 0o700 });
    args.push("--tmpfs", auditArtifactDir);
  }

  let ghWrapperDir: string | undefined;
  // GitHub credential split (ISSUE_NUM/ISSUE_NUM-adjacent): real workers only — this
  // guard is deliberately narrower than the `mcHome` one above so root (never
  // sandboxed in production) and the E2E root-agent sandboxed test double
  // both keep the host's real gh credential unconditionally.
  if (mcHome && basename(actorParent) === "workers") {
    ghWrapperDir = injectWorkerGithubCredential(args, mcHome);
    // Google user-OAuth token shadow : same real-workers-only guard as
    // the gh credential split. Root and the E2E root-agent double keep host
    // visibility of the real `~/.config/gchat` dir.
    injectGoogleCredentialShadow(args);
    // Host-secrets masking : same real-workers-only guard as the gh
    // credential split above — root (unsandboxed in production) and the E2E
    // root-agent test double keep host visibility.
    injectSecretsMasking(args, commandPrefix, mcHome, basename(realActorDir));
  }

  // Write scope: the actor's own directory, re-bound in place over the ro view.
  args.push("--bind", realActorDir, realActorDir);
  // Write scope: shared pnpm CAS (installs land here), mounted in place.
  args.push("--bind", pnpmStore, pnpmStore);
  // Write scope: the provider's auth/state dir(s), at their real paths.
  for (const dir of providerWritableStateDirs(o.authMode)) {
    addWritableBindIfExists(args, dir, dir);
  }

  // Topology guard (not secrecy): the root's real agy mcp_config carries the chat
  // server; a sandboxed worker must report to its parent, not talk to humans. Pin
  // the per-invocation config over both known paths (after the rw ~/.gemini bind,
  // so this file override wins).
  if (o.mcpConfigPath && o.authMode === "antigravity") {
    const gemini = join(getHostHomeDir(), ".gemini");
    args.push(
      "--ro-bind",
      o.mcpConfigPath,
      join(gemini, "config", "mcp_config.json"),
      "--ro-bind",
      o.mcpConfigPath,
      join(gemini, "antigravity", "mcp_config.json")
    );
  } else if (o.mcpConfigPath && o.authMode === "claude") {
    // claude reads `--mcp-config` from this fixed in-sandbox path . The
    // source on host /tmp is shadowed from siblings by their own tmpfs /tmp, so
    // only the owner — via this explicit bind — can read it: closes worker→worker
    // token harvest while still delivering the config to the owning sandbox.
    args.push("--ro-bind", o.mcpConfigPath, SANDBOX_MCP_CONFIG_PATH);
  } else if (o.mcpConfigPath && o.authMode === "codex") {
    // codex config is bound to /tmp/config.toml inside the sandbox (since CODEX_HOME=/tmp)
    args.push("--bind", o.mcpConfigPath, "/tmp/config.toml");
  } else if (o.mcpConfigPath && o.authMode === "kimi") {
    // kimi-code discovers MCP servers from KIMI_CODE_HOME/mcp.json. KIMI_CODE_HOME
    // is pinned to /tmp/kimi-home below, so bind the per-run host-/tmp source to
    // that in-sandbox path after ensuring the tmpfs parent exists.
    ensureTargetParentDirs(args, SANDBOX_KIMI_MCP_CONFIG_PATH);
    args.push("--ro-bind", o.mcpConfigPath, SANDBOX_KIMI_MCP_CONFIG_PATH);
  }

  if (o.authMode === "claude") {
    if (o.isE2eRoot) {
      // E2E Root actor: Set CLAUDE_CONFIG_DIR to /tmp/claude-auth for session persistence
      args.push("--setenv", "CLAUDE_CONFIG_DIR", "/tmp/claude-auth");
      args.push("--dir", "/tmp/claude-auth");

      // Bind the writeable workspace folder for Claude state (sessions database, etc.)
      const stateDir = join(realActorDir, ".claude-state");
      mkdirSync(stateDir, { recursive: true });
      args.push("--bind", stateDir, "/tmp/claude-auth");

      // Bind host credentials read-only on top of the state directory if they exist
      const hostCreds = join(getHostHomeDir(), ".claude", ".credentials.json");
      if (existsSync(hostCreds)) {
        args.push("--ro-bind", hostCreds, "/tmp/claude-auth/.credentials.json");
      }
    } else {
      // Real workers: use default host configuration directory (persists token refreshes)
      args.push("--unsetenv", "CLAUDE_CONFIG_DIR");
    }
  }

  if (o.authMode === "codex") {
    // Copy auth.json from host ~/.codex/auth.json to a temp file in /tmp and bind it
    const hostHome = getHostHomeDir();
    const hostAuthPath = join(hostHome, ".codex", "auth.json");
    if (existsSync(hostAuthPath)) {
      try {
        const authData = readFileSync(hostAuthPath);
        const authTempPath = join("/tmp", `rusa-auth-codex-${basename(o.actorDir)}.json`);
        writeFileSync(authTempPath, authData, { mode: 0o600 });
        args.push("--bind", authTempPath, "/tmp/auth.json");
        tempPaths.push(authTempPath);
      } catch {
        // best effort
      }
    }

    // Cross-wake session continuity : persist codex's session rollouts in a
    // per-actor host-/tmp dir and bind it over CODEX_HOME's sessions path. This
    // bind MUST come after the `--tmpfs /tmp` above (in the initial args), or the
    // tmpfs would shadow it; the store is created here so the bind source exists.
    // The store is NOT a tempPath — unlike the auth copy it persists across runs,
    // retire, and redeploy (the actor's memory), giving revive/restart continuity
    // parity with claude. See {@link codexRolloutStoreDir}.
    const sessionsStore = codexRolloutStoreDir(o.actorDir);
    mkdirSync(sessionsStore, { recursive: true, mode: 0o700 });
    args.push("--bind", sessionsStore, SANDBOX_CODEX_SESSIONS_PATH);
  }

  if (o.authMode === "kimi") {
    const kimiCodeDir = join(getHostHomeDir(), ".kimi-code");
    // Redirect kimi-code's data dir to the sandbox's writable /tmp so session writes are
    // isolated per-worker (mirrors the CODEX_HOME=/tmp pattern for codex workers). The
    // sessions half of that pattern — persisting the store across invocations — is wired
    // below via the per-actor bind ; the rest of /tmp/kimi-home is per-invocation.
    args.push("--setenv", "KIMI_CODE_HOME", "/tmp/kimi-home");
    args.push("--dir", "/tmp/kimi-home");
    // config.toml is static — bind read-only from the host ~/.kimi-code.
    addReadonlyBindIfExists(args, join(kimiCodeDir, "config.toml"), "/tmp/kimi-home/config.toml");
    // credentials/: kimi (0.23.6) rewrites credentials/kimi-code.json on EVERY run (atomic
    // tmp-write + rename inside the dir), so a read-only bind fails with EROFS and makes the
    // provider unusable for any sandboxed actor . Copy the dir to a per-actor host-/tmp
    // dir and bind it writable — same discipline as the oauth token below: the host creds stay
    // untouched, the in-run rewrite lands in the throwaway copy and is discarded on run-end, and
    // per-actor copies never race. Needs the whole dir writable because kimi renames a tmp file
    // over kimi-code.json (a single-file bind can't be renamed over).
    const kimiCredsSrc = join(kimiCodeDir, "credentials");
    if (existsSync(kimiCredsSrc)) {
      try {
        const credsTemp = join(tmpdir(), `rusa-kimicreds-${basename(o.actorDir)}`);
        rmSync(credsTemp, { recursive: true, force: true }); // clear any stale copy from a prior crash
        cpSync(kimiCredsSrc, credsTemp, { recursive: true });
        args.push("--bind", credsTemp, "/tmp/kimi-home/credentials");
        tempPaths.push(credsTemp);
      } catch {
        // best-effort: kimi will fail at auth if creds are missing — not a sandbox setup error
      }
    }
    // OAuth token: copy to a per-actor host-/tmp file and bind writable so token refresh
    // can succeed within the run (discarded on run-end, same discipline as codex auth).
    const kimiOauthSrc = join(kimiCodeDir, "oauth", "kimi-code");
    if (existsSync(kimiOauthSrc)) {
      try {
        const oauthTemp = join(tmpdir(), `rusa-auth-kimi-${basename(o.actorDir)}`);
        writeFileSync(oauthTemp, readFileSync(kimiOauthSrc), { mode: 0o600 });
        args.push("--dir", "/tmp/kimi-home/oauth");
        args.push("--bind", oauthTemp, "/tmp/kimi-home/oauth/kimi-code");
        tempPaths.push(oauthTemp);
      } catch {
        // best-effort: kimi will fail at auth if no token — not a sandbox setup error
      }
    }
    // Cross-invocation session continuity (ISSUE_NUM + follow-up): kimi keeps its session
    // transcripts under KIMI_CODE_HOME/sessions AND a sibling KIMI_CODE_HOME/session_index.jsonl
    // that maps a session id to its workdir bucket. /tmp/kimi-home is a per-invocation sandbox
    // tmpfs, so both vanished with the prior invocation's bwrap and every `kimi -r <id>` resume
    // failed "Session not found". ISSUE_NUM persisted sessions/ alone, but the `-r` id->bucket lookup
    // reads the sibling index FIRST, so resume still failed until the index is persisted too
    // (isolated by solid-rusa's Layer 2 real-`-r` E2E). Persist BOTH in a per-actor host-/tmp
    // dir laid out like KIMI_CODE_HOME's session slice and bind each into place — same
    // memory-not-secret discipline as codex's rollout store (see {@link kimiSessionStoreDir}):
    // NOT tempPaths, survive across runs/retire/redeploy. Creds/oauth above stay ephemeral
    // (separate paths, unaffected). Must come AFTER the initial `--tmpfs /tmp` and the
    // `--dir /tmp/kimi-home` above, or they would be shadowed.
    const kimiSessionsStore = kimiSessionStoreDir(o.actorDir);
    mkdirSync(join(kimiSessionsStore, "sessions"), { recursive: true, mode: 0o700 });
    const kimiIndexPath = join(kimiSessionsStore, "session_index.jsonl");
    if (!existsSync(kimiIndexPath)) {
      // bind source must exist; an empty index is kimi's fresh-start state (it appends).
      writeFileSync(kimiIndexPath, "", { mode: 0o600 });
    }
    args.push("--bind", join(kimiSessionsStore, "sessions"), "/tmp/kimi-home/sessions");
    args.push("--bind", kimiIndexPath, "/tmp/kimi-home/session_index.jsonl");
  }

  const hostFlutterRoot = resolveHostFlutterRoot();
  const pathPrefixes: string[] = [];
  if (ghWrapperDir) {
    pathPrefixes.push(ghWrapperDir);
  }
  if (hostFlutterRoot) {
    const { wrapperDir, inSandboxFlutter } = setupFlutterOverlay(
      args,
      hostFlutterRoot,
      realActorDir
    );
    pathPrefixes.push(wrapperDir);
    args.push("--setenv", "PATH", [...pathPrefixes, buildToolchainPath()].join(":"));
    args.push("--setenv", "PUB_CACHE", `${inSandboxFlutter}/.pub-cache`);
  } else {
    args.push(
      "--setenv",
      "PATH",
      pathPrefixes.length > 0
        ? [...pathPrefixes, buildToolchainPath()].join(":")
        : buildToolchainPath()
    );
  }

  args.push("--setenv", "NPM_CONFIG_STORE_DIR", pnpmStore);
  args.push("--setenv", "npm_config_store_dir", pnpmStore);
  args.push("--setenv", "TMPDIR", "/tmp");
  args.push("--setenv", "TMP", "/tmp");
  args.push("--setenv", "TEMP", "/tmp");
  args.push("--setenv", "XDG_CACHE_HOME", "/tmp/cache");
  args.push("--setenv", "npm_config_cache", "/tmp/cache/npm");
  args.push("--setenv", "XDG_RUNTIME_DIR", "/tmp");
  injectScopedNpmReadTokenEnv(args, tempPaths, SANDBOX_SCOPED_NPMRC_PATH);
  // Non-interactive baseline environment to prevent interactive-prompt hangs
  args.push("--setenv", "COREPACK_ENABLE_DOWNLOAD_PROMPT", "0");
  args.push("--setenv", "CI", "1");
  args.push("--setenv", "GIT_TERMINAL_PROMPT", "0");
  args.push("--setenv", "GIT_PAGER", "cat");
  args.push("--setenv", "PAGER", "cat");
  args.push("--setenv", "DEBIAN_FRONTEND", "noninteractive");
  if (o.authMode === "codex") {
    args.push("--setenv", "CODEX_HOME", "/tmp");
  }
  // Prevent Claude Code from detecting a nested session inside the sandbox.
  args.push("--unsetenv", "CLAUDECODE");
  if (o.authMode !== "claude") {
    args.push("--unsetenv", "CLAUDE_CONFIG_DIR");
  }
  args.push("--chdir", realActorDir);
  injectGitBridgeEnv(args);

  return { args, commandPrefix, tempPaths };
}

/** Assemble the bwrap argv, including any grant-specific in-sandbox entrypoint. */
export function buildActorBwrapCommand(
  result: ActorBwrapResult,
  command: string,
  commandArgs: string[]
): string[] {
  return [...result.args, "--", ...result.commandPrefix, command, ...commandArgs];
}

function injectGitBridgeEnv(args: string[]): void {
  try {
    const config = loadConfig();
    if (config.gitBridge) {
      const port = config.gitBridgePort ?? 8085;
      args.push(
        "--setenv",
        "GIT_CONFIG_PARAMETERS",
        `'url.http://127.0.0.1:${port}/.insteadOf=https://github.com/' 'url.http://127.0.0.1:${port}/.insteadOf=git@github.com:'`
      );
    }
  } catch {
    // Config not found or invalid — do not inject (default to inert/no-op)
  }
}

/**
 * Mesh entrypoint: an actor owns a single private directory and clones whatever
 * repos its charter needs inside it. Visibility is intentionally OPEN — an actor
 * may READ the whole host, including any other actor's repo (e.g. a reviewer
 * inspecting a coder's work). Isolation is write-scope, not read-scope: the actor
 * can only WRITE inside its own directory, the provider's state dir, the shared
 * pnpm CAS, and /tmp.
 *
 * Keeps the REAL home (read-only), so there's no synthetic HOME and no auth
 * curation — tools find their config at the real path, and git + gh come from
 * the inherited PATH (always granted; the mesh never restricts capabilities).
 * See {@link buildMeshActorBwrapArgs}.
 */
export function buildActorBwrapArgs(
  actorDir: string,
  authMode?: SandboxAuthMode,
  mcpConfigPath?: string,
  isE2eRoot?: boolean,
  understandingMount?: string
): ActorBwrapResult {
  return buildMeshActorBwrapArgs({
    actorDir,
    authMode,
    mcpConfigPath,
    isE2eRoot,
    understandingMount,
  });
}

let _hostFlutterRoot: string | null | undefined;
export function resolveHostFlutterRoot(): string | null {
  if (_hostFlutterRoot !== undefined) return _hostFlutterRoot;
  try {
    const flutterBin = execSync("which flutter", { encoding: "utf8" }).trim();
    if (flutterBin) {
      _hostFlutterRoot = dirname(dirname(realpathSync(flutterBin)));
      return _hostFlutterRoot;
    }
  } catch {}
  _hostFlutterRoot = null;
  return null;
}

export function setupFlutterOverlay(
  args: string[],
  hostFlutterRoot: string,
  realActorDir: string
): { wrapperDir: string; inSandboxFlutter: string } {
  const fuseOverlayFsPath = "/usr/bin/fuse-overlayfs";
  const hasFuseOverlayFs = existsSync(fuseOverlayFsPath) || process.env.MOCK_FUSE === "1";
  const hasDevFuse = existsSync("/dev/fuse") || process.env.MOCK_FUSE === "1";
  const canMount = hasFuseOverlayFs && hasDevFuse;
  const inSandboxFlutter = "/tmp/flutter-sdk";

  args.push("--dir", inSandboxFlutter);

  if (canMount && existsSync(hostFlutterRoot)) {
    const flutterUpper = join(realActorDir, ".flutter_upper");
    const flutterWork = join(realActorDir, ".flutter_work");
    const flutterMnt = join(realActorDir, ".flutter_mnt");
    mkdirSync(flutterUpper, { recursive: true });
    mkdirSync(flutterWork, { recursive: true });
    mkdirSync(flutterMnt, { recursive: true });

    // Construction resilience: if .flutter_mnt is already mounted at setup time,
    // unmount it unprivileged before mounting fresh so stale mounts heal automatically .
    teardownFlutterOverlay(realActorDir);

    // Host-level mount: mount the overlay on the host outside bwrap so the
    // sandbox doesn't need mount privileges or /dev/fuse access inside bwrap .
    let mounted = false;
    try {
      execFileSync(
        fuseOverlayFsPath,
        [
          "-o",
          `lowerdir=${hostFlutterRoot},upperdir=${flutterUpper},workdir=${flutterWork}`,
          flutterMnt,
        ],
        { stdio: "pipe" }
      );
      mounted = true;
    } catch (err: unknown) {
      const stderr =
        (err as { stderr?: Buffer })?.stderr?.toString() ?? (err as Error)?.message ?? String(err);
      console.error(`[Sandbox Warning] Host fuse-overlayfs mount failed: ${stderr}`);
    }

    if (mounted) {
      args.push("--bind", flutterMnt, inSandboxFlutter);
      return { wrapperDir: `${inSandboxFlutter}/bin`, inSandboxFlutter };
    }
  }

  // Fallback / fail shim if fuse-overlayfs is missing or failed to mount
  mkdirSync(realActorDir, { recursive: true });
  const fakeWrapperDir = "/tmp/flutter-wrapper/bin";
  args.push("--dir", "/tmp/flutter-wrapper");
  args.push("--dir", fakeWrapperDir);
  const fakeFlutterBin = join(realActorDir, ".flutter_fail");
  writeFileSync(
    fakeFlutterBin,
    `#!/bin/sh\necho "[Sandbox Error] fuse-overlayfs or /dev/fuse is missing or failed to mount. Cannot mount shared Flutter SDK. Silent private copy fallback is disabled per ISSUE_NUM." >&2\nexit 1\n`,
    { mode: 0o755 }
  );
  args.push("--ro-bind", fakeFlutterBin, `${fakeWrapperDir}/flutter`);
  args.push("--ro-bind", fakeFlutterBin, `${fakeWrapperDir}/dart`);

  return { wrapperDir: fakeWrapperDir, inSandboxFlutter };
}

export function teardownFlutterOverlay(realActorDir: string): void {
  const flutterMnt = join(realActorDir, ".flutter_mnt");
  if (existsSync(flutterMnt) || process.env.MOCK_FUSE === "1") {
    try {
      execFileSync("fusermount3", ["-u", "-z", flutterMnt], { stdio: "pipe" });
    } catch {
      try {
        execFileSync("fusermount", ["-u", "-z", flutterMnt], { stdio: "pipe" });
      } catch {}
    }
  }
}
