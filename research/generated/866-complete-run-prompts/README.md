# Complete run prompt appearance evidence

Synthetic fixtures only; no live actors, credentials or user prompts. The exact-text contract is [issue #866 comment 5972303770](https://github.com/MEK-Org/rusa/issues/866#issuecomment-5972303770); the bounded retrieval disposition is [5972967230](https://github.com/MEK-Org/rusa/issues/866#issuecomment-5972967230).

Before source: `876012d75afaa95a131f6ecb8e1e5117745db609`. After product source: `4fc6059a18a4b9420777438c452e939f6957182e` (PR #874). The after web binary was built at `59cb942011b837742c1fb875534438426d30bcfe`; its complete Flutter subtree and pinned dependencies are byte-identical at the final product head. [Source pins](source-pins.json) include the disclosure widget. The same [fixture](run_prompt_web_capture.dart) renders the real EventsTab using synthetic FakeApi data. Fonts use the private SDK Roboto-Regular.ttf registered locally for Roboto/system-ui/monospace identically in both trees; the product theme is unchanged.

Wide viewport 1180×820; narrow 390×844; DPR 2. Flutter CanvasKit release web build and local headless Google Chrome, Playwright capture. All eight fresh frames were visually inspected at original resolution. The filter, timestamp, run_start badge and resolved-model text remain visible. Expanded text wraps in the narrow viewport; the Provider banner is removed, and unavailable reads display “Prompt unavailable.”

| State | Wide | Narrow |
| --- | --- | --- |
| Before | [wide-before.png](wide-before.png) | [narrow-before.png](narrow-before.png) |
| Collapsed | [wide-collapsed.png](wide-collapsed.png) | [narrow-collapsed.png](narrow-collapsed.png) |
| Expanded | [wide-expanded.png](wide-expanded.png) | [narrow-expanded.png](narrow-expanded.png) |
| Unavailable | [wide-unavailable.png](wide-unavailable.png) | [narrow-unavailable.png](narrow-unavailable.png) |

Copy the fixture into each initialized source tree at packages/rusa/flutter_dashboard/test/run_prompt_web_capture.dart and run pub get. From flutter_dashboard:

```sh
<private-sdk>/bin/cache/dart-sdk/bin/dart <private-sdk>/bin/cache/flutter_tools.snapshot --no-version-check build web --release --no-pub --no-web-resources-cdn --target test/run_prompt_web_capture.dart --output-dir <workspace>/evidence/866-review-final-web-after
python3 configure-browser-assets.py <workspace>/evidence/866-review-final-web-after <private-sdk>/bin/cache/artifacts/material_fonts/Roboto-Regular.ttf after
```

The final after build exited 0 in 140.5s. Its retained stdout SHA256 is `7063009ecbfee66c9f5f8d557dd5479f616928cad70699e96866cda1d0fbad3d`. The unchanged baseline binary was reused from the prior observed 394.6s exit-0 build at the before source, served from evidence/866-simplified-web-before. All eight PNGs were newly captured using the final helper. Copy browser-capture.cjs into the after checkout, then run:

```sh
node packages/rusa/866-review-capture.cjs
```

The script serves compiled fixtures only on loopback, blocks external browser requests, requires the existing event labels, clicks the real disclosure, and waits for loading to finish and raster work to settle. SelectableText does not expose its content through CanvasKit semantics; expanded content was verified visually. Fonts-ready, twelve animation frames, settling and a warm GPU readback precede retained PNGs. [Capture log](capture.log): eight states captured, exit 0. No pixels were edited. [SHA256SUMS](SHA256SUMS) pins the evidence files. This evidence branch is separate from the product branch; no appearance approval is claimed.
