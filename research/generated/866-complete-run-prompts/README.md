# Complete run prompt appearance evidence

Synthetic fixtures only; no live actors, credentials or user prompts. This replaces prior provenance/truncation evidence following the operator scope clarification in issue #866 comment 5972303770.

Before source: `876012d75afaa95a131f6ecb8e1e5117745db609`.
After product source: `c1746723b3692b7cab53252111c35f826581dd73` (PR #874).
Source dependency SHA256 pins are in [source-pins.json](source-pins.json). The same [fixture](run_prompt_web_capture.dart) renders the real EventsTab using synthetic FakeApi data in both source trees. Fonts use the private SDK Roboto-Regular.ttf registered locally for Roboto/system-ui/monospace identically in both trees; the product theme is unchanged.

Wide viewport 1180×820; narrow 390×844; DPR 2. Flutter CanvasKit release web build and local headless Google Chrome, Playwright capture. All eight frames were visually inspected at original resolution; filter, timestamp, run_start badge and resolved-model text remain visible. Expanded text wraps in the narrow viewport. The prompt is a short synthetic example with no truncation banner or fabricated byte metadata.

| State | Wide | Narrow |
| --- | --- | --- |
| Before | [wide-before.png](wide-before.png) | [narrow-before.png](narrow-before.png) |
| Collapsed | [wide-collapsed.png](wide-collapsed.png) | [narrow-collapsed.png](narrow-collapsed.png) |
| Expanded | [wide-expanded.png](wide-expanded.png) | [narrow-expanded.png](narrow-expanded.png) |
| Unavailable | [wide-unavailable.png](wide-unavailable.png) | [narrow-unavailable.png](narrow-unavailable.png) |

Copy the fixture into each source tree at packages/rusa/flutter_dashboard/test/run_prompt_web_capture.dart, initialize its submodules, and run pub get. From each flutter_dashboard directory:

```sh
<private-sdk>/bin/cache/dart-sdk/bin/dart <private-sdk>/bin/cache/flutter_tools.snapshot --no-version-check build web --release --no-pub --no-web-resources-cdn --target test/run_prompt_web_capture.dart --output-dir <workspace>/evidence/866-simplified-web-after
python3 configure-browser-assets.py <workspace>/evidence/866-simplified-web-after <private-sdk>/bin/cache/artifacts/material_fonts/Roboto-Regular.ttf after
```

Use output 866-simplified-web-before and base before for the baseline. Both observed builds exited 0: after 378.4s, before 394.6s. The existing optional Wasm interoperability warnings do not affect these CanvasKit captures. Copy browser-capture.cjs to the after checkout's packages/rusa/866-complete-capture.cjs, then run from that checkout root:

```sh
node packages/rusa/866-complete-capture.cjs
```

The script serves only the compiled fixtures on loopback, blocks external browser requests, requires the existing event labels, clicks the real disclosure, waits for fonts/raster work, and warms GPU readback before retaining PNGs. [Capture log](capture.log): eight states captured, exit 0. No pixels were edited. [SHA256SUMS](SHA256SUMS) pins the evidence files. This evidence branch is separate from the product branch; no appearance approval is claimed.
