# OpenRouter / Pi protocol spike (#808)

This is the first part of the no-schema fixture spike proposed in
[#808](https://github.com/MEK-Org/rusa/issues/808). It implements the Pi RPC wire
boundary for one fresh portable invocation. It is not registered as a production
provider. Importing it cannot launch a harness or spend inference credit.

The contract targets `@earendil-works/pi-coding-agent@0.99.2`, source
`005af57d88ee23b33778f343a9595b32e67ff788`. The opt-in [offline executable receipt](../../../../../docs/spikes/808-pi-offline/README.md)
records startup and selected configuration readbacks for that release, without inference. The authoritative references are
the pinned [RPC protocol](https://github.com/earendil-works/pi/blob/005af57d88ee23b33778f343a9595b32e67ff788/packages/coding-agent/docs/rpc.md),
[commands](https://github.com/earendil-works/pi/blob/005af57d88ee23b33778f343a9595b32e67ff788/packages/coding-agent/docs/rpc-commands.md),
and [events](https://github.com/earendil-works/pi/blob/005af57d88ee23b33778f343a9595b32e67ff788/packages/coding-agent/docs/json.md).

## Implemented boundary

- LF-only framing handles CRLF, split UTF-8 and literal Unicode separators.
  Records, final assistant text and retained request count have limits.
- Before prompting, read back the exact OpenRouter model, reject a nonempty or persistent
  session, and disable automatic inference retries and automatic compaction.
  Explicit effort requires exact readback and capability validation; omitted
  effort uses the harness default. `get_state` exposes the raw thinking level,
  so it does not replace the supported-level check.
- Correlate responses by command ID. Prompt acceptance and `agent_end` do not
  settle the invocation. Wait for `agent_settled`, including when it arrives
  before the prompt response. Rejected, queued or extension-handled prompts fail.
- Provider errors, aborts, reported model changes, malformed records and a stream
  ending before settlement fail. A supplied model must match exactly, including its
  string type. The first recorded execution failure is retained. Success requires the final assistant message
  to end with `stop`; tool-use, length-limited and unfinished turns fail. Only
  the final assistant message supplies output text. Extension/stream errors and
  unexpected retry/compaction events fail. Command diagnostics are omitted.
- Retain one usage observation per completed assistant message received before
  cancellation begins, including partial work reported before interruption.
  Streaming and turn-end echoes do not duplicate it.
  Raw usage is a harness report. It is not a measurement of OpenRouter billed
  cost. Missing reported model or usage stays unknown. Nothing writes accounting
  rows, estimates supplier identity or persists a new provider under another name.
- Cancellation immediately closes this one-shot invocation, including behind a
  stalled write. `cancel()` is awaitable and idempotent. No cooperative abort
  processing or grace period is assumed. Later stdout and EOF are ignored.
  Observations retained before cancellation remain available; later usage is
  dropped. These incomplete observations cannot establish total billed usage.
  Host failure also settles `run()` immediately. The host owns deadlines and
  process-group termination.

`PiRpcTransport` is an injected boundary. Its writer must honor backpressure;
its closer must close stdin and arrange process cleanup even during a stalled
write. Normal writes are serialized through drain. Failure and cancellation close
without waiting for drain. The protocol fixtures implement
this interface in memory. The subprocess fixtures use real stdin/stdout pipes to a
synthetic Node peer. Neither is captured evidence that the released Pi binary
works with Rusa.

## Before production registration

The rest of #808 remains open. A production adapter needs the following evidence:

1. Verify a pinned executable and reuse the supervised subprocess/sandbox path.
   Generate isolated agent/auth/session configuration. Deny ambient project
   settings, instructions, extensions, skills, prompts and extra MCP endpoints.
   Prove this with a poisoned environment and a real offline harness invocation.
2. Supply actor-bound MCP endpoints and fail readiness if any required endpoint
   cannot connect. Prove granted calls work and ungranted calls are refused.
3. Provider invocation permissions and cross-provider credential isolation are a
   separate design question. PR #1112 follows the existing providers, with no
   OpenRouter-only invocation grant or profile restriction, per the
   [operator ruling](https://github.com/MEK-Org/rusa/pull/1112#issuecomment-6266285746).
4. Add opt-in configuration, exact model/capability validation and budget admission.
   Missing, expired or exhausted budget must block even responsive starts, while
   allowing another available pool entry. A prepaid balance does not enter quota
   reset-window pacing. Exercise real provider error translation for 401, 402,
   429, 5xx, stream failure, cancellation and timeout.
5. Prove process cleanup, yield, restart and model-switch portable continuity with
   production supervisor integration. The synthetic subprocess tests prove direct-child
   closure after settlement and EOF before settlement. They do not prove descendant cleanup,
   sandbox or filesystem isolation, in-flight cancellation or real harness continuity.
6. After operator provisioning and routing/data-policy review, run the separate
   capped synthetic smoke test. Record the executable version, adapter head,
   actual emitted records and spend. Durable accounting and its schema review
   remain a separate slice.

## Local fixture verification

From `packages/rusa`, run:

```sh
pnpm exec vitest run src/providers/openrouter/pi-rpc.test.ts src/providers/openrouter/pi-rpc-subprocess.test.ts
```

The settlement test also rejects a mutation that treats `agent_end` as terminal:
it observes transport closure before `agent_settled` and fails. Restore the source
after the mutation before running the normal suite.

The subprocess fixture launches only the current Node executable with an empty
environment and a synthetic RPC peer. It never loads Pi or inference credentials.
The fixture uses the shared subprocess supervisor's opt-in duplex transport.
Writes await stdin callbacks; close destroys stdin, kills the detached process
group, and awaits the direct child's close event. The host feeds stdout bytes
into the protocol decoder and distinguishes actual EOF from termination flushes.
The two cases assert successful settlement and the exact EOF-before-settlement
error. Each has a 10 s test timeout around a 3 s fallback deadline, so a missing
EOF listener fails with the deadline reason. The peer stays alive after settlement
and after closing stdout so direct-child cleanup is exercised. Sandbox reuse,
descendant cleanup verification and real Pi compatibility remain open.


## Worker sandbox prototype

The opt-in adapter supports fresh worker runs through the shared actor bwrap
launcher. The invocation's private Pi state is rebound after the shared `/tmp`
shadow, and Pi starts in its empty working directory. Actor-bound MCP settings,
admission checks, the minimal child environment and RPC supervision also apply
inside bwrap. Native-session resume and computer use remain unsupported.

`provider.test.ts` runs a synthetic RPC peer through real bwrap when available.
It checks writable actor files, hidden sibling files and ungranted secrets,
a visible read-only host file, isolated Pi cwd, synthetic inference-key delivery,
and successful RPC settlement. This does not establish real Pi inference or
complete the remaining production requirements above.

Worker launches use the operator-managed Pi login without a provider-use grant,
matching the existing providers. Model selection follows the ordinary runtime
path. This PR adds no shared-launcher credential masks and accepts saved profiles
containing other provider entries. Broader invocation permissions and credential
isolation are deferred by the
[operator ruling](https://github.com/MEK-Org/rusa/pull/1112#issuecomment-6266285746).

The adapter binds the existing `auth.json` read-only into isolated Pi state for
bwrap workers, without copying credentials or supplying a key environment
variable. Unsandboxed launches reference that file through a symlink. The whole
profile is visible to Pi; settings, MCP configuration and cwd stay isolated.
The synthetic worker test launches without any provider grant, accepts a mixed
profile, and verifies that the bound login rejects writes.
