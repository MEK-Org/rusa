// Public-safe, synthetic before/after ring-and-tooltip captures for #1125. Run with:
//
//   flutter test test/quota_tooltip_1125_screenshot_test.dart
//
// The before fixture is the pre-change `formatRelativeResetDuration` result
// for 45 hours ("1 day"); the widget test covers that staging behavior red
// before this change. Both images use the same synthetic quota, ring and cadence.
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rusa_dashboard/models.dart';
import 'package:rusa_dashboard/theme.dart';
import 'package:rusa_dashboard/widgets/header.dart' show quotaScheduleColor;
import 'package:rusa_dashboard/widgets/quota_tooltip.dart';

import 'screenshot_support.dart';

final String _outDir = '${Directory.current.path}/screenshots';

void main() {
  setUpAll(loadFonts);

  final now = DateTime.utc(2030, 1, 1, 12);
  final window = QuotaWindowDto(
    id: 'weekly',
    label: 'Weekly',
    usedPercent: 6.25,
    status: 'available',
    headline: true,
    windowMs: 48 * 3600 * 1000,
    resetAtIso: now.add(const Duration(hours: 45)).toIso8601String(),
  );
  const throttle = QuotaThrottleDto(
    intervalSeconds: 600,
    expired: false,
    buckets: [],
    updatedAt: '2030-01-01T12:00:00.000Z',
  );

  Future<void> capture(
    WidgetTester tester,
    String filename,
    Widget tooltip,
  ) async {
    await tester.binding.setSurfaceSize(const Size(520, 240));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pump();
    final key = GlobalKey();
    await tester.pumpWidget(
      RepaintBoundary(
        key: key,
        child: MaterialApp(
          debugShowCheckedModeBanner: false,
          theme: buildMeshTheme(),
          home: Scaffold(
            backgroundColor: MeshColors.bgPrimary,
            body: Center(
              child: Container(
                padding: const EdgeInsets.all(12),
                decoration: BoxDecoration(
                  color: MeshColors.bgSecondary,
                  border: Border.all(color: MeshColors.border),
                  borderRadius: BorderRadius.circular(6),
                ),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.center,
                  children: [
                    _QuotaRing(window: window, now: now),
                    const SizedBox(height: 14),
                    SizedBox(width: 360, child: tooltip),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
    await tester.pump(const Duration(milliseconds: 250));
    expect(find.byType(CircularProgressIndicator), findsOneWidget);
    await tester.runAsync(() => captureBoundary(key, '$_outDir/$filename'));
  }

  testWidgets('captures the 45-hour reset ring and staging tooltip (#1125)', (tester) async {
    await capture(
      tester,
      '1125_quota_ring_tooltip_before.png',
      const _StagingTooltip(),
    );
    expect(find.textContaining('Resets in 1 day'), findsOneWidget);
  });

  testWidgets('captures the 45-hour reset ring and updated tooltip (#1125)', (tester) async {
    await capture(
      tester,
      '1125_quota_ring_tooltip_after.png',
      QuotaTooltip(
        providerName: 'Claude',
        windows: [window],
        throttle: throttle,
        now: now,
      ),
    );
    expect(find.textContaining('Provider reset in 45 hours'), findsOneWidget);
    expect(find.textContaining('Pacing: every 10 minutes'), findsOneWidget);
  });
}

/// The same outer-ring geometry and schedule color used by the header's quota
/// strip, kept beside the staging tooltip fixture so the visual change is only
/// the reset wording.
class _QuotaRing extends StatelessWidget {
  const _QuotaRing({required this.window, required this.now});

  final QuotaWindowDto window;
  final DateTime now;

  @override
  Widget build(BuildContext context) => Row(
    mainAxisSize: MainAxisSize.min,
    children: [
      SizedBox(
        width: 24,
        height: 24,
        child: Center(
          child: SizedBox(
            width: 20,
            height: 20,
            child: CircularProgressIndicator(
              value: (100 - window.usedPercent!) / 100,
              strokeWidth: 4,
              strokeCap: StrokeCap.butt,
              color: quotaScheduleColor(window, now: now),
              backgroundColor: MeshColors.border,
            ),
          ),
        ),
      ),
      const SizedBox(width: 5),
      const Text('Claude', style: TextStyle(fontSize: 12)),
    ],
  );
}

/// Exact text/layout produced by staging for this fixed synthetic fixture.
class _StagingTooltip extends StatelessWidget {
  const _StagingTooltip();

  @override
  Widget build(BuildContext context) => const SizedBox(
    width: 360,
    child: Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          'Claude',
          style: TextStyle(fontSize: 13, fontWeight: FontWeight.w700),
        ),
        SizedBox(height: 6),
        Text(
          'Weekly: +0 (94% / 94%) - Resets in 1 day',
          style: TextStyle(fontSize: 12),
        ),
        SizedBox(height: 2),
        Text('Pacing: every 10 minutes', style: TextStyle(fontSize: 12)),
        SizedBox(height: 2),
        Text('Last Read: n/a', style: TextStyle(fontSize: 12)),
      ],
    ),
  );
}
