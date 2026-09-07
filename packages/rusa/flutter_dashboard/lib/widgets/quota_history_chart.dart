import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../models.dart';
import '../theme.dart';

const _providerSeriesColors = <String, Color>{
  'claude': Color(0xFFC15F3C),
  'agy': Color(0xFF3B82F6),
  'codex': Color(0xFF10B981),
  'kimi': Color(0xFFA855F7),
};

const _fallbackSeriesColors = <Color>[
  MeshColors.accent,
  MeshColors.statusActive,
  MeshColors.statusIdle,
  Color(0xFFA855F7),
  Color(0xFFEC4899),
  Color(0xFF14B8A6),
  Color(0xFF818CF8),
  Color(0xFFF97316),
];

/// Keeps known provider colors stable when the API changes the series order.
Color _quotaChartColorForProvider(String provider, int fallbackIndex) =>
    _providerSeriesColors[provider] ??
    _fallbackSeriesColors[fallbackIndex % _fallbackSeriesColors.length];

String _providerTitle(String provider) => switch (provider) {
  'claude' => 'Claude',
  'codex' => 'Codex',
  'agy' => 'Agy',
  'kimi' => 'Kimi',
  _ => provider,
};

/// Time-series plots for quota headroom and throttle period, each carrying its
/// own color key directly beneath it.
class QuotaHistoryChart extends StatelessWidget {
  const QuotaHistoryChart({
    super.key,
    required this.history,
    this.isStale = false,
  });

  final QuotaHistoryDto history;
  final bool isStale;

  @override
  Widget build(BuildContext context) {
    final end =
        DateTime.tryParse(history.generatedAt)?.toUtc() ??
        DateTime.now().toUtc();
    final start =
        DateTime.tryParse(history.historySince)?.toUtc() ??
        end.subtract(const Duration(days: 3));
    final visible = history.history
        .where(
          (series) =>
              series.windowId == 'weekly' &&
              series.points.any((point) {
                final observedAt = DateTime.tryParse(point.observedAt)?.toUtc();
                return observedAt != null &&
                    !observedAt.isBefore(start) &&
                    !observedAt.isAfter(end);
              }),
        )
        .toList();

    if (visible.isEmpty) {
      return const Text(
        'No quota readings recorded in the prior 3 days.',
        style: TextStyle(color: MeshColors.textMuted, fontSize: 13),
      );
    }

    final cachedNote = isStale
        ? ' Cached snapshot as of ${history.generatedAt}.'
        : '';

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (isStale) ...[
          Text(
            'Cached snapshot as of ${history.generatedAt}',
            style: kMonoStyle.copyWith(
              color: MeshColors.textMuted,
              fontSize: 11,
            ),
          ),
          const SizedBox(height: 8),
        ],
        _ChartSection(
          title: 'Quota Headroom',
          subtitle:
              'The amount of quota remaining compared with the amount of time '
              'remaining. Positive values indicate excess quota, negative '
              'values indicate quota is being consumed ahead of schedule.',
          semanticsLabel:
              'Quota headroom over the prior 3 days. '
              'Vertical scale minus fifty to plus fifty percent centered at zero.'
              '$cachedNote',
          chartKey: const Key('quota-pace-error-chart'),
          endLabelKey: const Key('quota-pace-error-end-label'),
          painter: QuotaPaceErrorChartPainter(
            series: visible,
            start: start,
            end: end,
          ),
          series: visible,
          isStale: isStale,
        ),
        const SizedBox(height: 16),
        _ChartSection(
          title: 'Throttle Period',
          subtitle:
              'How long the mesh waits between runs. The scale is logarithmic, '
              'so each labelled gridline is ten times the one below it.',
          semanticsLabel:
              'Throttle period over the prior 3 days. '
              'Logarithmic vertical scale in seconds.'
              '$cachedNote',
          chartKey: const Key('quota-throttle-interval-chart'),
          endLabelKey: const Key('quota-throttle-interval-end-label'),
          painter: QuotaThrottleIntervalChartPainter(
            series: visible,
            start: start,
            end: end,
          ),
          series: visible,
          isStale: isStale,
        ),
      ],
    );
  }
}

