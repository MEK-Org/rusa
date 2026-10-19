import 'dart:math' as math;
import 'dart:ui' show PathMetric;

import 'package:flutter/material.dart';

import '../models.dart';
import '../theme.dart';

/// Every Overview chart spans the same prior three days (#1018).
const kOverviewChartWindow = Duration(days: 3);

/// Median lines are solid cyan; max lines are dashed amber.
const kInboxMedianColor = MeshColors.accent;
const kInboxMaxColor = MeshColors.statusIdle;

/// One time range for every Overview chart, so all of them end at the same
/// instant: the newest `generatedAt` among the payloads on screen.
({DateTime start, DateTime end}) overviewChartRange(
  Iterable<String> generatedAts,
) {
  DateTime? end;
  for (final raw in generatedAts) {
    final at = DateTime.tryParse(raw)?.toUtc();
    if (at != null && (end == null || at.isAfter(end))) end = at;
  }
  final shared = end ?? DateTime.now().toUtc();
  return (start: shared.subtract(kOverviewChartWindow), end: shared);
}

/// Where one statistic lands on a plot: the connected runs of minutes.
@visibleForTesting
class InboxMetricTrace {
  const InboxMetricTrace({required this.segments});

  final List<List<Offset>> segments;
}

/// Maps one statistic onto [plot]. Points sit at their minute. A minute with
/// no sample, or with no live actor to summarize, breaks the line.
@visibleForTesting
InboxMetricTrace traceInboxMetric(
  List<InboxMetricPointDto> points, {
  required DateTime start,
  required DateTime end,
  required Rect plot,
  required int intervalSeconds,
  required double? Function(InboxMetricPointDto point) valueOf,
  required double Function(double value) yFor,
}) {
  final spanMs = end.millisecondsSinceEpoch - start.millisecondsSinceEpoch;
  final segments = <List<Offset>>[];
  if (spanMs <= 0) return InboxMetricTrace(segments: segments);
  final intervalMs = intervalSeconds * 1000;

  List<Offset>? current;
  DateTime? previous;
  for (final point in points) {
    final minute = DateTime.tryParse(point.minute)?.toUtc();
    if (minute == null || minute.isBefore(start) || minute.isAfter(end)) {
      continue;
    }
    final value = valueOf(point);
    final contiguous =
        previous != null &&
        minute.difference(previous).inMilliseconds <= intervalMs;
    previous = minute;
    if (value == null || !contiguous) {
      if (current != null) segments.add(current);
      current = null;
    }
    if (value == null) continue;
    final x =
        plot.left +
        (minute.millisecondsSinceEpoch - start.millisecondsSinceEpoch) /
            spanMs *
            plot.width;
    (current ??= []).add(Offset(x, yFor(value)));
  }
  if (current != null) segments.add(current);
  return InboxMetricTrace(segments: segments);
}

/// A linear axis from zero to [top] with four equal steps.
@visibleForTesting
class InboxMetricAxis {
  const InboxMetricAxis(this.top, this.label);

  final double top;
  final String Function(double value) label;

  /// Inbox sizes: whole-entry steps of 1, 2 or 5 × 10ⁿ.
  factory InboxMetricAxis.count(double highest) {
    var step = 1.0;
    while (step * 4 < highest) {
      final magnitude = math
          .pow(10, (math.log(step) / math.ln10).floor())
          .toDouble();
      final mantissa = step / magnitude;
      step = (mantissa < 2 ? 2 : (mantissa < 5 ? 5 : 10)) * magnitude;
    }
    return InboxMetricAxis(step * 4, (v) => v.round().toString());
  }

  /// Ages: steps from a ladder of familiar durations.
  factory InboxMetricAxis.age(double highestSeconds) {
    const ladder = [
      60, 5 * 60, 15 * 60, 30 * 60, 3600, 2 * 3600, 6 * 3600, 12 * 3600, //
      86400, 2 * 86400, 7 * 86400,
    ];
    var step = ladder.last.toDouble();
    for (final candidate in ladder) {
      if (candidate * 4 >= highestSeconds) {
        step = candidate.toDouble();
        break;
      }
    }
    while (step * 4 < highestSeconds) {
      step *= 2;
    }
    return InboxMetricAxis(step * 4, inboxAgeLabel);
  }

  double fractionOf(double value) => (value / top).clamp(0.0, 1.0);
}

/// A compact age, in the largest whole unit that fits.
String inboxAgeLabel(double seconds) {
  final s = seconds.round();
  if (s == 0) return '0';
  if (s % 86400 == 0) return '${s ~/ 86400}d';
  if (s % 3600 == 0) return '${s ~/ 3600}h';
  if (s % 60 == 0) return '${s ~/ 60}m';
  return '${s}s';
}

/// The two Overview inbox charts (#1018): cross-actor inbox size and age of the
/// oldest unhandled item, each as a per-minute median and max.
class InboxMetricsChart extends StatelessWidget {
  const InboxMetricsChart({
    super.key,
    required this.metrics,
    required this.start,
    required this.end,
    this.isStale = false,
  });

