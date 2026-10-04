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

/// Project an external reference or URL string out to a browsable web URL,
/// or null if the reference has no web representation.
///
/// Mirrored from the server-side reference projection:
/// - github:OWNER/REPO -> https://github.com/OWNER/REPO
/// - github:OWNER/REPO/issues/N -> https://github.com/OWNER/REPO/issues/N
/// - github:OWNER/REPO/pulls/N -> https://github.com/OWNER/REPO/pull/N
/// - github:OWNER/REPO/issues/N/comments/C -> https://github.com/OWNER/REPO/issues/N#issuecomment-C
/// - github:OWNER/REPO/pulls/N/comments/C -> https://github.com/OWNER/REPO/pull/N#discussion_rC
/// - github:OWNER/REPO/pulls/N/reviews/R -> https://github.com/OWNER/REPO/pull/N#pullrequestreview-R
/// - github:OWNER/REPO/branches/B -> https://github.com/OWNER/REPO/tree/B
/// - slack:channels/C -> https://app.slack.com/archives/C
/// - slack:channels/C/messages/T -> https://app.slack.com/archives/C/p{T without dot}
/// - Raw http:// or https:// URLs are returned verbatim.
String? referenceUrl(String? rawRef) {
  if (rawRef == null) return null;
  final trimmed = rawRef.trim();
  if (trimmed.isEmpty) return null;
  if (trimmed.startsWith('https://') || trimmed.startsWith('http://')) {
    return trimmed;
  }
  final separator = trimmed.indexOf(':');
  if (separator <= 0) return null;
  final scheme = trimmed.substring(0, separator).toLowerCase();
  final path = trimmed.substring(separator + 1).trim();
  if (path.isEmpty) return null;

  if (scheme == 'slack') {
    final segments = path.split('/').where((s) => s.isNotEmpty).toList();
    if (segments.isNotEmpty &&
        segments[0] == 'channels' &&
        segments.length >= 2) {
      final channel = segments[1];
      if (segments.length >= 4 && segments[2] == 'messages') {
        final ts = segments[3].replaceAll('.', '');
        return 'https://app.slack.com/archives/${Uri.encodeComponent(channel)}/p$ts';
      }
      return 'https://app.slack.com/archives/${Uri.encodeComponent(channel)}';
    }
    return null;
  }

  if (scheme == 'github') {
    if (path.contains('#')) {
      final hashIndex = path.indexOf('#');
      final repoPart = path.substring(0, hashIndex).trim();
      final numPart = path.substring(hashIndex + 1).trim();
      if (numPart.isNotEmpty && int.tryParse(numPart) != null) {
        return 'https://github.com/$repoPart/issues/$numPart';
      }
      return 'https://github.com/$repoPart#$numPart';
    }

    final segments = path.split('/').where((s) => s.isNotEmpty).toList();
    if (segments.isEmpty) return null;

    if (segments.length >= 4 && segments[2] == 'branches') {
      final owner = segments[0];
      final repo = segments[1];
      final branch = segments.sublist(3).join('/');
      return 'https://github.com/$owner/$repo/tree/${Uri.encodeComponent(branch)}';
    }

    final isPullRequest = segments.length > 2 && segments[2] == 'pulls';
    String anchor = '';
    final commentIndex = segments.indexOf('comments');
    final reviewIndex = segments.indexOf('reviews');

    if (commentIndex >= 0 && commentIndex == segments.length - 2) {
      anchor = isPullRequest
          ? '#discussion_r${segments[commentIndex + 1]}'
          : '#issuecomment-${segments[commentIndex + 1]}';
      segments.removeRange(commentIndex, segments.length);
    } else if (isPullRequest &&
        reviewIndex >= 0 &&
        reviewIndex == segments.length - 2) {
      anchor = '#pullrequestreview-${segments[reviewIndex + 1]}';
      segments.removeRange(reviewIndex, segments.length);
    }

    if (segments.length > 2 && segments[2] == 'pulls') {
      segments[2] = 'pull';
    }

    return 'https://github.com/${segments.join('/')}$anchor';
  }

  return null;
}
