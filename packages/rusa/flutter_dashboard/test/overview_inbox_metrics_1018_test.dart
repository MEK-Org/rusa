import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rusa_dashboard/api.dart';
import 'package:rusa_dashboard/models.dart';
import 'package:rusa_dashboard/store.dart';
import 'package:rusa_dashboard/widgets/inbox_metrics_chart.dart';
import 'package:rusa_dashboard/widgets/overview_tab.dart';
import 'package:rusa_dashboard/widgets/quota_history_chart.dart';

import 'fakes.dart';

final _end = DateTime.utc(2026, 10, 19, 12);
final _start = _end.subtract(kOverviewChartWindow);

InboxMetricPointDto _point(
  DateTime minute, {
  int actors = 3,
  double size = 1,
  double age = 60,
}) => InboxMetricPointDto(
  minute: minute.toIso8601String(),
  observedAt: minute.add(const Duration(seconds: 5)).toIso8601String(),
  actorCount: actors,
  inboxSizeMedian: actors == 0 ? null : size,
  inboxSizeMax: actors == 0 ? null : size * 2,
  oldestAgeSecondsMedian: actors == 0 ? null : age,
  oldestAgeSecondsMax: actors == 0 ? null : age * 2,
);

InboxMetricsDto _metrics(List<InboxMetricPointDto> points, {DateTime? at}) =>
    InboxMetricsDto(
      generatedAt: (at ?? _end).toIso8601String(),
      windowStart: _start.toIso8601String(),
      windowEnd: _end.toIso8601String(),
      intervalSeconds: 60,
      points: points,
    );

