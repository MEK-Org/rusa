// Headless glass_goals-parser check over IU calibration ops. Feed it the JSON the
// op-getter serves (either `{"ops":[...]}` or a bare `[...]`); it runs the real GG
// `Op.fromJsonMap` over every op and reports parse failures + exits non-zero on any.
//
// The cheap calibration-validation primitive: curl-the-store != render-through-the-parser.
// Run this over `/api/understanding/ops` output before a human opens the view so a
// parse-breaking op is caught first.
import 'dart:convert';
import 'dart:io';

import 'package:goals_core/sync.dart' show Op;

void main(List<String> args) {
  if (args.isEmpty) {
    stderr.writeln('usage: dart run tool/iu_parse_check.dart <ops.json>');
    exit(2);
  }
  final decoded = jsonDecode(File(args[0]).readAsStringSync());
  final list = (decoded is Map && decoded['ops'] != null)
      ? decoded['ops'] as List
      : decoded as List;
  var ok = 0, fail = 0;
  final errs = <String>[];
  for (final m in list) {
    try {
      Op.fromJsonMap(m as Map<String, dynamic>);
      ok++;
    } catch (e) {
      fail++;
      if (errs.length < 5) {
        final mm = m as Map;
        errs.add('${mm['i'] ?? mm['id'] ?? '?'}: $e');
      }
    }
  }
  stdout.writeln('IU parse-check: ok=$ok fail=$fail of ${list.length}');
  for (final e in errs) {
    stdout.writeln('  FAIL $e');
  }
  exit(fail == 0 ? 0 : 1);
}
