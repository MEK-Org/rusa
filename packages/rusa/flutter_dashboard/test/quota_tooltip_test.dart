import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rusa_dashboard/models.dart';
import 'package:rusa_dashboard/widgets/quota_tooltip.dart';

void main() {
  group('QuotaTooltip widget (#760)', () {
    final now = DateTime.utc(2026, 9, 29, 12, 0, 0);

    testWidgets(
      'renders lane with weekly and session windows matching operator example',
      (tester) async {
        // Operator example:
        // Claude
        // Weekly:  +8 (87% / 79%) - Resets in 2 days
        // Session: -1 (5% / 6%)  - Resets in 25 minutes
        // Pacing:  every 10 minutes
        // Last Read: 30 minutes ago

        // 2 days remaining = 48 hours = 172,800,000 ms.
        // For 79% time remaining: windowMs = 172,800,000 / 0.79 = ~218,734,177 ms.
        const weeklyRemainingMs = 48 * 3600 * 1000;
        final weeklyWindowMs = (weeklyRemainingMs / 0.79).round();

        // 25 minutes remaining = 1,500,000 ms.
        // For 6% time remaining: windowMs = 1,500,000 / 0.06 = 25,000,000 ms.
        const sessionRemainingMs = 25 * 60 * 1000;
        final sessionWindowMs = (sessionRemainingMs / 0.06).round();

        final weekly = QuotaWindowDto(
          id: 'weekly',
          label: 'Weekly',
          usedPercent: 13, // 87% remaining
          status: 'available',
          headline: true,
          windowMs: weeklyWindowMs,
          resetAtIso: now.add(const Duration(days: 2)).toIso8601String(),
          scrapedAt: now
              .subtract(const Duration(minutes: 30))
              .toIso8601String(),
        );

        final session = QuotaWindowDto(
          id: 'session',
          label: 'Session',
          usedPercent: 95, // 5% remaining
          status: 'available',
          headline: false,
          windowMs: sessionWindowMs,
          resetAtIso: now.add(const Duration(minutes: 25)).toIso8601String(),
          scrapedAt: now
              .subtract(const Duration(minutes: 30))
              .toIso8601String(),
        );

        final throttle = QuotaThrottleDto(
          intervalSeconds: 600, // 10 minutes
          expired: false,
          capped: false,
          buckets: const [],
          updatedAt: now.toIso8601String(),
        );

        await tester.pumpWidget(
          MaterialApp(
            home: Scaffold(
              body: QuotaTooltip(
                providerName: 'Claude',
                windows: [weekly, session],
                throttle: throttle,
                scrapedAt: now
                    .subtract(const Duration(minutes: 30))
                    .toIso8601String(),
                showThrottle: true,
                now: now,
              ),
            ),
          ),
        );

        expect(find.text('Claude'), findsOneWidget);
        expect(
          find.textContaining('Weekly: +8 (87% / 79%) - Resets in 2 days'),
          findsOneWidget,
        );
        expect(
          find.textContaining('Session: -1 (5% / 6%) - Resets in 25 minutes'),
          findsOneWidget,
        );
        expect(find.textContaining('Pacing: every 10 minutes'), findsOneWidget);
        expect(
          find.textContaining('Last Read: 30 minutes ago'),
          findsOneWidget,
        );

        // Verify no legacy "estimated quota at reset"
        expect(find.textContaining('at reset'), findsNothing);
        expect(find.textContaining('left at reset'), findsNothing);
      },
    );

    testWidgets('renders lane with one window and no pacing row (e.g. Fable)', (
      tester,
    ) async {
      final fableWeekly = QuotaWindowDto(
        id: 'weekly',
        label: 'Current week (Fable)',
        usedPercent: 74, // 26% remaining
        status: 'available',
        headline: true,
        windowMs: 7 * 24 * 3600 * 1000,
        resetAtIso: now.add(const Duration(days: 5)).toIso8601String(),
        scrapedAt: now.subtract(const Duration(minutes: 5)).toIso8601String(),
      );

      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: QuotaTooltip(
              providerName: 'Fable',
              windows: [fableWeekly],
              throttle: null,
              scrapedAt: now
                  .subtract(const Duration(minutes: 5))
                  .toIso8601String(),
              showThrottle: false,
              now: now,
            ),
          ),
        ),
      );

      expect(find.text('Fable'), findsOneWidget);
      // The title already names the model; the row says which window.
      expect(find.textContaining(RegExp(r'^Weekly: .*\(26% / ')), findsOneWidget);
      expect(find.textContaining('(Fable)'), findsNothing);
      expect(find.textContaining('Resets in 5 days'), findsOneWidget);
      expect(find.textContaining('Last Read: 5 minutes ago'), findsOneWidget);
      // Pacing row must be omitted when showThrottle is false
      expect(find.textContaining('Pacing:'), findsNothing);
      expect(find.textContaining('Session:'), findsNothing);
    });

    testWidgets('renders unknown lane with truthful n/a indicators', (
      tester,
    ) async {
      const unknownWeekly = QuotaWindowDto(
        id: 'weekly',
        label: 'Weekly',
        usedPercent: null,
        status: 'unknown',
        headline: false,
      );

      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: QuotaTooltip(
              providerName: 'Unknown',
              windows: const [unknownWeekly],
              throttle: null,
              scrapedAt: null,
              showThrottle: true,
              now: now,
            ),
          ),
        ),
      );

      expect(find.text('Unknown'), findsOneWidget);
      expect(find.textContaining('Weekly: n/a'), findsOneWidget);
      expect(find.textContaining('Pacing: n/a'), findsOneWidget);
      expect(find.textContaining('Last Read: n/a'), findsOneWidget);
    });

    testWidgets(
      'renders window past its reset without showing stale percentages',
      (tester) async {
        final expired = QuotaWindowDto(
          id: 'weekly',
          label: 'Weekly',
          usedPercent: 50,
          status: 'available',
          headline: true,
          windowMs: 7 * 24 * 3600 * 1000,
          resetAtIso: now
              .subtract(const Duration(minutes: 15))
              .toIso8601String(),
          scrapedAt: now.subtract(const Duration(hours: 1)).toIso8601String(),
        );

        await tester.pumpWidget(
          MaterialApp(
            home: Scaffold(
              body: QuotaTooltip(
                providerName: 'Codex',
                windows: [expired],
                throttle: null,
                scrapedAt: now
                    .subtract(const Duration(hours: 1))
                    .toIso8601String(),
                showThrottle: false,
                now: now,
              ),
            ),
          ),
        );

        expect(find.text('Codex'), findsOneWidget);
        expect(find.textContaining('window reset at'), findsOneWidget);
        expect(
          find.textContaining(
            'no fresh read since (awaiting fresh read, estimated ~100% remaining)',
          ),
          findsOneWidget,
        );
        expect(find.textContaining('50%'), findsNothing);
      },
    );

    testWidgets(
      'formats resetAtIso gracefully when windowMs <= 0 without raw ISO string',
      (tester) async {
        final windowNoMs = QuotaWindowDto(
          id: 'weekly',
          label: 'Weekly',
          usedPercent: 40,
          status: 'available',
          headline: true,
          windowMs: 0,
          resetAtIso: now.add(const Duration(hours: 3)).toIso8601String(),
          scrapedAt: now
              .subtract(const Duration(minutes: 10))
              .toIso8601String(),
        );

        await tester.pumpWidget(
          MaterialApp(
            home: Scaffold(
              body: QuotaTooltip(
                providerName: 'Claude',
                windows: [windowNoMs],
                throttle: null,
                scrapedAt: now
                    .subtract(const Duration(minutes: 10))
                    .toIso8601String(),
                showThrottle: false,
                now: now,
              ),
            ),
          ),
        );

        expect(find.text('Claude'), findsOneWidget);
        expect(
          find.textContaining('Weekly: 60% remaining - Resets in 3 hours'),
          findsOneWidget,
        );
        expect(find.textContaining('.000Z'), findsNothing);
      },
    );

    testWidgets('adapts to narrow screens without overflow', (tester) async {
      const weeklyRemainingMs = 48 * 3600 * 1000;
      final weeklyWindowMs = (weeklyRemainingMs / 0.79).round();

      final weekly = QuotaWindowDto(
        id: 'weekly',
        label: 'Weekly',
        usedPercent: 13,
        status: 'available',
        headline: true,
        windowMs: weeklyWindowMs,
        resetAtIso: now.add(const Duration(days: 2)).toIso8601String(),
        scrapedAt: now.subtract(const Duration(minutes: 30)).toIso8601String(),
      );

      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: SizedBox(
              width: 220,
              child: QuotaTooltip(
                providerName: 'Claude',
                windows: [weekly],
                throttle: const QuotaThrottleDto(
                  intervalSeconds: 600,
                  expired: false,
                  capped: false,
                  buckets: [],
                  updatedAt: '2026-09-29T12:00:00.000Z',
                ),
                scrapedAt: now
                    .subtract(const Duration(minutes: 30))
                    .toIso8601String(),
                showThrottle: true,
                now: now,
              ),
            ),
          ),
        ),
      );

      expect(tester.takeException(), isNull);
      expect(find.text('Claude'), findsOneWidget);
      expect(find.textContaining('Weekly:'), findsOneWidget);
    });
  });

  // Seat 2 review 5353887533: the structured tooltip keeps the control loop's
  // freshness and pacing explanations from the legacy text tooltip, in a
  // secondary section under Last Read.
  group('QuotaTooltip pacing diagnostics (#760)', () {
    final now = DateTime.utc(2026, 9, 29, 12, 0, 0);
    final weekly = QuotaWindowDto(
      id: 'weekly',
      label: 'Weekly',
      usedPercent: 13,
      status: 'available',
      headline: true,
      windowMs: 7 * 24 * 3600 * 1000,
      resetAtIso: now.add(const Duration(days: 2)).toIso8601String(),
    );

    QuotaTooltip tooltipFor(
      QuotaThrottleDto throttle, {
      bool showThrottle = true,
    }) => QuotaTooltip(
      providerName: 'Claude',
      windows: [weekly],
      throttle: throttle,
      scrapedAt: now.subtract(const Duration(minutes: 30)).toIso8601String(),
      showThrottle: showThrottle,
      now: now,
    );

    // Matt's #764 review: the hottest bucket's error is its window row's
    // headroom negated (`Session: -1` is "1.0 points over pace").
    test('leaves the hottest bucket to its window row', () {
      expect(
        quotaPacingDiagnostics(
          const QuotaThrottleDto(
            intervalSeconds: 73,
            expired: false,
            updatedAt: '2026-07-22T12:00:00.000Z',
            buckets: [
              QuotaThrottleBucketDto(
                key: 'claude:session',
                error: 4,
                percentLeft: 30,
                timeRemainingPct: 50,
              ),
              QuotaThrottleBucketDto(
                key: 'claude:weekly',
                error: 20,
                percentLeft: 30,
                timeRemainingPct: 50,
              ),
            ],
          ),
        ),
        isEmpty,
      );
    });

    // Freshness restates Last Read: its age, with the stale suffixes.
    test('leaves a fresh reading to Last Read', () {
      expect(
        quotaPacingDiagnostics(
          const QuotaThrottleDto(
            intervalSeconds: 600,
            expired: false,
            updatedAt: '2026-09-25T13:42:29.000Z',
            buckets: [],
            freshness: QuotaFreshnessDto(mode: 'scrape'),
          ),
        ),
        isEmpty,
      );
    });

    test('leaves a stale reading to Last Read', () {
      expect(
        quotaPacingDiagnostics(
          const QuotaThrottleDto(
            intervalSeconds: 600,
            expired: false,
            updatedAt: '2026-09-25T13:42:29.000Z',
            buckets: [],
            freshness: QuotaFreshnessDto(mode: 'scrape', stale: true),
          ),
        ),
        isEmpty,
      );
    });

    test(
      'explains the configured maximum, leaving reset-waiting to the window row',
      () {
        expect(
          quotaPacingDiagnostics(
            const QuotaThrottleDto(
              intervalSeconds: 36000,
              expired: false,
              capped: true,
              updatedAt: '2026-09-25T13:42:29.000Z',
              buckets: [],
              freshness: QuotaFreshnessDto(
                mode: 'manual',
                stale: true,
                hardStale: true,
                resetWaiting: true,
              ),
            ),
          ),
          ['Limited to the configured maximum interval'],
        );
      },
    );

    test('explains expired-window recovery instead of the hottest bucket', () {
      expect(
        quotaPacingDiagnostics(
          const QuotaThrottleDto(
            intervalSeconds: 73,
            expired: true,
            updatedAt: '2026-07-22T12:00:00.000Z',
            buckets: [
              QuotaThrottleBucketDto(
                key: 'claude:weekly',
                error: 20,
                percentLeft: 30,
                timeRemainingPct: 50,
              ),
            ],
          ),
        ),
        ['Previous quota window expired; returning to the configured interval'],
      );
    });

    test('is empty when nothing beyond the interval explains pacing', () {
      expect(
        quotaPacingDiagnostics(
          const QuotaThrottleDto(
            intervalSeconds: 73,
            expired: false,
            updatedAt: '2026-07-22T12:00:00.000Z',
            buckets: [],
          ),
        ),
        isEmpty,
      );
    });

    testWidgets('renders the diagnostics under Last Read', (tester) async {
      final tooltip = tooltipFor(
        const QuotaThrottleDto(
          intervalSeconds: 36000,
          expired: false,
          capped: true,
          updatedAt: '2026-09-25T13:42:29.000Z',
          buckets: [],
          freshness: QuotaFreshnessDto(
            mode: 'manual',
            stale: true,
            hardStale: true,
          ),
        ),
      );
      await tester.pumpWidget(MaterialApp(home: Scaffold(body: tooltip)));

      expect(find.textContaining('Freshness'), findsNothing);
      expect(
        find.text('Limited to the configured maximum interval'),
        findsOneWidget,
      );
      expect(
        tooltip.toPlainText(),
        'Claude\n'
        '\n'
        'Weekly: +58 (87% / 29%) - Resets in 2 days\n'
        'Pacing: every 10 hours\n'
        'Last Read (manual): 30 minutes ago [overdue: hard-stale, fail-safe cap applied]\n'
        '\n'
        'Limited to the configured maximum interval',
      );
    });

    testWidgets('omits the diagnostics when the lane hides pacing', (
      tester,
    ) async {
      final tooltip = tooltipFor(
        const QuotaThrottleDto(
          intervalSeconds: 36000,
          expired: false,
          capped: true,
          updatedAt: '2026-09-25T13:42:29.000Z',
          buckets: [],
        ),
        showThrottle: false,
      );
      await tester.pumpWidget(MaterialApp(home: Scaffold(body: tooltip)));

      expect(find.textContaining('configured maximum'), findsNothing);
      expect(tooltip.toPlainText(), isNot(contains('configured maximum')));
    });
  });
}
