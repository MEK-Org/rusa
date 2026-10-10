/// One line of a brief change: kept, removed from the old text, or added in
/// the new one.
enum BriefDiffOp { same, removed, added }

class BriefDiffLine {
  final BriefDiffOp op;
  final String text;

  const BriefDiffLine(this.op, this.text);

  @override
  bool operator ==(Object other) =>
      other is BriefDiffLine && other.op == op && other.text == text;

  @override
  int get hashCode => Object.hash(op, text);

  @override
  String toString() => '${op.name}: $text';
}

List<String> _lines(String text) {
  final trimmed = text.trimRight();
  return trimmed.isEmpty ? const [] : trimmed.split('\n');
}

/// The line-level change from [before] to [after], in reading order, with
/// removals listed before the additions that replace them.
///
/// A plain longest-common-subsequence diff: a brief is capped at 16 KiB, so
/// the quadratic table stays small, and an exact minimal diff reads better
/// than a heuristic one for text this short.
List<BriefDiffLine> diffBriefLines(String before, String after) {
  final a = _lines(before);
  final b = _lines(after);
  final lcs = List.generate(
    a.length + 1,
    (_) => List<int>.filled(b.length + 1, 0),
  );
  for (var i = a.length - 1; i >= 0; i--) {
    for (var j = b.length - 1; j >= 0; j--) {
      lcs[i][j] = a[i] == b[j]
          ? lcs[i + 1][j + 1] + 1
          : (lcs[i + 1][j] >= lcs[i][j + 1] ? lcs[i + 1][j] : lcs[i][j + 1]);
    }
  }
  final out = <BriefDiffLine>[];
  var i = 0;
  var j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] == b[j]) {
      out.add(BriefDiffLine(BriefDiffOp.same, a[i]));
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.add(BriefDiffLine(BriefDiffOp.removed, a[i]));
      i++;
    } else {
      out.add(BriefDiffLine(BriefDiffOp.added, b[j]));
      j++;
    }
  }
  for (; i < a.length; i++) {
    out.add(BriefDiffLine(BriefDiffOp.removed, a[i]));
  }
  for (; j < b.length; j++) {
    out.add(BriefDiffLine(BriefDiffOp.added, b[j]));
  }
  return out;
}
