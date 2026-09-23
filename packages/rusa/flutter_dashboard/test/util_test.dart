import 'package:flutter_test/flutter_test.dart';
import 'package:rusa_dashboard/util.dart';

void main() {
  group('formatReturnsIn', () {
    test('falls back to the raw string when unparseable', () {
      expect(formatReturnsIn('not-a-date'), 'not-a-date');
    });

    test('reports "due" once the moment has passed', () {
      final past = DateTime.now()
          .subtract(const Duration(minutes: 5))
          .toIso8601String();
      expect(formatReturnsIn(past), 'due');
    });

    test('renders days and hours for a multi-day horizon', () {
      // A few seconds of slack absorbs the gap between this clock read and
      // the one inside formatReturnsIn, so truncation can't flip the minute.
      final future = DateTime.now()
          .add(const Duration(days: 2, hours: 3, seconds: 30))
          .toIso8601String();
      expect(formatReturnsIn(future), 'in 2d 3h');
    });

    test('renders hours and minutes within a single day', () {
      final future = DateTime.now()
          .add(const Duration(hours: 4, minutes: 20, seconds: 30))
          .toIso8601String();
      expect(formatReturnsIn(future), 'in 4h 20m');
    });

    test('renders minutes within a single hour', () {
      final future = DateTime.now()
          .add(const Duration(minutes: 15, seconds: 30))
          .toIso8601String();
      expect(formatReturnsIn(future), 'in 15m');
    });

    test('renders "in <1m" for a horizon under a minute away', () {
      final future = DateTime.now()
          .add(const Duration(seconds: 30))
          .toIso8601String();
      expect(formatReturnsIn(future), 'in <1m');
    });
  });

  group('formatStartsIn', () {
    final now = DateTime.utc(2026, 1, 1, 12);
    String? at(Duration d) =>
        formatStartsIn(now.add(d).toIso8601String(), now: now);

    test('quotes an approximate, rounded wait', () {
      expect(at(const Duration(seconds: 20)), 'in <1 min');
      expect(at(const Duration(minutes: 7, seconds: 40)), 'in ~8 min');
      expect(at(const Duration(hours: 2)), 'in ~2 h');
      expect(at(const Duration(hours: 2, minutes: 5)), 'in ~2 h 5 min');
      expect(at(const Duration(days: 3, hours: 4)), 'in ~3 d 4 h');
      expect(at(const Duration(days: 1)), 'in ~1 d');
    });

    test('returns null once the estimate has passed or is unreadable', () {
      expect(at(const Duration(seconds: -1)), isNull);
      expect(formatStartsIn('not-a-date', now: now), isNull);
    });
  });
}
