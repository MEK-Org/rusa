// Captures the real quota indicator and its tooltip for #1125. The matching
// before image is generated from the staging revision of this same widget path.
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rusa_dashboard/models.dart';
import 'package:rusa_dashboard/store.dart';
import 'package:rusa_dashboard/theme.dart';
import 'package:rusa_dashboard/widgets/header.dart';
import 'package:rusa_dashboard/widgets/quota_tooltip.dart';

import 'fakes.dart';
import 'screenshot_support.dart';

final String _outDir = '${Directory.current.path}/screenshots';

void main() {
  setUpAll(loadFonts);

  testWidgets('captures the updated 45-hour quota ring tooltip (#1125)', (
    tester,
  ) async {
    await tester.runAsync(() async {
      final now = DateTime.now().toUtc();
      final window = QuotaWindowDto(
        id: 'weekly',
        label: 'Weekly',
        usedPercent: 6.25,
        status: 'available',
        headline: true,
        windowMs: 48 * 3600 * 1000,
        resetAtIso: now
            .add(const Duration(hours: 45, minutes: 1))
            .toIso8601String(),
        scrapedAt: now.toIso8601String(),
      );
      final throttle = QuotaThrottleDto(
        intervalSeconds: 600,
        expired: false,
        buckets: const [],
        updatedAt: now.toIso8601String(),
      );
      final api = FakeApi()
        ..threadsResult = [makeThread('root', created: 't0')]
        ..quotaResult = QuotaSnapshotDto(
          generatedAt: now.toIso8601String(),
          providers: [
            ProviderQuotaDto(
              provider: 'claude',
              status: 'available',
              usedPercent: null,
              tier: null,
              message: null,
              windows: [window],
              throttle: throttle,
            ),
          ],
        );
      final store = DashboardStore(api: api, stream: FakeStream());
      await store.init();
      await store.refreshQuota();
      addTearDown(store.dispose);
      await tester.binding.setSurfaceSize(const Size(520, 240));
      addTearDown(() => tester.binding.setSurfaceSize(null));
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
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    QuotaIndicators(store: store),
                    const SizedBox(height: 14),
                    SizedBox(
                      width: 360,
                      child: QuotaTooltip(
                        providerName: 'Claude',
                        windows: [window],
                        throttle: throttle,
                        now: now,
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      );
      await tester.pump(const Duration(milliseconds: 250));
      expect(find.textContaining('Resets in 45 hours'), findsOneWidget);
      expect(find.textContaining('Pacing: every 10 minutes'), findsOneWidget);
      await captureBoundary(key, '$_outDir/1125_quota_ring_tooltip_after.png');
    });
  });
}
