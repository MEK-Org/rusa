// Screenshot harness for #918's authenticated operator hold recovery control.
// It records the reachable dashboard control before use and its scoped,
// authenticated confirmation after opening it. Run:
//
//   flutter test test/hold_recovery_918_screenshot_test.dart
//
// It writes `screenshots/918_hold_recovery_control_<before|after>.png`.
import 'dart:io';
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rusa_dashboard/store.dart';
import 'package:rusa_dashboard/theme.dart';
import 'package:rusa_dashboard/widgets/actor_tree.dart';

import 'fakes.dart';
import 'screenshot_support.dart';

final String _outDir = '${Directory.current.path}/screenshots';

Future<void> _captureFinderBoundary(
  WidgetTester tester,
  Finder finder,
  String path,
) async {
  final boundary = tester.renderObject<RenderRepaintBoundary>(finder);
  final image = await boundary.toImage(pixelRatio: 2.0);
  final bytes = (await image.toByteData(
    format: ui.ImageByteFormat.png,
  ))!.buffer.asUint8List();
  final file = File(path)..createSync(recursive: true);
  file.writeAsBytesSync(Uint8List.fromList(bytes));
}

void main() {
  setUpAll(loadFonts);

  testWidgets('hold recovery control before and after', (tester) async {
    await tester.runAsync(() async {
      final api = FakeApi()
        ..threadsResult = [makeThread('root', created: 't0')]
        ..rootControlProviders = ['codex'];
      final store = DashboardStore(api: api, stream: FakeStream());
      addTearDown(store.dispose);
      await store.init();
      tester.view
        ..physicalSize = const Size(520, 150)
        ..devicePixelRatio = 1.0;
      addTearDown(tester.view.reset);
      final key = GlobalKey();
      await tester.pumpWidget(
        RepaintBoundary(
          key: key,
          child: MaterialApp(
            debugShowCheckedModeBanner: false,
            theme: buildMeshTheme(),
            home: Scaffold(
              body: Align(
                alignment: Alignment.topRight,
                child: ActorTreeControls(store: store),
              ),
            ),
          ),
        ),
      );
      await tester.pump(const Duration(milliseconds: 100));
      await captureBoundary(
        key,
        '$_outDir/918_hold_recovery_control_before.png',
      );

      tester.view.physicalSize = const Size(520, 480);
      await tester.pump();
      await tester.tap(find.byTooltip('Clear availability holds'));
      await tester.pump(const Duration(milliseconds: 100));
      await tester.pumpAndSettle();
      expect(find.widgetWithText(FilledButton, 'Clear'), findsOneWidget);
      await _captureFinderBoundary(
        tester,
        find.byKey(const ValueKey('availability-hold-clear-dialog')),
        '$_outDir/918_hold_recovery_control_after.png',
      );
    });
  });
}
