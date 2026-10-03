# Durable local human appearance evidence

PR #875 before/after appearance review, using synthetic data only. Before server source: `876012d75afaa95a131f6ecb8e1e5117745db609`. After server source: `f5ed13d8a4ccde1ba3c4bf628cee0816dc6ee0f6`. Both complete Flutter source trees equal `92062cdb6df8b2ab1cd7e0103031a87bf065d4aa`. [Source pins](source-pins.json) verify nine rendering dependencies and this relation.

PR1 changes server identity inputs without changing Flutter source. An auth-disabled zero-user startup previously left no durable user and attributed new local messages to `human:operator`; startup now bootstraps a durable principal, and new messages/replies use that UUID. The [approved plan](https://github.com/MEK-Org/rusa/issues/597#issuecomment-5971079774) and [verified final-head proof](https://github.com/MEK-Org/rusa/pull/875#issuecomment-5973198455) provide the implementation/behavior receipts. These images exercise the real EventsTab and ActorAvatar with representative synthetic input, not a running startup or production account.

The single release web binary was built at the after source with the same [fixture](principal_web_capture.dart), then rendered twice with before/after inputs. A reserved synthetic UUID stands in for the repository-minted durable ID. The fake API supplies those input shapes; widgets and their fallback code are unmodified. The loopback helper returns an actual synthetic 404 for avatar requests so ActorAvatar renders its existing error fallback. The header caption identifies the fixture and is outside the product widgets.

Observed appearance change: the Events Log's `to`/`from` labels show a durable UUID instead of `human:operator`; the unchanged avatar fallback shows a paw instead of a person because its current literal branch recognizes only the alias. The narrow labels wrap without overflow. These images disclose that existing behavior; no appearance repair or approval is claimed.

| Viewport | Before | After |
| --- | --- | --- |
| Wide 1180×820 | [wide-before.png](wide-before.png) | [wide-after.png](wide-after.png) |
| Narrow 390×844 | [narrow-before.png](narrow-before.png) | [narrow-after.png](narrow-after.png) |

All four original-resolution frames were visually inspected. They show the avatar fallback, Kind filter, All Events, timestamps, message_sent/message_received badges, complete synthetic text and direction labels. DPR 2; Flutter CanvasKit release; Playwright with local headless Google Chrome. No pixels were edited or synthesized. External browser requests are blocked.

Copy the fixture into the after checkout at packages/rusa/flutter_dashboard/test/principal_web_capture.dart. From flutter_dashboard, run:

```sh
<private-sdk>/bin/cache/dart-sdk/bin/dart <private-sdk>/bin/cache/flutter_tools.snapshot --no-version-check build web --release --no-pub --no-web-resources-cdn --target test/principal_web_capture.dart --output-dir <workspace>/evidence/597-appearance-web
python3 configure-browser-assets.py <workspace>/evidence/597-appearance-web <private-sdk>/bin/cache/artifacts/material_fonts/Roboto-Regular.ttf after
```

Observed build: 70.8s, exit 0. Retained build stdout SHA256 `c70442b157dc8768888cab061b1fbaf4c2fd2e91ae141192e978a93c7ad82ae0`. Roboto-Regular.ttf is registered locally for Roboto/system-ui/monospace in both states; MaterialIcons comes from the compiled SDK asset. The first capture attempt failed because the helper did not serve the configured `/after/` asset prefix; the corrected helper maps that prefix and completed all four states. The failed attempt remains private evidence and is not a successful receipt.

Copy browser-capture.cjs to the after checkout and run from its repository root:

```sh
node packages/rusa/597-appearance-capture.cjs
```

[Capture log](capture.log): four states captured, exit 0, four actual synthetic avatar 404s. The helper requires the event labels, waits for fonts/raster work and warms GPU readback. [SHA256SUMS](SHA256SUMS) pins this evidence. The temporary fixture/helper were removed from the clean product checkout; this branch changes only review artifacts. Matt's appearance approval remains held.
