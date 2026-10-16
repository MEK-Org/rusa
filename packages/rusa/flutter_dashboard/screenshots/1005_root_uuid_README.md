# Configured actor identity evidence (#1005)

The [operator review amendment](https://github.com/MEK-Org/rusa/pull/1005#issuecomment-6204772476) gives the literal legacy `root` actor a minted UUID while preserving its given handle. These renders isolate that identity change; the established synthetic charter, avatar, handle and child relationship are identical on both sides. The PR's earlier default-charter appearance evidence remains separate.

`test/root_uuid_1005_screenshot_test.dart` renders the actual Flutter ActorTree/DetailPanel and phone MeshHeader with a fake API and generated portraits. Every fixture value is synthetic. It asserts the preserved `ember-familiar` handle in all four cases and the visible raw ID on desktop. Functional import, reference, restart and rollback coverage lives in the TypeScript suites; these images demonstrate presentation only.

| View | Before | After |
| --- | --- | --- |
| Desktop, 1360 × 840 | [before](1005_root_uuid_wide_before.png) | [after](1005_root_uuid_wide_after.png) |
| Phone, 390 × 844 | [before](1005_root_uuid_phone_before.png) | [after](1005_root_uuid_phone_after.png) |

The desktop ID changes from `root` to `f42e93fb-94c7-4c2a-bb16-7161b3a9d346`. The phone normally shows the handle rather than the raw ID, so its two captures are byte-identical.

Run from `packages/rusa` with the configured Flutter SDK:

```sh
node scripts/flutter-run.mjs test test/root_uuid_1005_screenshot_test.dart
```

Observed result: 4 passed. Flutter analyze: no issues found. PNGs are captured at pixel ratio 2.

```text
2cdffcfa5098778bdadeaf2e77082989db398bdfc816d7309d64f341a55f1199  1005_root_uuid_phone_after.png
2cdffcfa5098778bdadeaf2e77082989db398bdfc816d7309d64f341a55f1199  1005_root_uuid_phone_before.png
77937b1db22f64b9bf70e0416cc0d35f0f3f6946e93dee0e4537b54e62c95b46  1005_root_uuid_wide_after.png
b3842253ef0af81641a6ab4ad1122b89b032a16309e0d981e3587ce98711b4f0  1005_root_uuid_wide_before.png
```
