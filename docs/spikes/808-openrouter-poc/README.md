# Local OpenRouter provider proof of concept

This implements the end-to-end target in #808: start a disposable Rusa instance,
create its first top-level actor through the dashboard API, run that actor on
OpenRouter through Pi, send a ping over fake human chat and verify the nonce
comes back through the chat-write MCP tool. The runner also requires a successful
run settlement before shutting down the instance.

OpenRouter is an ordinary provider: configure `providers.openrouter: { cliCommand: pi }`.
`cliCommand` selects the Pi adapter and names the executable, the same way
`antigravity` runs `agy`; the provider name stays `openrouter` for model routing.
Launch the installed `pi` on the service PATH, then run `/login openrouter`.
The saved login comes from the selected `PI_CODING_AGENT_DIR` or Pi's normal
`~/.pi/agent` location. The adapter validates the
OpenRouter entry and exposes the selected existing
`auth.json` through a read-only bind for workers or a symlink for unsandboxed
launches. The whole saved profile is visible to Pi, including other provider
entries. Run settings, MCP configuration and cwd remain isolated. Missing or
unsupported login produces an authentication-required
error. Command-based API key entries are unsupported. No mesh key file or
`OPENROUTER_API_KEY` is supplied. The operator's auth file is never modified.

Worker runs use the shared bwrap launcher. Native session resumes and computer
use remain unsupported; portable context and a model are required.
The `pi` executable and its Node runtime must be available on the service PATH.

## Run

Install repository dependencies with `pnpm install` and install Pi globally.
Authenticate by launching `pi`. The following smoke is a paid, opt-in test using
that provider account; no paid request runs in CI.

```sh
pnpm --filter rusa exec tsup
# Supply the operator-approved Git identity variables for the scratch commit.
node docs/spikes/808-openrouter-poc/smoke.mjs openai/gpt-4.1-mini
```

The script uses loopback ports 8323–8327. It creates a private base config and
an instance under `~/.rusa-e2e/openrouter-poc-*`, with fake chat and GitHub. Before every POST the Linux-only runner checks
procfs to verify that both dashboard and chat listeners belong to its spawned
child or descendants. An occupied port owned by another process is refused. The
current E2E provisioner starts empty; `rootActor` config does not synthesize a
new actor. The script creates the first actor through `POST /api/mesh/actors`
with `contextMode: tail`. No existing instance or production config is edited.

The first setup turn asks the capability-admin actor to grant itself
`chat-write:spaces/e2e-dm`. The runner verifies that durable grant and completed
turn before sending the ping. This exercises the ordinary grant path. The
second turn reads the source message, replies through the newly mounted
chat-write endpoint and handles its inbox. The script checks the chat destination,
nonce and `pong`, then verifies the successful `run_end`.
It writes `receipt.json` and stops the instance even on failure. Instance state
and logs remain available for inspection; remove that disposable root when done.

## Implemented behavior and remaining work

The provider registry and normal model-selection path resolve `openrouter`.
Each invocation starts a fresh supervised Pi RPC process, validates its exact
model/session state using the existing protocol implementation and passes only
the existing saved login plus temporary runtime settings.
Pi starts in the resolved actor workspace, while its HOME, agent configuration,
cache and MCP configuration remain per-invocation private state. This restores
repository discovery and durable workspace changes across fresh invocations.
Pi 0.99.2 with `--no-approve` treats the workspace as untrusted, so project
`.pi/settings.json`, `.pi/mcp.json`, extensions, skills, prompts and themes are
ignored. Its one project-side effect is the startup migration that renames
`<cwd>/.pi/commands` to `<cwd>/.pi/prompts` when only the former exists; that
rename is part of the actor-workspace boundary. The synthetic runtime proof
starts from a nonempty repository before exercising the two fresh invocations.
Pi's built-in filesystem and shell tools remain enabled alongside granted MCP
tools. Worker launches use the shared actor Bubblewrap boundary. Only the native
MCP extension and generated admission extension are loaded.

Deadline/cancellation and settlement use the existing process-group supervisor;
the provider awaits direct-child close and removes the temporary launch tree.
Private, exclusive-create `usage-<UUID>.json` observations go to
`$RUSA_HOME/artifacts/openrouter`, never the actor cwd. They are not OpenRouter
billing receipts or subscription token rows. A failed receipt write is logged
and does not change the run result. Receipts are retained without rotation for
this opt-in prototype's review; remove them with the disposable home.
There are no schema changes and no entries in reset-window quota pacing.

Production checkpoints should be decided against this working implementation.
Remaining work includes model/runtime provisioning, richer MCP admission and
authorization failure handling, admission
budget controls, durable cost accounting, portable-context behavior across real tasks
and broader tool/process containment. Portable context is required. The provider
declares no reasoning-effort capability, so selection rejects an effort and Pi
uses its default. The Actor-supplied deadline owns a normal run; a
standalone adapter call retains its 120-second fallback. The adapter disables
automatic retries, compaction and cache warming (`cacheWarming: "off"`); account-side
limits remain external to this prototype. Provider invocation permissions and cross-provider
credential isolation are
deferred to a broader design discussion. Per the
[operator ruling](https://github.com/MEK-Org/rusa/pull/1112#issuecomment-6266285746),
this prototype uses the same provider-use standard as existing providers,
without an OpenRouter-only grant or mixed-profile rejection.

## Observed results

See `receipt.json` for the successful local smoke receipt. The historical
`anthropic/claude-sonnet-4` used in offline probes was absent from OpenRouter's
model listing during this run; the live proof uses `openai/gpt-4.1-mini`.


The pinned Pi MCP extension (`dist/extensions/mcp/index.js:872-906`) waits at most
10 seconds for direct MCP connections, then proceeds even if they failed or
remain pending. This adapter loads a second, host-generated extension. Before
each inference turn it waits up to 12 seconds for at least one registered tool
in every required namespace, then exits Pi with code 78 if any is absent. Hook
exceptions alone are insufficient because Pi's extension runner catches them.
Empty-tool servers and ambiguous/long namespaces are refused by this PoC.
This verifies tool registration, not permission for every operation or future
connection health. Synthetic tests cover connected, delayed, missing and empty
tool sets; no additional paid smoke was run for the review amendment.

Pi's `pi-ai/dist/api/openai-completions.js:160` initializes assistant `model`
from `model.id`. The retained RPC `reportedModel` observations are therefore Pi
configuration echoes, not verified OpenRouter response identities. Every supplied
mismatch still fails the existing RPC boundary, and an absent observation stays
absent. The provider leaves `RunResult.model` unset. The historical receipt is
preserved with this provenance caveat; it proves the nonce reply and settlement,
not upstream model identity.

Offline review checks:

```sh
node --test docs/spikes/808-openrouter-poc/ownership.test.mjs
pnpm --filter rusa exec vitest run src/providers/openrouter/provider.test.ts src/providers/openrouter/mcp-admission.test.ts src/providers/provider-selection.test.ts
```

The real Pi 0.99.2 offline guard probe exited 78 with zero requests to its
synthetic inference endpoint. It uses a fake key and local-only model base URL:

```sh
/absolute/pinned-node/bin/node --experimental-strip-types \
  docs/spikes/808-openrouter-poc/mcp-guard-probe.mjs \
  /absolute/pi-package/dist/bundle/cli.js
```

The original full-suite run did not produce a final summary before its process
ended. Its log records failures in icon assets, quota integration, concurrent
migration and Flutter detection. Treat it as incomplete, not passing; no baseline
comparison is claimed. Hosted Checks at the original head passed according to
the review steward; replacement-head Checks and two fresh verdicts are required.
