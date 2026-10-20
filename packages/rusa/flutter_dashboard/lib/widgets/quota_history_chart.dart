import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:intl/intl.dart';

import '../models.dart';
import '../theme.dart';
import 'chart_frame.dart';

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

/// Fable is drawn in a lighter tone of the Claude color (#728). It is not in
/// [_fallbackSeriesColors], so no hashed series can land on it.
const _fableSeriesColor = MeshColors.fable;

bool _isFableSeries(QuotaHistorySeriesDto series) =>
    series.scope == 'model' &&
    series.provider == 'claude' &&
    isFableModelScope(series.modelIds);

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
/// whole number of days (`HISTORY_WINDOW_MS`); [phrase] reads "prior 3 days"
/// and [title] is its heading form.
({DateTime start, DateTime end, String phrase, String title})
quotaHistoryRangeOf(QuotaHistoryDto history) {
  final end =
      DateTime.tryParse(history.generatedAt)?.toUtc() ?? DateTime.now().toUtc();
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

/// Time-series plots for quota headroom and throttle period, each carrying its
/// own color key directly beneath it.
class QuotaHistoryChart extends StatelessWidget {
  const QuotaHistoryChart({
    super.key,
    required this.history,
    this.isStale = false,
    this.sharedRange,
  });

  final QuotaHistoryDto history;
  final bool isStale;

  /// The range shared by every Overview chart (#1018); defaults to the
  /// history's own bounds.
  final ({DateTime start, DateTime end})? sharedRange;

  @override
  Widget build(BuildContext context) {
    final own = quotaHistoryRangeOf(history);
    final start = sharedRange?.start ?? own.start;
    final end = sharedRange?.end ?? own.end;
    final range =
        'prior ${(end.difference(start).inMinutes / (24 * 60)).round()} days';
    // History is fetched once (#26) while the shared end keeps moving with the
    // inbox charts, so once its readings stop a minute or more short of the
    // range's end, the end label says where they stop instead of "now".
    final dataEnd = end.difference(own.end) >= const Duration(minutes: 1)
        ? DateFormat('HH:mm').format(own.end.toLocal())
        : null;
    final asOfLabel = dataEnd == null ? null : 'as of $dataEnd';
    final asOfNote = dataEnd == null ? '' : ' Readings end at $dataEnd.';
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
    // Fable keeps its hashed slot above, so every other series steps past it
    // exactly as before; only the color Fable is drawn in changes (#728). Only
    // the first Fable series is repainted, so two never share a color.
    for (final series in visible) {
      if (_isFableSeries(series)) {
        colors[series] = _fableSeriesColor;
        break;
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

    final cachedNote = isStale
        ? ' Cached snapshot as of ${history.generatedAt}.'
        : asOfNote;

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
        ChartSection(
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
          legend: _SeriesLegend(
            series: headroomSeries,
            colors: colors,
            empty: 'No controller decisions recorded in the $range.',
          ),
          isStale: isStale,
          endLabel: asOfLabel,
        ),
        const SizedBox(height: 16),
        ChartSection(
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
          legend: _SeriesLegend(
            series: throttleSeries,
            colors: colors,
            empty: 'No throttle decisions recorded in the $range.',
          ),
          isStale: isStale,
          endLabel: asOfLabel,
        ),
      ],
    );
  }
}

/// The color key for the series drawn on one plot.
class _SeriesLegend extends StatelessWidget {
  const _SeriesLegend({
    required this.series,
    required this.colors,
    required this.empty,
  });

  final List<QuotaHistorySeriesDto> series;
  final Map<QuotaHistorySeriesDto, Color> colors;
  final String empty;

  @override
  Widget build(BuildContext context) {
    if (series.isEmpty) {
      return Text(
        empty,
        style: const TextStyle(color: MeshColors.textMuted, fontSize: 12),
      );
    }
    return Wrap(
      spacing: 18,
      runSpacing: 8,
      children: [
        for (final s in series)
          ChartLegendItem(
            label: s.scope == 'model'
                ? '${_providerTitle(s.provider)} · ${s.label}'
                : _providerTitle(s.provider),
            color: colors[s]!,
          ),
      ],
    );
  }
}

/// Where one series lands on a plot: the connected runs of readings.
@visibleForTesting
class QuotaSeriesTrace {
  const QuotaSeriesTrace({required this.segments});

  final List<List<Offset>> segments;
}

/// Maps one series onto [plot]. [valueOf] picks the reading a chart plots, or
/// null where there is none, and [yFor] places it. Readings outside the range
/// are skipped, and a reading without a value or after a reset breaks the line.
QuotaSeriesTrace _traceSeries(
  QuotaHistorySeriesDto series, {
  required DateTime start,
  required DateTime end,
  required Rect plot,
  required double? Function(QuotaHistoryPointDto point) valueOf,
  required double Function(double value) yFor,
}) {
  final spanMs = end.millisecondsSinceEpoch - start.millisecondsSinceEpoch;
  final segments = <List<Offset>>[];
  if (spanMs <= 0) return QuotaSeriesTrace(segments: segments);
  double xFor(DateTime at) =>
      plot.left +
      ((at.millisecondsSinceEpoch - start.millisecondsSinceEpoch) / spanMs)
              .clamp(0.0, 1.0) *
          plot.width;

  List<Offset>? current;
  DateTime? lastResetAt;
  for (final point in series.points) {
    // A reading that can't be placed on the axis is skipped, not a break.
    final observedAt = DateTime.tryParse(point.observedAt)?.toUtc();
    if (observedAt == null ||
        observedAt.isBefore(start) ||
        observedAt.isAfter(end)) {
      continue;
    }
    final value = valueOf(point);
    if (value == null) {
      // A reading without a value is a missing reading: break the line.
      if (current != null) segments.add(current);
      current = null;
      continue;
    }
    final resetAt = point.resetAtIso != null
        ? DateTime.tryParse(point.resetAtIso!)?.toUtc()
        : null;

    final reset =
        lastResetAt != null &&
        resetAt != null &&
        _windowReset(observedAt, resetAt, lastResetAt);

    final offset = Offset(xFor(observedAt), yFor(value));
    if (current == null || reset) {
      if (current != null) segments.add(current);
      current = [offset];
    } else {
      current.add(offset);
    }
    lastResetAt = resetAt;
  }
  if (current != null) segments.add(current);
  return QuotaSeriesTrace(segments: segments);
}

/// The plots break at every reading after the last reading's reported reset,
/// and wherever that instant moves.
bool _windowReset(
  DateTime observedAt,
  DateTime resetAt,
  DateTime lastResetAt,
) =>
    resetAt.difference(lastResetAt).abs() > _windowResetShift ||
    observedAt.isAfter(lastResetAt);

/// Strokes each segment of [trace] in [color], with a dot at every reading.
void _paintTrace(Canvas canvas, QuotaSeriesTrace trace, Color color) {
  final linePaint = Paint()
    ..color = color
    ..strokeWidth = 2
    ..style = PaintingStyle.stroke
    ..strokeCap = StrokeCap.round
    ..strokeJoin = StrokeJoin.round;
  for (final seg in trace.segments) {
    if (seg.length < 2) continue;
    final path = Path()..moveTo(seg.first.dx, seg.first.dy);
    for (final point in seg.skip(1)) {
      path.lineTo(point.dx, point.dy);
    }
    canvas.drawPath(path, linePaint);
  }

  final dotPaint = Paint()
    ..color = color
    ..style = PaintingStyle.fill;
  for (final seg in trace.segments) {
    for (final point in seg) {
      canvas.drawCircle(point, 2.5, dotPaint);
    }
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

  /// Map one series onto [plot], breaking at resets and missing decisions.
  @visibleForTesting
  static QuotaSeriesTrace traceFor(
    QuotaHistorySeriesDto series,
    DateTime start,
    DateTime end,
    Rect plot,
  ) => _traceSeries(
    series,
    start: start,
    end: end,
    plot: plot,
    valueOf: (point) => point.error,
    yFor: (error) =>
        plot.top + ((50.0 - error.clamp(-50.0, 50.0)) / 100.0) * plot.height,
  );

  @override
  void paint(Canvas canvas, Size size) {
    final plot = chartPlotRect(size);
    if (plot.width <= 0 || plot.height <= 0) return;

    final gridPaint = chartGridPaint();
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
      paintChartValueLabel(canvas, percent > 0 ? '+$percent%' : '$percent%', y);
    }
    paintChartTimeAxis(canvas, plot, start, end, gridPaint);

    for (var i = 0; i < series.length; i++) {
      _paintTrace(canvas, traceFor(series[i], start, end, plot), colors[i]);
    }
  }

  @override
  bool shouldRepaint(covariant QuotaPaceErrorChartPainter oldDelegate) =>
      oldDelegate.series != series ||
      oldDelegate.colors != colors ||
      oldDelegate.start != start ||
      oldDelegate.end != end;
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

  /// Map one series onto [plot], breaking at resets and non-finite intervals.
  @visibleForTesting
  static QuotaSeriesTrace traceFor(
    QuotaHistorySeriesDto series,
    DateTime start,
    DateTime end,
    Rect plot,
    double Function(double seconds) yFor,
  ) => _traceSeries(
    series,
    start: start,
    end: end,
    plot: plot,
    valueOf: (point) => (point.intervalSeconds?.isFinite ?? false)
        ? point.intervalSeconds
        : null,
    yFor: yFor,
  );

  @override
  void paint(Canvas canvas, Size size) {
    final plot = chartPlotRect(size);
    if (plot.width <= 0 || plot.height <= 0) return;

    final gridPaint = chartGridPaint();
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
      paintChartValueLabel(canvas, '${decadeSeconds.round()}s', y);
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

    paintChartTimeAxis(canvas, plot, start, end, gridPaint);

    for (var i = 0; i < series.length; i++) {
      _paintTrace(
        canvas,
        traceFor(series[i], start, end, plot, yFor),
        colors[i],
      );
    }
  }

  @override
  bool shouldRepaint(covariant QuotaThrottleIntervalChartPainter oldDelegate) =>
      oldDelegate.series != series ||
      oldDelegate.colors != colors ||
      oldDelegate.start != start ||
      oldDelegate.end != end;
}
