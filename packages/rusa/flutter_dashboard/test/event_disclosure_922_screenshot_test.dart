// Screenshot harness for #922's Events-tab chevrons on synthetic fixtures.
// Run:
//
//   flutter test test/event_disclosure_922_screenshot_test.dart
//
// It writes `screenshots/922_events_<viewport>_<state>.png`. The collapsed
// scene needs no interaction, so the same file run against staging with
// `--dart-define=SHOT_SUFFIX=before` writes the matching `_collapsed_before`
// images, which show today's always-inline second lines.
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
const String _suffix = String.fromEnvironment('SHOT_SUFFIX');

const _actor = 'fixture-actor';
const _parent = 'fixture-parent';

List<MeshEvent> _events() => [
  makeEvent(
    'sent',
    'message_sent',
    actor: _actor,
    detail: '00000000-0000-4000-8000-000000000001',
    body: 'Fixed the parser; focused tests pass. PR is open for review.',
    payload: '{"to": "$_parent"}',
  ),
  makeEvent('end-yield', 'run_end', actor: _actor, detail: 'exit 0'),
  makeEvent(
    'yield',
    'run_yielded',
    actor: _actor,
    detail: 'complete',
    body: 'Parser fix pushed with a regression test.',
  ),
  makeEvent(
    'start',
    'run_start',
    actor: _actor,
    payload: '{"runId":"fixture-run","provider":"claude","model":"m"}',
  ),
  makeEvent(
    'received',
    'message_received',
    actor: _actor,
    detail: '00000000-0000-4000-8000-000000000002',
    body: 'Please repair the fixture parser and report back.',
    payload: '{"from": "$_parent"}',
  ),
  makeEvent('queued', 'run_queued', actor: _actor, detail: 'message from root'),
  makeEvent('spawned', 'actor_spawned', actor: _actor, peer: _parent),
];

void main() {
  setUpAll(loadFonts);

  const sizes = [('wide', Size(1180, 820)), ('phone', Size(390, 844))];
  final states = _suffix == 'before'
      ? ['collapsed']
      : ['collapsed', 'expanded'];

  for (final (viewport, size) in sizes) {
    for (final state in states) {
      testWidgets('#922 events $viewport $state', (tester) async {
        await tester.runAsync(() async {
          final api = FakeApi()
            ..threadsResult = [makeThread(_actor), makeThread(_parent)]
            ..eventPages = [EventPage(events: _events(), nextCursor: null)];
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
          if (state == 'expanded') {
            for (final label in ['message', 'yield', 'details']) {
              for (final chevron in find.byTooltip('Show $label').evaluate()) {
                await tester.tap(find.byWidget(chevron.widget));
              }
            }
            for (var i = 0; i < 5; i++) {
              await tester.pump(const Duration(milliseconds: 50));
            }
            expect(
              find.text('Please repair the fixture parser and report back.'),
              findsOneWidget,
            );
            expect(find.text('message from root'), findsOneWidget);
            expect(
              find.text('Parser fix pushed with a regression test.'),
              findsOneWidget,
            );
          }
          expect(tester.takeException(), isNull);
          final name = _suffix.isEmpty ? state : '${state}_$_suffix';
          await captureBoundary(
            key,
            '$_outDir/922_events_${viewport}_$name.png',
          );
        });
      });
    }
  }
}
