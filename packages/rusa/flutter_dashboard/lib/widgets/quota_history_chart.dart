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

Color _quotaChartColorForSeries(
  QuotaHistorySeriesDto series,
  int fallbackIndex, {
  Set<Color> taken = const {},
}) {
  if (series.scope != 'model') {
    return _quotaChartColorForProvider(series.provider, fallbackIndex);
  }
  // Model history must be visually distinct from its provider-wide series.
  // Hash canonical IDs rather than the display label, which is presentation.
  final identity = series.modelIds.join('\u0000');
  final hash = identity.codeUnits.fold<int>(
    0,
    (value, codeUnit) => value * 31 + codeUnit,
  );
  // Step past colors already on the chart, so a model never shares a color
  // with another visible series while the palette has room (#706).
  for (var step = 0; step < _fallbackSeriesColors.length; step++) {
    final color =
        _fallbackSeriesColors[(hash.abs() + step) %
            _fallbackSeriesColors.length];
    if (!taken.contains(color)) return color;
  }
  return _fallbackSeriesColors[hash.abs() % _fallbackSeriesColors.length];
}

/// Reported reset instants that move by more than this belong to a new quota
/// window rather than parse jitter. Every plot here breaks on this one rule.
const _windowResetShift = Duration(hours: 1);

/// The range a history snapshot covers, from the API's own bounds, so every
/// label names the range that was actually returned. The API's range is a
/// whole number of days (`HISTORY_WINDOW_MS`); [phrase] reads "prior 14 days"
/// and [title] is its heading form.
({DateTime start, DateTime end, String phrase, String title})
quotaHistoryRangeOf(QuotaHistoryDto history) {
  final end =
      DateTime.tryParse(history.generatedAt)?.toUtc() ??
      DateTime.now().toUtc();
  // An unreadable bound draws an empty range rather than a guessed one.
  final start = DateTime.tryParse(history.historySince)?.toUtc() ?? end;
  final days = (end.difference(start).inMinutes / (24 * 60)).round();
  return (
    start: start,
    end: end,
    phrase: 'prior $days days',
    title: 'Prior $days Days',
  );
}

String _providerTitle(String provider) => switch (provider) {
  'claude' => 'Claude',
  'codex' => 'Codex',
  'agy' => 'Agy',
  'kimi' => 'Kimi',
  _ => provider,
};

