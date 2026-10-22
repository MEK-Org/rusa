// Screenshot harness for #1119's Events-tab rows on synthetic fixtures: a
// remote, receipt-backed run whose provider end the host could not observe
// (here, the stall watchdog). Run:
//
//   flutter test test/remote_unresolved_1119_screenshot_test.dart
//
// It writes `screenshots/1119_events_<viewport>_<before|after>[_expanded].png`,
// the expanded scene with each row's detail disclosed. Both
// scenes render the rows `packages/rusa/src/commands/start.ts` records in its
// lifecycle `onEnd`: before #1119 that run ended with a result, recorded as
// `run_end` (`detail: exit <code>`, `body: output`); with #1119 it releases
// its claim, recorded as `run_abandoned` (`detail: reason`, `body: cause`).
// Nothing in the dashboard changes; only the recorded row does.
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

const _actor = 'fixture-actor';
const _parent = 'fixture-parent';
const _output = 'fixture provider output before the watchdog fired';

MeshEvent _end(String scene) => scene == 'before'
    ? MeshEvent(
        id: 'end',
        ts: '2026-01-01T00:00:00Z',
        kind: 'run_end',
        actorId: _actor,
        detail: 'exit 143',
        body: _output,
        payload: '{"runId":"fixture-run","success":false,"exitCode":143}',
        success: false,
      )
    : makeEvent(
        'end',
        'run_abandoned',
        actor: _actor,
        detail: 'termination-unresolved',
        body: 'stall-watchdog: $_output',
        payload: '{"started":true,"termination":"unresolved"}',
      );

List<MeshEvent> _events(String scene) => [
  _end(scene),
  makeEvent(
    'start',
    'run_start',
    actor: _actor,
    detail: 'ctx 2048B/2r/a1b2c3d4e5f6',
    payload: '{"runId":"fixture-run","provider":"codex","model":"m"}',
  ),
  makeEvent('queued', 'run_queued', actor: _actor, detail: 'message from root'),
  makeEvent('spawned', 'actor_spawned', actor: _actor, peer: _parent),
];

void main() {
  setUpAll(loadFonts);

  const sizes = [('wide', Size(1180, 820)), ('phone', Size(390, 844))];
  for (final (viewport, size) in sizes) {
    for (final scene in ['before', 'after']) {
      for (final expanded in [false, true]) {
        testWidgets(
          '#1119 events $viewport $scene${expanded ? ' expanded' : ''}',
          (tester) async {
            await tester.runAsync(() async {
              final api = FakeApi()
                ..threadsResult = [makeThread(_actor), makeThread(_parent)]
                ..eventPages = [
                  EventPage(events: _events(scene), nextCursor: null),
                ];
              final store = DashboardStore(api: api, stream: FakeStream());
              addTearDown(store.dispose);
              await store.refreshThreads();
              store.clickActor(_actor);
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
                await tester.pump(const Duration(milliseconds: 50));
              }
              expect(
                find.text(scene == 'before' ? 'run_end' : 'run_abandoned'),
                findsWidgets,
              );
              if (expanded) {
                for (final label in ['message', 'details', 'run details']) {
                  for (final chevron
                      in find.byTooltip('Show $label').evaluate()) {
                    await tester.tap(find.byWidget(chevron.widget));
                  }
                }
                for (var i = 0; i < 5; i++) {
                  await tester.pump(const Duration(milliseconds: 50));
                }
                expect(
                  find.text(
                    scene == 'before' ? 'exit 143' : 'termination-unresolved',
                  ),
                  findsOneWidget,
                );
              }
              expect(tester.takeException(), isNull);
              await captureBoundary(
                key,
                '$_outDir/1119_events_${viewport}_$scene${expanded ? '_expanded' : ''}.png',
              );
            });
          },
        );
      }
    }
  }
}
