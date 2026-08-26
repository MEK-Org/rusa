import { randomUUID } from "node:crypto";
import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { parse, stringify } from "smol-toml";
import type { ProviderConfig } from "../config/types.js";
import {
  type ActorBwrapResult,
  buildActorBwrapArgs,
  buildActorBwrapCommand,
  codexRolloutStoreDir,
  teardownFlutterOverlay,
} from "./sandbox.js";
import { runSubprocess } from "./subprocess-execution.js";
import {
  attributedTokenUsage,
  extractCodexTokenUsageFromStore,
  unattributedTokenUsage,
} from "./token-accounting.js";
import type { CodingProvider, McpServerSpec, RunOptions, RunResult } from "./types.js";

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

/** A session/conversation UUID as it appears in codex rollout filenames + `session_meta.payload.id`. */
const SESSION_UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/**
 * Parse a Codex model string into its base model identifier and optional reasoning effort qualifier.
 * Codex models are slugs like 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.5', 'gpt-5.4-mini'.
 * Reasoning effort (e.g. 'low', 'medium', 'high', 'extra-high', 'none') is configured separately
 * in Codex (via `model_reasoning_effort` in config.toml or `--config model_reasoning_effort=...`)
 * and must not be passed inside `--model <slug>` (which causes 400 errors from ChatGPT-auth accounts).
 */
export function parseCodexModel(rawModel?: string): {
  model?: string;
  reasoningEffort?: string;
} {
  if (!rawModel) return {};
  const trimmed = rawModel.trim();
  if (!trimmed) return {};

  const baseMatch = trimmed.match(/^([^\s(]+)/);
  const baseModel = baseMatch ? baseMatch[1] : trimmed;

  const effortRemainder = trimmed.slice(baseModel.length);
  const effortMatch = effortRemainder.match(/\b(low|medium|high|extra-high|none)\b/i);
  const reasoningEffort = effortMatch ? effortMatch[1].toLowerCase() : undefined;

  return {
    model: baseModel,
    reasoningEffort,
  };
}

export interface CodexArgsOptions {
  prompt: string;
  model?: string;
  /** Per-invocation Codex config overrides, passed as repeatable `--config` flags. */
  configOverrides?: string[];
  /** Working root for a FRESH run (`--cd`). Ignored on resume — codex reloads the session's recorded cwd. */
  cwd: string;
  /**
   * Resume an existing session by id instead of starting fresh. codex 0.137's
   * `exec resume` subcommand rejects `--cd`/`--yolo`; it reloads the recorded cwd
   * and takes the long `--dangerously-bypass-approvals-and-sandbox` form of yolo.
   */
  resumeSessionId?: string;
}

/**
 * Build the `codex` CLI args (pure). Two shapes:
 * - fresh:  `exec --yolo --cd <cwd> [--model M] <prompt>`
 * - resume: `exec resume --dangerously-bypass-approvals-and-sandbox [--model M] <id> <prompt>`
 *
 * The resume shape is dictated by codex 0.137's subcommand grammar
 * (`codex exec resume [OPTIONS] [SESSION_ID] [PROMPT]`), which does NOT accept
 * `--cd` or `--yolo`. codex resolves the working root from the session's recorded
 * `cwd`; the run-dispatch site guarantees the process cwd matches it (the sandbox
 * `--chdir`s into the worktree), so codex's cwd-filter is satisfied.
 */
export function buildCodexArgs(o: CodexArgsOptions): string[] {
  // A model that was requested but is blank can't be passed through, and
  // dropping the flag would hand the run to the config-default model — a
  // silent substitution (ISSUE_NUM, same class as ISSUE_NUM). Hard stop instead.
  const rawModel = o.model?.trim();
  if (o.model !== undefined && !rawModel) {
    throw new Error(
      "codex: requested model slug is empty — refusing to fall through to the config-default model "
    );
  }
  const { model, reasoningEffort } = parseCodexModel(rawModel);
  const configOverrides = [...(o.configOverrides ?? [])];
  if (reasoningEffort && !configOverrides.some((c) => c.startsWith("model_reasoning_effort="))) {
    configOverrides.push(`model_reasoning_effort=${JSON.stringify(reasoningEffort)}`);
  }

  if (o.resumeSessionId) {
    const args = ["exec", "resume", "--dangerously-bypass-approvals-and-sandbox"];
    if (model) args.push("--model", model);
    for (const override of configOverrides) args.push("--config", override);
    args.push(o.resumeSessionId, o.prompt);
    return args;
  }
  const args = ["exec", "--yolo", "--cd", o.cwd];
  if (model) args.push("--model", model);
  for (const override of configOverrides) args.push("--config", override);
  args.push(o.prompt);
  return args;
}

/**
 * Find the session id of the newest `rollout-*.jsonl` under a codex sessions tree
 * (`<sessionsDir>/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`). Returns the UUID from the
 * filename, falling back to the first JSONL line's `session_meta.payload.id`.
 * Returns undefined if the tree has no rollout. Pure + total (never throws) so a
 * capture failure degrades to "no session captured" rather than failing the run.
 */
export function extractNewestCodexSessionId(sessionsDir: string): string | undefined {
  let newest: { path: string; mtimeMs: number } | undefined;
  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry);
      let st: ReturnType<typeof statSync>;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        walk(full);
      } else if (entry.startsWith("rollout-") && entry.endsWith(".jsonl")) {
        if (!newest || st.mtimeMs > newest.mtimeMs) newest = { path: full, mtimeMs: st.mtimeMs };
      }
    }
  };
  walk(sessionsDir);
  if (!newest) return undefined;
  // Prefer the filename UUID (stable, no read); fall back to the session_meta line.
  const fromName = basenameMatch(newest.path);
  if (fromName) return fromName;
  try {
    const firstLine = readFileSync(newest.path, "utf-8").split("\n", 1)[0];
    const parsed = JSON.parse(firstLine) as { payload?: { id?: string } };
    const id = parsed?.payload?.id;
    if (id && SESSION_UUID_RE.test(id)) return id;
  } catch {
    /* unreadable / malformed — fall through */
  }
  return undefined;
}