  final InboxMetricsDto metrics;
  final DateTime start;
  final DateTime end;
  final bool isStale;

  @override
  Widget build(BuildContext context) {
    final inRange = metrics.points.where((point) {
      final minute = DateTime.tryParse(point.minute)?.toUtc();
      return minute != null && !minute.isBefore(start) && !minute.isAfter(end);
    }).toList();
    final days = (end.difference(start).inMinutes / (24 * 60)).round();
    final range = 'prior $days days';
    final cachedNote = isStale
        ? ' Cached snapshot as of ${metrics.generatedAt}.'
        : '';

    if (inRange.isEmpty) {
      return Text(
        'No inbox samples recorded in the $range.',
        key: const Key('inbox-metrics-empty'),
        style: const TextStyle(color: MeshColors.textMuted, fontSize: 13),
      );
    }

    double highest(double? Function(InboxMetricPointDto) of) =>
        inRange.fold(0.0, (top, point) => math.max(top, of(point) ?? 0));
    final sizeAxis = InboxMetricAxis.count(highest((p) => p.inboxSizeMax));
    final ageAxis = InboxMetricAxis.age(highest((p) => p.oldestAgeSecondsMax));

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (isStale) ...[
          Text(
            'Cached snapshot as of ${metrics.generatedAt}',
            style: kMonoStyle.copyWith(
              color: MeshColors.textMuted,
              fontSize: 11,
            ),
          ),
          const SizedBox(height: 8),
        ],
        _InboxChartSection(
          title: 'Inbox Size',
          subtitle:
              'Unhandled entries per live actor, sampled each minute. Seen or '
              'selected entries count until handled; an empty inbox counts as '
              'zero.',
          semanticsLabel:
              'Inbox size over the $range: median and max across live actors '
              'each minute.$cachedNote',
          chartKey: const Key('inbox-size-chart'),
          endLabelKey: const Key('inbox-size-end-label'),
          painter: InboxMetricChartPainter(
            points: inRange,
            start: start,
            end: end,
            intervalSeconds: metrics.intervalSeconds,
            axis: sizeAxis,
            median: (p) => p.inboxSizeMedian,
            max: (p) => p.inboxSizeMax,
          ),
          isStale: isStale,
        ),
        const SizedBox(height: 16),
        _InboxChartSection(
          title: 'Oldest Inbox Item',
          subtitle:
              'How long each live actor\'s oldest unhandled entry has waited. '
              'An empty inbox counts as zero.',
          semanticsLabel:
              'Oldest inbox item age over the $range: median and max across '
              'live actors each minute.$cachedNote',
          chartKey: const Key('inbox-oldest-chart'),
          endLabelKey: const Key('inbox-oldest-end-label'),
          painter: InboxMetricChartPainter(
            points: inRange,
            start: start,
            end: end,
            intervalSeconds: metrics.intervalSeconds,
            axis: ageAxis,
            median: (p) => p.oldestAgeSecondsMedian,
            max: (p) => p.oldestAgeSecondsMax,
          ),
          isStale: isStale,
        ),
        const SizedBox(height: 10),
        _CoverageNote(points: inRange, start: start, end: end, range: range),
      ],
    );
  }
}

class _InboxChartSection extends StatelessWidget {
  const _InboxChartSection({
    required this.title,
    required this.subtitle,
    required this.semanticsLabel,
    required this.chartKey,
    required this.endLabelKey,
    required this.painter,
    required this.isStale,
  });

  final String title;
  final String subtitle;
  final String semanticsLabel;
  final Key chartKey;
  final Key endLabelKey;
  final CustomPainter painter;
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
        const Wrap(
          spacing: 18,
          runSpacing: 8,
          children: [
            _LegendItem(label: 'Median', color: kInboxMedianColor),
            _LegendItem(label: 'Max', color: kInboxMaxColor, dashed: true),
          ],
        ),
      ],
    );
  }
}

class _LegendItem extends StatelessWidget {
  const _LegendItem({
    required this.label,
    required this.color,
    this.dashed = false,
  });

  final String label;
  final Color color;
  final bool dashed;

  @override
  Widget build(BuildContext context) {
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        SizedBox(
          width: 18,
          height: 3,
          child: dashed
              ? Row(
                  mainAxisAlignment: MainAxisAlignment.spaceBetween,
                  children: [
                    for (var i = 0; i < 3; i++)
                      Container(width: 4, height: 3, color: color),
                  ],
                )
              : DecoratedBox(
                  decoration: BoxDecoration(
                    color: color,
                    borderRadius: BorderRadius.circular(2),
                  ),
                ),
        ),
        const SizedBox(width: 6),
        Text(
          label,
          style: const TextStyle(color: MeshColors.textSecondary, fontSize: 12),
        ),
      ],
    );
  }
}

