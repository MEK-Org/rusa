import 'package:intl/intl.dart';

final DateFormat _tsFormat = DateFormat('yyyy-MM-dd HH:mm:ss');

/// Format an ISO-8601 timestamp as `yyyy-MM-dd HH:mm:ss` in local time, matching
/// the mockup. Falls back to the raw string if it can't be parsed.
String formatTs(String iso) {
  final dt = DateTime.tryParse(iso);
  if (dt == null) return iso;
  return _tsFormat.format(dt.toLocal());
}
