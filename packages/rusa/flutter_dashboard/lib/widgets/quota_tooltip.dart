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

class _WindowRowData {
  const _WindowRowData({
    required this.window,
    required this.text,
    this.isEstimate = false,
  });

  final QuotaWindowDto window;
  final String text;
  final bool isEstimate;
}

/// A structured widget replacing the plain-text quota ring tooltip (#760).
///
/// Displays:
/// - Provider heading (e.g. "Claude")
/// - One row per quota window: `$label: $margin ($quotaRemaining% / $timeRemaining%) - Resets in $relativeReset`
/// - Pacing row: `Pacing: every $interval` (omitted when [showThrottle] is false)
/// - Last read row: `Last Read: $age`
class QuotaTooltip extends StatelessWidget {
  const QuotaTooltip({
    super.key,
    required this.providerName,
    required this.windows,
    this.throttle,
    this.scrapedAt,
    this.showThrottle = true,
    this.isEstimated,
    this.now,
  });

  final String providerName;
  final List<QuotaWindowDto> windows;
  final QuotaThrottleDto? throttle;
  final String? scrapedAt;
  final bool showThrottle;
  final bool Function(QuotaWindowDto)? isEstimated;
  final DateTime? now;

  List<_WindowRowData> _buildWindowRows(DateTime currentTime) {
    if (windows.isEmpty) {
      return const [
        _WindowRowData(
          window: QuotaWindowDto(
            id: 'weekly',
            label: 'Weekly',
            usedPercent: null,
            status: 'unknown',
            headline: false,
          ),
          text: 'Weekly: n/a',
        ),
      ];
    }

    final rows = <_WindowRowData>[];
    for (final window in windows) {
      final label = window.label.isNotEmpty
          ? window.label
          : (window.id == 'weekly'
              ? 'Weekly'
              : (window.id == 'session' || window.id == 'five_hour'
                  ? 'Session'
                  : window.id));

      final estimate = isEstimated != null && isEstimated!(window);

      if (!window.isKnown || window.usedPercent == null) {
        rows.add(_WindowRowData(
          window: window,
          text: '$label: n/a',
          isEstimate: estimate,
        ));
        continue;
      }

      if (window.isPastReset(currentTime)) {
        final resetText = window.resetAtIso;
        final reset = resetText != null ? DateTime.tryParse(resetText) : null;
        final resetStr = reset != null
            ? DateFormat('EEE h:mm a').format(reset.toLocal())
            : (resetText ?? '');
        rows.add(_WindowRowData(
          window: window,
          text: '$label: window reset at $resetStr; no fresh read since',
          isEstimate: estimate,
        ));
        continue;
      }

      final quotaRemaining = (100 - (window.usedPercent ?? 0)).clamp(0, 100).round();
      final resetText = window.resetAtIso;
      final reset = resetText != null ? DateTime.tryParse(resetText) : null;

      if (reset != null && window.windowMs > 0) {
        final remainingMs = reset.difference(currentTime).inMilliseconds;
        if (remainingMs > 0) {
          final timeRemaining =
              (remainingMs / window.windowMs * 100).clamp(0, 100).round();
          final margin = quotaRemaining - timeRemaining;
          final marginStr = margin >= 0 ? '+$margin' : '$margin';
          final resetDuration =
              formatRelativeResetDuration(Duration(milliseconds: remainingMs));
          rows.add(_WindowRowData(
            window: window,
            text:
                '$label: $marginStr ($quotaRemaining% / $timeRemaining%) - Resets in $resetDuration',
            isEstimate: estimate,
          ));
          continue;
        }
      }

      if (resetText != null) {
        rows.add(_WindowRowData(
          window: window,
          text: '$label: $quotaRemaining% remaining - Resets $resetText',
          isEstimate: estimate,
        ));
      } else {
        rows.add(_WindowRowData(
          window: window,
          text: '$label: $quotaRemaining% remaining',
          isEstimate: estimate,
        ));
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
    for (final r in rows) {
      lines.add(r.text);
    }
    final pacing = _buildPacingText();
    if (pacing != null) {
      lines.add(pacing);
    }
    lines.add(_buildLastReadText(currentTime));
    return lines.join('\n');
  }

  @override
  Widget build(BuildContext context) {
    final currentTime = now ?? DateTime.now();
    final windowRows = _buildWindowRows(currentTime);
    final pacingText = _buildPacingText();
    final lastReadText = _buildLastReadText(currentTime);

    return Container(
      constraints: const BoxConstraints(maxWidth: 360),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            providerName,
            style: const TextStyle(
              fontSize: 13,
              fontWeight: FontWeight.w700,
            ),
          ),
          const SizedBox(height: 6),
          for (final row in windowRows) ...[
            Text(
              row.text,
              style: const TextStyle(fontSize: 12),
            ),
            const SizedBox(height: 2),
          ],
          if (pacingText != null) ...[
            Text(
              pacingText,
              style: const TextStyle(fontSize: 12),
            ),
            const SizedBox(height: 2),
          ],
          Text(
            lastReadText,
            style: const TextStyle(fontSize: 12),
          ),
        ],
      ),
    );
  }
}
