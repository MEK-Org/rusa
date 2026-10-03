# Run prompt disclosure appearance evidence

Synthetic fixtures only; no live actors, user prompts, credentials or private data.

Before source: `53b52993d858ca8b932811ded654016525eab54b`.
After product source: `709ab01710387832693490f04c362a433ca8dece` (PR #874).
The six after captures were rerun at that exact committed product head.
The same screenshot harness was copied unchanged to the detached before tree for its two captures.

Harness: `packages/rusa/flutter_dashboard/test/run_prompt_screenshot_test.dart`.
It renders the real EventsTab with a synthetic FakeApi run_start event and synthetic prompt response.
Wide viewport: 1180 x 820 logical pixels; narrow: 390 x 844; capture DPR: 2.

| State | Wide | Narrow |
| --- | --- | --- |
| Before | [wide-before.png](wide-before.png) | [narrow-before.png](narrow-before.png) |
| After collapsed | [wide-collapsed.png](wide-collapsed.png) | [narrow-collapsed.png](narrow-collapsed.png) |
| After expanded | [wide-expanded.png](wide-expanded.png) | [narrow-expanded.png](narrow-expanded.png) |
| After unavailable | [wide-unavailable.png](wide-unavailable.png) | [narrow-unavailable.png](narrow-unavailable.png) |

The expanded capture intentionally uses a short synthetic prompt with the truncation banner's synthetic 300000-byte metadata. It demonstrates the banner and layout, not a real 256-KiB retained row. Byte-boundary and original-count behavior are separately covered by repository tests.

Current production captures have unknown provenance and are unavailable through the endpoint. The expanded response is a synthetic fixture; these pictures do not imply production disclosure is currently available. No appearance approval is claimed.

Commands (private Flutter SDK overlay, supported tools; no modification of shared SDK):

```sh
RUSA_866_SCREENSHOTS=<output> <sdk>/bin/cache/dart-sdk/bin/dart <sdk>/bin/cache/flutter_tools.snapshot --no-version-check test --no-pub test/run_prompt_screenshot_test.dart
RUSA_866_CAPTURE_SOURCE=before RUSA_866_SCREENSHOTS=<output> <sdk>/bin/cache/dart-sdk/bin/dart <sdk>/bin/cache/flutter_tools.snapshot --no-version-check test --no-pub test/run_prompt_screenshot_test.dart
```

Observed: six after tests and two before tests passed, exit 0. All eight PNGs visually inspected. SHA-256 digests are in [SHA256SUMS](SHA256SUMS).

This branch contains evidence only beyond the product head. It is not intended for a product merge.
