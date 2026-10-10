# #903 responsive-mark history: appearance evidence

Evidence for PR #943 at product head `a49070cb7536193c8159a55638c950fa18cff54d`. (The first captures were made at `44261ee2`, before the label change.) This branch only hosts the evidence; it is not for merge.

These are real `WorkTab` obligation-detail renders, made with the repo's own screenshot support (`test/screenshot_support.dart`, fake API, bundled fonts), using synthetic data only. `capture_test.dart.txt` is the harness. Copy it into `packages/rusa/flutter_dashboard/test/` and run `flutter test --dart-define=PHASE=before|after <file>`.

The obligation is the same responsive, ready obligation in both phases:

- **before** (staging): marking it responsive writes no history row, so the trail shows only the earlier reassignment.
- **after** (#943): the mark appends one `responsive` history row. `_historyLabel` names it: "‹actor› marked responsive" (or "‹actor› cleared responsive" if the explicit value returns to null). At `44261ee2` it fell through to the generic "‹actor› updated obligation"; `a49070cb` adds the label, per [review](https://github.com/MEK-Org/rusa/pull/943#issuecomment-6098962797).

| | wide (1600×1000) | narrow (390×844, scrolled to History) |
|---|---|---|
| before | ![](responsive_history_before_wide.png) | ![](responsive_history_before_narrow.png) |
| after | ![](responsive_history_after_wide.png) | ![](responsive_history_after_narrow.png) |

SHA256:
```
76d421d9c2175e2d32c78f8183262ec9802232f52f2570ff6365a4a2a30b7036  responsive_history_before_wide.png
409a62d262791e43c43c39e9a5de01e4aa3ca28b28b95ffde81c7dbdb624ef1e  responsive_history_before_narrow.png
0169ddaa6fe11697dc831a91f6f55eb13457cf5922e860485e5302ed04d6e10b  responsive_history_after_wide.png
23a610b2d220b01d20f7307c78e892847c0ab321fcde813c95b351686efdb83c  responsive_history_after_narrow.png
```