/// Time-series plots for quota headroom, throttle period and quota remaining,
/// each carrying its own color key directly beneath it.
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
    final (:start, :end, phrase: range, title: _) = quotaHistoryRangeOf(
      history,
    );
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
      return Text(
        'No quota readings recorded in the $range.',
        style: const TextStyle(color: MeshColors.textMuted, fontSize: 13),
      );
    }

    // Colors come from the full series order, so a series keeps its color on
    // every plot even when another plot omits series it cannot draw.
    // Provider colors are fixed, so they are assigned before model colors.
    final colors = Map<QuotaHistorySeriesDto, Color>.identity();
    for (final model in [false, true]) {
      for (var i = 0; i < visible.length; i++) {
        if ((visible[i].scope == 'model') != model) continue;
        colors[visible[i]] = _quotaChartColorForSeries(
          visible[i],
          i,
          taken: colors.values.toSet(),
        );
      }
    }
    // Headroom and throttle are controller decisions. A reading recorded
    // without one (model history before its lane had a controller) has nothing
    // to draw there, so those plots neither draw nor name it (#706).
    final headroomSeries = visible
        .where((series) => series.points.any((point) => point.error != null))
        .toList();
    final throttleSeries = visible
        .where(
          (series) => series.points.any(
            (point) => point.intervalSeconds?.isFinite ?? false,
          ),
        )
        .toList();
    final remainingSeries = visible
        .where(
          (series) => series.points.any(
            (point) => point.remainingPercent?.isFinite ?? false,
          ),
        )
        .toList();

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
              'Quota headroom over the $range. '
              'Vertical scale minus fifty to plus fifty percent centered at zero.'
              '$cachedNote',
          chartKey: const Key('quota-pace-error-chart'),
          endLabelKey: const Key('quota-pace-error-end-label'),
          painter: QuotaPaceErrorChartPainter(
            series: headroomSeries,
            colors: [for (final s in headroomSeries) colors[s]!],
            start: start,
            end: end,
          ),
          series: headroomSeries,
          colors: colors,
          emptyLegend: 'No controller decisions recorded in the $range.',
          isStale: isStale,
        ),
        const SizedBox(height: 16),
        _ChartSection(
          title: 'Throttle Period',
          subtitle:
              'How long the mesh waits between runs. The scale is logarithmic.',
          semanticsLabel:
              'Throttle period over the $range. '
              'Logarithmic vertical scale in seconds.'
              '$cachedNote',
          chartKey: const Key('quota-throttle-interval-chart'),
          endLabelKey: const Key('quota-throttle-interval-end-label'),
          painter: QuotaThrottleIntervalChartPainter(
            series: throttleSeries,
            colors: [for (final s in throttleSeries) colors[s]!],
            start: start,
            end: end,
          ),
          series: throttleSeries,
          colors: colors,
          emptyLegend: 'No throttle decisions recorded in the $range.',
          isStale: isStale,
        ),
        const SizedBox(height: 16),
        _ChartSection(
          title: 'Quota Remaining',
          subtitle:
              'The share of each weekly quota still unused, as recorded. '
              'Dashed lines mark quota resets; breaks mark missing readings.',
          semanticsLabel:
              'Quota remaining over the $range. '
              'Vertical scale zero to one hundred percent remaining.'
              '$cachedNote',
          chartKey: const Key('quota-remaining-chart'),
          endLabelKey: const Key('quota-remaining-end-label'),
          painter: QuotaRemainingChartPainter(
            series: remainingSeries,
            colors: [for (final s in remainingSeries) colors[s]!],
            start: start,
            end: end,
          ),
          series: remainingSeries,
          colors: colors,
          emptyLegend: 'No quota readings recorded in the $range.',
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
    required this.colors,
    required this.emptyLegend,
    required this.isStale,
  });

  final String title;
  final String subtitle;
  final String semanticsLabel;
  final Key chartKey;
  final Key endLabelKey;
  final CustomPainter painter;
  final List<QuotaHistorySeriesDto> series;
  final Map<QuotaHistorySeriesDto, Color> colors;
  final String emptyLegend;
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
        if (series.isEmpty)
          Text(
            emptyLegend,
            style: const TextStyle(color: MeshColors.textMuted, fontSize: 12),
          )
        else
          Wrap(
            spacing: 18,
            runSpacing: 8,
            children: [
              for (final s in series) _LegendItem(series: s, color: colors[s]!),
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
          series.scope == 'model'
              ? '${_providerTitle(series.provider)} · ${series.label}'
              : _providerTitle(series.provider),
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
    required this.colors,
    required this.start,
    required this.end,
  });

  final List<QuotaHistorySeriesDto> series;

  /// One color per [series] entry, matching the legend.
  final List<Color> colors;
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
          if (resetDiff > _windowResetShift ||
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

      final color = colors[i];
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
      oldDelegate.colors != colors ||
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
    required this.colors,
    required this.start,
    required this.end,
  });

  final List<QuotaHistorySeriesDto> series;

  /// One color per [series] entry, matching the legend.
  final List<Color> colors;
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
          if (resetDiff > _windowResetShift ||
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

      final color = colors[i];
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
      oldDelegate.colors != colors ||
      oldDelegate.start != start ||
      oldDelegate.end != end;
}

/// Where one series lands on the quota-remaining plot: the connected runs of
/// readings, and the x position of each quota reset between them.
@visibleForTesting
class QuotaRemainingTrace {
  const QuotaRemainingTrace({required this.segments, required this.resetXs});

  final List<List<Offset>> segments;
  final List<double> resetXs;
}

/// Paints the recorded quota remaining, 0% to 100%, for every series with a
/// reading. Unlike headroom and throttle it needs no controller decision, so
/// model history recorded before its lane had a controller still draws (#706).
///
/// Only recorded readings are drawn. The line breaks at a quota reset (marked
/// by a dashed vertical line) and across any stretch longer than [maxJoinGap]
/// without a reading, so a gap never reads as a flat or zero value.
class QuotaRemainingChartPainter extends CustomPainter {
  QuotaRemainingChartPainter({
    required this.series,
    required this.colors,
    required this.start,
    required this.end,
  });

  final List<QuotaHistorySeriesDto> series;

  /// One color per [series] entry, matching the legend.
  final List<Color> colors;
  final DateTime start;
  final DateTime end;

  /// The longest silence still drawn as one line. The API keeps the newest
  /// reading in each 30-minute bucket of the 14-day range, so readings kept
  /// from adjacent buckets can sit almost 60 minutes apart with nothing
  /// missing; this must stay comfortably above 60 minutes. Two hours breaks
  /// the line only after at least three empty buckets in a row. It is a
  /// judgment call, not fitted to the recording cadence, which is minutes.
  static const maxJoinGap = Duration(hours: 2);

