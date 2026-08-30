import 'package:flutter_test/flutter_test.dart';
import 'package:rusa_dashboard/dashboard_title.dart';

void main() {
  group('resolveDashboardTitle', () {
    test('keeps the title the served shell loaded with', () {
      // The server brands index.html with the configured root actor's name; the
      // app must re-assert that, not overwrite it (see dashboard_title.dart).
      expect(resolveDashboardTitle('Ember Familiar'), 'Ember Familiar');
      expect(resolveDashboardTitle('Rusa Staging'), 'Rusa Staging');
    });

    test('trims surrounding whitespace', () {
      expect(resolveDashboardTitle('  Ember Familiar\n'), 'Ember Familiar');
    });

    test('falls back when the shell carries no title', () {
      expect(resolveDashboardTitle(null), defaultDashboardTitle);
      expect(resolveDashboardTitle(''), defaultDashboardTitle);
      expect(resolveDashboardTitle('   '), defaultDashboardTitle);
    });
  });
}
