import 'package:flutter/material.dart';
import 'package:flutter_svg/flutter_svg.dart';

/// The dashboard's upper-left brand mark: the operator-supplied antler/tree
/// artwork (issue #412). The source SVG is tightly cropped — the antlers and
/// roots run to its edges — so it always renders inside fixed padding that
/// gives the artwork visual breathing room at the existing header size, on
/// both the desktop header and the phone drawer.
class BrandMark extends StatelessWidget {
  const BrandMark({super.key, this.artworkSize = 22});

  /// Height of the artwork box itself. Padding is added around it on top of
  /// this, so the widget's total footprint is `artworkSize + 2 * kPadding`.
  final double artworkSize;

  /// Surrounding space compensating for the artwork's tight crop. Sized so the
  /// padded widget still sits comfortably in the 56px header row.
  static const double kPadding = 5;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.all(kPadding),
      child: SvgPicture.asset(
        'assets/antler_tree_mark.svg',
        height: artworkSize,
        fit: BoxFit.contain,
        semanticsLabel: 'Rusa antler-tree mark',
      ),
    );
  }
}
