# #973 failed agy run notice appearance receipt

Matched synthetic captures of the inbox failure notice a parent sees when an
agy run exits non-zero, before and after PR #973, at wide (1100 × 800) and
phone (390 × 844) viewports, at pixel ratio 2.

Each capture comes from the real route: an `AntigravityProvider` run with a
mocked child process and a synthetic per-run `--log-file`, then
`routeRunFailure` with the deterministic exhaustion classifier, then the
resulting `mesh.mechanical_note` payload rendered by the unchanged `InboxTab`.
The before phase runs the same fixture against the staging-base provider
source; the after phase runs #973's provider.

- `signin_failed_*`: the run log records a failed silent sign-in.
- `healthy_control_*`: the run log records the startup "not logged in" lines
  followed by a successful silent sign-in, the shape every healthy run has.

Both scenarios fail with the same unsupported-effort stdout, so the before
notices are identical and their PNGs share one hash. After #973, the notice
gains one fixed status line under the unchanged cause. The provider carries
that line in its own `signInDiagnostic` result field, and `routeRunFailure`
renders it after the output tail. The run output, which exhaustion
classification reads, is unchanged. The captures were first taken when the line
was appended to the output, then re-rendered after the move to the separate
field: the notice text and all eight PNG hashes are identical. No raw log line, URL,
identifier or token reaches the notice. `manifest.json` records the source
revisions, synthetic inputs, exact notice text, dimensions, byte counts and
SHA-256 values.
