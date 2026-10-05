// Screenshot harness for #920's run_mcp_diagnostic event. The Events tab is
// unchanged; what changes is that each started run now records one more mesh
// event after `run_end`, and the default "All Events" filter lists every kind.
// Run:
//
//   flutter test test/run_mcp_diagnostic_920_screenshot_test.dart
//
// It writes `screenshots/920_events_<viewport>_<before|after>.png`.
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rusa_dashboard/models.dart';
import 'package:rusa_dashboard/store.dart';
import 'package:rusa_dashboard/theme.dart';
import 'package:rusa_dashboard/widgets/events_tab.dart';

import 'fakes.dart';
import 'screenshot_support.dart';

final String _outDir = '${Directory.current.path}/screenshots';

void main() {
  setUpAll(loadFonts);

  // One run as the server records it, newest first.
  final run = [
    makeEvent('end', 'run_end', actor: 'a', detail: 'exit 0'),
    makeEvent(
      'start',
      'run_start',
      actor: 'a',
      payload:
          '{"provider": "codex", "model": "gpt-5.6-sol", "responsive": false}',
    ),
  ];
  final diagnostic = makeEvent(
    'diag',
    'run_mcp_diagnostic',
    actor: 'a',
    detail: 'used',
    payload:
        '{"classification":"used","servers":{"mesh":{"initialized":true,"toolsListed":true,"toolCalls":2}},"totalCalls":2}',
  );

  const sizes = [('wide', Size(1180, 300)), ('phone', Size(390, 420))];
  final states = [
    ('before', run),
    ('after', [diagnostic, ...run]),
  ];

  for (final (viewport, size) in sizes) {
    for (final (name, events) in states) {
      testWidgets('events tab $viewport $name', (tester) async {
        await tester.runAsync(() async {
          final api = FakeApi()
            ..threadsResult = [makeThread('a', created: 't0')]
            ..eventPages = [EventPage(events: events, nextCursor: null)];
          final store = DashboardStore(api: api, stream: FakeStream());
          addTearDown(store.dispose);
          await store.init();
          store.toggleActor('a');
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
                child: Scaffold(body: EventsTab(store: store)),
              ),
            ),
          );
          for (var i = 0; i < 5; i++) {
            await Future<void>.delayed(const Duration(milliseconds: 20));
            await tester.pump(const Duration(milliseconds: 50));
          }
          expect(find.text('run_end'), findsOneWidget);
          expect(
            find.text('run_mcp_diagnostic'),
            name == 'after' ? findsOneWidget : findsNothing,
          );
          expect(tester.takeException(), isNull);
          await captureBoundary(
            key,
            '$_outDir/920_events_${viewport}_$name.png',
          );
        });
      });
    }
  }
}
