import 'package:flutter_test/flutter_test.dart';
import 'package:rusa_dashboard/event_coalesce.dart';

import 'fakes.dart';

// Events are passed newest-first (server order = rowid desc). Within a run the
// rowid order is run_start < run_yielded < run_end, so in a newest-first list a
// run_end sits ABOVE (before) its own run_yielded.

void main() {
  group('coalesceRunEvents', () {
    test('merges a run_end with its run\'s run_yielded (complete)', () {
      final rows = coalesceRunEvents([
        makeEvent('2', 'run_end', actor: 'x', detail: 'exit 0'),
        makeEvent('1', 'run_yielded', actor: 'x', detail: 'complete'),
      ]);
      expect(rows, hasLength(1));
      expect(rows.single.isCoalesced, isTrue);
      expect(rows.single.primary.kind, 'run_end');
      expect(rows.single.yieldStatus, 'complete');
    });

    test('merges a blocked yield too', () {
      final rows = coalesceRunEvents([
        makeEvent('2', 'run_end', actor: 'x'),
        makeEvent('1', 'run_yielded', actor: 'x', detail: 'blocked'),
      ]);
      expect(rows, hasLength(1));
      expect(rows.single.yieldStatus, 'blocked');
    });

    test(
      'pairs across interleaved other-actor events (not global adjacency)',
      () {
        final rows = coalesceRunEvents([
          makeEvent('3', 'run_end', actor: 'x'),
          makeEvent('2', 'message_sent', actor: 'y', peer: 'x'),
          makeEvent('1', 'run_yielded', actor: 'x', detail: 'complete'),
        ]);
        expect(rows, hasLength(2)); // coalesced(x) + the y message
        expect(rows[0].isCoalesced, isTrue);
        expect(rows[1].primary.kind, 'message_sent');
      },
    );

    test('a run_end with no yield (auto-continue) stays standalone', () {
      final rows = coalesceRunEvents([
        makeEvent('3', 'run_continued', actor: 'x'),
        makeEvent('2', 'run_end', actor: 'x'),
        makeEvent('1', 'run_start', actor: 'x'),
      ]);
      expect(rows, hasLength(3));
      expect(rows.every((r) => !r.isCoalesced), isTrue);
    });

    test('never pairs a run_end with a different run\'s yield', () {
      // Two complete runs for x, newest-first.
      final rows = coalesceRunEvents([
        makeEvent('6', 'run_end', actor: 'x'),
        makeEvent('5', 'run_yielded', actor: 'x', detail: 'blocked'),
        makeEvent('4', 'run_start', actor: 'x'),
        makeEvent('3', 'run_end', actor: 'x'),
        makeEvent('2', 'run_yielded', actor: 'x', detail: 'complete'),
        makeEvent('1', 'run_start', actor: 'x'),
      ]);
      expect(rows, hasLength(4)); // 2 coalesced + 2 run_start
      expect(rows[0].isCoalesced, isTrue);
      expect(rows[0].yieldStatus, 'blocked');
      expect(rows[1].primary.kind, 'run_start');
      expect(rows[2].isCoalesced, isTrue);
      expect(rows[2].yieldStatus, 'complete');
      expect(rows[3].primary.kind, 'run_start');
    });

    test('continuation_capped bounds the scan (no cross-run pairing)', () {
      // A capped run ends without yielding; an earlier run's yield is older.
      final rows = coalesceRunEvents([
        makeEvent('5', 'run_end', actor: 'x'),
        makeEvent('4', 'continuation_capped', actor: 'x'),
        makeEvent('3', 'run_end', actor: 'x'),
        makeEvent('2', 'run_yielded', actor: 'x', detail: 'complete'),
        makeEvent('1', 'run_start', actor: 'x'),
      ]);
      // Newest run_end stops at continuation_capped → standalone; the older
      // run_end still pairs with its own complete yield.
      expect(rows, hasLength(4));
      expect(rows[0].isCoalesced, isFalse); // run_end '5'
      expect(rows[1].primary.kind, 'continuation_capped');
      expect(rows[2].isCoalesced, isTrue); // run_end '3' + yield '2'
      expect(rows[2].yieldStatus, 'complete');
    });

    test('a dropped yield (no live actor) is never merged', () {
      final rows = coalesceRunEvents([
        makeEvent(
          '1',
          'run_yielded',
          actor: 'x',
          detail: 'dropped — no live actor',
        ),
      ]);
      expect(rows, hasLength(1));
      expect(rows.single.isCoalesced, isFalse);
    });

    test('skips past a dropped yield without consuming a real pair', () {
      final rows = coalesceRunEvents([
        makeEvent('3', 'run_end', actor: 'x'),
        makeEvent(
          '2',
          'run_yielded',
          actor: 'x',
          detail: 'dropped — no live actor',
        ),
        makeEvent('1', 'run_start', actor: 'x'),
      ]);
      // run_end finds no real yield before hitting run_start → standalone;
      // the dropped yield is its own row.
      expect(rows, hasLength(3));
      expect(rows.every((r) => !r.isCoalesced), isTrue);
    });

    test('root run_end (never yields) stays standalone', () {
      final rows = coalesceRunEvents([
        makeEvent('1', 'run_end', actor: 'root'),
      ]);
      expect(rows, hasLength(1));
      expect(rows.single.isCoalesced, isFalse);
    });

    test('preserves order and non-run events', () {
      final rows = coalesceRunEvents([
        makeEvent('4', 'actor_spawned', actor: 'x'),
        makeEvent('3', 'run_end', actor: 'x'),
        makeEvent('2', 'run_yielded', actor: 'x', detail: 'complete'),
        makeEvent('1', 'run_start', actor: 'x'),
      ]);
      expect(rows.map((r) => r.primary.id).toList(), ['4', '3', '1']);
      expect(rows[1].isCoalesced, isTrue);
    });
  });
}
