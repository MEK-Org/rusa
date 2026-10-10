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
}