/// How much of the range was sampled and how many live actors were
/// summarized, so outages and population changes are not mistaken for an
/// empty mesh.
class _CoverageNote extends StatelessWidget {
  const _CoverageNote({
    required this.points,
    required this.start,
    required this.end,
    required this.range,
  });

  final List<InboxMetricPointDto> points;
  final DateTime start;
  final DateTime end;
  final String range;

  @override
  Widget build(BuildContext context) {
    // Whole minutes inside the closed range [start, end].
    const minuteMs = 60 * 1000;
    final minutes =
        (end.millisecondsSinceEpoch ~/ minuteMs) -
        ((start.millisecondsSinceEpoch + minuteMs - 1) ~/ minuteMs) +
        1;
    final counts = points.map((p) => p.actorCount);
    final latest = points.last.actorCount;
    final low = counts.reduce(math.min);
    final high = counts.reduce(math.max);
    final population = low == high
        ? '$latest live actors throughout'
        : '$latest live actors at the latest sample ($low–$high over the range)';
    return Text(
      'Sampled ${points.length} of $minutes minutes in the $range; gaps are '
      'unsampled minutes. $population.',
      key: const Key('inbox-metrics-coverage'),
      style: const TextStyle(color: MeshColors.textMuted, fontSize: 11),
    );
  }
}

/// Paints one statistic's median (solid) and max (dashed) on a linear scale
/// from zero.
class InboxMetricChartPainter extends CustomPainter {
  InboxMetricChartPainter({
    required this.points,
    required this.start,
    required this.end,
    required this.intervalSeconds,
    required this.axis,
    required this.median,
    required this.max,
  });

  final List<InboxMetricPointDto> points;
  final DateTime start;
  final DateTime end;
  final int intervalSeconds;
  final InboxMetricAxis axis;
  final double? Function(InboxMetricPointDto point) median;
  final double? Function(InboxMetricPointDto point) max;

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
    for (var quarter = 0; quarter <= 4; quarter++) {
      final value = axis.top * quarter / 4;
      final y = plot.bottom - axis.fractionOf(value) * plot.height;
      canvas.drawLine(Offset(plot.left, y), Offset(plot.right, y), gridPaint);
      _paintLabel(
        canvas,
        axis.label(value),
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
    _paintLabel(canvas, _agoLabel(span), Offset(plot.left, plot.bottom + 7));
    _paintLabel(
      canvas,
      _agoLabel(Duration(milliseconds: span.inMilliseconds ~/ 2)),
      Offset(plot.center.dx - 28, plot.bottom + 7),
      width: 56,
      align: TextAlign.center,
    );

    double yFor(double value) =>
        plot.bottom - axis.fractionOf(value) * plot.height;
    InboxMetricTrace trace(double? Function(InboxMetricPointDto) of) =>
        traceInboxMetric(
          points,
          start: start,
          end: end,
          plot: plot,
          intervalSeconds: intervalSeconds,
          valueOf: of,
          yFor: yFor,
        );
    // Max first, so the median stays legible where the two coincide.
    _paintTrace(canvas, trace(max), kInboxMaxColor, dashed: true);
    _paintTrace(canvas, trace(median), kInboxMedianColor);
  }

  @override
  bool shouldRepaint(covariant InboxMetricChartPainter oldDelegate) =>
      oldDelegate.points != points ||
      oldDelegate.start != start ||
      oldDelegate.end != end ||
      oldDelegate.axis.top != axis.top;
}

void _paintTrace(
  Canvas canvas,
  InboxMetricTrace trace,
  Color color, {
  bool dashed = false,
}) {
  final linePaint = Paint()
    ..color = color
    ..strokeWidth = 2
    ..style = PaintingStyle.stroke
    ..strokeCap = StrokeCap.butt
    ..strokeJoin = StrokeJoin.round;
  final dotPaint = Paint()
    ..color = color
    ..style = PaintingStyle.fill;
  for (final seg in trace.segments) {
    // A lone sampled minute has no neighbour to join; mark it with a dot.
    if (seg.length < 2) {
      canvas.drawCircle(seg.first, 2, dotPaint);
      continue;
    }
    final path = Path()..moveTo(seg.first.dx, seg.first.dy);
    for (final point in seg.skip(1)) {
      path.lineTo(point.dx, point.dy);
    }
    canvas.drawPath(dashed ? _dash(path) : path, linePaint);
  }
}

/// [path] as 6px dashes with 4px gaps.
Path _dash(Path path) {
  final dashed = Path();
  for (final PathMetric metric in path.computeMetrics()) {
    var distance = 0.0;
    while (distance < metric.length) {
      dashed.addPath(
        metric.extractPath(distance, math.min(distance + 6, metric.length)),
        Offset.zero,
      );
      distance += 10;
    }
  }
  return dashed;
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

String _agoLabel(Duration duration) {
  final hours = duration.inHours;
  if (hours >= 24 && hours % 24 == 0) return '${hours ~/ 24}d ago';
  return '${hours}h ago';
}