function basenameMatch(path: string): string | undefined {
  return basename(path).match(SESSION_UUID_RE)?.[0];
}

/**
 * Read the model Codex recorded for a session. The rollout's
 * `turn_context.payload.model` is provider-side read-back, unlike the spawn
 * request slug.
 */
export function extractCodexBoundModel(sessionsDir: string, sessionId: string): string | undefined {
  const file = findCodexRolloutFile(sessionsDir, sessionId);
  if (!file) return undefined;
  try {
    const lines = readFileSync(file, "utf-8").split(/\r?\n/);
    for (const line of lines) {
      if (!line.trim()) continue;
      const parsed = JSON.parse(line) as { type?: string; payload?: { model?: unknown } };
      if (parsed.type !== "turn_context") continue;
      const model = parsed.payload?.model;
      return typeof model === "string" && model.trim() ? model.trim() : undefined;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/**
 * Locate the rollout file for a given session id anywhere under a sessions tree
 * (`rollout-<ts>-<id>.jsonl`), or undefined if none. Pure + total (never throws).
 */
export function findCodexRolloutFile(sessionsDir: string, sessionId: string): string | undefined {
  const needle = sessionId.toLowerCase();
  const walk = (dir: string): string | undefined => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return undefined;
    }
    for (const entry of entries) {
      const full = join(dir, entry);
      let st: ReturnType<typeof statSync>;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        const hit = walk(full);
        if (hit) return hit;
      } else if (
        entry.startsWith("rollout-") &&
        entry.endsWith(".jsonl") &&
        entry.toLowerCase().includes(needle)
      ) {
        return full;
      }
    }
    return undefined;
  };
  return walk(sessionsDir);
}

/**
 * Whether a rollout for the given session id exists anywhere under a sessions
 * tree. Used to decide resume-vs-fresh: a stored id whose rollout is gone (e.g.
 * host `/tmp` wiped by a reboot) must fall back to a fresh run, not a hard error.
 */
export function codexRolloutExists(sessionsDir: string, sessionId: string): boolean {
  return findCodexRolloutFile(sessionsDir, sessionId) !== undefined;
}

/**
 * Whether the stored session is safe to `codex exec resume`. The rollout file
 * must exist AND its first JSONL line must parse as a `session_meta` record
 * carrying a UUID `payload.id`. This is the cheap pre-check that filters a
 * MISSING rollout (post-reboot) and a CORRUPT/truncated one (crash mid-write,
 * partial flush, version mismatch) before we ever spawn — both fall back to a
 * fresh run. It is NOT the only safety net: any resume that still fails at the
 * CLI (deeper/mid-file corruption the first line can't reveal) is caught by the
 * spawn-time fallback in {@link CodexProvider.run}. Pure + total (never throws).
 */
