import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import '../models.dart';
import '../theme.dart';

/// Formats a relative reset duration, e.g. "2 days", "25 minutes", "1 hour".
String formatRelativeResetDuration(Duration diff) {
  if (diff.inDays >= 1) {
    final days = diff.inDays;
    return '$days ${days == 1 ? 'day' : 'days'}';
  }
  if (diff.inHours >= 1) {
    final hours = diff.inHours;
    return '$hours ${hours == 1 ? 'hour' : 'hours'}';
  }
  if (diff.inMinutes >= 1) {
    final minutes = diff.inMinutes;
    return '$minutes ${minutes == 1 ? 'minute' : 'minutes'}';
  }
  return '< 1 minute';
}

/// Formats a pacing interval, e.g. "10 minutes", "1 minute", "45 seconds", "2 hours".
String formatPacingInterval(double seconds) {
  if (seconds < 60) {
    final s = seconds.round();
    return '$s ${s == 1 ? 'second' : 'seconds'}';
  }
  if (seconds < 3600) {
    final mins = seconds / 60;
    if (mins == mins.roundToDouble()) {
      final m = mins.round();
      return '$m ${m == 1 ? 'minute' : 'minutes'}';
    }
    return '${mins.toStringAsFixed(1)} minutes';
  }
  final hrs = seconds / 3600;
  if (hrs == hrs.roundToDouble()) {
    final h = hrs.round();
    return '$h ${h == 1 ? 'hour' : 'hours'}';
  }
  return '${hrs.toStringAsFixed(1)} hours';
}

/// Formats a relative age from scrape time, e.g. "30 minutes ago", "just now", "2 days ago".
String formatLastReadAge(Duration age) {
  if (age.isNegative || age.inSeconds < 60) {
    return 'just now';
  }
  if (age.inMinutes < 60) {
    final m = age.inMinutes;
    return '$m ${m == 1 ? 'minute' : 'minutes'} ago';
  }
  if (age.inHours < 24) {
    final h = age.inHours;
    return '$h ${h == 1 ? 'hour' : 'hours'} ago';
  }
  final d = age.inDays;
  return '$d ${d == 1 ? 'day' : 'days'} ago';
}

/// How long a lane may go without a real reading before its ring carries the
/// yellow warning triangle (#759). The server's rollover estimate uses the
/// same span.
const Duration kQuotaReadingStaleAfter = Duration(hours: 2);

/// How long ago [window]'s last real reading was taken, or null when it never
/// had one or the stamp can't be parsed.
Duration? readingAge(QuotaWindowDto? window, DateTime now) {
  final scrapedText = window?.scrapedAt;
  if (window == null || !window.isKnown || scrapedText == null) return null;
  final scraped = DateTime.tryParse(scrapedText);
  return scraped == null ? null : now.difference(scraped);
}

/// Whether the ring draws [window]'s value — possibly 0%, when a reading or
/// estimate says the window is exhausted — rather than empty for unknown.
bool ringShowsValue(QuotaWindowDto? window, DateTime? now) =>
    window != null &&
    window.usedPercent != null &&
    window.isKnown &&
    !(now != null && window.isPastReset(now));

/// The age of the oldest reading behind a ring still showing a value, when it
/// is more than [kQuotaReadingStaleAfter] old; null while every one is recent.
Duration? staleReadingAge(Iterable<QuotaWindowDto?> windows, DateTime now) {
  Duration? oldest;
  for (final window in windows) {
    if (!ringShowsValue(window, now)) continue;
    final age = readingAge(window, now);
    if (age == null || age <= kQuotaReadingStaleAfter) continue;
    if (oldest == null || age > oldest) oldest = age;
  }
  return oldest;
}

/// Formats a stale duration for warnings, e.g. "3h", "2d".
String formatStaleAge(Duration age) =>
    age.inHours >= 24 ? '${age.inDays}d' : '${age.inHours}h';

/// A window's burn-down position at [now]: quota remaining vs. time remaining
/// in its window, shared by the ring color and the tooltip text so they never
/// disagree. `timeRemainingPct`/`remainingMs`/`delta` are null when
/// `resetAt`/`windowMs` aren't enough to place `now` inside the window
/// (missing, unparseable, or a zero-length window).
class SchedulePosition {
  const SchedulePosition({
    required this.quotaRemainingPct,
    required this.timeRemainingPct,
    required this.remainingMs,
  });

  final double quotaRemainingPct;
  final double? timeRemainingPct;

  /// Raw (unclamped) milliseconds until `resetAt`.
  final int? remainingMs;

  double? get delta =>
      timeRemainingPct == null ? null : quotaRemainingPct - timeRemainingPct!;
}

