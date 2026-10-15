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

/// The most table cells [diffBriefLines] will allocate for the lines
/// between the shared prefix and suffix. The 16 KiB cap bounds bytes, not
/// lines: a brief of mostly blank lines can still run to thousands of them.
const briefDiffMaxCells = 1 << 20;

/// The line-level change from [before] to [after], in reading order, with
/// removals listed before the additions that replace them.
///
/// The shared leading and trailing lines are kept as they are, and a
/// longest-common-subsequence diff runs on what lies between. When that middle
/// is too large for the table ([briefDiffMaxCells]), it reads as all of its old
/// lines removed and all of its new lines added: still the full before and
/// after text, without the quadratic work.
List<BriefDiffLine> diffBriefLines(String before, String after) {
  final a = _lines(before);
  final b = _lines(after);
  var start = 0;
  while (start < a.length && start < b.length && a[start] == b[start]) {
    start++;
  }
  var endA = a.length;
  var endB = b.length;
  while (endA > start && endB > start && a[endA - 1] == b[endB - 1]) {
    endA--;
    endB--;
  }
  final out = [
    for (var k = 0; k < start; k++) BriefDiffLine(BriefDiffOp.same, a[k]),
  ];
  final n = endA - start;
  final m = endB - start;
  if ((n + 1) * (m + 1) > briefDiffMaxCells) {
    for (var i = start; i < endA; i++) {
      out.add(BriefDiffLine(BriefDiffOp.removed, a[i]));
    }
    for (var j = start; j < endB; j++) {
      out.add(BriefDiffLine(BriefDiffOp.added, b[j]));
    }
  } else {
    final lcs = List.generate(n + 1, (_) => List<int>.filled(m + 1, 0));
    for (var i = n - 1; i >= 0; i--) {
      for (var j = m - 1; j >= 0; j--) {
        lcs[i][j] = a[start + i] == b[start + j]
            ? lcs[i + 1][j + 1] + 1
            : (lcs[i + 1][j] >= lcs[i][j + 1] ? lcs[i + 1][j] : lcs[i][j + 1]);
      }
    }
    var i = 0;
    var j = 0;
    while (i < n && j < m) {
      if (a[start + i] == b[start + j]) {
        out.add(BriefDiffLine(BriefDiffOp.same, a[start + i]));
        i++;
        j++;
      } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
        out.add(BriefDiffLine(BriefDiffOp.removed, a[start + i]));
        i++;
      } else {
        out.add(BriefDiffLine(BriefDiffOp.added, b[start + j]));
        j++;
      }
    }
    for (; i < n; i++) {
      out.add(BriefDiffLine(BriefDiffOp.removed, a[start + i]));
    }
    for (; j < m; j++) {
      out.add(BriefDiffLine(BriefDiffOp.added, b[start + j]));
    }
  }
  for (var k = endA; k < a.length; k++) {
    out.add(BriefDiffLine(BriefDiffOp.same, a[k]));
  }
  return out;
}
