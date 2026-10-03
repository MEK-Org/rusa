# Run prompt disclosure appearance evidence

Synthetic fixtures only; no live actors, user prompts, credentials or private data.
These eight browser captures replace the incomplete widget-test rasters at evidence commit d7a451fa. Product UI was unchanged during this evidence repair.

Before source: `53b52993d858ca8b932811ded654016525eab54b`.
After product source: `212c0d0bfd8ad5813477bde8b28ec0a44a083e6b` (PR #874).
[Source pins](source-pins.json) contain hashes of the actual UI/theme/fixture dependencies, each checked against the named committed tree. The same [web fixture](run_prompt_web_capture.dart) renders the real EventsTab in both trees using a FakeApi synthetic run_start event and prompt response.

Wide viewport: 1180 x 820 logical pixels; narrow: 390 x 844; DPR: 2.
Renderer: Flutter CanvasKit release web build; Google Chrome 146.0.7680.164; Playwright 1.58.2. Fonts are the private Flutter SDK's Roboto-Regular.ttf, locally registered for Roboto/system-ui/monospace in the synthetic fixture. This deterministic fixture font mapping is used identically before and after; it does not modify the product theme.

| State | Wide | Narrow |
| --- | --- | --- |
| Before | [wide-before.png](wide-before.png) | [narrow-before.png](narrow-before.png) |
| After collapsed | [wide-collapsed.png](wide-collapsed.png) | [narrow-collapsed.png](narrow-collapsed.png) |
| After expanded | [wide-expanded.png](wide-expanded.png) | [narrow-expanded.png](narrow-expanded.png) |
| After unavailable | [wide-unavailable.png](wide-unavailable.png) | [narrow-unavailable.png](narrow-unavailable.png) |

The expanded capture uses a short synthetic prompt with synthetic 300000-byte metadata to demonstrate the truncation banner and layout. Repository tests establish real retention byte boundaries. Production captures have unknown provenance and remain unavailable through the endpoint; expanded fixtures do not imply production disclosure is usable. No appearance approval is claimed.

Reproduction uses a private Flutter SDK overlay and local browser. Copy the web fixture into each source tree at packages/rusa/flutter_dashboard/test/run_prompt_web_capture.dart. From each flutter_dashboard directory, build with the supported tool (substitute that tree's output path):

```sh
<private-sdk>/bin/cache/dart-sdk/bin/dart <private-sdk>/bin/cache/flutter_tools.snapshot --no-version-check build web --release --no-pub --no-web-resources-cdn --target test/run_prompt_web_capture.dart --output-dir <workspace>/evidence/866-browser-after
python3 configure-browser-assets.py <workspace>/evidence/866-browser-after <private-sdk>/bin/cache/artifacts/material_fonts/Roboto-Regular.ttf after
```

Repeat for before source using output 866-browser-before and base before. Both observed release builds exited 0 (74.0s after, 92.7s before). The build reported the existing flutter_dropzone JS interoperability warning for optional Wasm; these captures use CanvasKit.

Copy [browser-capture.cjs](browser-capture.cjs) to the after checkout's packages/rusa/866-browser-capture.cjs. From that checkout root:

```sh
node packages/rusa/866-browser-capture.cjs > ../evidence/866-validation/browser-final-capture.log 2>&1
```

The script serves only the two compiled fixture directories on 127.0.0.1, blocks external browser requests, requires existing filter/timestamp/run-kind/model labels, clicks the disclosure for expanded/unavailable states, waits for font/raster work and warms GPU readback before retaining each PNG. [Observed capture log](capture.log): all eight states captured, exit 0. All eight retained PNGs were visually inspected for those labels, provider/banner/prompt and unavailable notice. No screenshot pixels were edited. [SHA256SUMS](SHA256SUMS) pins PNGs, fixture, script and source manifest.

This branch contains evidence only beyond the original product head; it is not intended for a product merge. Review PR #874 at the after product SHA above.