/// Slices a window into quota remaining and time remaining at [now].
SchedulePosition? schedulePosition(QuotaWindowDto? window, DateTime now) {
  final used = window?.usedPercent;
  if (window == null || used == null || !window.isKnown) return null;
  if (window.isPastReset(now)) return null;
  final remaining = remainingMs(window, now);
  if (remaining != null && remaining <= 0) return null;
  return SchedulePosition(
    quotaRemainingPct: (100 - used).clamp(0, 100).toDouble(),
    timeRemainingPct: remaining == null
        ? null
        : (remaining / window.windowMs * 100).clamp(0, 100).toDouble(),
    remainingMs: remaining,
  );
}

/// Milliseconds until `resetAtIso`, or null when `windowMs`/the
/// reset text aren't enough to place `now` inside the window (missing,
/// unparseable, or a zero-length window).
int? remainingMs(QuotaWindowDto window, DateTime now) {
  if (window.windowMs <= 0) return null;
  final resetText = window.resetAtIso;
  if (resetText == null) return null;
  final reset = DateTime.tryParse(resetText);
  if (reset == null) return null;
  return reset.difference(now).inMilliseconds;
}

/// The control loop's own explanation of its pacing decision that no other
/// row carries: expired-window recovery and the configured-maximum cap.
/// Carried over from the legacy text tooltip so a slow provider stays
/// distinguishable from a busy mesh. The legacy freshness and hottest-bucket
/// lines are not repeated (#764 review): Last Read carries the reading's age,
/// staleness and mode, a window row carries a reset still awaiting its read,
/// and a bucket's error is its window row's headroom negated.
List<String> quotaPacingDiagnostics(QuotaThrottleDto throttle) => [
  if (throttle.expired)
    'Previous quota window expired; returning to the configured interval',
  if (throttle.capped) 'Limited to the configured maximum interval',
];

/// A structured widget replacing the plain-text quota ring tooltip (#760).
///
/// Displays:
/// - Provider heading (e.g. "Claude")
/// - One row per quota window, named for its kind (`Weekly`, `Session`) since
///   the heading already names the provider or model:
///   `$label: $margin ($quotaRemaining% / $timeRemaining%) - Resets in $relativeReset`
///   Marked with an estimate note when dead-reckoned (#759).
/// - Pacing row: `Pacing: every $interval` (omitted when [showThrottle] is false)
/// - Warning row: `Warning: no new reading for ...` when the reading behind
///   the ring, estimated or served as-is, is older than 2h (#759)
/// - Last read row: `Last Read: $age`, marked when stale or manually entered
/// - Secondary pacing diagnostics ([quotaPacingDiagnostics]), when pacing is shown
class QuotaTooltip extends StatelessWidget {
  const QuotaTooltip({
    super.key,
    required this.providerName,
    required this.windows,
    this.throttle,
    this.scrapedAt,
    this.showThrottle = true,
    this.staleFor,
    this.now,
  });

  final String providerName;
  final List<QuotaWindowDto> windows;
  final QuotaThrottleDto? throttle;
  final String? scrapedAt;
  final bool showThrottle;
  final Duration? staleFor;
  final DateTime? now;

  List<String> _buildWindowRows(DateTime currentTime) {
    final rows = <String>[];
    for (final window in windows) {
      final label = switch (window.id) {
        'weekly' => 'Weekly',
        'session' => 'Session',
        _ when window.label.isNotEmpty => window.label,
        'five_hour' => 'Session',
        _ => window.id,
      };

      if (!window.isKnown || window.usedPercent == null) {
        rows.add('$label: n/a');
        continue;
      }

      if (window.isPastReset(currentTime)) {
        final resetText = window.resetAtIso;
        final reset = resetText != null ? DateTime.tryParse(resetText) : null;
        final resetStr = reset != null
            ? DateFormat('EEE h:mm a').format(reset.toLocal())
            : (resetText ?? '');
        rows.add(
          '$label: window reset at $resetStr; no fresh read since (awaiting fresh read, estimated ~100% remaining)',
        );
        continue;
      }

      final pos = schedulePosition(window, currentTime);
      final quotaRemaining = (100 - (window.usedPercent ?? 0))
          .clamp(0, 100)
          .round();
      final resetText = window.resetAtIso;
      final reset = resetText != null ? DateTime.tryParse(resetText) : null;

      String row;
      if (pos != null &&
          pos.timeRemainingPct != null &&
          pos.remainingMs != null) {
        final timeRemaining = pos.timeRemainingPct!.round();
        final margin = quotaRemaining - timeRemaining;
        final marginStr = margin >= 0 ? '+$margin' : '$margin';
        final resetDuration = formatRelativeResetDuration(
          Duration(milliseconds: pos.remainingMs!),
        );
        row =
            '$label: $marginStr ($quotaRemaining% / $timeRemaining%) - Resets in $resetDuration';
      } else if (reset != null) {
        if (reset.isAfter(currentTime)) {
          final resetDuration = formatRelativeResetDuration(
            reset.difference(currentTime),
          );
          row = '$label: $quotaRemaining% remaining - Resets in $resetDuration';
        } else {
          final resetStr = DateFormat('EEE h:mm a').format(reset.toLocal());
          row = '$label: $quotaRemaining% remaining - resets $resetStr';
        }
      } else if (resetText != null) {
        row = '$label: $quotaRemaining% remaining - resets $resetText';
      } else {
        row = '$label: $quotaRemaining% remaining';
      }

      rows.add(row);
      if (window.estimated) {
        final scraped = DateTime.tryParse(window.scrapedAt ?? '');
        final at = scraped == null
            ? ''
            : ' at ${DateFormat('HH:mm').format(scraped.toLocal())}';
        rows.add('estimate: extended from the last real reading$at');
      }
    }
    return rows;
  }

