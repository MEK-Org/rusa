import 'package:flutter_test/flutter_test.dart';
import 'package:rusa_dashboard/actor_display.dart';

void main() {
  test(
    'uses the authenticated profile label only for the viewing principal',
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
    'does not infer human identity from ids and uses Operator for an unnamed viewer',
    () {
      expect(
        actorDisplayLabel(
          'human:another-person',
          null,
          (id) => id == '00000000-0000-4000-8000-000000000001',
          'Ada Lovelace',
        ),
        'Unknown actor',
      );
      expect(
        actorDisplayLabel('00000000-0000-4000-8000-000000000001'),
        'Unknown actor',
      );
      expect(
        actorDisplayLabel(
          '00000000-0000-4000-8000-000000000001',
          null,
          (id) => id == '00000000-0000-4000-8000-000000000001',
          '   ',
        ),
        'Operator',
      );
    },
  );
}
