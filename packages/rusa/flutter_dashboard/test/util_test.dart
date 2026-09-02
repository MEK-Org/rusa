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
}
