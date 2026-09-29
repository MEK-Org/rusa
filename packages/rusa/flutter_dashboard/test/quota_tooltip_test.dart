import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rusa_dashboard/models.dart';
import 'package:rusa_dashboard/widgets/quota_tooltip.dart';

void main() {
  group('QuotaTooltip widget (#760)', () {
    final now = DateTime.utc(2026, 9, 29, 12, 0, 0);

    testWidgets('renders lane with weekly and session windows matching operator example', (
      tester,
    ) async {
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
        scrapedAt: now.subtract(const Duration(minutes: 30)).toIso8601String(),
      );

      final session = QuotaWindowDto(
        id: 'session',
        label: 'Session',
        usedPercent: 95, // 5% remaining
        status: 'available',
        headline: false,
        windowMs: sessionWindowMs,
        resetAtIso: now.add(const Duration(minutes: 25)).toIso8601String(),
        scrapedAt: now.subtract(const Duration(minutes: 30)).toIso8601String(),
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
              scrapedAt: now.subtract(const Duration(minutes: 30)).toIso8601String(),
              showThrottle: true,
              now: now,
            ),
          ),
        ),
      );

      expect(find.text('Claude'), findsOneWidget);
      expect(find.textContaining('Weekly: +8 (87% / 79%) - Resets in 2 days'), findsOneWidget);
      expect(find.textContaining('Session: -1 (5% / 6%) - Resets in 25 minutes'), findsOneWidget);
      expect(find.textContaining('Pacing: every 10 minutes'), findsOneWidget);
      expect(find.textContaining('Last Read: 30 minutes ago'), findsOneWidget);

      // Verify no legacy "estimated quota at reset"
      expect(find.textContaining('at reset'), findsNothing);
      expect(find.textContaining('left at reset'), findsNothing);
    });

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
              scrapedAt: now.subtract(const Duration(minutes: 5)).toIso8601String(),
              showThrottle: false,
              now: now,
            ),
          ),
        ),
      );

      expect(find.text('Fable'), findsOneWidget);
      expect(find.textContaining('Current week (Fable):'), findsOneWidget);
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

    testWidgets('renders window past its reset without showing stale percentages', (
      tester,
    ) async {
      final expired = QuotaWindowDto(
        id: 'weekly',
        label: 'Weekly',
        usedPercent: 50,
        status: 'available',
        headline: true,
        windowMs: 7 * 24 * 3600 * 1000,
        resetAtIso: now.subtract(const Duration(minutes: 15)).toIso8601String(),
        scrapedAt: now.subtract(const Duration(hours: 1)).toIso8601String(),
      );

      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: QuotaTooltip(
              providerName: 'Codex',
              windows: [expired],
              throttle: null,
              scrapedAt: now.subtract(const Duration(hours: 1)).toIso8601String(),
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
    });

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
          scrapedAt: now.subtract(const Duration(minutes: 10)).toIso8601String(),
        );

        await tester.pumpWidget(
          MaterialApp(
            home: Scaffold(
              body: QuotaTooltip(
                providerName: 'Claude',
                windows: [windowNoMs],
                throttle: null,
                scrapedAt: now.subtract(const Duration(minutes: 10)).toIso8601String(),
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
                scrapedAt: now.subtract(const Duration(minutes: 30)).toIso8601String(),
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
}
