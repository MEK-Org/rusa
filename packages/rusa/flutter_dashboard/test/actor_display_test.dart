import 'package:flutter_test/flutter_test.dart';
import 'package:rusa_dashboard/actor_display.dart';

void main() {
  test(
    'uses the authenticated profile label only for the viewing principal',
    () {
      expect(
        actorDisplayLabel(
          'human:operator',
          null,
          (id) => id == 'human:operator',
          'Ada Lovelace',
        ),
        'Ada Lovelace',
      );
      expect(
        actorDisplayLabel(
          'durable-user-id',
          (id) => null,
          (id) => id == 'durable-user-id',
          'ada@example.test',
        ),
        'ada@example.test',
      );
    },
  );

  test(
    'keeps Operator for another human principal and as the safe fallback',
    () {
      expect(
        actorDisplayLabel(
          'human:another-person',
          null,
          (id) => id == 'human:operator',
          'Ada Lovelace',
        ),
        'Operator',
      );
      expect(actorDisplayLabel('human:operator'), 'Operator');
      expect(
        actorDisplayLabel(
          'human:operator',
          null,
          (id) => id == 'human:operator',
          '   ',
        ),
        'Operator',
      );
    },
  );
}
