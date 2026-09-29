import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import '../models.dart';

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

/// The control loop's own explanation of its pacing decision beyond the
/// interval: freshness mode and state, expired-window recovery, the hottest
/// bucket, and the configured-maximum cap. Carried over from the legacy text
/// tooltip so a slow provider stays distinguishable from a busy mesh.
List<String> quotaPacingDiagnostics(QuotaThrottleDto throttle) {
  final lines = <String>[];
  final f = throttle.freshness;
  if (f != null) {
    final modeLabel = f.mode == 'manual' ? 'manual' : 'scrape';
    const hardStale = 'overdue (hard-stale, fail-safe cap applied)';
    if (f.resetWaiting) {
      lines.add(
        'Freshness ($modeLabel): window reset; awaiting fresh reading (estimated)',
      );
      if (f.hardStale) lines.add('Freshness ($modeLabel): $hardStale');
    } else if (f.hardStale) {
      lines.add('Freshness ($modeLabel): $hardStale');
    } else if (f.stale) {
      lines.add('Freshness ($modeLabel): overdue (stale reading)');
    } else {
      lines.add('Freshness ($modeLabel): fresh');
    }
  }
  if (throttle.expired) {
    lines.add(
      'Previous quota window expired; returning to the configured interval',
    );
  } else if (throttle.buckets.isNotEmpty) {
    final hottest = throttle.buckets.reduce(
      (a, b) => a.error >= b.error ? a : b,
    );
    lines.add(
      'Hottest bucket ${hottest.key}: ${hottest.error.toStringAsFixed(1)} points over pace',
    );
  }
  if (throttle.capped) {
    lines.add('Limited to the configured maximum interval');
  }
  return lines;
}

/// A structured widget replacing the plain-text quota ring tooltip (#760).
///
/// Displays:
/// - Provider heading (e.g. "Claude")
/// - One row per quota window: `$label: $margin ($quotaRemaining% / $timeRemaining%) - Resets in $relativeReset`
/// - Pacing row: `Pacing: every $interval` (omitted when [showThrottle] is false)
/// - Last read row: `Last Read: $age`
/// - Secondary pacing diagnostics ([quotaPacingDiagnostics]), when pacing is shown
class QuotaTooltip extends StatelessWidget {
  const QuotaTooltip({
    super.key,
    required this.providerName,
    required this.windows,
    this.throttle,
    this.scrapedAt,
    this.showThrottle = true,
    this.now,
  });

  final String providerName;
  final List<QuotaWindowDto> windows;
  final QuotaThrottleDto? throttle;
  final String? scrapedAt;
  final bool showThrottle;
  final DateTime? now;

  List<String> _buildWindowRows(DateTime currentTime) {
    final rows = <String>[];
    for (final window in windows) {
      final label = window.label.isNotEmpty
          ? window.label
          : (window.id == 'weekly'
                ? 'Weekly'
                : (window.id == 'session' || window.id == 'five_hour'
                      ? 'Session'
                      : window.id));

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

      if (pos != null &&
          pos.timeRemainingPct != null &&
          pos.remainingMs != null) {
        final timeRemaining = pos.timeRemainingPct!.round();
        final margin = quotaRemaining - timeRemaining;
        final marginStr = margin >= 0 ? '+$margin' : '$margin';
        final resetDuration = formatRelativeResetDuration(
          Duration(milliseconds: pos.remainingMs!),
        );
        rows.add(
          '$label: $marginStr ($quotaRemaining% / $timeRemaining%) - Resets in $resetDuration',
        );
        continue;
      }

      if (reset != null) {
        if (reset.isAfter(currentTime)) {
          final resetDuration = formatRelativeResetDuration(
            reset.difference(currentTime),
          );
          rows.add(
            '$label: $quotaRemaining% remaining - Resets in $resetDuration',
          );
        } else {
          final resetStr = DateFormat('EEE h:mm a').format(reset.toLocal());
          rows.add('$label: $quotaRemaining% remaining - resets $resetStr');
        }
      } else if (resetText != null) {
        rows.add('$label: $quotaRemaining% remaining - resets $resetText');
      } else {
        rows.add('$label: $quotaRemaining% remaining');
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
    if (freshness != null) {
      if (freshness.hardStale) {
        return 'Last Read: $ageText [overdue: hard-stale]';
      }
      if (freshness.stale) {
        return 'Last Read: $ageText [overdue: stale]';
      }
    }
    return 'Last Read: $ageText';
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
            Text(text, style: const TextStyle(fontSize: 12)),
            const SizedBox(height: 2),
          ],
          if (pacingText != null) ...[
            Text(pacingText, style: const TextStyle(fontSize: 12)),
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
