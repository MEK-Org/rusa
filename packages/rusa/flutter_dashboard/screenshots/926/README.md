# #926 completion-matcher appearance receipt

These are matched synthetic dashboard captures for PR #926. They show the
read-only completion matcher in the Work detail's facts column, at wide
(1400 × 900) and narrow (390 × 844) viewports, at pixel ratio 2.

The fixture uses only synthetic identifiers and a synthetic `pr_merged`
matcher, recorded as closed without merging, in the detail-snapshot JSON. Both phases receive the same JSON. The
pre-change dashboard at merge-base `39cfeb0c86f707195dfab6c5bdeeac30f87d9179`
ignores the then-unknown `completionMatcher` key; #926's dashboard decodes it
and renders the panel in its unmerged-close state: the canonical target, the
hedged "PR was closed without merging at" label, and the setter. The
resolution line is reserved for deployed matchers and is absent here.
No dashboard service, actor, or live obligation is queried.

Run from the repository root with a writable Flutter SDK:

```sh
FLUTTER_CMD=/tmp/flutter-sdk/bin/flutter \
  bash packages/rusa/flutter_dashboard/screenshots/926/regenerate.sh
```

The script creates an isolated detached merge-base worktree for the before
phase, initializes its public submodule, runs the temporary fixture against
both source revisions, and removes the temporary worktree and test source when
it exits. `manifest.json` records source revisions, dimensions, byte counts and
SHA-256 values for the four PNGs.