/// One plot: heading, plain-English subtitle, the canvas itself, and the color
/// key for the providers drawn on it.
class _ChartSection extends StatelessWidget {
  const _ChartSection({
    required this.title,
    required this.subtitle,
    required this.semanticsLabel,
    required this.chartKey,
    required this.endLabelKey,
    required this.painter,
    required this.series,
    required this.isStale,
  });

  final String title;
  final String subtitle;
  final String semanticsLabel;
  final Key chartKey;
  final Key endLabelKey;
  final CustomPainter painter;
  final List<QuotaHistorySeriesDto> series;
  final bool isStale;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(
          title,
          style: const TextStyle(
            color: MeshColors.textPrimary,
            fontSize: 13,
            fontWeight: FontWeight.w600,
          ),
        ),
        const SizedBox(height: 2),
        Text(
          subtitle,
          style: const TextStyle(color: MeshColors.textMuted, fontSize: 11),
        ),
        const SizedBox(height: 8),
        Semantics(
          label: semanticsLabel,
          child: Container(
            height: 220,
            decoration: BoxDecoration(
              color: MeshColors.bgTertiary,
              borderRadius: BorderRadius.circular(6),
              border: Border.all(
                color: MeshColors.border.withValues(alpha: 0.5),
              ),
            ),
            padding: const EdgeInsets.fromLTRB(8, 8, 8, 2),
            child: Stack(
              children: [
                CustomPaint(
                  key: chartKey,
                  painter: painter,
                  size: Size.infinite,
                ),
                Positioned(
                  right: 0,
                  bottom: 0,
                  child: Text(
                    isStale ? 'cached' : 'now',
                    key: endLabelKey,
                    style: kMonoStyle.copyWith(
                      color: MeshColors.textMuted,
                      fontSize: 9,
                    ),
                  ),
                ),
              ],
            ),
          ),
        ),
        const SizedBox(height: 10),
        Wrap(
          spacing: 18,
          runSpacing: 8,
          children: [
            for (var i = 0; i < series.length; i++)
              _LegendItem(
                series: series[i],
                color: _quotaChartColorForProvider(series[i].provider, i),
              ),
          ],
        ),
      ],
    );
  }
}

class _LegendItem extends StatelessWidget {
  const _LegendItem({required this.series, required this.color});

  final QuotaHistorySeriesDto series;
  final Color color;

  @override
  Widget build(BuildContext context) {
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Container(
          width: 18,
          height: 3,
          decoration: BoxDecoration(
            color: color,
            borderRadius: BorderRadius.circular(2),
          ),
        ),
        const SizedBox(width: 6),
        Text(
          _providerTitle(series.provider),
          style: const TextStyle(color: MeshColors.textSecondary, fontSize: 12),
        ),
      ],
    );
  }
}

/// Paints quota headroom (percentLeft - timeRemainingPct).
/// Vertically centered at 0% (range -50% to +50%).
/// Positive = surplus quota / additional quota to burn (above 0), negative = underwater / burning fast (below 0).
/// Mind the window-reset line-break caveat: breaks the series into separate
/// segments at each window reset instead of drawing a cliff across windows.
class QuotaPaceErrorChartPainter extends CustomPainter {
  QuotaPaceErrorChartPainter({
    required this.series,
    required this.start,
    required this.end,
  });

  final List<QuotaHistorySeriesDto> series;
  final DateTime start;
  final DateTime end;

  static const _left = 42.0;
  static const _right = 10.0;
  static const _top = 10.0;
  static const _bottom = 27.0;

