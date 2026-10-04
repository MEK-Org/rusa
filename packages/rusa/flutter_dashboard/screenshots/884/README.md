Matched synthetic failure notices for #884. The baseline adapter is staging
`a06afc8b8cea58fa789688eafa1ccd79c194fef0`; the after adapter is this PR.
Actual `RunResult` values pass through `routeRunFailure` with the deterministic
classifier, then their mechanical inbox notes and forensics render in the existing
`InboxTab` using FakeApi. No live provider or dashboard requests occur.

Three matching scenarios each have wide (1100 × 800) and narrow (390 × 844)
before/after PNGs at pixel ratio 2:

- `interrupted`: one completed assistant event, then external SIGTERM. Parsed text
  precedes the labeled raw tail, even with zero omissions; the raw JSON repeats
  semantic text. The label distinguishes the raw portion from the answer.
- `auth`: early `unauthorized`, 192 KiB of synthetic whitespace, a terminal
  diagnostic, exit 1, no parsed text. The new summary describes a raw phrase match,
  not an independently verified authentication failure.
- `quota`: early `quota exhausted`, the same whitespace/terminal diagnostic and
  exit 1. The notice retains its existing quota lead and adds bounded matched-term
  evidence when the raw marker was evicted.

Whitespace makes the terminal summary and added evidence readable; these are
representative synthetic notices, not production observations. Other evicted
network/composite terms use the same evidence format. Large non-whitespace tails
can fill the existing last-800-character failure summary. No widget/layout/style,
schema or wire change. The deterministic fallback ignores the exact omitted-byte
label line, so its count cannot satisfy the `429` or `5`/`hour`/`limit` rules.
Matched-fact preservation compares original raw facts with the raw tail and does
not promise remote-classifier equivalence. Matt's personal appearance approval remains required.

Regenerate from the repository root with installed pnpm and a writable Flutter SDK:

```sh
bash packages/rusa/flutter_dashboard/screenshots/884/regenerate.sh
```

`regenerate.sh` materializes the baseline from the pinned public git commit,
copies the two committed `.fixture` sources into temporary test locations, runs
the actual adapter/failure-sink receipt and Flutter rendering, then removes those
temporary sources. It refuses to overwrite existing files. `notices.json` holds
the observed synthetic notes; no raw giant fixtures or private evidence is included.
`manifest.json` pins PNG sizes/hashes/dimensions and adapter/classifier source blobs.
The evidence directory follows the existing dashboard screenshot convention.