export function codexRolloutResumable(sessionsDir: string, sessionId: string): boolean {
  const file = findCodexRolloutFile(sessionsDir, sessionId);
  if (!file) return false;
  try {
    const firstLine = readFileSync(file, "utf-8").split("\n", 1)[0];
    const parsed = JSON.parse(firstLine) as { type?: string; payload?: { id?: string } };
    const id = parsed?.payload?.id;
    return typeof id === "string" && SESSION_UUID_RE.test(id);
  } catch {
    return false;
  }
}

/**
 * Whether a failed codex run's output looks like an authentication failure
 * (expired/invalid host token). Surfaced loudly to the operator; also used to
 * skip the resume→fresh fallback (a fresh run won't fix bad auth either).
 */
export function isCodexAuthFailure(output: string): boolean {
  const o = output.toLowerCase();
  return (
    o.includes("unauthorized") ||
    o.includes("auth failed") ||
    o.includes("authentication failed") ||
    o.includes("token expired") ||
    o.includes("login required") ||
    o.includes("token invalid")
  );
}

/** Strip any mcp_servers configuration blocks from base config TOML. */
export function stripMcpServersFromToml(toml: string): string {
  try {
    const parsed = parse(toml) as Record<string, unknown>;
    delete parsed.mcp_servers;
    return stringify(parsed);
  } catch {
    // Fall back to empty toml on parse failure
    return "";
  }
}

/**
 * Force the top-level `model` key of a codex config TOML to the requested model
 * (no-op when no model was requested). Belt-and-suspenders for ISSUE_NUM: the merged
 * worker config starts from the HOST's ~/.codex/config.toml, whose `model`
 * default is what the CLI silently falls back to if it fails to resolve the
 * `--model` slug in the worker's environment (ISSUE_NUM-class silent substitution).
 * Forcing the key makes the flag and the config agree, so a resolution hiccup
 * can never quietly downgrade the run to a different model.
 */
export function overrideTomlModel(toml: string, rawModel: string | undefined): string {
  if (!rawModel) return toml;
  const { model, reasoningEffort } = parseCodexModel(rawModel);
  if (!model) return toml;
  try {
    const parsed = parse(toml) as Record<string, unknown>;
    parsed.model = model;
    if (reasoningEffort) {
      parsed.model_reasoning_effort = reasoningEffort;
    }
    return stringify(parsed);
  } catch {
    // Unparseable base config: a config carrying only the requested model still
    // beats one carrying a wrong default.
    const fallback: Record<string, unknown> = { model };
    if (reasoningEffort) {
      fallback.model_reasoning_effort = reasoningEffort;
    }
    return stringify(fallback);
  }
}

/** Build the `[mcp_servers]` TOML section for Codex. */
export function buildCodexMcpConfig(servers: McpServerSpec[]): string {
  const mcpServers: Record<string, unknown> = {};
  for (const s of servers) {
    mcpServers[s.name] = { url: s.url };
  }
  return stringify({ mcp_servers: mcpServers });
}

/**
 * Build invocation-scoped Codex config overrides for an unsandboxed root run.
 * Root runs cannot consume the sandbox-only config.toml bind, so pass the same
 * model pin and MCP server map through Codex's repeatable `--config` option.
 */
export function buildCodexConfigOverrides(servers: McpServerSpec[], rawModel?: string): string[] {
  const overrides: string[] = [];
  const { model, reasoningEffort } = parseCodexModel(rawModel);
  if (model) overrides.push(`model=${JSON.stringify(model)}`);
  if (reasoningEffort) overrides.push(`model_reasoning_effort=${JSON.stringify(reasoningEffort)}`);
  for (const server of servers) {
    overrides.push(`mcp_servers.${server.name}.url=${JSON.stringify(server.url)}`);
  }
  return overrides;
}

/**
 * OpenAI Codex CLI provider.
 * Spawns `codex exec "<prompt>"` in non-interactive mode with --full-auto and --yolo.
 */
export class CodexProvider implements CodingProvider {
  public readonly providerName = "codex";

  constructor(
    public readonly name: string,
    private readonly config: ProviderConfig,
    public readonly model?: string
  ) {}