  @override
  void paint(Canvas canvas, Size size) {
    final plot = Rect.fromLTRB(
      _left,
      _top,
      size.width - _right,
      size.height - _bottom,
    );
    if (plot.width <= 0 || plot.height <= 0) return;

    final gridPaint = Paint()
      ..color = MeshColors.border.withValues(alpha: 0.7)
      ..strokeWidth = 1;
    final zeroPaint = Paint()
      ..color = MeshColors.textMuted.withValues(alpha: 0.6)
      ..strokeWidth = 1.2;

    // Vertical scale: -50% to +50% centered at 0%
    // Y-values: +50%, +25%, 0%, -25%, -50%
    for (final percent in [50, 25, 0, -25, -50]) {
      final y = plot.top + ((50 - percent) / 100) * plot.height;
      canvas.drawLine(
        Offset(plot.left, y),
        Offset(plot.right, y),
        percent == 0 ? zeroPaint : gridPaint,
      );
      final labelText = percent > 0
          ? '+$percent%'
          : '$percent%';
      _paintLabel(
        canvas,
        labelText,
        Offset(0, y - 7),
        width: _left - 6,
        align: TextAlign.right,
      );
    }

    for (var quarter = 0; quarter <= 4; quarter++) {
      final x = plot.left + (quarter / 4) * plot.width;
      canvas.drawLine(Offset(x, plot.top), Offset(x, plot.bottom), gridPaint);
    }

    final span = end.difference(start);
    _paintLabel(
      canvas,
      _agoLabel(span),
      Offset(plot.left, plot.bottom + 7),
    );
    _paintLabel(
      canvas,
      _agoLabel(Duration(milliseconds: span.inMilliseconds ~/ 2)),
      Offset(plot.center.dx - 28, plot.bottom + 7),
      width: 56,
      align: TextAlign.center,
    );

    final spanMs = end.millisecondsSinceEpoch - start.millisecondsSinceEpoch;
    if (spanMs <= 0) return;

    for (var i = 0; i < series.length; i++) {
      final segments = <List<Offset>>[];
      List<Offset>? currentSegment;
      DateTime? lastResetAt;
      DateTime? lastObservedAt;

      for (final point in series[i].points) {
        if (point.error == null) {
          if (currentSegment != null && currentSegment.isNotEmpty) {
            segments.add(currentSegment);
            currentSegment = null;
          }
          continue;
        }

        final observedAt = DateTime.tryParse(point.observedAt)?.toUtc();
        if (observedAt == null ||
            observedAt.isBefore(start) ||
            observedAt.isAfter(end)) {
          continue;
        }

        final resetAt = point.resetAtIso != null
            ? DateTime.tryParse(point.resetAtIso!)?.toUtc()
            : null;

        bool isReset = false;
        if (lastResetAt != null && resetAt != null) {
          final resetDiff = resetAt.difference(lastResetAt).abs();
          if (resetDiff > const Duration(hours: 1) ||
              (lastObservedAt != null && observedAt.isAfter(lastResetAt))) {
            isReset = true;
          }
        }

        final x = plot.left +
            ((observedAt.millisecondsSinceEpoch -
                            start.millisecondsSinceEpoch) /
                        spanMs)
                    .clamp(0.0, 1.0) *
                plot.width;
        final clampedError = point.error!.clamp(-50.0, 50.0);
        final y = plot.top + ((50.0 - clampedError) / 100.0) * plot.height;
        final offset = Offset(x, y);

        if (isReset || currentSegment == null) {
          if (currentSegment != null && currentSegment.isNotEmpty) {
            segments.add(currentSegment);
          }
          currentSegment = [offset];
        } else {
          currentSegment.add(offset);
        }

        lastResetAt = resetAt;
        lastObservedAt = observedAt;
      }

      if (currentSegment != null && currentSegment.isNotEmpty) {
        segments.add(currentSegment);
      }

      if (segments.isEmpty) continue;

      final color = _quotaChartColorForProvider(series[i].provider, i);
      final linePaint = Paint()
        ..color = color
        ..strokeWidth = 2
        ..style = PaintingStyle.stroke
        ..strokeCap = StrokeCap.round
        ..strokeJoin = StrokeJoin.round;

      for (final seg in segments) {
        if (seg.length > 1) {
          final path = Path()..moveTo(seg.first.dx, seg.first.dy);
          for (final point in seg.skip(1)) {
            path.lineTo(point.dx, point.dy);
          }
          canvas.drawPath(path, linePaint);
        }
      }

      final dotPaint = Paint()
        ..color = color
        ..style = PaintingStyle.fill;

      for (final seg in segments) {
        for (final point in seg) {
          canvas.drawCircle(point, 2.5, dotPaint);
        }
      }
    }
  }

  void _paintLabel(
    Canvas canvas,
    String text,
    Offset offset, {
    double width = 40,
    TextAlign align = TextAlign.left,
  }) {
    final painter = TextPainter(
      text: TextSpan(
        text: text,
        style: kMonoStyle.copyWith(color: MeshColors.textMuted, fontSize: 9),
      ),
      textDirection: TextDirection.ltr,
      textAlign: align,
    )..layout(maxWidth: width);
    painter.paint(canvas, offset);
  }

