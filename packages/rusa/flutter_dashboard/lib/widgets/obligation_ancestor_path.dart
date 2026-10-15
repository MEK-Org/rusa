import 'package:flutter/material.dart';

import '../models.dart';
import '../theme.dart';

/// An obligation's ancestors above its title, root first and parent last
/// (#1076). When the whole path does not fit, a … button takes the place of
/// the ancestors nearest the root, keeping as many of the nearest parents as
/// fit; it lists the hidden ones, root first. Every ancestor shown, on the
/// path or in that list, opens its own obligation through [onOpen].
class ObligationAncestorPath extends StatelessWidget {
  const ObligationAncestorPath({
    super.key,
    required this.ancestors,
    required this.onOpen,
  });

  /// Root first, parent last.
  final List<ObligationDto> ancestors;
  final ValueChanged<String> onOpen;

  static const _textStyle = TextStyle(fontSize: 12, height: 1.3);
  static const _crumbPadding = EdgeInsets.symmetric(horizontal: 4, vertical: 3);
  static const _separatorWidth = 14.0;
  static const _ellipsisWidth = 28.0;
  static const _ellipsisGap = 4.0;

  /// How many of the nearest ancestors to show, given each crumb's width
  /// root first: all of them when the whole path fits in [maxWidth], else as
  /// many as fit after the … button, and never fewer than the parent, which
  /// is cut short when even it alone does not fit.
  static int visibleCount(List<double> crumbWidths, double maxWidth) {
    final n = crumbWidths.length;
    var width = 0.0;
    for (var i = 0; i < n; i++) {
      width += crumbWidths[i] + (i > 0 ? _separatorWidth : 0);
    }
    // A lone parent has nothing to hide: it is cut short instead.
    if (width <= maxWidth || n == 1) return n;
    var shown = 0;
    width = _ellipsisWidth + _ellipsisGap;
    for (var i = n - 1; i >= 0; i--) {
      width += _separatorWidth + crumbWidths[i];
      if (width > maxWidth) break;
      shown++;
    }
    return shown.clamp(1, n - 1);
  }

  @override
  Widget build(BuildContext context) {
    if (ancestors.isEmpty) return const SizedBox.shrink();
    final style = DefaultTextStyle.of(context).style.merge(_textStyle);
    final direction = Directionality.of(context);
    final scaler = MediaQuery.textScalerOf(context);
    final widths = [
      for (final a in ancestors)
        (TextPainter(
                  text: TextSpan(text: a.heading, style: style),
                  textDirection: direction,
                  textScaler: scaler,
                  maxLines: 1,
                )..layout())
                .width
                .ceilToDouble() +
            _crumbPadding.horizontal,
    ];
    return LayoutBuilder(
      builder: (context, constraints) {
        final shown = visibleCount(widths, constraints.maxWidth);
        final hidden = ancestors.sublist(0, ancestors.length - shown);
        final visible = ancestors.sublist(ancestors.length - shown);
        return Row(
          children: [
            if (hidden.isNotEmpty) ...[
              _HiddenAncestorsButton(hidden: hidden, onOpen: onOpen),
              const SizedBox(width: _ellipsisGap),
              const _Separator(),
            ],
            for (var i = 0; i < visible.length; i++) ...[
              if (i > 0) const _Separator(),
              if (i == visible.length - 1)
                // The parent takes whatever is left, so a width the
                // measurement missed shortens it rather than overflowing.
                Flexible(child: _crumb(visible[i], isParent: true))
              else
                _crumb(visible[i], isParent: false),
            ],
          ],
        );
      },
    );
  }

  Widget _crumb(ObligationDto ancestor, {required bool isParent}) => InkWell(
    key: ValueKey('ancestor-crumb-${ancestor.id}'),
    borderRadius: BorderRadius.circular(4),
    onTap: () => onOpen(ancestor.id),
    child: Padding(
      padding: _crumbPadding,
      child: Text(
        ancestor.heading,
        maxLines: 1,
        softWrap: false,
        overflow: TextOverflow.ellipsis,
        style: _textStyle.copyWith(
          color: isParent ? MeshColors.textSecondary : MeshColors.textMuted,
        ),
      ),
    ),
  );
}

class _Separator extends StatelessWidget {
  const _Separator();

  @override
  Widget build(BuildContext context) => const Icon(
    Icons.chevron_right,
    size: ObligationAncestorPath._separatorWidth,
    color: MeshColors.textMuted,
  );
}

/// The … that stands for the ancestors nearest the root, and the list of them
/// it opens.
class _HiddenAncestorsButton extends StatelessWidget {
  const _HiddenAncestorsButton({required this.hidden, required this.onOpen});

  final List<ObligationDto> hidden;
  final ValueChanged<String> onOpen;

  @override
  Widget build(BuildContext context) {
    return PopupMenuButton<String>(
      key: const ValueKey('ancestor-path-more'),
      tooltip: 'Show hidden ancestors',
      padding: EdgeInsets.zero,
      color: MeshColors.bgSecondary,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(8),
        side: const BorderSide(color: MeshColors.border),
      ),
      position: PopupMenuPosition.under,
      // Wider than a menu's default, so long titles keep more of themselves;
      // a narrow screen still clamps it.
      constraints: const BoxConstraints(minWidth: 200, maxWidth: 420),
      onSelected: onOpen,
      itemBuilder: (_) => [
        for (var i = 0; i < hidden.length; i++)
          PopupMenuItem<String>(
            key: ValueKey('ancestor-menu-${hidden[i].id}'),
            value: hidden[i].id,
            height: 40,
            child: Row(
              children: [
                Icon(
                  i == 0
                      ? Icons.account_tree_outlined
                      : Icons.subdirectory_arrow_right,
                  size: 16,
                  color: MeshColors.textMuted,
                ),
                const SizedBox(width: 10),
                Flexible(
                  child: Text(
                    hidden[i].heading,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(
                      color: MeshColors.textPrimary,
                      fontSize: 13,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ),
              ],
            ),
          ),
      ],
      child: Container(
        width: ObligationAncestorPath._ellipsisWidth,
        height: 22,
        decoration: BoxDecoration(
          border: Border.all(color: MeshColors.border),
          borderRadius: BorderRadius.circular(4),
        ),
        child: const Icon(
          Icons.more_horiz,
          size: 16,
          color: MeshColors.accent,
        ),
      ),
    );
  }
}
