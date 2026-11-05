// Screenshot harness for #1234: Running Mesh Workers and Recent Activity span
// the Overview content width, on synthetic fixtures. Run:
//
//   flutter test test/overview_activity_width_1234_screenshot_test.dart \
//     --dart-define=SHOT_SUFFIX=after
//
// It writes `screenshots/1234_overview_<viewport>_<suffix>.png`. The `before` images come from this harness run at
// the PR's base commit with SHOT_SUFFIX=before, which records rather than fails
// on the phone overflow that commit has.
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
const String _suffix = String.fromEnvironment(
  'SHOT_SUFFIX',
  defaultValue: 'after',
);

final _end = DateTime.utc(2026, 10, 19, 12);
final _start = _end.subtract(const Duration(days: 3));

const _issueRef = 'github:example/project/issues/100';
const _commentRef = 'github:example/project/issues/100/comments/1';
const _meshRef = 'mesh:messages/layout-round-3';

String _iso(DateTime at) => at.toIso8601String();

QuotaHistoryDto _quotaHistory() {
  QuotaHistorySeriesDto series(String provider, double phase) =>
      QuotaHistorySeriesDto(
        provider: provider,
        windowId: 'weekly',
        label: 'Weekly',
        points: [
          for (var hour = 0; hour <= 72; hour += 2)
            QuotaHistoryPointDto(
              observedAt: _iso(_start.add(Duration(hours: hour))),
              remainingPercent: 80 - hour / 2,
              error: 18 * math.sin(hour / 9 + phase),
              intervalSeconds: 30 + 25 * (1 + math.sin(hour / 7 + phase)),
            ),
        ],
      );
  return QuotaHistoryDto(
    generatedAt: _iso(_end),
    historySince: _iso(_start),
    history: [series('claude', 0), series('codex', 2)],
  );
}

