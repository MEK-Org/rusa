import 'package:flutter/material.dart';

import '../models.dart';
import '../theme.dart';

const _seriesColors = <Color>[
  MeshColors.accent,
  MeshColors.statusActive,
  MeshColors.statusIdle,
  Color(0xFFA855F7),
  Color(0xFFEC4899),
  Color(0xFF14B8A6),
  Color(0xFF818CF8),
  Color(0xFFF97316),
];

String _providerTitle(String provider) => switch (provider) {
  'claude' => 'Claude',
  'codex' => 'Codex',
  'agy' => 'Agy',
  'kimi' => 'Kimi',
  _ => provider,
};

/// Legend + time-series plots for durable quota history and pace-controller error.
class QuotaHistoryChart extends StatelessWidget {
  const QuotaHistoryChart({
    super.key,
    required this.snapshot,
    this.isStale = false,
  });

  final QuotaSnapshotDto snapshot;
  final bool isStale;

  @override
  Widget build(BuildContext context) {
    final end =
        DateTime.tryParse(snapshot.generatedAt)?.toUtc() ??
        DateTime.now().toUtc();
    final start =
        DateTime.tryParse(snapshot.historySince)?.toUtc() ??
        end.subtract(const Duration(days: 3));
    final visible = snapshot.history
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

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (isStale) ...[
          Text(
            'Cached snapshot as of ${snapshot.generatedAt}',
            style: kMonoStyle.copyWith(
              color: MeshColors.textMuted,
              fontSize: 11,
            ),
          ),
          const SizedBox(height: 8),
        ],
        Semantics(
          label:
              'Weekly quota remaining over the prior 3 days. '
              'Vertical scale zero to one hundred percent.'
              '${isStale ? ' Cached snapshot as of ${snapshot.generatedAt}.' : ''}',
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
                  key: const Key('quota-history-chart'),
                  painter: QuotaHistoryChartPainter(
                    series: visible,
                    start: start,
                    end: end,
                  ),
                  size: Size.infinite,
                ),
                Positioned(
                  right: 0,
                  bottom: 0,
                  child: Text(
                    isStale ? 'cached' : 'now',
                    key: const Key('quota-history-end-label'),
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
        const SizedBox(height: 16),
        const Text(
          'Pace-Controller Error — Delta from Target %',
          style: TextStyle(
            color: MeshColors.textPrimary,
            fontSize: 13,
            fontWeight: FontWeight.w600,
          ),
        ),
        const SizedBox(height: 2),
        Text(
          'delta = quotaRemaining% - timeRemaining% (positive = surplus quota, negative = underwater / burning fast)',
          style: kMonoStyle.copyWith(
            color: MeshColors.textMuted,
            fontSize: 11,
          ),
        ),
        const SizedBox(height: 8),
        Semantics(
          label:
              'Pace-controller error relative to target over the prior 3 days. '
              'Vertical scale minus fifty to plus fifty percent centered at zero.'
              '${isStale ? ' Cached snapshot as of ${snapshot.generatedAt}.' : ''}',
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
                  key: const Key('quota-pace-error-chart'),
                  painter: QuotaPaceErrorChartPainter(
                    series: visible,
                    start: start,
                    end: end,
                  ),
                  size: Size.infinite,
                ),
                Positioned(
                  right: 0,
                  bottom: 0,
                  child: Text(
                    isStale ? 'cached' : 'now',
                    key: const Key('quota-pace-error-end-label'),
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
        const SizedBox(height: 16),
        const Text(
          'Throttle Period — Seconds',
          style: TextStyle(
            color: MeshColors.textPrimary,
            fontSize: 13,
            fontWeight: FontWeight.w600,
          ),
        ),
        const SizedBox(height: 2),
        Text(
          'Computed interval between runs',
          style: kMonoStyle.copyWith(
            color: MeshColors.textMuted,
            fontSize: 11,
          ),
        ),
        const SizedBox(height: 8),
        Semantics(
          label:
              'Pace-controller throttle interval over the prior 3 days.'
              '${isStale ? ' Cached snapshot as of ${snapshot.generatedAt}.' : ''}',
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
                  key: const Key('quota-throttle-interval-chart'),
                  painter: QuotaThrottleIntervalChartPainter(
                    series: visible,
                    start: start,
                    end: end,
                  ),
                  size: Size.infinite,
                ),
                Positioned(
                  right: 0,
                  bottom: 0,
                  child: Text(
                    isStale ? 'cached' : 'now',
                    key: const Key('quota-throttle-interval-end-label'),
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
        const SizedBox(height: 12),
        Wrap(
          spacing: 18,
          runSpacing: 8,
          children: [
            for (var i = 0; i < visible.length; i++)
              _LegendItem(
                series: visible[i],
                color: _seriesColors[i % _seriesColors.length],
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

/// Paints quota remaining, so quota consumption moves a series downward.
class QuotaHistoryChartPainter extends CustomPainter {
  QuotaHistoryChartPainter({
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
    for (final percent in [0, 25, 50, 75, 100]) {
      final y = plot.bottom - (percent / 100) * plot.height;
      canvas.drawLine(Offset(plot.left, y), Offset(plot.right, y), gridPaint);
      _paintLabel(
        canvas,
        '$percent%',
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
      final points = series[i].points
          .map((point) {
            final observedAt = DateTime.tryParse(point.observedAt)?.toUtc();
            if (observedAt == null ||
                observedAt.isBefore(start) ||
                observedAt.isAfter(end)) {
              return null;
            }
            final x =
                plot.left +
                ((observedAt.millisecondsSinceEpoch -
                                start.millisecondsSinceEpoch) /
                            spanMs)
                        .clamp(0.0, 1.0) *
                    plot.width;
            final remaining = point.remainingPercent.clamp(0.0, 100.0);
            final y = plot.bottom - (remaining / 100) * plot.height;
            return Offset(x, y);
          })
          .whereType<Offset>()
          .toList();
      if (points.isEmpty) continue;

      final color = _seriesColors[i % _seriesColors.length];
      final linePaint = Paint()
        ..color = color
        ..strokeWidth = 2
        ..style = PaintingStyle.stroke
        ..strokeCap = StrokeCap.round
        ..strokeJoin = StrokeJoin.round;
      final path = Path()..moveTo(points.first.dx, points.first.dy);
      for (final point in points.skip(1)) {
        path.lineTo(point.dx, point.dy);
      }
      canvas.drawPath(path, linePaint);
      final dotPaint = Paint()
        ..color = color
        ..style = PaintingStyle.fill;
      for (final point in points) {
        canvas.drawCircle(point, 2.5, dotPaint);
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
  bool shouldRepaint(covariant QuotaHistoryChartPainter oldDelegate) =>
      oldDelegate.series != series ||
      oldDelegate.start != start ||
      oldDelegate.end != end;
}

/// Paints pace-controller error (percentLeft - timeRemainingPct).
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

      final color = _seriesColors[i % _seriesColors.length];
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
/// Paints throttle interval (seconds).
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

    double maxInterval = 60.0; // default minimum max scale
    for (final s in series) {
      for (final p in s.points) {
        if (p.intervalSeconds != null && p.intervalSeconds! > maxInterval) {
          maxInterval = p.intervalSeconds!;
        }
      }
    }
    
    // Add 10% headroom
    maxInterval = (maxInterval * 1.1).ceilToDouble();

    // Vertical scale: 0 to maxInterval
    for (var quarter = 0; quarter <= 4; quarter++) {
      final val = maxInterval * (quarter / 4);
      final y = plot.bottom - (quarter / 4) * plot.height;
      canvas.drawLine(Offset(plot.left, y), Offset(plot.right, y), gridPaint);
      _paintLabel(
        canvas,
        '${val.round()}s',
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
        if (point.intervalSeconds == null) {
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
        final clampedInterval = point.intervalSeconds!.clamp(0.0, maxInterval);
        final y = plot.bottom - (clampedInterval / maxInterval) * plot.height;
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

      final color = _seriesColors[i % _seriesColors.length];
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