  static const _left = 42.0;
  static const _right = 10.0;
  static const _top = 10.0;
  static const _bottom = 27.0;

  /// Map one series onto [plot], breaking at resets and gaps.
  @visibleForTesting
  static QuotaRemainingTrace traceFor(
    QuotaHistorySeriesDto series,
    DateTime start,
    DateTime end,
    Rect plot,
  ) {
    final spanMs = end.millisecondsSinceEpoch - start.millisecondsSinceEpoch;
    final segments = <List<Offset>>[];
    final resetXs = <double>[];
    if (spanMs <= 0) {
      return QuotaRemainingTrace(segments: segments, resetXs: resetXs);
    }
    double xFor(DateTime at) =>
        plot.left +
        ((at.millisecondsSinceEpoch - start.millisecondsSinceEpoch) / spanMs)
                .clamp(0.0, 1.0) *
            plot.width;

    List<Offset>? current;
    DateTime? lastResetAt;
    DateTime? lastObservedAt;
    for (final point in series.points) {
      final remaining = point.remainingPercent;
      final observedAt = DateTime.tryParse(point.observedAt)?.toUtc();
      if (remaining == null ||
          !remaining.isFinite ||
          observedAt == null ||
          observedAt.isBefore(start) ||
          observedAt.isAfter(end)) {
        continue;
      }
      final resetAt = point.resetAtIso != null
          ? DateTime.tryParse(point.resetAtIso!)?.toUtc()
          : null;

      // Same window-reset rule as the headroom and throttle plots.
      var isReset = false;
      if (lastResetAt != null && resetAt != null) {
        isReset =
            resetAt.difference(lastResetAt).abs() > _windowResetShift ||
            observedAt.isAfter(lastResetAt);
      }
      if (isReset) {
        // Mark the reported reset instant, kept between the two readings it
        // separates.
        var marker = lastResetAt!;
        if (marker.isBefore(lastObservedAt!)) marker = lastObservedAt;
        if (marker.isAfter(observedAt)) marker = observedAt;
        resetXs.add(xFor(marker));
      }
      final isGap =
          lastObservedAt != null &&
          observedAt.difference(lastObservedAt) > maxJoinGap;

      final offset = Offset(
        xFor(observedAt),
        plot.top + (1 - remaining.clamp(0.0, 100.0) / 100) * plot.height,
      );
      if (current == null || isReset || isGap) {
        if (current != null) segments.add(current);
        current = [offset];
      } else {
        current.add(offset);
      }
      lastResetAt = resetAt;
      lastObservedAt = observedAt;
    }
    if (current != null) segments.add(current);
    return QuotaRemainingTrace(segments: segments, resetXs: resetXs);
  }

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
    for (final percent in [100, 75, 50, 25, 0]) {
      final y = plot.top + (1 - percent / 100) * plot.height;
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

    for (var i = 0; i < series.length; i++) {
      final trace = traceFor(series[i], start, end, plot);
      final color = colors[i];

      final resetPaint = Paint()
        ..color = color.withValues(alpha: 0.45)
        ..strokeWidth = 1;
      for (final x in trace.resetXs) {
        for (var y = plot.top; y < plot.bottom; y += 6) {
          canvas.drawLine(
            Offset(x, y),
            Offset(x, math.min(y + 3, plot.bottom)),
            resetPaint,
          );
        }
      }

      final linePaint = Paint()
        ..color = color
        ..strokeWidth = 2
        ..style = PaintingStyle.stroke
        ..strokeCap = StrokeCap.round
        ..strokeJoin = StrokeJoin.round;
      final dotPaint = Paint()
        ..color = color
        ..style = PaintingStyle.fill;
      for (final seg in trace.segments) {
        if (seg.length == 1) {
          // A lone reading has no line; a dot keeps it visible.
          canvas.drawCircle(seg.single, 2.5, dotPaint);
          continue;
        }
        final path = Path()..moveTo(seg.first.dx, seg.first.dy);
        for (final point in seg.skip(1)) {
          path.lineTo(point.dx, point.dy);
        }
        canvas.drawPath(path, linePaint);
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
  bool shouldRepaint(covariant QuotaRemainingChartPainter oldDelegate) =>
      oldDelegate.series != series ||
      oldDelegate.colors != colors ||
      oldDelegate.start != start ||
      oldDelegate.end != end;
}
