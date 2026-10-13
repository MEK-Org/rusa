import 'package:flutter_test/flutter_test.dart';
import 'package:rusa_dashboard/brief_diff.dart';

void main() {
  const same = BriefDiffOp.same;
  const removed = BriefDiffOp.removed;
  const added = BriefDiffOp.added;
  List<(BriefDiffOp, String)> ops(String before, String after) => [
    for (final line in diffBriefLines(before, after)) (line.op, line.text),
  ];

  test('a replaced line reads as its removal then its addition, in place', () {
    expect(ops('## WHAT\nA\nB\nC', '## WHAT\nA\nX\nC'), [
      (same, '## WHAT'),
      (same, 'A'),
      (removed, 'B'),
      (added, 'X'),
      (same, 'C'),
    ]);
  });

  test('additions and removals at the edges and trailing newlines', () {
    expect(ops('A\nB\n', 'B\nC\n\n'), [
      (removed, 'A'),
      (same, 'B'),
      (added, 'C'),
    ]);
    expect(ops('', 'A'), [(added, 'A')]);
    expect(ops('A', ''), [(removed, 'A')]);
    expect(ops('A\nB', 'A\nB\n'), [(same, 'A'), (same, 'B')]);
  });

  test('a moved line is one removal and one addition, the rest kept', () {
    expect(ops('A\nB\nC', 'B\nC\nA'), [
      (removed, 'A'),
      (same, 'B'),
      (same, 'C'),
      (added, 'A'),
    ]);
  });

  group('a brief of many short lines, within the 16 KiB cap', () {
    // ~15,000 blank lines fit in 16 KiB; a full table would be 225M cells.
    final blanks = List.filled(15000, '').join('\n');
    final before = '## WHAT\n$blanks\n## HOW\n\n## DOMAIN';

    test('one changed heading keeps every shared line and diffs only it', () {
      final diff = ops(before, before.replaceFirst('## HOW', '## How'));
      expect(diff.where((l) => l.$1 != same), [
        (removed, '## HOW'),
        (added, '## How'),
      ]);
      expect(diff.length, 15000 + 5);
    });

    test('edits at both ends past the table bound read as the whole middle '
        'removed then added', () {
      final after = '## what\n$blanks\n## HOW\n\n## DOMAIN\nNew. [x:y]';
      final diff = ops(before, after);
      final removedLines = diff.where((l) => l.$1 == removed).toList();
      final addedLines = diff.where((l) => l.$1 == added).toList();
      expect(diff.where((l) => l.$1 == same), isEmpty);
      expect(removedLines.length, 15000 + 4);
      expect(addedLines.length, 15000 + 5);
      expect(removedLines.first, (removed, '## WHAT'));
      expect(addedLines.last, (added, 'New. [x:y]'));
      expect(diff.indexOf(addedLines.first), removedLines.length);
    });
  });
}