  String? _buildPacingText() {
    if (!showThrottle) return null;
    if (throttle != null) {
      return 'Pacing: every ${formatPacingInterval(throttle!.intervalSeconds)}';
    }
    return 'Pacing: n/a';
  }

  Duration? _staleAge(DateTime currentTime) {
    if (staleFor != null) return staleFor;
    return staleReadingAge(windows, currentTime);
  }

  String? _buildWarningText(DateTime currentTime) {
    final age = _staleAge(currentTime);
    if (age == null) return null;
    return 'Warning: no new reading for ${formatStaleAge(age)}';
  }

  List<String> _buildDiagnostics() {
    if (!showThrottle || throttle == null) return const [];
    return quotaPacingDiagnostics(throttle!);
  }

  String _buildLastReadText(DateTime currentTime) {
    if (scrapedAt == null) return 'Last Read: n/a';
    final scraped = DateTime.tryParse(scrapedAt!);
    if (scraped == null) return 'Last Read: n/a';
    final age = currentTime.difference(scraped);
    final ageText = formatLastReadAge(age);
    final freshness = throttle?.freshness;
    final row = freshness?.mode == 'manual'
        ? 'Last Read (manual): $ageText'
        : 'Last Read: $ageText';
    if (freshness != null) {
      if (freshness.hardStale) {
        return '$row [overdue: hard-stale, fail-safe cap applied]';
      }
      if (freshness.stale) return '$row [overdue: stale]';
    }
    return row;
  }

  /// Plain-text representation of this tooltip for screen readers and tests.
  String toPlainText([DateTime? at]) {
    final currentTime = at ?? now ?? DateTime.now();
    final lines = <String>[providerName, ''];
    final rows = _buildWindowRows(currentTime);
    for (final text in rows) {
      lines.add(text);
    }
    final pacing = _buildPacingText();
    if (pacing != null) {
      lines.add(pacing);
    }
    final warning = _buildWarningText(currentTime);
    if (warning != null) {
      lines.add(warning);
    }
    lines.add(_buildLastReadText(currentTime));
    final diagnostics = _buildDiagnostics();
    if (diagnostics.isNotEmpty) {
      lines
        ..add('')
        ..addAll(diagnostics);
    }
    return lines.join('\n');
  }

  @override
  Widget build(BuildContext context) {
    final currentTime = now ?? DateTime.now();
    final windowRows = _buildWindowRows(currentTime);
    final pacingText = _buildPacingText();
    final warningText = _buildWarningText(currentTime);
    final lastReadText = _buildLastReadText(currentTime);
    final diagnostics = _buildDiagnostics();
    final diagnosticStyle = TextStyle(
      fontSize: 11,
      color: DefaultTextStyle.of(context).style.color?.withValues(alpha: 0.75),
    );

    return Container(
      constraints: const BoxConstraints(maxWidth: 360),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            providerName,
            style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w700),
          ),
          const SizedBox(height: 6),
          for (final text in windowRows) ...[
            Text(
              text,
              style: text.startsWith('estimate:')
                  ? diagnosticStyle
                  : const TextStyle(fontSize: 12),
            ),
            const SizedBox(height: 2),
          ],
          if (pacingText != null) ...[
            Text(pacingText, style: const TextStyle(fontSize: 12)),
            const SizedBox(height: 2),
          ],
          if (warningText != null) ...[
            Text(
              warningText,
              style: const TextStyle(
                fontSize: 12,
                color: MeshColors.quotaStaleWarning,
              ),
            ),
            const SizedBox(height: 2),
          ],
          Text(lastReadText, style: const TextStyle(fontSize: 12)),
          if (diagnostics.isNotEmpty) ...[
            const SizedBox(height: 6),
            for (final text in diagnostics) Text(text, style: diagnosticStyle),
          ],
        ],
      ),
    );
  }
}