  @override
  bool shouldRepaint(covariant QuotaPaceErrorChartPainter oldDelegate) =>
      oldDelegate.series != series ||
      oldDelegate.start != start ||
      oldDelegate.end != end;
}

String _agoLabel(Duration duration) {
  final hours = duration.inHours;
  if (hours >= 24 && hours % 24 == 0) {
    return '${hours ~/ 24}d ago';
  }
  return '${hours}h ago';
}

/// The base-10 decade axis behind the throttle-period chart. The observed
/// range is rounded outward to whole decades so gridlines land on 1s / 10s /
/// 100s, and [fractionOf] maps a reading onto that axis.
@visibleForTesting
class ThrottleLogAxis {
  ThrottleLogAxis._(this.minExponent, this.maxExponent);

  /// Shortest period the axis can show; anything at or below it is pinned to
  /// the floor, since log(0) has nowhere to go.
  static const minSeconds = 1.0;

  factory ThrottleLogAxis.forSeries(List<QuotaHistorySeriesDto> series) {
    var lowest = double.infinity;
    var highest = minSeconds;
    for (final s in series) {
      for (final point in s.points) {
        final interval = point.intervalSeconds;
        if (interval == null || !interval.isFinite) continue;
        final floored = math.max(interval, minSeconds);
        lowest = math.min(lowest, floored);
        highest = math.max(highest, floored);
      }
    }
    if (!lowest.isFinite) lowest = minSeconds;

    final minExponent = (math.log(lowest) / math.ln10).floor();
    var maxExponent = (math.log(highest) / math.ln10).ceil();
    // Always span at least one whole decade, so a flat series still gets a
    // readable axis instead of a zero-height one.
    if (maxExponent <= minExponent) maxExponent = minExponent + 1;
    return ThrottleLogAxis._(minExponent, maxExponent);
  }

  final int minExponent;
  final int maxExponent;

  double get floorSeconds => math.pow(10, minExponent).toDouble();
  double get ceilSeconds => math.pow(10, maxExponent).toDouble();

  /// Height of [seconds] on the axis: 0 at the bottom, 1 at the top.
  double fractionOf(double seconds) {
    final clamped = seconds.clamp(floorSeconds, ceilSeconds);
    return (math.log(clamped) / math.ln10 - minExponent) /
        (maxExponent - minExponent);
  }
}

/// Paints the throttle period (seconds) on a base-10 logarithmic vertical
/// scale, so a few seconds of drift stays visible next to multi-minute backoff.
class QuotaThrottleIntervalChartPainter extends CustomPainter {
  QuotaThrottleIntervalChartPainter({
    required this.series,
    required this.start,
    required this.end,
  });

  final List<QuotaHistorySeriesDto> series;
  final DateTime start;
  final DateTime end;

  static const _left = 42.0;
  static const _right = 10.0;
  static const _top = 10.0;
  static const _bottom = 27.0;

