import 'package:intl/intl.dart';

final DateFormat _tsFormat = DateFormat('yyyy-MM-dd HH:mm:ss');

/// Format an ISO-8601 timestamp as `yyyy-MM-dd HH:mm:ss` in local time, matching
/// the mockup. Falls back to the raw string if it can't be parsed.
String formatTs(String iso) {
  final dt = DateTime.tryParse(iso);
  if (dt == null) return iso;
  return _tsFormat.format(dt.toLocal());
}

/// Render a scheduled obligation's `nextReadyAt` as "in 3h 12m" / "in 5d", or
/// "due" once the moment has passed — a scheduler callback that hasn't fired
/// yet, not a stale value, so this deliberately avoids implying failure.
String formatReturnsIn(String iso) {
  final dt = DateTime.tryParse(iso);
  if (dt == null) return iso;
  final diff = dt.difference(DateTime.now());
  if (diff.isNegative) return 'due';
  final days = diff.inDays;
  if (days > 0) return 'in ${days}d ${diff.inHours % 24}h';
  final hours = diff.inHours;
  if (hours > 0) return 'in ${hours}h ${diff.inMinutes % 60}m';
  final minutes = diff.inMinutes;
  if (minutes > 0) return 'in ${minutes}m';
  return 'in <1m';
}

/// Render a queued run's estimated start approximately — "in ~8 min",
/// "in ~2 h 5 min", "in ~3 d 4 h", or "in <1 min" — or null once the estimate
/// has passed, when the run is due rather than scheduled. The estimate shifts
/// with pacing, so it is rounded to the nearest minute and never quoted to the
/// second.
String? formatStartsIn(String iso, {DateTime? now}) {
  final dt = DateTime.tryParse(iso);
  if (dt == null) return null;
  final diff = dt.difference(now ?? DateTime.now());
  if (diff.isNegative) return null;
  if (diff < const Duration(minutes: 1)) return 'in <1 min';
  final minutes = (diff.inSeconds / 60).round();
  if (minutes < 60) return 'in ~$minutes min';
  final hours = minutes ~/ 60;
  if (hours < 24) {
    final rest = minutes % 60;
    return rest == 0 ? 'in ~$hours h' : 'in ~$hours h $rest min';
  }
  final days = hours ~/ 24;
  final restHours = hours % 24;
  return restHours == 0 ? 'in ~$days d' : 'in ~$days d $restHours h';
}