  async run(opts: RunOptions): Promise<RunResult> {
    const runStartedAt = new Date().toISOString();
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const command = this.config.cliCommand ?? "codex";

    const tempPaths: string[] = [];

    let mcpConfigSource: string | undefined;

    const cleanupMcpConfig = () => {
      if (mcpConfigSource) {
        try {
          unlinkSync(mcpConfigSource);
        } catch {
          /* best effort */
        }
      }
      for (const p of tempPaths) {
        try {
          unlinkSync(p);
        } catch {
          /* best effort */
        }
      }
      if (opts.sandbox) {
        teardownFlutterOverlay(opts.sandbox.worktreePath);
      }
    };

    // Resolve where this run's session rollouts live, so we can decide
    // resume-vs-fresh and capture the id afterwards . Only sandboxed runs
    // get a PER-ACTOR isolated store (sandbox.ts binds it over CODEX_HOME's
    // sessions path); an unsandboxed run would share the host's ~/.codex/sessions
    // with every other process, so "newest rollout" is racy/cross-actor there —
    // we deliberately skip resume/capture when unsandboxed (it keeps today's
    // stateless behavior, and the mesh always sandboxes codex subactors).
    const sessionsDir = opts.sandbox ? codexRolloutStoreDir(opts.sandbox.worktreePath) : undefined;

    // Resume only when we have a stored id AND its rollout passes a cheap validity
    // pre-check (exists + first JSONL line parses as session_meta with a UUID id).
    // A MISSING rollout (host /tmp wiped by a reboot) OR a CORRUPT/truncated one
    // (crash mid-write, partial flush, version mismatch) fails the pre-check → we
    // run fresh and recapture a new id. Deeper corruption the first line can't
    // reveal is caught by the spawn-time fallback below. Never a hard error.
    const resumeSessionId =
      sessionsDir && opts.session?.id && codexRolloutResumable(sessionsDir, opts.session.id)
        ? opts.session.id
        : undefined;

    const codexCwd = opts.sandbox ? opts.sandbox.worktreePath : opts.cwd;
    const configOverrides = opts.sandbox
      ? undefined
      : buildCodexConfigOverrides(opts.mcpServers ?? [], this.model);

    // Build the bwrap wrapper ONCE (sandbox setup + per-actor sessions-store bind +
    // auth temp). Reused across a resume→fresh retry so the second spawn still sees
    // the bound auth/config; only the codex args after `--` differ per attempt.
    let spawnCommand = command;
    const spawnCwd = opts.sandbox ? "/" : opts.cwd;
    let bwrapResult: ActorBwrapResult | undefined;

    // Capture the session id for the next wake to resume . codex writes
    // the rollout at session start, so capture regardless of exit code (like
    // agy). Newest-rollout id covers fresh runs (new id), same-file resumes
    // (unchanged id), and resumes that fork a new rollout (new id) alike; fall
    // back to the incoming id so a run that produced no detectable rollout never
    // nulls out a known session.
    const captureSessionId = (): string | undefined =>
      sessionsDir ? (extractNewestCodexSessionId(sessionsDir) ?? opts.session?.id) : undefined;
    const captureBoundModel = (sessionId: string | undefined): string | undefined =>
      sessionsDir && sessionId ? extractCodexBoundModel(sessionsDir, sessionId) : undefined;

    // Spawn codex once with the given CLI args and resolve a RunResult. Does NOT
    // clean up temp files — run() does that once in `finally`, after any retry.
    const spawnCodex = (codexArgs: string[]): Promise<RunResult> => {
      const spawnArgs = bwrapResult
        ? buildActorBwrapCommand(bwrapResult, command, codexArgs)
        : codexArgs;
      const buildResultWithSession = (
        base: Omit<RunResult, "sessionId" | "boundModel" | "tokenUsage">
      ): RunResult => {
        const sessionId = captureSessionId();
        const boundModel = captureBoundModel(sessionId);
        const totals =
          sessionsDir && sessionId
            ? extractCodexTokenUsageFromStore(sessionsDir, sessionId, runStartedAt)
            : null;
        return {
          ...base,
          sessionId,
          boundModel,
          tokenUsage: totals
            ? attributedTokenUsage("codex", boundModel ?? this.model ?? null, totals)
            : unattributedTokenUsage("codex", boundModel ?? this.model ?? null),
        };
      };

      return runSubprocess({
        command: spawnCommand,
        args: spawnArgs,
        cwd: spawnCwd,
        timeoutMs,
        signal: opts.signal,
        onStdout: opts.onStdout,
        onStderr: opts.onStderr,
        onChunk: opts.onChunk,
        // Temp cleanup is owned by run() below, not per-spawn.
        buildKilledResult: ({ output, exitCode, cancelled, interrupted, graceKilled }) =>
          buildResultWithSession({
            success: false,
            output,
            exitCode,
            cancelled,
            interrupted,
            graceKilled,
          }),
        buildSignalResult: ({ output, exitCode, cancelled, interrupted, graceKilled }) =>
          buildResultWithSession({
            success: false,
            output,
            exitCode,
            cancelled,
            interrupted,
            graceKilled,
          }),
        buildExitResult: (output, exitCode) => {
          // Auth-fail alarm: if the run fails with an auth error, alert the operator.
          if (exitCode !== 0 && isCodexAuthFailure(output)) {
            console.error("\n=======================================================");
            console.error(
              "🚨 CODE PROMPT AUTHENTICATION ALARM: Codex subactor run failed due to auth error."
            );
            console.error(
              "The host refresh token might have expired. Please run 'codex login' on the host."
            );
            console.error("=======================================================\n");
          }
          return buildResultWithSession({
            success: exitCode === 0,
            output,
            exitCode,
          });
        },
        buildSpawnErrorResult: (err) =>
          buildResultWithSession({
            success: false,
            output: `Failed to spawn codex: ${err.message}`,
            exitCode: 1,
          }),
      });
    };

    try {
      // Attach MCP servers by writing a temporary config file for this run.
      // Mirror the claude layout: the SOURCE always goes to host /tmp (tmpdir)
      // and for a sandboxed run is --ro-bind-ed to ~/.codex/config.toml.
      const hasMcpServers = opts.mcpServers && opts.mcpServers.length > 0;
      if (opts.sandbox && (hasMcpServers || this.model)) {
        mcpConfigSource = join("/tmp", `rusa-mcp-codex-${randomUUID()}.toml`);
        let baseConfig = "";
        const hostHome = process.env.HOME ?? "/root";
        const hostConfigPath = join(hostHome, ".codex", "config.toml");
        if (existsSync(hostConfigPath)) {
          try {
            baseConfig = readFileSync(hostConfigPath, "utf-8");
          } catch {
            /* best effort */
          }
        }
        // Pin the requested model into the merged config so the inherited host
        // default can never shadow the `--model` flag .
        const stripped = overrideTomlModel(stripMcpServersFromToml(baseConfig), this.model);
        const merged =
          stripped +
          (opts.mcpServers && opts.mcpServers.length > 0
            ? buildCodexMcpConfig(opts.mcpServers)
            : "");
        writeFileSync(mcpConfigSource, merged);
      }

      if (opts.sandbox) {
        // codex is a Node.js script installed globally via npm. The sandbox already
        // mounts the node runtime root (which includes global node_modules) read-only,
        // so codex is available on the sandbox PATH without explicit binary mounting.
        const bResult = buildActorBwrapArgs(
          opts.sandbox.worktreePath,
          "codex",
          mcpConfigSource,
          opts.sandbox.isE2eRoot
        );
        bwrapResult = bResult;
        spawnCommand = "bwrap";
        tempPaths.push(...bResult.tempPaths);
      }

      // Attempt resume when the pre-check cleared it. Fall back to a fresh run on
      // ANY resume failure the pre-check couldn't catch — deeper/mid-file rollout
      // corruption, a version mismatch, or any other load error. `codex exec` exits
      // non-zero on such infra/session errors (not on task-incompletion), so a
      // non-zero resume exit is the right trigger. Skip the fallback for auth
      // failures (a fresh run won't fix bad auth) and for cancellation. This
      // guarantees a bad session self-heals to a fresh one rather than wedging the
      // actor on every wake.
      if (resumeSessionId) {
        const resumeResult = await spawnCodex(
          buildCodexArgs({
            prompt: opts.prompt,
            model: this.model,
            cwd: codexCwd,
            resumeSessionId,
            configOverrides,
          })
        );
        if (
          resumeResult.success ||
          resumeResult.cancelled ||
          isCodexAuthFailure(resumeResult.output)
        ) {
          return resumeResult;
        }
        opts.onChunk?.(
          `\n[codex] resume of session ${resumeSessionId} failed (exit ${resumeResult.exitCode}); falling back to a fresh session\n`
        );
      }

      return await spawnCodex(
        buildCodexArgs({
          prompt: opts.prompt,
          model: this.model,
          cwd: codexCwd,
          configOverrides,
        })
      );
    } finally {
      cleanupMcpConfig();
    }
  }
}
