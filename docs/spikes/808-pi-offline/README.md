# Pi 0.99.2 offline compatibility receipt

This opt-in probe sends only five state/configuration RPC commands to a real Pi
child through Rusa's shared supervisor. It sends no prompt and supplies no
inference credential. It is separate from CI and production registration.

## Pins and setup

Observed on Linux x64, 2026-10-17. Host Node 20.19.2 cannot start this Pi release
(missing `node:module.enableCompileCache`). Use the temporary Node below; leave
the service runtime unchanged.

* Pi: `@earendil-works/pi-coding-agent@0.99.2`, source
  `005af57d88ee23b33778f343a9595b32e67ff788`.
* Pi archive SHA-512 (hex):
  `e91d4167637bec2ad57067f7782d8aa2f4f3d50e1162201ec9dbd55904f9e3a3767e2d6705cf356944656ce64282bb96a16f5563f52b2f30f29c5e184e8969a0`.
* Node `v22.19.0`, linux-x64 archive SHA-256:
  `c0649af18e6a24f6fe5535a3e86b341dd49a8e71117c8b68bde973ef834f16f2`.
* Published npm-shrinkwrap.json SHA-256:
  `036c4af893d78da7df2d8b1464db904e8e2c4ad73a4d6c572f1161699fdaedf5`.

From the repository root, with curl, tar, sha256sum, sha512sum, diff, pnpm and the
repository dependencies installed:

```sh
probe_dir=$(mktemp -d)
export probe_dir
curl --fail --location https://nodejs.org/dist/v22.19.0/node-v22.19.0-linux-x64.tar.xz -o "$probe_dir/node.tar.xz"
echo "c0649af18e6a24f6fe5535a3e86b341dd49a8e71117c8b68bde973ef834f16f2  $probe_dir/node.tar.xz" | sha256sum -c -
tar -xJf "$probe_dir/node.tar.xz" -C "$probe_dir" --no-same-owner
curl --fail --location https://registry.npmjs.org/@earendil-works/pi-coding-agent/-/pi-coding-agent-0.99.2.tgz -o "$probe_dir/pi.tgz"
echo "e91d4167637bec2ad57067f7782d8aa2f4f3d50e1162201ec9dbd55904f9e3a3767e2d6705cf356944656ce64282bb96a16f5563f52b2f30f29c5e184e8969a0  $probe_dir/pi.tgz" | sha512sum -c -
tar -xzf "$probe_dir/pi.tgz" -C "$probe_dir" --no-same-owner
echo "036c4af893d78da7df2d8b1464db904e8e2c4ad73a4d6c572f1161699fdaedf5  $probe_dir/package/npm-shrinkwrap.json" | sha256sum -c -
cp "$probe_dir/package/package.json" "$probe_dir/package/package.json.original"
PATH="$probe_dir/node-v22.19.0-linux-x64/bin:$PATH" npm --prefix "$probe_dir/package" pkg delete devDependencies
diff "$probe_dir/package/package.json.original" "$probe_dir/package/package.json" || [ "$?" -eq 1 ]
PATH="$probe_dir/node-v22.19.0-linux-x64/bin:$PATH" npm --prefix "$probe_dir/package" ci --omit=dev --ignore-scripts --no-audit --no-fund --legacy-peer-deps
echo "036c4af893d78da7df2d8b1464db904e8e2c4ad73a4d6c572f1161699fdaedf5  $probe_dir/package/npm-shrinkwrap.json" | sha256sum -c -
env -i NODE_COMPILE_CACHE="$probe_dir/version-compile-cache" "$probe_dir/node-v22.19.0-linux-x64/bin/node" "$probe_dir/package/dist/bundle/cli.js" --version
pnpm --filter rusa exec tsup src/providers/subprocess-execution.ts --format esm --no-config --out-dir "$probe_dir/supervisor"
node docs/spikes/808-pi-offline/probe.mjs "$probe_dir/supervisor/subprocess-execution.js" "$probe_dir/node-v22.19.0-linux-x64/bin/node" "$probe_dir/package/dist/bundle/cli.js" > "$probe_dir/receipt.jsonl"
cat "$probe_dir/receipt.jsonl"
```

Stop on any failed command. Retain the receipt, then remove the temporary prefix
when finished. Downloads and dependency installation require network access;
the RPC launch uses an explicitly empty inherited environment plus only the six
entries logged in the receipt. `PI_OFFLINE` is not a network sandbox.

The pinned Node archive includes npm 10.9.3. Its `pkg delete devDependencies`
command removes development dependencies from the temporary manifest without
other value changes. The copy and diff commands print the minimal manifest
change for inspection (diff exits 1 for expected differences). The first npm 10.9.3
`ci --omit=dev --ignore-scripts` attempt crashed in peer resolution; adding
`--legacy-peer-deps` exposed development dependencies missing from the published
production shrinkwrap. With the manifest edit and commands above, installation completed
with 121 packages. The shrinkwrap remained unchanged. The expected manifest
diff removes only this block:

```diff
-	"devDependencies": {
-		"@earendil-works/pi-client": "^0.99.2",
-		"@earendil-works/pi-protocol": "^0.99.2",
-		"@earendil-works/pi-server": "^0.99.2",
-		"@types/cross-spawn": "6.0.6",
-		"@types/hosted-git-info": "3.0.5",
-		"@types/node": "22.19.19",
-		"@types/proper-lockfile": "4.1.4",
-		"@types/semver": "7.7.1",
-		"marked": "18.0.11",
-		"shx": "0.4.0",
-		"vitest": "4.1.11"
-	},
```

