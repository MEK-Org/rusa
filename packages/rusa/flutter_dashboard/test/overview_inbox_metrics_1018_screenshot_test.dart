// Screenshot harness for #1018's Overview inbox charts on synthetic fixtures.
// Run:
//
//   flutter test test/overview_inbox_metrics_1018_screenshot_test.dart
//
// It writes `screenshots/1018_overview_<viewport>_after.png`, tall enough to
// show the whole Overview. The inbox window has a six-hour unsampled outage
// and a retirement that drops the live population from 9 to 7 actors; the
// queued actor carries a focus card. The `_before` images come from the base
// commit with the same fixture minus the inbox payload, which the base API
// cannot express.
//
// `1018_overview_wide_aged_<suffix>.png` is an Overview left open two hours:
// quota history was fetched once at 10:00 (#26) while the inbox window has
// kept refreshing to 12:00.
import 'dart:io';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rusa_dashboard/models.dart';
import 'package:rusa_dashboard/store.dart';
import 'package:rusa_dashboard/theme.dart';
import 'package:rusa_dashboard/widgets/overview_tab.dart';

import 'fakes.dart';
import 'screenshot_support.dart';

final String _outDir = '${Directory.current.path}/screenshots';
const String _suffix = String.fromEnvironment('SHOT_SUFFIX');

final _end = DateTime.utc(2026, 10, 19, 12);
final _start = _end.subtract(const Duration(days: 3));

String _iso(DateTime at) => at.toIso8601String();

QuotaHistoryDto _quotaHistory({Duration age = Duration.zero}) {
  final generatedAt = _end.subtract(age);
  QuotaHistorySeriesDto series(String provider, double phase) =>
      QuotaHistorySeriesDto(
        provider: provider,
        windowId: 'weekly',
        label: 'Weekly',
        points: [
          for (var hour = 0; hour <= 72 - age.inHours; hour += 2)
            QuotaHistoryPointDto(
              observedAt: _iso(_start.add(Duration(hours: hour))),
              remainingPercent: 80 - hour / 2,
              error: 18 * math.sin(hour / 9 + phase),
              intervalSeconds: 30 + 25 * (1 + math.sin(hour / 7 + phase)),
            ),
        ],
      );
  return QuotaHistoryDto(
    generatedAt: _iso(generatedAt),
    historySince: _iso(generatedAt.subtract(const Duration(days: 3))),
    history: [series('claude', 0), series('codex', 2)],
  );
}

InboxMetricsDto _inboxMetrics() {
  final points = <InboxMetricPointDto>[];
  for (var i = 0; i <= 3 * 24 * 60; i++) {
    // The host was down for six hours on the first day.
    if (i >= 1500 && i < 1860) continue;
    final minute = _start.add(Duration(minutes: i));
    final actors = i < 2600 ? 9 : 7;
    final busy = math.max(0.0, math.sin(i / 180));
    // Ages climb while work waits and fall back when the oldest is handled.
    final sawtooth = (i % 240) * 60.0;
    points.add(
      InboxMetricPointDto(
        minute: _iso(minute),
        observedAt: _iso(minute.add(const Duration(seconds: 4))),
        actorCount: actors,
        inboxSizeMedian: (busy * 2).roundToDouble(),
        inboxSizeMax: (2 + busy * 7).roundToDouble(),
        oldestAgeSecondsMedian: busy * 600,
        oldestAgeSecondsMax: 300 + sawtooth * (0.5 + busy),
      ),
    );
  }
  return InboxMetricsDto(
    generatedAt: _iso(_end),
    windowStart: _iso(_start),
    windowEnd: _iso(_end),
    intervalSeconds: 60,
    points: points,
  );
}

FakeApi _api({Duration quotaAge = Duration.zero}) => FakeApi()
  ..threadsResult = [
    makeThread('root', runState: RunState.idle, title: 'Steward'),
    makeThread(
      'w1',
      parent: 'root',
      runState: RunState.running,
      title: 'Overview charts',
    ),
    makeThread(
      'w2',
      parent: 'root',
      runState: RunState.running,
      title: 'Release notes',
    ),
    makeThread(
      'w3',
      parent: 'root',
      runState: RunState.queued,
      queuePosition: 0,
      title: 'Docs sweep',
      // A focus card shows where queued work lands beside, or below, its
      // actor at this width.
      selectedObligation: makeObligation(
        'ob-docs',
        ownerId: 'w3',
        intent: 'Refresh the setup guide screenshots',
      ),
    ),
  ]
  ..obligationsResult = [
    makeObligation(
      'ob-ready',
      ownerId: testUserPrincipalId,
      intent: 'Approve the inbox chart schema',
    ),
    makeObligation(
      'ob-waiting',
      ownerId: testUserPrincipalId,
      intent: 'Pick the launch date',
      status: 'waiting',
    ),
  ]
  ..quotaHistoryResult = _quotaHistory(age: quotaAge)
  ..inboxMetricsResult = _inboxMetrics();

void main() {
  setUpAll(loadFonts);

  const sizes = [
    ('wide', Size(1180, 1500), Duration.zero),
    ('phone', Size(390, 3300), Duration.zero),
    ('wide_aged', Size(1180, 1500), Duration(hours: 2)),
  ];

  for (final (viewport, size, quotaAge) in sizes) {
    testWidgets('#1018 overview $viewport', (tester) async {
      await tester.runAsync(() async {
        final store = DashboardStore(
          api: _api(quotaAge: quotaAge),
          stream: FakeStream(),
        );
        await store.init();
        addTearDown(store.dispose);
        tester.view
          ..physicalSize = size
          ..devicePixelRatio = 1.0;
        addTearDown(tester.view.reset);
        final key = GlobalKey();
        await tester.pumpWidget(
          MaterialApp(
            debugShowCheckedModeBanner: false,
            theme: buildMeshTheme(),
            home: RepaintBoundary(
              key: key,
              child: Scaffold(
                backgroundColor: MeshColors.bgPrimary,
                body: OverviewTab(store: store),
              ),
            ),
          ),
        );
        for (var i = 0; i < 5; i++) {
          await Future<void>.delayed(Duration.zero);
          await tester.pump(const Duration(milliseconds: 50));
        }
        expect(find.text('Approve the inbox chart schema'), findsOneWidget);
        expect(
          find.text('Refresh the setup guide screenshots'),
          findsOneWidget,
        );
        expect(tester.takeException(), isNull);
        final name = _suffix.isEmpty ? 'after' : _suffix;
        await captureBoundary(
          key,
          '$_outDir/1018_overview_${viewport}_$name.png',
        );
      });
    });
  }
}
