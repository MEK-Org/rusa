import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rusa_dashboard/models.dart';
import 'package:rusa_dashboard/theme.dart';
import 'package:rusa_dashboard/widgets/quota_history_chart.dart';

void main() {
  const history = QuotaHistoryDto(
    generatedAt: '2026-07-26T20:00:00.000Z',
    historySince: '2026-07-23T20:00:00.000Z',
    history: [
      QuotaHistorySeriesDto(
        provider: 'claude',
        windowId: 'weekly',
        label: 'Weekly',
        points: [
          QuotaHistoryPointDto(
            observedAt: '2026-07-25T21:00:00.000Z',
            remainingPercent: 80,
          ),
          QuotaHistoryPointDto(
            observedAt: '2026-07-26T19:00:00.000Z',
            remainingPercent: 55,
          ),
        ],
      ),
      QuotaHistorySeriesDto(
        provider: 'claude',
        windowId: 'session',
        label: 'Session',
        points: [
          QuotaHistoryPointDto(
            observedAt: '2026-07-26T19:00:00.000Z',
            remainingPercent: 12,
          ),
        ],
      ),
    ],
  );

  testWidgets('plots weekly headroom and throttle period, each with a key', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(900, 1200);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    await tester.pumpWidget(
      MaterialApp(
        theme: buildMeshTheme(),
        home: const Scaffold(
          body: SizedBox(
            width: 900,
            child: Padding(
              padding: EdgeInsets.all(16),
              child: QuotaHistoryChart(history: history),
            ),
          ),
        ),
      ),
    );

    // The absolute remaining-quota chart is gone; headroom leads instead.
    expect(find.byKey(const Key('quota-history-chart')), findsNothing);
    expect(find.byKey(const Key('quota-pace-error-chart')), findsOneWidget);
    expect(
      find.byKey(const Key('quota-throttle-interval-chart')),
      findsOneWidget,
    );
    expect(find.text('Quota Headroom'), findsOneWidget);
    expect(find.text('Throttle Period'), findsOneWidget);
    expect(
      find.text('Pace-Controller Error — Delta from Target %'),
      findsNothing,
    );
    // One color key per chart.
    expect(find.text('Claude'), findsNWidgets(2));
    expect(find.text('Claude · Weekly'), findsNothing);
    expect(find.text('Claude · Session'), findsNothing);
    expect(find.text('55% · as of 2026-07-26T19:00:00.000Z'), findsNothing);
    expect(find.text('now'), findsNWidgets(2));
    expect(find.byType(LinearProgressIndicator), findsNothing);

    final errorPaint = tester.widget<CustomPaint>(
      find.byKey(const Key('quota-pace-error-chart')),
    );
    final errorPainter = errorPaint.painter! as QuotaPaceErrorChartPainter;
    expect(errorPainter.series.single.provider, 'claude');
    expect(errorPainter.start, DateTime.parse('2026-07-23T20:00:00.000Z'));
    expect(errorPainter.end, DateTime.parse('2026-07-26T20:00:00.000Z'));

    final throttlePaint = tester.widget<CustomPaint>(
      find.byKey(const Key('quota-throttle-interval-chart')),
    );
    final throttlePainter =
        throttlePaint.painter! as QuotaThrottleIntervalChartPainter;
    expect(throttlePainter.series.single.provider, 'claude');
  });

  testWidgets(
    'labels a stale cached chart with verbatim timestamps and never now',
    (tester) async {
      tester.view.physicalSize = const Size(900, 1200);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      await tester.pumpWidget(
        MaterialApp(
          theme: buildMeshTheme(),
          home: const Scaffold(
            body: SizedBox(
              width: 900,
              child: QuotaHistoryChart(history: history, isStale: true),
            ),
          ),
        ),
      );

      expect(
        find.text('Cached snapshot as of 2026-07-26T20:00:00.000Z'),
        findsOneWidget,
      );
      expect(find.text('55% · as of 2026-07-26T19:00:00.000Z'), findsNothing);
      expect(find.text('cached'), findsNWidgets(2));
      expect(find.text('now'), findsNothing);
    },
  );

  testWidgets('shows an honest empty state when no recent scrapes exist', (
    tester,
  ) async {
    await tester.pumpWidget(
      MaterialApp(
        theme: buildMeshTheme(),
        home: const Scaffold(
          body: QuotaHistoryChart(
            history: QuotaHistoryDto(
              generatedAt: '2026-07-26T20:00:00.000Z',
              historySince: '2026-07-23T20:00:00.000Z',
              history: [],
            ),
          ),
        ),
      ),
    );

    expect(
      find.text('No quota readings recorded in the prior 3 days.'),
      findsOneWidget,
    );
    expect(find.byKey(const Key('quota-pace-error-chart')), findsNothing);
    expect(
      find.byKey(const Key('quota-throttle-interval-chart')),
      findsNothing,
    );
  });

  testWidgets(
    'renders pace controller error chart with window-reset line breaks',
    (tester) async {
      tester.view.physicalSize = const Size(900, 1200);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      const resetCycle1 = '2026-07-27T00:00:00.000Z';
      const resetCycle2 = '2026-08-03T00:00:00.000Z';
      const multiWindowHistory = QuotaHistoryDto(
        generatedAt: '2026-07-28T12:00:00.000Z',
        historySince: '2026-07-25T12:00:00.000Z',
        history: [
          QuotaHistorySeriesDto(
            provider: 'claude',
            windowId: 'weekly',
            label: 'Weekly',
            points: [
              // Cycle 1 points (underwater / burning fast: -15%)
              QuotaHistoryPointDto(
                observedAt: '2026-07-26T10:00:00.000Z',
                remainingPercent: 30,
                error: -15.0,
                resetAtIso: resetCycle1,
              ),
              QuotaHistoryPointDto(
                observedAt: '2026-07-26T22:00:00.000Z',
                remainingPercent: 10,
                error: -20.0,
                resetAtIso: resetCycle1,
              ),
              // Window reset happens -> Cycle 2 points (surplus quota / burning slow: +10%)
              QuotaHistoryPointDto(
                observedAt: '2026-07-27T06:00:00.000Z',
                remainingPercent: 95,
                error: 5.0,
                resetAtIso: resetCycle2,
              ),
              QuotaHistoryPointDto(
                observedAt: '2026-07-28T10:00:00.000Z',
                remainingPercent: 85,
                error: 10.0,
                resetAtIso: resetCycle2,
              ),
            ],
          ),
        ],
      );

      await tester.pumpWidget(
        MaterialApp(
          theme: buildMeshTheme(),
          home: const Scaffold(
            body: SizedBox(
              width: 900,
              child: Padding(
                padding: EdgeInsets.all(16),
                child: QuotaHistoryChart(history: multiWindowHistory),
              ),
            ),
          ),
        ),
      );

      expect(find.byKey(const Key('quota-pace-error-chart')), findsOneWidget);
      final errorPaint = tester.widget<CustomPaint>(
        find.byKey(const Key('quota-pace-error-chart')),
      );
      final painter = errorPaint.painter! as QuotaPaceErrorChartPainter;
      expect(painter.series.single.points.length, 4);
      expect(painter.series.single.points.map((p) => p.error), [
        -15.0,
        -20.0,
        5.0,
        10.0,
      ]);
    },
  );

  group('ThrottleLogAxis', () {
    QuotaHistorySeriesDto seriesWith(List<double?> intervals) =>
        QuotaHistorySeriesDto(
          provider: 'claude',
          windowId: 'weekly',
          label: 'Weekly',
          points: [
            for (var i = 0; i < intervals.length; i++)
              QuotaHistoryPointDto(
                observedAt: '2026-07-26T0$i:00:00.000Z',
                remainingPercent: 50,
                intervalSeconds: intervals[i],
              ),
          ],
        );

    test('rounds the observed range outward to whole decades', () {
      final axis = ThrottleLogAxis.forSeries([
        seriesWith([12.0, 340.0]),
      ]);
      expect(axis.minExponent, 1);
      expect(axis.maxExponent, 3);
      expect(axis.floorSeconds, 10.0);
      expect(axis.ceilSeconds, 1000.0);
    });

    test('spaces readings logarithmically rather than linearly', () {
      final axis = ThrottleLogAxis.forSeries([
        seriesWith([1.0, 100.0]),
      ]);
      expect(axis.fractionOf(1), closeTo(0.0, 1e-9));
      expect(axis.fractionOf(10), closeTo(0.5, 1e-9));
      expect(axis.fractionOf(100), closeTo(1.0, 1e-9));
      // A 2s change near the floor is far more visible than the same change
      // near the ceiling — that is the point of the log scale.
      final lowStep = axis.fractionOf(3) - axis.fractionOf(1);
      final highStep = axis.fractionOf(100) - axis.fractionOf(98);
      expect(lowStep, greaterThan(highStep * 10));
    });

    test(
      'keeps a full decade for a flat series and pins sub-second readings',
      () {
        final axis = ThrottleLogAxis.forSeries([
          seriesWith([0.0, 0.25, null]),
        ]);
        expect(axis.minExponent, 0);
        expect(axis.maxExponent, 1);
        expect(axis.fractionOf(0), 0.0);
        expect(axis.fractionOf(0.25), 0.0);
      },
    );

    test('falls back to a default decade when no interval was recorded', () {
      final axis = ThrottleLogAxis.forSeries([
        seriesWith([null, null]),
      ]);
      expect(axis.floorSeconds, 1.0);
      expect(axis.ceilSeconds, 10.0);
    });
  });
}
