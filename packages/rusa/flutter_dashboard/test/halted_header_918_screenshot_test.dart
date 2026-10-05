// Screenshot harness for #918's header HALTED indicator. The header widget is
// unchanged; what changes is the `halted` flag `/api/mesh/threads` reports.
// After `/halt provider:codex model:m1` then a bare `/resume`, staging has
// deleted its HALT file and reports false, while #918 keeps the hold in force
// and reports true (start.test.ts asserts the server side). Run:
//
//   flutter test test/halted_header_918_screenshot_test.dart
//
// It writes `screenshots/918_halted_header_<viewport>_<before|after>.png`.
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rusa_dashboard/store.dart';
import 'package:rusa_dashboard/theme.dart';
import 'package:rusa_dashboard/widgets/header.dart';

import 'fakes.dart';
import 'screenshot_support.dart';

final String _outDir = '${Directory.current.path}/screenshots';

void main() {
  setUpAll(loadFonts);

  const sizes = [('wide', Size(1180, 120)), ('phone', Size(390, 120))];
  const states = [('before', false), ('after', true)];

  for (final (viewport, size) in sizes) {
    for (final (name, halted) in states) {
      testWidgets('halted header $viewport $name', (tester) async {
        await tester.runAsync(() async {
          final api = FakeApi()
            ..halted = halted
            ..threadsResult = [makeThread('root', created: 't0')];
          final store = DashboardStore(api: api, stream: FakeStream());
          addTearDown(store.dispose);
          await store.init();
          tester.view
            ..physicalSize = size
            ..devicePixelRatio = 1.0;
          addTearDown(tester.view.reset);
          final key = GlobalKey();
          await tester.pumpWidget(
            MaterialApp(
              debugShowCheckedModeBanner: false,
              theme: buildMeshTheme(),
              home: RepaintBoundary(
                key: key,
                child: Scaffold(
                  body: Align(
                    alignment: Alignment.topCenter,
                    child: MeshHeader(
                      store: store,
                      selected: DashboardView.actors,
                      onSelect: (_) {},
                      onMenuTap: viewport == 'phone' ? () {} : null,
                    ),
                  ),
                ),
              ),
            ),
          );
          for (var i = 0; i < 5; i++) {
            await Future<void>.delayed(const Duration(milliseconds: 20));
            await tester.pump(const Duration(milliseconds: 50));
          }
          expect(
            find.byIcon(Icons.pause_circle_filled),
            halted ? findsOneWidget : findsNothing,
          );
          expect(tester.takeException(), isNull);
          await captureBoundary(
            key,
            '$_outDir/918_halted_header_${viewport}_$name.png',
          );
        });
      });
    }
  }
}
