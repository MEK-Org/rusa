import 'package:flutter/material.dart';

import '../theme.dart';

// The frame every Overview time-series plot shares (#1018): one heading,
// canvas, time axis and legend style, so the plots align by construction.

/// Width reserved left of the plot for the value labels.
const kChartPlotLeft = 42.0;

/// Where a plot sits inside a canvas of [size].
Rect chartPlotRect(Size size) =>
    Rect.fromLTRB(kChartPlotLeft, 10, size.width - 10, size.height - 27);

/// The gridline paint every plot uses.
Paint chartGridPaint() => Paint()
  ..color = MeshColors.border.withValues(alpha: 0.7)
  ..strokeWidth = 1;

/// Paints one axis label in the charts' muted monospace.
void paintChartLabel(
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

/// Paints one value label right-aligned beside the gridline at [y].
void paintChartValueLabel(Canvas canvas, String text, double y) =>
    paintChartLabel(
      canvas,
      text,
      Offset(0, y - 7),
      width: kChartPlotLeft - 6,
      align: TextAlign.right,
    );

/// Paints the quarter gridlines and the "ago" labels along the time axis.
void paintChartTimeAxis(
  Canvas canvas,
  Rect plot,
  DateTime start,
  DateTime end,
  Paint gridPaint,
) {
  for (var quarter = 0; quarter <= 4; quarter++) {
    final x = plot.left + (quarter / 4) * plot.width;
    canvas.drawLine(Offset(x, plot.top), Offset(x, plot.bottom), gridPaint);
  }

  final span = end.difference(start);
  paintChartLabel(canvas, _agoLabel(span), Offset(plot.left, plot.bottom + 7));
  paintChartLabel(
    canvas,
    _agoLabel(Duration(milliseconds: span.inMilliseconds ~/ 2)),
    Offset(plot.center.dx - 28, plot.bottom + 7),
    width: 56,
    align: TextAlign.center,
  );
}

String _agoLabel(Duration duration) {
  final hours = duration.inHours;
  if (hours >= 24 && hours % 24 == 0) return '${hours ~/ 24}d ago';
  return '${hours}h ago';
}

/// One plot: heading, plain-English subtitle, the canvas with its "now" (or
/// "cached") end label, and the plot's [legend] beneath it.
class ChartSection extends StatelessWidget {
  const ChartSection({
    super.key,
    required this.title,
    required this.subtitle,
    required this.semanticsLabel,
    required this.chartKey,
    required this.endLabelKey,
    required this.painter,
    required this.isStale,
    required this.legend,
  });

  final String title;
  final String subtitle;
  final String semanticsLabel;
  final Key chartKey;
  final Key endLabelKey;
  final CustomPainter painter;
  final bool isStale;
  final Widget legend;

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
        legend,
      ],
    );
  }
}

/// A legend entry: a short solid (or dashed) stroke and its label.
class ChartLegendItem extends StatelessWidget {
  const ChartLegendItem({
    super.key,
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
        if (dashed)
          SizedBox(
            width: 18,
            height: 3,
            child: Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                for (var i = 0; i < 3; i++)
                  Container(width: 4, height: 3, color: color),
              ],
            ),
          )
        else
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
          label,
          style: const TextStyle(color: MeshColors.textSecondary, fontSize: 12),
        ),
      ],
    );
  }
}
