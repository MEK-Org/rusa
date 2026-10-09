import 'package:flutter_test/flutter_test.dart';
import 'package:rusa_dashboard/actor_display.dart';

void main() {
  test(
    'uses the authenticated profile label for the viewing principal',
    () {
      expect(
        actorDisplayLabel(
          '00000000-0000-4000-8000-000000000001',
          null,
          (id) => id == '00000000-0000-4000-8000-000000000001',
          'Ada Lovelace',
        ),
        'Ada Lovelace',
      );
    },
  );
}
