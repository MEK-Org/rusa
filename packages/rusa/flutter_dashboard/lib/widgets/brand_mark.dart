import 'package:flutter/material.dart';
import 'package:flutter_svg/flutter_svg.dart';

/// The dashboard's upper-left brand mark: the operator-supplied antler/tree
/// artwork (issue #412). The source SVG is tightly cropped — the antlers and
/// roots run to its edges — so it always renders inside fixed padding that
/// gives the artwork visual breathing room at the existing header size, on
/// both the desktop header and the phone drawer.
class BrandMark extends StatelessWidget {
  const BrandMark({super.key});

  /// Fixed height constraint for the artwork box itself. Sized so the padded
  /// widget sits comfortably centered in the 56px header row.
  static const double _kArtworkHeight = 22;

  /// Surrounding space compensating for the artwork's tight crop.
  ///
  /// With [kPadding] of 5 px on all sides and artwork height constrained to
  /// 22 px, the widget's vertical footprint is 32 px (`22 + 2 * 5`). Because
  /// the SVG has an intrinsic 687×596 aspect ratio (~1.1527:1) letterboxed by
  /// [BoxFit.contain], the artwork renders at ~25.36 px wide, producing a total
  /// horizontal footprint of ~35.36 px (`25.36 + 2 * 5`).
  static const double kPadding = 5;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.all(kPadding),
      child: SvgPicture.asset(
        'assets/antler_tree_mark.svg',
        height: _kArtworkHeight,
        fit: BoxFit.contain,
        semanticsLabel: 'Rusa antler-tree mark',
      ),
    );
  }
}
