#!/usr/bin/env bash
set -euo pipefail

# Make matched synthetic captures from the merge-base dashboard and this head.
# The test fixture is compatible with both: the old decoder ignores the
# completionMatcher field; the #926 decoder renders it. No service is started
# and no live mesh data is used.
repo=$(git rev-parse --show-toplevel)
cd "$repo"
fixture=packages/rusa/flutter_dashboard/screenshots/926/appearance_test.dart.fixture
test_rel=packages/rusa/flutter_dashboard/test/926_completion_matcher_screenshot_test.dart
out_rel=packages/rusa/flutter_dashboard/screenshots/926
base=$(git merge-base origin/staging HEAD)
temp=$(mktemp -d "${TMPDIR:-/tmp}/rusa-926-before.XXXXXX")

cleanup() {
  rm -f "$test_rel"
  if git -C "$repo" worktree list --porcelain | grep -Fq "worktree $temp"; then
    git -C "$repo" worktree remove --force "$temp"
  fi
}
trap cleanup EXIT

for path in "$fixture" "$out_rel"; do
  test -e "$path" || { echo "Required artifact is missing: $path" >&2; exit 1; }
done
test ! -e "$test_rel" || { echo "Temporary test path already exists: $test_rel" >&2; exit 1; }
git worktree add --detach "$temp" "$base"
git -C "$temp" submodule update --init --recursive
mkdir -p "$temp/$out_rel"
cp "$fixture" "$temp/$test_rel"
(
  cd "$temp/packages/rusa"
  FLUTTER_CMD="${FLUTTER_CMD:-flutter}" node scripts/flutter-run.mjs test \
    --dart-define=MATCHER_PHASE=before test/926_completion_matcher_screenshot_test.dart
)
cp "$temp/$out_rel"/*_before.png "$out_rel/"
cp "$fixture" "$test_rel"
(
  cd packages/rusa
  FLUTTER_CMD="${FLUTTER_CMD:-flutter}" node scripts/flutter-run.mjs test \
    --dart-define=MATCHER_PHASE=after test/926_completion_matcher_screenshot_test.dart
)
