import 'package:flutter_test/flutter_test.dart';
import 'package:rusa_dashboard/actor_display.dart';

void main() {
  test('uses the authenticated profile label for human principals', () {
    expect(
      actorDisplayLabel('human:operator', null, null, 'Ada Lovelace'),
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
  });

  test('keeps Operator as the safe human-label fallback', () {
    expect(actorDisplayLabel('human:operator'), 'Operator');
    expect(actorDisplayLabel('human:operator', null, null, '   '), 'Operator');
  });
}
