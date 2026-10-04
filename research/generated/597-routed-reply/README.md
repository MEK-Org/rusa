# Routed reply display evidence

Four synthetic native Flutter captures render the actual ChatTab and DashboardStore with the original actor selected. Current frames ingest the server-validated sent event plus its received echo; reload frames fetch the same synthetic persisted chat row. Each contains one completion bubble attributed to `peer-handle`, the actual responding actor. Wide viewport is 1180 × 820; narrow is 390 × 844, both at DPR 2. All four were inspected for legibility and truthful attribution.

The capture harness verifies exactly one chat row and the peer sender before each capture. The separate authenticated HTTP → ActorMesh → actual MCP regression verifies durable accepted-input provenance, original-session history and SSE, rollback and isolation. These pictures do not claim live production traffic, a browser run or an actual OS scheduler wake.

Regenerate by copying `capture-harness.dart` to the dashboard `test` directory beside `fakes.dart` and `screenshot_support.dart`, setting `RUSA_875_SCREENSHOTS` to an output directory, and running Flutter test on that harness. It uses the Flutter test font support and native raster rendering. `source-pins.json` pins the display sources and `manifest.json` records SHA256/bytes for the harness, sources and captures. The capture command passed four cases, exit 0. Matt appearance approval remains held.
