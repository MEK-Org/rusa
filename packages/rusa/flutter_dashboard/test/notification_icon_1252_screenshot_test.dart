// Public-safe review capture for #1252's Android notification small icon.
// SYNTHETIC: this is not an Android rendering and not a device capture. It
// applies the status bar's alpha-only rule to what each build falls back to,
// and to the shipped vector drawable's own path data translated to SVG
// (after). Before, an unbranded build falls back to the scaffold launcher PNG;
// a branded build falls back to its adaptive launcher icon, whose opaque
// black background makes every pixel inside the device's icon mask opaque.
// That mask is device-dependent; it is drawn square here, as reported.
// Device tinting and layout vary by OS version.
// Run: flutter test test/notification_icon_1252_screenshot_test.dart
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_svg/flutter_svg.dart';
import 'package:flutter_test/flutter_test.dart';

import 'screenshot_support.dart';

const _res = 'android/app/src/main/res';

String _attr(String xml, String name, [String fallback = '']) =>
    RegExp('android:$name="([^"]*)"').firstMatch(xml)?.group(1) ?? fallback;

/// The drawable's viewport, group transform and paths as SVG, so the capture
/// shows the path data that ships rather than a redrawn copy.
String _vectorAsSvg(String xml) {
  final group = RegExp(r'<group\b[^>]*>').firstMatch(xml)!.group(0)!;
  final px = _attr(group, 'pivotX', '0'), py = _attr(group, 'pivotY', '0');
  final transform =
      'translate(${_attr(group, 'translateX', '0')} '
      '${_attr(group, 'translateY', '0')}) '
      'translate($px $py) '
      'scale(${_attr(group, 'scaleX', '1')} ${_attr(group, 'scaleY', '1')}) '
      'translate(-$px -$py)';
  final paths = [
    for (final m in RegExp(r'<path\b[^>]*/>').allMatches(xml))
      () {
        final p = m.group(0)!;
        final fill = _attr(p, 'fillColor');
        final stroke = _attr(p, 'strokeColor');
        return '<path d="${_attr(p, 'pathData')}" '
            'fill="${fill.isEmpty ? 'none' : 'white'}" '
            '${stroke.isEmpty ? '' : 'stroke="white" '
                      'stroke-width="${_attr(p, 'strokeWidth')}" '
                      'stroke-linecap="${_attr(p, 'strokeLineCap', 'butt')}"'}/>';
      }(),
  ];
  return '<svg xmlns="http://www.w3.org/2000/svg" '
      'viewBox="0 0 ${_attr(xml, 'viewportWidth')} '
      '${_attr(xml, 'viewportHeight')}">'
      '<g transform="$transform">${paths.join()}</g></svg>';
}

class _Surface {
  const _Surface(this.name, this.bar, this.shade, this.tint, this.text);
  final String name;
  final Color bar, shade, tint, text;
}

const _surfaces = [
  _Surface(
    'light',
    Color(0xFFF1F3F4),
    Color(0xFFFFFFFF),
    Color(0xFF3C4043),
    Color(0xFF202124),
  ),
  _Surface(
    'dark',
    Color(0xFF000000),
    Color(0xFF2D2E31),
    Color(0xFFE8EAED),
    Color(0xFFE8EAED),
  ),
];

/// Draws [icon] from its alpha channel alone, in [tint], at [size].
Widget _alphaOnly(Widget icon, Color tint, double size) => SizedBox.square(
  dimension: size,
  child: ColorFiltered(
    colorFilter: ColorFilter.mode(tint, BlendMode.srcIn),
    child: icon,
  ),
);

Widget _frame(GlobalKey key, _Surface s, Widget Function(double) icon) =>
    MaterialApp(
      debugShowCheckedModeBanner: false,
      home: Scaffold(
        body: RepaintBoundary(
          key: key,
          child: Container(
            width: 360,
            color: s.bar,
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                // Status bar, icon at its 24dp size.
                Padding(
                  padding: const EdgeInsets.fromLTRB(16, 8, 16, 8),
                  child: Row(
                    children: [
                      Text('9:41', style: TextStyle(color: s.text)),
                      const SizedBox(width: 8),
                      icon(24),
                    ],
                  ),
                ),
                // Simplified shade entry; not Android's template layout.
                Container(
                  margin: const EdgeInsets.fromLTRB(8, 0, 8, 8),
                  padding: const EdgeInsets.all(12),
                  decoration: BoxDecoration(
                    color: s.shade,
                    borderRadius: BorderRadius.circular(16),
                  ),
                  child: Row(
                    children: [
                      icon(24),
                      const SizedBox(width: 12),
                      Text(
                        'Rusa · now\nNew reply',
                        style: TextStyle(color: s.text, height: 1.4),
                      ),
                    ],
                  ),
                ),
                // Magnified 4x so the silhouette is inspectable.
                Padding(
                  padding: const EdgeInsets.only(bottom: 12),
                  child: Center(child: icon(96)),
                ),
              ],
            ),
          ),
        ),
      ),
    );

void main() {
  setUpAll(loadFonts);

  final launcher = File('$_res/mipmap-xxxhdpi/ic_launcher.png');
  final svg = _vectorAsSvg(
    File('$_res/drawable/ic_stat_rusa.xml').readAsStringSync(),
  );

  // One widget test renders all six captures; this harness asserts nothing
  // and exists to regenerate the committed review PNGs.
  testWidgets('captures the before and after small icons', (tester) async {
    await tester.runAsync(() async {
      for (final s in _surfaces) {
        for (final (phase, image) in [
          ('before_unbranded', (double _) => Image.file(launcher)),
          (
            'before_branded',
            (double _) => const ColoredBox(color: Colors.black),
          ),
          ('after', (double _) => SvgPicture.string(svg)),
        ]) {
          final key = GlobalKey();
          await tester.pumpWidget(
            _frame(key, s, (size) => _alphaOnly(image(size), s.tint, size)),
          );
          if (phase == 'before_unbranded') {
            await precacheImage(
              FileImage(launcher),
              tester.element(find.byType(Scaffold)),
            );
          }
          for (var i = 0; i < 4; i++) {
            await tester.pump(const Duration(milliseconds: 50));
          }
          await captureBoundary(
            key,
            'screenshots/1252_notification_icon_${s.name}_$phase.png',
          );
        }
      }
    });
  });
}
