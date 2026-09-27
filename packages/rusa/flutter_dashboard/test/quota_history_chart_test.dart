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

  QuotaHistorySeriesDto weeklySeries(
    String provider,
    double remainingPercent,
  ) => QuotaHistorySeriesDto(
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
    expect(legendColors, [...providerColors, ...providerColors]);
  });

  testWidgets('plots headroom and throttle period with keys', (tester) async {
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

    expect(find.byKey(const Key('quota-history-chart')), findsNothing);
    expect(find.byKey(const Key('quota-pace-error-chart')), findsOneWidget);
    expect(
      find.byKey(const Key('quota-throttle-interval-chart')),
      findsOneWidget,
    );
    expect(find.byKey(const Key('quota-remaining-chart')), findsNothing);
    expect(find.text('Quota Headroom'), findsOneWidget);
    expect(find.text('Throttle Period'), findsOneWidget);
    expect(find.text('Quota Remaining'), findsNothing);
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

      expect(find.text('Claude'), findsNWidgets(2));
      // Fable carries a throttle period but no headroom decision, so the
      // headroom key does not name it.
      expect(find.text('Claude · Fable'), findsOneWidget);
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

  group('model quota readings without a controller decision (#706)', () {
    // Fable model history as the coordinator records it: remaining percent
    // with no controller decision.
    const reset = '2026-10-03T00:00:00.000Z';
    const fable = QuotaHistorySeriesDto(
      provider: 'claude',
      windowId: 'weekly',
      scope: 'model',
      modelIds: ['claude-fable'],
      label: 'Fable',
      points: [
        QuotaHistoryPointDto(
          observedAt: '2026-09-24T01:00:00.000Z',
          remainingPercent: 70,
          resetAtIso: reset,
        ),
        QuotaHistoryPointDto(
          observedAt: '2026-09-26T14:55:00.000Z',
          remainingPercent: 61,
          resetAtIso: reset,
        ),
      ],
    );
    const claude = QuotaHistorySeriesDto(
      provider: 'claude',
      windowId: 'weekly',
      label: 'Weekly',
      points: [
        QuotaHistoryPointDto(
          observedAt: '2026-09-26T14:00:00.000Z',
          remainingPercent: 60,
          error: 5,
          intervalSeconds: 45,
          resetAtIso: reset,
        ),
        QuotaHistoryPointDto(
          observedAt: '2026-09-26T14:55:00.000Z',
          remainingPercent: 58,
          error: 4,
          intervalSeconds: 50,
          resetAtIso: reset,
        ),
      ],
    );
    const generatedAt = '2026-09-26T15:00:00.000Z';
    const historySince = '2026-09-23T15:00:00.000Z';

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

    testWidgets('headroom and throttle draw and name only controller series', (
      tester,
    ) async {
      await pumpChart(
        tester,
        const QuotaHistoryDto(
          generatedAt: generatedAt,
          historySince: historySince,
          history: [claude, fable],
        ),
      );

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
      expect(find.text('Claude · Fable'), findsNothing);
      expect(find.text('Claude'), findsNWidgets(2));

      // Labels name the range the API returned.
      expect(
        find.bySemanticsLabel(RegExp('^Quota headroom over the prior 3 days')),
        findsOneWidget,
      );
    });

    testWidgets(
      'draws a controller-valued Fable line on headroom and throttle',
      (tester) async {
        const controlledFable = QuotaHistorySeriesDto(
          provider: 'claude',
          windowId: 'weekly',
          scope: 'model',
          modelIds: ['claude-fable'],
          label: 'Fable',
          points: [
            QuotaHistoryPointDto(
              observedAt: '2026-09-26T14:00:00.000Z',
              remainingPercent: 62,
              error: 3,
              intervalSeconds: 40,
              resetAtIso: reset,
            ),
            QuotaHistoryPointDto(
              observedAt: '2026-09-26T14:55:00.000Z',
              remainingPercent: 61,
              error: 2,
              intervalSeconds: 55,
              resetAtIso: reset,
            ),
          ],
        );
        await pumpChart(
          tester,
          const QuotaHistoryDto(
            generatedAt: generatedAt,
            historySince: historySince,
            history: [claude, controlledFable],
          ),
        );

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
        expect(headroom.series.map((s) => s.label), ['Weekly', 'Fable']);
        expect(throttle.series.map((s) => s.label), ['Weekly', 'Fable']);
        expect(find.text('Claude · Fable'), findsNWidgets(2));

        // Both readings join into one painted segment on each plot.
        const plot = Rect.fromLTWH(0, 0, 480, 100);
        expect(
          QuotaPaceErrorChartPainter.traceFor(
            headroom.series[1],
            headroom.start,
            headroom.end,
            plot,
          ).segments.map((s) => s.length),
          [2],
        );
        expect(
          QuotaThrottleIntervalChartPainter.traceFor(
            throttle.series[1],
            throttle.start,
            throttle.end,
            plot,
            (seconds) => 100 - seconds,
          ).segments.map((s) => s.length),
          [2],
        );
      },
    );

    testWidgets(
      'says so when no series has a controller decision instead of an empty key',
      (tester) async {
        await pumpChart(
          tester,
          const QuotaHistoryDto(
            generatedAt: generatedAt,
            historySince: historySince,
            history: [fable],
          ),
        );

        expect(
          find.text('No controller decisions recorded in the prior 3 days.'),
          findsOneWidget,
        );
        expect(
          find.text('No throttle decisions recorded in the prior 3 days.'),
          findsOneWidget,
        );
        expect(find.text('Claude · Fable'), findsNothing);
      },
    );

    testWidgets('gives a model series a color no visible provider uses', (
      tester,
    ) async {
      // codex-mini's hashed palette slot is the Codex green.
      QuotaHistorySeriesDto withInterval(QuotaHistorySeriesDto series) =>
          QuotaHistorySeriesDto(
            provider: series.provider,
            windowId: series.windowId,
            scope: series.scope,
            modelIds: series.modelIds,
            label: series.label,
            points: const [
              QuotaHistoryPointDto(
                observedAt: '2026-09-26T14:00:00.000Z',
                remainingPercent: 40,
                intervalSeconds: 60,
              ),
            ],
          );
      await pumpChart(
        tester,
        QuotaHistoryDto(
          generatedAt: generatedAt,
          historySince: historySince,
          history: [
            withInterval(
              const QuotaHistorySeriesDto(
                provider: 'codex',
                windowId: 'weekly',
                label: 'Weekly',
                points: [],
              ),
            ),
            withInterval(
              const QuotaHistorySeriesDto(
                provider: 'codex',
                windowId: 'weekly',
                scope: 'model',
                modelIds: ['codex-mini'],
                label: 'Mini',
                points: [],
              ),
            ),
          ],
        ),
      );
      final throttle =
          tester
                  .widget<CustomPaint>(
                    find.byKey(const Key('quota-throttle-interval-chart')),
                  )
                  .painter!
              as QuotaThrottleIntervalChartPainter;
      expect(throttle.colors[0], const Color(0xFF10B981));
      expect(throttle.colors[1], isNot(const Color(0xFF10B981)));
    });

    group('Fable is drawn in #CF8063 (#728)', () {
      const fableColor = Color(0xFFCF8063);
      QuotaHistorySeriesDto controlled(
        String provider,
        List<String> modelIds, {
        String label = 'Model',
      }) => QuotaHistorySeriesDto(
        provider: provider,
        windowId: 'weekly',
        scope: modelIds.isEmpty ? 'provider' : 'model',
        modelIds: modelIds,
        label: label,
        points: const [
          QuotaHistoryPointDto(
            observedAt: '2026-09-26T14:00:00.000Z',
            remainingPercent: 62,
            error: 3,
            intervalSeconds: 40,
          ),
        ],
      );
      List<Color> plotColors(WidgetTester tester, String key) {
        final painter = tester
            .widget<CustomPaint>(find.byKey(Key(key)))
            .painter!;
        return painter is QuotaPaceErrorChartPainter
            ? painter.colors
            : (painter as QuotaThrottleIntervalChartPainter).colors;
      }

      Color legendColor(WidgetTester tester, Finder label) {
        final key = tester.widget<Container>(
          find.descendant(
            of: find.ancestor(of: label, matching: find.byType(Row)).first,
            matching: find.byType(Container),
          ),
        );
        return (key.decoration! as BoxDecoration).color!;
      }

      testWidgets('on both plots and both legend keys', (tester) async {
        await pumpChart(
          tester,
          QuotaHistoryDto(
            generatedAt: generatedAt,
            historySince: historySince,
            history: [
              controlled('claude', const []),
              controlled('codex', const []),
              controlled('claude', const ['claude-fable-5-1'], label: 'Fable'),
            ],
          ),
        );

        // Provider colors are unchanged: Claude, then Codex.
        const expected = [Color(0xFFC15F3C), Color(0xFF10B981), fableColor];
        expect(plotColors(tester, 'quota-pace-error-chart'), expected);
        expect(plotColors(tester, 'quota-throttle-interval-chart'), expected);
        final legends = find.text('Claude · Fable');
        expect(legends, findsNWidgets(2));
        expect(legendColor(tester, legends.at(0)), fableColor);
        expect(legendColor(tester, legends.at(1)), fableColor);
      });

      testWidgets('and no other series ever lands on it', (tester) async {
        const others = [
          'claude-opus-5-5',
          'claude-sonnet-5',
          'claude-haiku-4-5',
          'claude-opus-4-8',
          'claude-sonnet-4-6',
          'claude-opus',
          'claude-mythos',
          'claude-sonnet',
          'claude-haiku',
        ];
        await pumpChart(
          tester,
          QuotaHistoryDto(
            generatedAt: generatedAt,
            historySince: historySince,
            history: [
              controlled('claude', const []),
              for (final id in others) controlled('claude', [id]),
              // A Fable-named model on another provider is not Claude's Fable.
              controlled('codex', const ['claude-fable']),
              controlled('claude', const ['claude-fable'], label: 'Fable'),
              // A second Fable series still gets a color of its own.
              controlled('claude', const ['claude-fable-5-1'], label: 'Fable'),
            ],
          ),
        );

        final colors = plotColors(tester, 'quota-throttle-interval-chart');
        expect(colors, hasLength(others.length + 4));
        final fableAt = [
          for (var i = 0; i < colors.length; i++)
            if (colors[i] == fableColor) i,
        ];
        expect(fableAt, [others.length + 2]);
        expect(plotColors(tester, 'quota-pace-error-chart'), colors);
      });
    });

    test('parses a missing remaining value as null, never 0%', () {
      expect(
        QuotaHistoryPointDto.fromJson(const {
          'observedAt': '2026-09-26T14:10:00.000Z',
        }).remainingPercent,
        isNull,
      );
    });
  });

  group('controller plot traces keep their own break rules (#713)', () {
    final start = DateTime.parse('2026-09-26T08:00:00.000Z');
    final end = DateTime.parse('2026-09-26T16:00:00.000Z');
    const plot = Rect.fromLTWH(0, 0, 480, 100);
    QuotaHistorySeriesDto seriesOf(List<QuotaHistoryPointDto> points) =>
        QuotaHistorySeriesDto(
          provider: 'claude',
          windowId: 'weekly',
          label: 'Weekly',
          points: points,
        );

    test('breaks at every reading after a passed reset', () {
      QuotaHistoryPointDto at(String time) => QuotaHistoryPointDto(
        observedAt: '2026-09-26T$time:00.000Z',
        remainingPercent: 50,
        error: 0,
        resetAtIso: '2026-09-26T14:30:00.000Z',
      );
      final stale = seriesOf([
        at('14:00'),
        at('14:40'),
        at('14:50'),
        at('15:00'),
      ]);

      final headroom = QuotaPaceErrorChartPainter.traceFor(
        stale,
        start,
        end,
        plot,
      );
      expect(headroom.segments.map((s) => s.length), [1, 1, 1, 1]);
    });

    test('joins readings across a long silence', () {
      final sparse = seriesOf(const [
        QuotaHistoryPointDto(
          observedAt: '2026-09-26T08:30:00.000Z',
          remainingPercent: 50,
          error: 0,
        ),
        QuotaHistoryPointDto(
          observedAt: '2026-09-26T15:30:00.000Z',
          remainingPercent: 50,
          error: 0,
        ),
      ]);

      expect(
        QuotaPaceErrorChartPainter.traceFor(
          sparse,
          start,
          end,
          plot,
        ).segments.map((s) => s.length),
        [2],
      );
    });

    test('breaks at a missing decision and clamps to the ±50% edges', () {
      final trace = QuotaPaceErrorChartPainter.traceFor(
        seriesOf(const [
          QuotaHistoryPointDto(
            observedAt: '2026-09-26T09:00:00.000Z',
            remainingPercent: 50,
            error: 60,
          ),
          QuotaHistoryPointDto(
            observedAt: '2026-09-26T10:00:00.000Z',
            remainingPercent: 50,
          ),
          QuotaHistoryPointDto(
            observedAt: '2026-09-26T11:00:00.000Z',
            remainingPercent: 50,
            error: -80,
          ),
        ]),
        start,
        end,
        plot,
      );
      expect(trace.segments.map((s) => s.map((o) => o.dy)), [
        [plot.top],
        [plot.bottom],
      ]);
    });

    test('throttle breaks at non-finite intervals and every passed reset, '
        'not at a long silence', () {
      QuotaHistoryPointDto at(String time, [double interval = 10]) =>
          QuotaHistoryPointDto(
            observedAt: '2026-09-26T$time:00.000Z',
            remainingPercent: 50,
            intervalSeconds: interval,
            resetAtIso: '2026-09-26T14:30:00.000Z',
          );
      double yFor(double seconds) => 100 - seconds;
      QuotaSeriesTrace traceOf(List<QuotaHistoryPointDto> points) =>
          QuotaThrottleIntervalChartPainter.traceFor(
            seriesOf(points),
            start,
            end,
            plot,
            yFor,
          );

      final nonFinite = traceOf([
        at('09:00', 10),
        at('10:00', double.infinity),
        at('11:00', 20),
      ]);
      expect(nonFinite.segments.map((s) => s.map((o) => o.dy)), [
        [yFor(10)],
        [yFor(20)],
      ]);

      final stale = traceOf([
        at('14:00'),
        at('14:40'),
        at('14:50'),
        at('15:00'),
      ]);
      expect(stale.segments.map((s) => s.length), [1, 1, 1, 1]);

      final sparse = traceOf([at('08:30'), at('12:30')]);
      expect(sparse.segments.map((s) => s.length), [2]);
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