## Observations and limits

`startup-receipt.log` preserves the original mixed-format five-command receipt using the supervisor
from reviewed head `69d388d90f4e7e3533b207812775d6919783091a`. Its executable probe
was the local predecessor of `probe.mjs`. The log is retained as the original
five-command evidence requested in the [#808 follow-up](https://github.com/MEK-Org/rusa/issues/808#issuecomment-6229400004);
it is historical evidence, not the output of the current three-scenario probe.

All three scenarios correlate five IDs/commands, report the exact requested
OpenRouter model, zero messages/pending messages, no session file, and no streaming.
The launch has no tools, extensions, skills, templates, context discovery or
themes. The child remains alive until supervisor close. The observed child
signal is SIGKILL. `result.exitCode: 0` is the probe's normalized signal result,
not a natural child exit status. The probe awaits direct-child closure and
asserts ENOENT after deleting each temporary launch directory. This cleanup
assertion covers only that directory. The current probe sets `NODE_COMPILE_CACHE`
to a directory inside each launch root and asserts that Pi creates it before
cleanup. The documented version command writes its cache under
`$probe_dir/version-compile-cache`, removed with the setup prefix.
`startup-isolation-receipt.jsonl` records the current 31-record probe against the
supervisor built from staging `ef54a3c0`. All three cache-presence and launch-cleanup
assertions pass. The [historical cache receipt](https://github.com/MEK-Org/rusa/blob/ef54a3c0ce6acf93b538ce94adf3b8757209b4e7/docs/spikes/808-pi-offline/cache-contained-receipt.jsonl)
records the previous three-scenario probe.

The [historical isolation receipt](https://github.com/MEK-Org/rusa/blob/bacefb9fe5be37b726b27265cbfbe4b4c7aeed7d/docs/spikes/808-pi-offline/isolation-receipt.jsonl)
predates this environment change and used the supervisor from staging `8009e5bd`. A
[reviewer observed](https://github.com/MEK-Org/rusa/pull/1095#discussion_r4301696109)
that its version launch wrote `/tmp/node-compile-cache` and RPC startup recreated
an empty cache directory there. The current change redirects this known cache
path; it does not inventory every filesystem write or establish a filesystem
sandbox. It does not remove caches left by historical runs.

Source inspection of pinned Pi `dist/main.js` shows `runMigrations(cwd)` before
startup settings and runtime project trust. The launched `dist/bundle/cli.js`
contains the same ordering in `dist/bundle/chunks/chunk-3YAHQSW6.js`.
The unbundled `dist/migrations.js` calls
`migrateExtensionSystem(cwd)`, which can rename project `.pi/commands` to
`.pi/prompts` before resource discovery. This fixture follows the source finding
reported in [#808](https://github.com/MEK-Org/rusa/issues/808#issuecomment-6231245069).
The `untrusted-poison` scenario exercises this with a synthetic
`cwd/.pi/commands/marker.md` alongside its conflicting settings. Despite
`--no-approve` and all the discovery-disable flags,
startup removes `commands/` and creates `prompts/` containing the exact marker
bytes. Each complete stdout line parses as JSON, and the buffer is empty after
termination, so no partial stdout tail remains. Stderr contains exactly
`Migrated Project commands/ → prompts/` followed by a newline. The other two
scenarios require empty stderr. The first migration run failed the old
empty-stderr assertion; the current assertion records this observed notice.

The migration scenario also seeds `HOME/.pi/agent/commands/marker.md`. With
`PI_CODING_AGENT_DIR` pointing elsewhere, that ambient marker remains unchanged
and no adjacent `prompts/` appears. Source inspection of pinned Pi 0.99.2
(`dist/migrations.js`, `migrateExtensionSystem`) shows that Global migration
targets the explicit `PI_CODING_AGENT_DIR`. The probe owns that directory and
seeds it without a `commands/` directory; this fixture does not distinguish
Global migration running from being skipped. No credential or executable
fixture is used.

A production design still needs an explicit workspace/configuration boundary;
discovery-disable flags alone do not provide it.

| Scenario | Conflicting settings | Initial compaction | After RPC disable |
| --- | --- | --- | --- |
| baseline | none outside explicit agent directory | false | false |
| untrusted-poison | HOME/.pi/agent and cwd/.pi, plus synthetic legacy command files, with --no-approve | false | false |
| trusted-control | same conflicting settings, with --approve | true | true |

Poison files enable compaction and request a conflicting model/provider. All
scenarios explicitly disable warming/retry and pin the requested CLI model.
The trusted control demonstrates that the project poison is effective. Pi reports
success for `set_auto_compaction(false)` while effective state remains true under
the trusted project override. The first probe run expected false after that
command and failed; the retained receipt asserts the observed override behavior.
This records Pi 0.99.2 behavior, not desired behavior. Whether this precedence is
intentional or an upstream bug is unknown. A change in this pinned observation
should fail the probe and require review.
Production admission must verify effective state rather than trust success alone.

The state assertions cover only the reported model and compaction setting. They do
not establish complete configuration/credential isolation, denied extra tools,
network isolation, native MCP readiness/authorization, descendant containment,
inference behavior, budgets or accounting. Startup reads project settings before
runtime trust handling. The migration fixture proves one startup write, not an
exhaustive inventory of startup side effects.
#808 and its paid-test/registration gates remain open.
