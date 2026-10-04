#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../.."
fixture=flutter_dashboard/screenshots/884
baseline=src/providers/codex-baseline.fixture.ts
capture=src/providers/codex-appearance-receipt.test.ts
render=flutter_dashboard/test/884_appearance_receipt_test.dart
for path in "$baseline" "$capture" "$render"; do
  if [[ -e "$path" ]]; then echo "Temporary receipt path already exists: $path" >&2; exit 1; fi
done
trap 'rm -f "$baseline" "$capture" "$render"' EXIT
git show a06afc8b8cea58fa789688eafa1ccd79c194fef0:packages/rusa/src/providers/codex.ts > "$baseline"
cp "$fixture/generate-notices.ts.fixture" "$capture"
cp "$fixture/appearance_test.dart.fixture" "$render"
pnpm exec vitest run --typecheck.enabled false "$capture"
node scripts/flutter-run.mjs test test/884_appearance_receipt_test.dart