  @override
  void paint(Canvas canvas, Size size) {
    final plot = Rect.fromLTRB(
      _left,
      _top,
      size.width - _right,
      size.height - _bottom,
    );
    if (plot.width <= 0 || plot.height <= 0) return;

    final gridPaint = Paint()
      ..color = MeshColors.border.withValues(alpha: 0.7)
      ..strokeWidth = 1;
    final minorGridPaint = Paint()
      ..color = MeshColors.border.withValues(alpha: 0.3)
      ..strokeWidth = 1;

    final axis = ThrottleLogAxis.forSeries(series);
    double yFor(double seconds) =>
        plot.bottom - axis.fractionOf(seconds) * plot.height;

    for (
      var exponent = axis.minExponent;
      exponent <= axis.maxExponent;
      exponent++
    ) {
      final decadeSeconds = math.pow(10, exponent).toDouble();
      final y = yFor(decadeSeconds);
      canvas.drawLine(Offset(plot.left, y), Offset(plot.right, y), gridPaint);
      _paintLabel(
        canvas,
        '${decadeSeconds.round()}s',
        Offset(0, y - 7),
        width: _left - 6,
        align: TextAlign.right,
      );
      // Unlabelled 2x-9x ticks inside each decade, so the compressed spacing
      // reads as logarithmic at a glance.
      if (exponent == axis.maxExponent) continue;
      for (var multiple = 2; multiple < 10; multiple++) {
        final minorY = yFor(decadeSeconds * multiple);
        canvas.drawLine(
          Offset(plot.left, minorY),
          Offset(plot.right, minorY),
          minorGridPaint,
        );
      }
    }

    for (var quarter = 0; quarter <= 4; quarter++) {
      final x = plot.left + (quarter / 4) * plot.width;
      canvas.drawLine(Offset(x, plot.top), Offset(x, plot.bottom), gridPaint);
    }

    final span = end.difference(start);
    _paintLabel(
      canvas,
      _agoLabel(span),
      Offset(plot.left, plot.bottom + 7),
    );
    _paintLabel(
      canvas,
      _agoLabel(Duration(milliseconds: span.inMilliseconds ~/ 2)),
      Offset(plot.center.dx - 28, plot.bottom + 7),
      width: 56,
      align: TextAlign.center,
    );

    final spanMs = end.millisecondsSinceEpoch - start.millisecondsSinceEpoch;
    if (spanMs <= 0) return;

    for (var i = 0; i < series.length; i++) {
      final segments = <List<Offset>>[];
      List<Offset>? currentSegment;
      DateTime? lastResetAt;
      DateTime? lastObservedAt;

      for (final point in series[i].points) {
        final interval = point.intervalSeconds;
        if (interval == null || !interval.isFinite) {
          if (currentSegment != null && currentSegment.isNotEmpty) {
            segments.add(currentSegment);
            currentSegment = null;
          }
          continue;
        }

        final observedAt = DateTime.tryParse(point.observedAt)?.toUtc();
        if (observedAt == null ||
            observedAt.isBefore(start) ||
            observedAt.isAfter(end)) {
          continue;
        }

        final resetAt = point.resetAtIso != null
            ? DateTime.tryParse(point.resetAtIso!)?.toUtc()
            : null;

        bool isReset = false;
        if (lastResetAt != null && resetAt != null) {
          final resetDiff = resetAt.difference(lastResetAt).abs();
          if (resetDiff > const Duration(hours: 1) ||
              (lastObservedAt != null && observedAt.isAfter(lastResetAt))) {
            isReset = true;
          }
        }

        final x = plot.left +
            ((observedAt.millisecondsSinceEpoch -
                            start.millisecondsSinceEpoch) /
                        spanMs)
                    .clamp(0.0, 1.0) *
                plot.width;
        final offset = Offset(x, yFor(interval));

        if (isReset || currentSegment == null) {
          if (currentSegment != null && currentSegment.isNotEmpty) {
            segments.add(currentSegment);
          }
          currentSegment = [offset];
        } else {
          currentSegment.add(offset);
        }

        lastResetAt = resetAt;
        lastObservedAt = observedAt;
      }

      if (currentSegment != null && currentSegment.isNotEmpty) {
        segments.add(currentSegment);
      }

      if (segments.isEmpty) continue;

      final color = _quotaChartColorForProvider(series[i].provider, i);
      final linePaint = Paint()
        ..color = color
        ..strokeWidth = 2
        ..style = PaintingStyle.stroke
        ..strokeCap = StrokeCap.round
        ..strokeJoin = StrokeJoin.round;

      for (final seg in segments) {
        if (seg.length > 1) {
          final path = Path()..moveTo(seg.first.dx, seg.first.dy);
          for (final point in seg.skip(1)) {
            path.lineTo(point.dx, point.dy);
          }
          canvas.drawPath(path, linePaint);
        }
      }

      final dotPaint = Paint()
        ..color = color
        ..style = PaintingStyle.fill;

      for (final seg in segments) {
        for (final point in seg) {
          canvas.drawCircle(point, 2.5, dotPaint);
        }
      }
    }
  }

  void _paintLabel(
    Canvas canvas,
    String text,
    Offset offset, {
    double width = 40,
    TextAlign align = TextAlign.left,
  }) {
    final painter = TextPainter(
      text: TextSpan(
        text: text,
        style: kMonoStyle.copyWith(color: MeshColors.textMuted, fontSize: 9),
      ),
      textDirection: TextDirection.ltr,
      textAlign: align,
    )..layout(maxWidth: width);
    painter.paint(canvas, offset);
  }

  @override
  bool shouldRepaint(covariant QuotaThrottleIntervalChartPainter oldDelegate) =>
      oldDelegate.series != series ||
      oldDelegate.start != start ||
      oldDelegate.end != end;
}
