import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rusa_dashboard/models.dart';
import 'package:rusa_dashboard/store.dart';
import 'package:rusa_dashboard/theme.dart';
import 'package:rusa_dashboard/widgets/header.dart';

import 'fakes.dart';
import 'screenshot_support.dart';

final String _outDir = '${Directory.current.path}/screenshots';

void main() {
  setUpAll(loadFonts);

  testWidgets('renders synthetic before/after Fable ring repair (#1078, #1093)', (
    tester,
  ) async {
    await tester.runAsync(() async {
      final now = DateTime.now().toUtc();
      await tester.binding.setSurfaceSize(const Size(1200, 220));
      addTearDown(() => tester.binding.setSurfaceSize(null));

      // Synthetic representations from the #1078 flap evidence:
      // Live reading has the full model set [claude-fable-5, claude-fable-5-1] with 65% remaining (35% used).
      final wideLiveWindow = QuotaWindowDto(
        id: 'weekly',
        label: 'Current week (Fable)',
        usedPercent: 35,
        status: 'available',
        headline: true,
        windowMs: 604800000,
        resetAtIso: now
            .add(const Duration(days: 3, hours: 4))
            .toIso8601String(),
        scrapedAt: now.subtract(const Duration(minutes: 30)).toIso8601String(),
        modelIds: const ['claude-fable-5', 'claude-fable-5-1'],
        estimated: false,
      );

      // Flapped lane in history has the narrower set [claude-fable-5] with 68% remaining (32% used).
      final narrowEstimatedWindow = QuotaWindowDto(
        id: 'weekly',
        label: 'Current week (Fable)',
        usedPercent: 32,
        status: 'available',
        headline: true,
        windowMs: 604800000,
        resetAtIso: now
            .add(const Duration(days: 3, hours: 4))
            .toIso8601String(),
        scrapedAt: now.subtract(const Duration(hours: 21)).toIso8601String(),
        modelIds: const ['claude-fable-5'],
        estimated: true,
      );

      QuotaSnapshotDto createSnapshot(List<QuotaWindowDto> fableWindows) {
        return QuotaSnapshotDto(
          generatedAt: now.toIso8601String(),
          providers: [
            ProviderQuotaDto(
              provider: 'claude',
              status: 'available',
              usedPercent: 64,
              tier: null,
              message: null,
              windows: [
                QuotaWindowDto(
                  id: 'weekly',
                  label: 'Weekly',
                  usedPercent: 64,
                  status: 'available',
                  headline: true,
                  windowMs: 604800000,
                  resetAtIso: now
                      .add(const Duration(days: 3, hours: 4))
                      .toIso8601String(),
                  scrapedAt: now
                      .subtract(const Duration(minutes: 30))
                      .toIso8601String(),
                ),
                QuotaWindowDto(
                  id: 'session',
                  label: 'Session',
                  usedPercent: 3,
                  status: 'available',
                  headline: false,
                  windowMs: 18000000,
                  resetAtIso: now
                      .add(const Duration(hours: 4, minutes: 30))
                      .toIso8601String(),
                  scrapedAt: now
                      .subtract(const Duration(minutes: 30))
                      .toIso8601String(),
                ),
              ],
              throttle: QuotaThrottleDto(
                intervalSeconds: 600,
                expired: false,
                capped: false,
                buckets: const [],
                updatedAt: now
                    .subtract(const Duration(minutes: 5))
                    .toIso8601String(),
                modelLanes: const [
                  QuotaThrottleModelLaneDto(
                    models: ['claude-fable-5', 'claude-fable-5-1'],
                    intervalSeconds: 900,
                  ),
                ],
              ),
              scrapedAt: now
                  .subtract(const Duration(minutes: 30))
                  .toIso8601String(),
              modelWindows: fableWindows,
            ),
            ProviderQuotaDto(
              provider: 'codex',
              status: 'available',
              usedPercent: 29,
              tier: null,
              message: null,
              windows: const [
                QuotaWindowDto(
                  id: 'weekly',
                  label: 'Weekly',
                  usedPercent: 71,
                  status: 'available',
                  headline: true,
                  windowMs: 604800000,
                ),
                QuotaWindowDto(
                  id: 'five_hour',
                  label: '5h',
                  usedPercent: 44,
                  status: 'available',
                  headline: false,
                  windowMs: 18000000,
                ),
              ],
            ),
          ],
        );
      }

      final key = GlobalKey();
      Future<void> pumpHeader(QuotaSnapshotDto quota) async {
        final api = FakeApi()
          ..threadsResult = [
            makeThread(
              'root',
              title: 'the root actor',
              status: 'active',
              runState: RunState.running,
            ),
          ]
          ..quotaResult = quota;
        final store = DashboardStore(api: api, stream: FakeStream());
        await store.init();
        await store.refreshQuota();
        addTearDown(store.dispose);

        await tester.pumpWidget(
          RepaintBoundary(
            key: key,
            child: MaterialApp(
              debugShowCheckedModeBanner: false,
              theme: buildMeshTheme(),
              home: Scaffold(
                backgroundColor: MeshColors.bgPrimary,
                body: Align(
                  alignment: Alignment.topCenter,
                  child: MeshHeader(
                    store: store,
                    selected: DashboardView.overview,
                    onSelect: (_) {},
                  ),
                ),
              ),
            ),
          ),
        );
        await tester.pump(const Duration(milliseconds: 250));
      }

      // ── Phase 1: BEFORE ──────────────────────────────────────────────────
      // Before the fix, withEstimates restores the narrow flapped lane alongside
      // the live wide window. Serving two Fable weekly windows causes
      // fableWeeklyWindow to return null (ambiguous match), rendering the ring as
      // n/a.
      await pumpHeader(createSnapshot([wideLiveWindow, narrowEstimatedWindow]));
      expect(find.text('Fable'), findsOneWidget);
      await captureBoundary(key, '$_outDir/1093_fable_ring_before.png');

      tester
          .state<TooltipState>(
            find.ancestor(
              of: find.text('Fable').first,
              matching: find.byType(Tooltip),
            ),
          )
          .ensureTooltipVisible();
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 250));
      expect(find.textContaining('Weekly: n/a'), findsOneWidget);
      await captureBoundary(key, '$_outDir/1093_fable_ring_tooltip_before.png');

      // ── Phase 2: AFTER ───────────────────────────────────────────────────
      // After the fix, withEstimates skips restoring the narrow dropped lane
      // because its model set is a subset of the shown wide window. Exactly one
      // Fable weekly window is served, so fableWeeklyWindow finds it and renders
      // the true live value (65% remaining).
      Tooltip.dismissAllToolTips();
      await tester.pumpWidget(const SizedBox.shrink());
      await tester.pump(const Duration(milliseconds: 100));

      await pumpHeader(createSnapshot([wideLiveWindow]));
      expect(find.text('Fable'), findsWidgets);
      await captureBoundary(key, '$_outDir/1093_fable_ring_after.png');

      tester
          .state<TooltipState>(
            find.ancestor(
              of: find.text('Fable').first,
              matching: find.byType(Tooltip),
            ),
          )
          .ensureTooltipVisible();
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 250));
      expect(find.textContaining('Weekly: '), findsOneWidget);
      expect(find.textContaining('65%'), findsWidgets);
      await captureBoundary(key, '$_outDir/1093_fable_ring_tooltip_after.png');
    });
  });
}