void main() {
  group('traceInboxMetric', () {
    const plot = Rect.fromLTWH(0, 0, 4320, 100);
    List<List<Offset>> trace(List<InboxMetricPointDto> points) =>
        traceInboxMetric(
          points,
          start: _start,
          end: _end,
          plot: plot,
          intervalSeconds: 60,
          valueOf: (p) => p.inboxSizeMedian,
          yFor: (v) => 100 - v,
        ).segments;

    test('places minutes exactly and spans the window edge to edge', () {
      final segments = trace([
        _point(_start),
        _point(_start.add(const Duration(minutes: 1)), size: 4),
        _point(_end.subtract(const Duration(minutes: 1))),
        _point(_end),
      ]);
      expect(segments, [
        [const Offset(0, 99), const Offset(1, 96)],
        [const Offset(4319, 99), const Offset(4320, 99)],
      ]);
    });

    test('breaks at a missing minute and at a minute with no live actor', () {
      final m = [for (var i = 0; i < 6; i++) _start.add(Duration(minutes: i))];
      final segments = trace([
        _point(m[0]),
        _point(m[1]),
        // m[2] was never sampled.
        _point(m[3]),
        _point(m[4], actors: 0),
        _point(m[5]),
      ]);
      expect(segments.map((s) => s.map((o) => o.dx).toList()).toList(), [
        [0, 1],
        [3],
        [5],
      ]);
    });

    test('a known-empty population reads as zero, not as a gap', () {
      final segments = trace([
        _point(_start, size: 0),
        _point(_start.add(const Duration(minutes: 1)), size: 0),
      ]);
      expect(segments, [
        [const Offset(0, 100), const Offset(1, 100)],
      ]);
    });

    test('drops samples outside the shared range', () {
      final segments = trace([
        _point(_start.subtract(const Duration(minutes: 1))),
        _point(_start),
        _point(_end.add(const Duration(minutes: 1))),
      ]);
      expect(segments, [
        [const Offset(0, 99)],
      ]);
    });
  });

  test('every Overview chart shares one 3-day range ending at the newest '
      'payload', () {
    final range = overviewChartRange([
      '2026-10-19T11:58:30Z',
      _end.toIso8601String(),
      'not a time',
    ]);
    expect(range.end, _end);
    expect(range.start, DateTime.utc(2026, 10, 16, 12));
  });

  test('axes start at zero and cover the max', () {
    expect(InboxMetricAxis.count(0).top, 4);
    expect(InboxMetricAxis.count(9).top, 20);
    expect(InboxMetricAxis.count(130).top, 200);
    expect(InboxMetricAxis.age(0).top, 240);
    expect(InboxMetricAxis.age(5000).top, 4 * 1800);
    expect(InboxMetricAxis.age(40 * 86400).top, 4 * 14 * 86400);
    expect(inboxAgeLabel(7200), '2h');
    expect(inboxAgeLabel(86400), '1d');
  });

  group('DashboardStore chart refresh', () {
    testWidgets('polls the inbox window at most once a minute', (tester) async {
      final api = FakeApi()..inboxMetricsResult = _metrics([_point(_start)]);
      final store = DashboardStore(api: api, stream: FakeStream());

      await store.pollInboxMetrics();
      await tester.pump(const Duration(seconds: 59));
      await store.pollInboxMetrics();
      expect(api.inboxMetricsCallCount, 1);
      await tester.pump(const Duration(seconds: 1));
      await store.pollInboxMetrics();
      expect(api.inboxMetricsCallCount, 2);
      // Quota history keeps its fetch-on-mount contract (#26).
      expect(api.quotaHistoryCallCount, 0);
      expect(store.inboxMetrics.value?.points, hasLength(1));
      // Disposing cancels the cooldown, leaving no timer behind.
      await store.dispose();
    });

    test(
      '503 is unavailable; other failures keep the window as cached',
      () async {
        final api = FakeApi();
        final store = DashboardStore(api: api, stream: FakeStream());
        addTearDown(store.dispose);

        await store.refreshInboxMetrics();
        expect(store.inboxMetrics.value, isNull);

        api.inboxMetricsResult = _metrics([_point(_start)]);
        await store.refreshInboxMetrics();
        expect(store.inboxMetricsStale.value, isFalse);
        api.inboxMetricsError = DashboardApiException(Uri(), 500, 'boom');
        await store.refreshInboxMetrics();
        expect(store.inboxMetrics.value, isNotNull);
        expect(store.inboxMetricsStale.value, isTrue);
      },
    );
  });

  group('Overview', () {
    Future<(FakeApi, DashboardStore)> pumpOverview(
      WidgetTester tester,
      Size size,
    ) async {
      final api = FakeApi()
        ..threadsResult = [makeThread('root')]
        ..quotaHistoryResult = QuotaHistoryDto(
          generatedAt: _end
              .subtract(const Duration(minutes: 7))
              .toIso8601String(),
          historySince: _start
              .subtract(const Duration(minutes: 7))
              .toIso8601String(),
          history: const [],
        )
        ..inboxMetricsResult = _metrics([
          for (var i = 0; i < 30; i++)
            _point(
              _end.subtract(Duration(minutes: 30 - i)),
              actors: 4 - i ~/ 10,
            ),
        ]);
      final store = DashboardStore(api: api, stream: FakeStream());
      await store.init();
      addTearDown(store.dispose);
      addTearDown(() => tester.binding.setSurfaceSize(null));
      await tester.binding.setSurfaceSize(size);
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(body: OverviewTab(store: store)),
        ),
      );
      for (var i = 0; i < 4; i++) {
        await Future<void>.delayed(Duration.zero);
        await tester.pump();
      }
      return (api, store);
    }

    testWidgets('wide puts work left and every chart right', (tester) async {
      await tester.runAsync(() async {
        await pumpOverview(tester, const Size(1200, 3000));

        final work = [
          'My Queue',
          'Running Mesh Workers',
          'Queued Actors',
          'Recent Activity',
        ].map((t) => tester.getRect(find.text(t))).toList();
        final quota = tester.getRect(find.textContaining('Quota Pacing'));
        final inbox = tester.getRect(find.text('Inbox Size'));
        final oldest = tester.getRect(find.text('Oldest Inbox Item'));
        for (final section in work) {
          expect(section.right, lessThan(quota.left));
          expect(section.left, closeTo(work.first.left, 1));
        }
        expect(inbox.left, greaterThan(work.first.right));
        expect(quota.top, lessThan(inbox.top));
        expect(inbox.top, lessThan(oldest.top));
        expect(find.text('Median'), findsNWidgets(2));
        expect(find.text('Max'), findsNWidgets(2));
        expect(tester.takeException(), isNull);
      });
    });

    testWidgets('phone stacks all work before all charts without overflow', (
      tester,
    ) async {
      await tester.runAsync(() async {
        await pumpOverview(tester, const Size(390, 4000));

        final recent = tester.getRect(find.text('Recent Activity'));
        final quota = tester.getRect(find.textContaining('Quota Pacing'));
        final inbox = tester.getRect(find.text('Inbox Size'));
        expect(recent.bottom, lessThan(quota.top));
        expect(quota.bottom, lessThan(inbox.top));
        expect(tester.takeException(), isNull);
      });
    });

    testWidgets('quota and inbox charts draw one shared range and end', (
      tester,
    ) async {
      await tester.runAsync(() async {
        await pumpOverview(tester, const Size(1200, 3000));

        final chart = tester.widget<QuotaHistoryChart>(
          find.byType(QuotaHistoryChart),
        );
        final inbox = tester.widget<InboxMetricsChart>(
          find.byType(InboxMetricsChart),
        );
        // The quota payload is 7 minutes older; both end at the newer one.
        expect(chart.sharedRange, (start: _start, end: _end));
        expect((inbox.start, inbox.end), (_start, _end));
        for (final key in const [
          Key('inbox-size-chart'),
          Key('inbox-oldest-chart'),
        ]) {
          final painter =
              tester.widget<CustomPaint>(find.byKey(key)).painter!
                  as InboxMetricChartPainter;
          expect((painter.start, painter.end), (_start, _end));
        }
        expect(
          tester
              .widget<Text>(find.byKey(const Key('inbox-metrics-coverage')))
              .data,
          'Sampled 30 of 4321 minutes in the prior 3 days; gaps are unsampled '
          'minutes. 2 live actors at the latest sample (2–4 over the range).',
        );
      });
    });

    testWidgets('refreshes the inbox chart once a minute while mounted', (
      tester,
    ) async {
      final api = FakeApi()..threadsResult = [makeThread('root')];
      final store = DashboardStore(api: api, stream: FakeStream());
      addTearDown(store.dispose);
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(body: OverviewTab(store: store)),
        ),
      );
      expect(api.inboxMetricsCallCount, 1);
      expect(find.text('Inbox metrics unavailable.'), findsOneWidget);

      await tester.pump(const Duration(seconds: 59));
      expect(api.inboxMetricsCallCount, 1);
      // The next 15s tick after the minute refreshes the inbox window only.
      await tester.pump(const Duration(seconds: 16));
      expect(api.inboxMetricsCallCount, 2);
      expect(api.quotaHistoryCallCount, 1);
      await tester.pump(const Duration(seconds: 44));
      expect(api.inboxMetricsCallCount, 2);

      await tester.pumpWidget(const SizedBox());
      await tester.pump(const Duration(minutes: 5));
      expect(api.inboxMetricsCallCount, 2);
    });
  });
}
