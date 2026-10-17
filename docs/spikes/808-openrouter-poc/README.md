# Local OpenRouter provider proof of concept

This implements the end-to-end target in #808: start a disposable Rusa instance,
create its first top-level actor through the dashboard API, run that actor on
OpenRouter through Pi, send a ping over fake human chat and verify the nonce
comes back through the chat-write MCP tool. The runner also requires a successful
run settlement with the requested model before shutting down the instance.

This is an explicit host-execution prototype, not production activation. Set
`RUSA_OPENROUTER_POC=1` and configure `providers.openrouter.openrouterPoc` with
absolute `nodePath`, `piPath` and `apiKeyPath`. The adapter refuses sandbox
requests and native session resumes. The E2E runner uses an explicitly selected
`container-boundary` deployment, so Pi runs on the host. Do not deploy this
prototype as a sandboxed-worker implementation.

## Run

Install repository dependencies with `pnpm install`. Follow the pinned Pi 0.99.2
and Node 22.19.0 download, integrity and dependency setup in
[the offline receipt](../808-pi-offline/README.md#pins-and-setup). Keep that runtime
prefix for this smoke; the service's Node installation does not change.

Provision a dedicated capped OpenRouter inference key and make its file mode
`600`. The script reads the key only inside the adapter and never prints it.
This is a paid, opt-in test. Check the key's cap and remaining balance before
running it. No paid request runs in CI.

From the repository root:

```sh
pnpm --filter rusa exec tsup
# Export GIT_AUTHOR_NAME, GIT_AUTHOR_EMAIL, GIT_COMMITTER_NAME and
# GIT_COMMITTER_EMAIL using the operator-approved identity for the disposable
# scratch commit. No existing Git identity configuration is changed.
node docs/spikes/808-openrouter-poc/smoke.mjs \
  /absolute/pinned-node/bin/node \
  /absolute/pi-package/dist/bundle/cli.js \
  /absolute/private-openrouter-key \
  openai/gpt-4.1-mini
```

The script reserves loopback ports 8323–8327. It creates a private base config and
an instance under `~/.rusa-e2e/openrouter-poc-*`, with fake chat and GitHub. The
current E2E provisioner starts empty; `rootActor` config does not synthesize a
new actor. The script creates the first actor through `POST /api/mesh/actors`
with `contextMode: tail`. No existing instance or production config is edited.

The first setup turn asks the capability-admin actor to grant itself
`chat-write:spaces/e2e-dm`. The runner verifies that durable grant and completed
turn before sending the ping. This exercises the ordinary grant path. The
second turn reads the source message, replies through the newly mounted
chat-write endpoint and handles its inbox. The script checks the chat destination,
nonce and `pong`, then verifies the successful `run_end` and reported model.
It writes `receipt.json` and stops the instance even on failure. Instance state
and logs remain available for inspection; remove that disposable root when done.

## Implemented behavior and remaining work

The provider registry and normal model-selection path resolve `openrouter`.
Each invocation starts a fresh supervised Pi RPC process, validates its exact
model/session state using the existing protocol implementation and passes only
the inference key plus temporary runtime settings in its child environment.
Pi starts in an empty temporary cwd to avoid migrating actor project files.
Only native MCP support is loaded. `--no-builtin-tools` disables filesystem and
shell tools while retaining granted MCP tools. `--no-tools` would disable MCP
as well and therefore does not work for this proof.

Deadline/cancellation and settlement use the existing process-group supervisor;
the provider awaits direct-child close and removes the temporary launch tree.
An actor-workspace `.openrouter-poc/usage-*.json` artifact retains harness usage
observations. It is not an OpenRouter billing receipt or subscription token row.
There are no schema changes and no entries in reset-window quota pacing.

Production checkpoints should be decided against this working implementation.
Remaining work includes worker sandbox/secret-grant integration, model/runtime
provisioning, required-MCP readiness and authorization failure handling, admission
budget controls, durable cost accounting, improved error diagnostics, portable
context behavior across real tasks and broader tool/process containment. The
prototype has a 120-second invocation ceiling and disables automatic retries and
compaction; the provider-side key cap remains the spend authority.

## Observed results

See `receipt.json` for the successful local smoke receipt. The historical
`anthropic/claude-sonnet-4` used in offline probes was absent from OpenRouter's
model listing during this run; the live proof uses `openai/gpt-4.1-mini`.