InboxMetricsDto _inboxMetrics() {
  final points = <InboxMetricPointDto>[];
  for (var i = 0; i <= 3 * 24 * 60; i += 5) {
    final minute = _start.add(Duration(minutes: i));
    final busy = math.max(0.0, math.sin(i / 180));
    points.add(
      InboxMetricPointDto(
        minute: _iso(minute),
        observedAt: _iso(minute.add(const Duration(seconds: 4))),
        actorCount: 7,
        inboxSizeMedian: (busy * 2).roundToDouble(),
        inboxSizeMax: (2 + busy * 7).roundToDouble(),
        oldestAgeSecondsMedian: busy * 600,
        oldestAgeSecondsMax: 300 + (i % 240) * 60.0 * (0.5 + busy),
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

FakeApi _api() => FakeApi()
  ..threadsResult = [
    makeThread('root', runState: RunState.idle, title: 'Steward'),
    for (final (id, title, focus) in const [
      ('w1', 'Overview layout', 'Widen the activity sections'),
      ('w2', 'Release notes', 'Draft the October release notes'),
      ('w3', 'Quota study', 'Compare pacing across weekly windows'),
      ('w4', 'Flaky tests', 'Stabilize the retention fixture'),
      ('w5', 'Follower update', 'Drain the follower before restart'),
    ])
      makeThread(
        id,
        parent: 'root',
        runState: RunState.running,
        title: title,
        selectedObligation: makeObligation(
          'ob-$id',
          ownerId: id,
          intent: focus,
        ),
      ),
    makeThread(
      'q1',
      parent: 'root',
      runState: RunState.queued,
      queuePosition: 0,
      title: 'Docs sweep',
      selectedObligation: makeObligation(
        'ob-docs',
        ownerId: 'q1',
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
  ..referencesResult = {
    _issueRef: const ReferenceDto(
      ref: _issueRef,
      scheme: 'github',
      title: 'unused',
      url: 'https://example.com/project/issues/100',
      entity: {
        'type': 'github_issue',
        'title': 'Let the proposed layout span the page',
      },
    ),
    _commentRef: const ReferenceDto(
      ref: _commentRef,
      scheme: 'github',
      title: _commentRef,
      author: 'a-reviewer',
      url: 'https://example.com/project/issues/100#comment-1',
      entity: {
        'type': 'github_comment',
        'body': 'Could the phone layout keep the same order as desktop?',
      },
    ),
    _meshRef: const ReferenceDto(
      ref: _meshRef,
      scheme: 'mesh',
      title: 'root → w3',
      entity: {'type': 'mesh_message', 'senderId': 'root', 'recipientId': 'w3'},
    ),
  }
  ..recentActivityResult = [
    // Live handled rows carry a reference, and render through ReferencePreview;
    // the fourth shows the fallback for one without any.
    for (final (i, kind, reference) in const [
      (0, 'GITHUB ISSUE', _issueRef),
      (1, 'GITHUB COMMENT', _commentRef),
      (2, 'MESH CHAT', _meshRef),
      (3, 'GITHUB ISSUE', null),
    ])
      RecentActivityItem(
        id: 'inbox_$i',
        kind: 'handled_inbox',
        time: _iso(_end.subtract(Duration(minutes: 7 * i))),
        actorId: 'w${i + 1}',
        sourceKind: kind,
        referenceKey: reference,
        sourceRef: reference ?? 'github:example/project/issues/${100 + i}',
        summary: 'Feedback on the proposed layout, round ${i + 1}',
        handledTime: _iso(_end.subtract(Duration(minutes: 7 * i))),
        addressedNote:
            'Reviewed the proposal, answered the open question on the thread '
            'and recorded the outcome for the next round.',
        linkedObligation: 'Obligation: Keep the proposal moving',
      ),
    RecentActivityItem(
      id: 'ob_1',
      kind: 'terminal_obligation',
      time: _iso(_end.subtract(const Duration(minutes: 40))),
      actorId: 'w2',
      sourceKind: 'OBLIGATION',
      sourceRef: 'github:example/project/issues/99',
      summary: 'Publish the September release notes',
      obligationId: '0e655f00-0000-4000-8000-000000000001',
      terminalStatus: 'done',
      terminalNote: 'Published and linked from the changelog',
      resolutionRef: 'github:example/project/pulls/98',
    ),
  ]
  ..quotaHistoryResult = _quotaHistory()
  ..inboxMetricsResult = _inboxMetrics();

void main() {
  setUpAll(loadFonts);

  // The whole Overview, then what a phone actually shows of Recent Activity.
  // Rows at the base commit are far taller, so its capture needs more height.
  final sizes = [
    ('desktop', const Size(1440, 3040), false),
    ('phone', Size(390, _suffix == 'before' ? 7000 : 4800), false),
    ('phone_activity', const Size(390, 844), true),
  ];

  for (final (viewport, size, showActivity) in sizes) {
    testWidgets('#1234 overview $viewport', (tester) async {
      final layoutErrors = <String>[];
      final priorOnError = FlutterError.onError;
      FlutterError.onError = (details) =>
          layoutErrors.add(details.exceptionAsString());
      addTearDown(() => FlutterError.onError = priorOnError);
      await tester.runAsync(() async {
        final store = DashboardStore(api: _api(), stream: FakeStream());
        await store.init();
        addTearDown(store.dispose);
        await store.refreshRecentActivity(deferUntilPostFrame: false);
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
        expect(find.text('Running Mesh Workers'), findsOneWidget);
        expect(find.text('Recent Activity'), findsOneWidget);
        if (showActivity) {
          await tester.ensureVisible(find.text('Recent Activity'));
          await tester.pump(const Duration(milliseconds: 50));
        }
        await captureBoundary(
          key,
          '$_outDir/1234_overview_${viewport}_$_suffix.png',
        );
        FlutterError.onError = priorOnError;
        // ignore: avoid_print
        print('#1234 $viewport layout errors: ${layoutErrors.length}');
        if (_suffix != 'before') expect(layoutErrors, isEmpty);
      });
    });
  }
}
