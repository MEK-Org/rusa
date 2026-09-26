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
            error: 4,
            intervalSeconds: 60,
          ),
          QuotaHistoryPointDto(
            observedAt: '2026-07-26T19:00:00.000Z',
            remainingPercent: 55,
            error: -2,
            intervalSeconds: 90,
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

  QuotaHistorySeriesDto weeklySeries(String provider, double remainingPercent) =>
      QuotaHistorySeriesDto(
        provider: provider,
        windowId: 'weekly',
        label: 'Weekly',
        points: [
          QuotaHistoryPointDto(
            observedAt: '2026-07-26T19:00:00.000Z',
            remainingPercent: remainingPercent,
            error: 0,
            intervalSeconds: 60,
          ),
        ],
      );

  final providerIdentityHistory = QuotaHistoryDto(
    generatedAt: '2026-07-26T20:00:00.000Z',
    historySince: '2026-07-23T20:00:00.000Z',
    history: [
      weeklySeries('claude', 80),
      weeklySeries('agy', 70),
      weeklySeries('codex', 60),
      weeklySeries('kimi', 50),
    ],
  );

  testWidgets('renders stable provider colors in every chart legend', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(900, 1200);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    await tester.pumpWidget(
      MaterialApp(
        theme: buildMeshTheme(),
        home: Scaffold(
          body: SizedBox(
            width: 900,
            child: QuotaHistoryChart(history: providerIdentityHistory),
          ),
        ),
      ),
    );

    final legendColors = tester
        .widgetList<Container>(find.byType(Container))
        .where(
          (container) =>
              container.constraints?.maxWidth == 18 &&
              container.constraints?.maxHeight == 3,
        )
        .map((container) => (container.decoration! as BoxDecoration).color)
        .toList();

    const providerColors = [
      Color(0xFFC15F3C),
      Color(0xFF3B82F6),
      Color(0xFF10B981),
      Color(0xFFA855F7),
    ];
    expect(legendColors, [
      ...providerColors,
      ...providerColors,
      ...providerColors,
    ]);
  });

  testWidgets('plots headroom, throttle period and remaining with keys', (
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

    // Headroom leads; recorded remaining follows the controller plots (#706).
    expect(find.byKey(const Key('quota-history-chart')), findsNothing);
    expect(find.byKey(const Key('quota-pace-error-chart')), findsOneWidget);
    expect(
      find.byKey(const Key('quota-throttle-interval-chart')),
      findsOneWidget,
    );
    expect(find.byKey(const Key('quota-remaining-chart')), findsOneWidget);
    expect(find.text('Quota Headroom'), findsOneWidget);
    expect(find.text('Throttle Period'), findsOneWidget);
    expect(find.text('Quota Remaining'), findsOneWidget);
    expect(
      tester.getTopLeft(find.text('Quota Headroom')).dy,
      lessThan(tester.getTopLeft(find.text('Quota Remaining')).dy),
    );
    expect(
      find.text(
        'How long the mesh waits between runs. The scale is logarithmic.',
      ),
      findsOneWidget,
    );
    expect(
      find.textContaining(
        'each labelled gridline is ten times the one below it',
      ),
      findsNothing,
    );
    expect(
      find.text('Pace-Controller Error — Delta from Target %'),
      findsNothing,
    );
    // One color key per chart.
    expect(find.text('Claude'), findsNWidgets(3));
    expect(find.text('Claude · Weekly'), findsNothing);
    expect(find.text('Claude · Session'), findsNothing);
    expect(find.text('55% · as of 2026-07-26T19:00:00.000Z'), findsNothing);
    expect(find.text('now'), findsNWidgets(3));
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
    'renders a Fable weekly series separately from provider-wide Claude',
    (tester) async {
      tester.view.physicalSize = const Size(900, 1200);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      const fableHistory = QuotaHistoryDto(
        generatedAt: '2026-07-26T20:00:00.000Z',
        historySince: '2026-07-23T20:00:00.000Z',
        history: [
          QuotaHistorySeriesDto(
            provider: 'claude',
            windowId: 'weekly',
            label: 'Weekly',
            points: [
              QuotaHistoryPointDto(
                observedAt: '2026-07-26T19:00:00.000Z',
                remainingPercent: 70,
                error: 3,
                intervalSeconds: 30,
              ),
            ],
          ),
          QuotaHistorySeriesDto(
            provider: 'claude',
            windowId: 'weekly',
            scope: 'model',
            modelIds: ['claude-fable'],
            label: 'Fable',
            points: [
              QuotaHistoryPointDto(
                observedAt: '2026-07-26T19:00:00.000Z',
                remainingPercent: 40,
                intervalSeconds: 120,
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
              child: QuotaHistoryChart(history: fableHistory),
            ),
          ),
        ),
      );

      expect(find.text('Claude'), findsNWidgets(3));
      // Fable carries a throttle period but no headroom decision, so the
      // headroom key does not name it.
      expect(find.text('Claude · Fable'), findsNWidgets(2));
      final errorPaint = tester.widget<CustomPaint>(
        find.byKey(const Key('quota-pace-error-chart')),
      );
      expect(
        (errorPaint.painter! as QuotaPaceErrorChartPainter).series,
        hasLength(1),
      );
      final throttlePainter =
          tester
                  .widget<CustomPaint>(
                    find.byKey(const Key('quota-throttle-interval-chart')),
                  )
                  .painter!
              as QuotaThrottleIntervalChartPainter;
      expect(throttlePainter.series, hasLength(2));
      // The model line is drawn in its own color, not the provider's.
      expect(throttlePainter.colors[0], const Color(0xFFC15F3C));
      expect(throttlePainter.colors[1], isNot(const Color(0xFFC15F3C)));
    },
  );

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
      expect(find.text('cached'), findsNWidgets(3));
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
    expect(find.byKey(const Key('quota-throttle-interval-chart')), findsNothing);
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

  group('historical model quota remaining (#706)', () {
    // Synthetic Fable model history as the coordinator records it: remaining
    // percent with no controller decision, from Sep 14 through the reset to Sep 26.
    QuotaHistoryPointDto fablePoint(
      String observedAt,
      double remaining,
      String resetAt,
    ) => QuotaHistoryPointDto(
      observedAt: observedAt,
      remainingPercent: remaining,
      resetAtIso: resetAt,
    );
    const firstReset = '2026-09-19T00:00:00.000Z';
    const secondReset = '2026-09-26T00:00:00.000Z';
    const thirdReset = '2026-10-03T00:00:00.000Z';
    final fable = QuotaHistorySeriesDto(
      provider: 'claude',
      windowId: 'weekly',
      scope: 'model',
      modelIds: const ['claude-fable'],
      label: 'Fable',
      points: [
        fablePoint('2026-09-14T00:05:00.000Z', 97, firstReset),
        fablePoint('2026-09-14T00:35:00.000Z', 96, firstReset),
        fablePoint('2026-09-18T23:30:00.000Z', 12, firstReset),
        fablePoint('2026-09-19T00:30:00.000Z', 100, secondReset),
        fablePoint('2026-09-19T01:00:00.000Z', 99, secondReset),
        // Nothing recorded for two days.
        fablePoint('2026-09-21T01:00:00.000Z', 70, secondReset),
        fablePoint('2026-09-21T01:30:00.000Z', 69, secondReset),
        fablePoint('2026-09-26T00:30:00.000Z', 0, thirdReset),
        fablePoint('2026-09-26T14:55:00.000Z', 61, thirdReset),
      ],
    );
    final claude = QuotaHistorySeriesDto(
      provider: 'claude',
      windowId: 'weekly',
      label: 'Weekly',
      points: const [
        QuotaHistoryPointDto(
          observedAt: '2026-09-26T14:00:00.000Z',
          remainingPercent: 60,
          error: 5,
          intervalSeconds: 45,
          resetAtIso: thirdReset,
        ),
        QuotaHistoryPointDto(
          observedAt: '2026-09-26T14:55:00.000Z',
          remainingPercent: 58,
          error: 4,
          intervalSeconds: 50,
          resetAtIso: thirdReset,
        ),
      ],
    );
    final fortnight = QuotaHistoryDto(
      generatedAt: '2026-09-26T15:00:00.000Z',
      historySince: '2026-09-12T15:00:00.000Z',
      history: [claude, fable],
    );

    Future<void> pumpChart(WidgetTester tester, QuotaHistoryDto history) async {
      tester.view.physicalSize = const Size(900, 1400);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      await tester.pumpWidget(
        MaterialApp(
          theme: buildMeshTheme(),
          home: Scaffold(
            body: SizedBox(
              width: 900,
              child: SingleChildScrollView(
                child: QuotaHistoryChart(history: history),
              ),
            ),
          ),
        ),
      );
    }

    testWidgets(
      'draws the Fable line on the remaining plot while the controller plots stay honest',
      (tester) async {
        await pumpChart(tester, fortnight);

        final remainingFinder = find.byKey(const Key('quota-remaining-chart'));
        final remaining =
            tester.widget<CustomPaint>(remainingFinder).painter!
                as QuotaRemainingChartPainter;
        expect(remaining.series.map((s) => s.label), ['Weekly', 'Fable']);
        expect(remaining.start, DateTime.parse('2026-09-12T15:00:00.000Z'));
        expect(remaining.end, DateTime.parse('2026-09-26T15:00:00.000Z'));
        final fableColor = remaining.colors[1];
        expect(fableColor, isNot(remaining.colors[0]));
        expect(
          tester.renderObject(remainingFinder),
          // Series paint in order: the provider line, then Fable's.
          paints
            ..path(color: remaining.colors[0])
            ..path(color: fableColor),
        );

        // Headroom and throttle draw and name only the controller series.
        final headroom =
            tester
                    .widget<CustomPaint>(
                      find.byKey(const Key('quota-pace-error-chart')),
                    )
                    .painter!
                as QuotaPaceErrorChartPainter;
        final throttle =
            tester
                    .widget<CustomPaint>(
                      find.byKey(const Key('quota-throttle-interval-chart')),
                    )
                    .painter!
                as QuotaThrottleIntervalChartPainter;
        expect(headroom.series.map((s) => s.label), ['Weekly']);
        expect(throttle.series.map((s) => s.label), ['Weekly']);
        expect(find.text('Claude · Fable'), findsOneWidget);
        expect(find.text('Claude'), findsNWidgets(3));

        // Labels name the range the API returned.
        expect(
          find.bySemanticsLabel(
            RegExp('^Quota remaining over the prior 14 days'),
          ),
          findsOneWidget,
        );
      },
    );

    testWidgets(
      'says so when no series has a controller decision instead of an empty key',
      (tester) async {
        await pumpChart(
          tester,
          QuotaHistoryDto(
            generatedAt: fortnight.generatedAt,
            historySince: fortnight.historySince,
            history: [fable],
          ),
        );

        expect(
          find.text('No controller decisions recorded in the prior 14 days.'),
          findsOneWidget,
        );
        expect(
          find.text('No throttle decisions recorded in the prior 14 days.'),
          findsOneWidget,
        );
        expect(find.text('Claude · Fable'), findsOneWidget);
      },
    );

    testWidgets('gives a model series a color no visible provider uses', (
      tester,
    ) async {
      // claude-fable's hashed palette slot is the Codex green.
      await pumpChart(
        tester,
        QuotaHistoryDto(
          generatedAt: fortnight.generatedAt,
          historySince: fortnight.historySince,
          history: [
            QuotaHistorySeriesDto(
              provider: 'codex',
              windowId: 'weekly',
              label: 'Weekly',
              points: const [
                QuotaHistoryPointDto(
                  observedAt: '2026-09-26T14:00:00.000Z',
                  remainingPercent: 40,
                ),
              ],
            ),
            fable,
          ],
        ),
      );
      final remaining =
          tester
                  .widget<CustomPaint>(
                    find.byKey(const Key('quota-remaining-chart')),
                  )
                  .painter!
              as QuotaRemainingChartPainter;
      expect(remaining.colors[0], const Color(0xFF10B981));
      expect(remaining.colors[1], isNot(const Color(0xFF10B981)));
    });

    test('breaks the line at resets and gaps and never invents a reading', () {
      const plot = Rect.fromLTWH(0, 0, 1400, 100);
      final trace = QuotaRemainingChartPainter.traceFor(
        fable,
        DateTime.parse('2026-09-12T15:00:00.000Z'),
        DateTime.parse('2026-09-26T15:00:00.000Z'),
        plot,
      );

      // [Sep 14 ×2] gap [Sep 18] reset [Sep 19 ×2] gap [Sep 21 ×2] reset+gap
      // [Sep 26 00:30] gap [Sep 26 14:55].
      expect(trace.segments.map((s) => s.length), [2, 1, 2, 2, 1, 1]);
      expect(trace.segments.expand((s) => s), hasLength(fable.points.length));
      // Two resets, each marked between the readings it separates.
      expect(trace.resetXs, hasLength(2));
      final sep19 =
          plot.width *
          DateTime.parse(firstReset)
              .difference(DateTime.parse('2026-09-12T15:00:00.000Z'))
              .inMilliseconds /
          const Duration(days: 14).inMilliseconds;
      expect(trace.resetXs.first, closeTo(sep19, 0.01));
      // A recorded 0% sits on the floor; 100% on the ceiling.
      expect(trace.segments[4].single.dy, plot.bottom);
      expect(trace.segments[2].first.dy, plot.top);
    });

    test('skips a reading with no remaining value rather than drawing 0%', () {
      final withMissing = QuotaHistorySeriesDto(
        provider: 'claude',
        windowId: 'weekly',
        label: 'Weekly',
        points: const [
          QuotaHistoryPointDto(
            observedAt: '2026-09-26T14:00:00.000Z',
            remainingPercent: 50,
          ),
          QuotaHistoryPointDto(
            observedAt: '2026-09-26T14:10:00.000Z',
            remainingPercent: null,
          ),
          QuotaHistoryPointDto(
            observedAt: '2026-09-26T14:20:00.000Z',
            remainingPercent: 48,
          ),
        ],
      );
      final trace = QuotaRemainingChartPainter.traceFor(
        withMissing,
        DateTime.parse('2026-09-26T13:00:00.000Z'),
        DateTime.parse('2026-09-26T15:00:00.000Z'),
        const Rect.fromLTWH(0, 0, 120, 100),
      );
      expect(trace.segments.single.map((o) => o.dy), [50, 52]);

      expect(
        QuotaHistoryPointDto.fromJson(const {
          'observedAt': '2026-09-26T14:10:00.000Z',
        }).remainingPercent,
        isNull,
      );
    });
  });

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

    test('keeps a full decade for a flat series and pins sub-second readings', () {
      final axis = ThrottleLogAxis.forSeries([
        seriesWith([0.0, 0.25, null]),
      ]);
      expect(axis.minExponent, 0);
      expect(axis.maxExponent, 1);
      expect(axis.fractionOf(0), 0.0);
      expect(axis.fractionOf(0.25), 0.0);
    });

    test('falls back to a default decade when no interval was recorded', () {
      final axis = ThrottleLogAxis.forSeries([
        seriesWith([null, null]),
      ]);
      expect(axis.floorSeconds, 1.0);
      expect(axis.ceilSeconds, 10.0);
    });
  });
}
