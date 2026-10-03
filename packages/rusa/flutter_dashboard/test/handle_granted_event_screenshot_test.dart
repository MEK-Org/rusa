// #868 appearance evidence (evidence branch only, not part of the PR).
//
// Renders the real dashboard Events tab for the event pages captured from the
// server at #868's base (19209da5) and head (842b3d3c): the same
// `grantHandle(holder, { id, role })` call, served by `listEventsByActors`.
// Only `handle_granted.detail` differs between the two fixtures. Thread
// handles are synthetic dashboard data; event JSON is verbatim server output.
//
//   flutter test test/handle_granted_event_screenshot_test.dart
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rusa_dashboard/models.dart';
import 'package:rusa_dashboard/store.dart';
import 'package:rusa_dashboard/theme.dart';
import 'package:rusa_dashboard/widgets/dashboard_body.dart';
import 'package:rusa_dashboard/widgets/events_tab.dart';

import 'fakes.dart';
import 'screenshot_support.dart';

final String _outDir = '${Directory.current.path}/screenshots';
const _handles = {
  'root': 'steady-owl',
  'aaaaaaaa-1111-4111-8111-111111111111': 'patient-heron',
  'bbbbbbbb-2222-4222-8222-222222222222': 'quiet-lynx',
};

Map<String, dynamic> _fixture(String name) =>
    jsonDecode(
          File(
            'test/fixtures/868/handle_granted_$name.json',
          ).readAsStringSync(),
        )
        as Map<String, dynamic>;

List<ThreadDto> _threads(Map<String, dynamic> fx) => [
  ThreadDto(
    id: 'root',
    handle: _handles['root']!,
    parentId: null,
    status: 'active',
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    title: 'the root actor',
    charterPreview: 'the root actor',
    createdAt: '2026-10-03T13:59:00Z',
    runState: RunState.idle,
  ),
  for (final a in (fx['actors'] as List).cast<Map<String, dynamic>>())
    ThreadDto(
      id: a['id'] as String,
      handle: _handles[a['id']]!,
      parentId: a['parentId'] as String?,
      status: 'active',
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      title: a['title'] as String,
      charterPreview: a['charter'] as String,
      createdAt: '2026-10-03T14:00:00Z',
      runState: RunState.idle,
    ),
];

Widget _app(DashboardStore store, Key key) => MaterialApp(
  debugShowCheckedModeBanner: false,
  theme: buildMeshTheme(),
  home: Scaffold(
    backgroundColor: MeshColors.bgPrimary,
    body: RepaintBoundary(
      key: key,
      child: DashboardBody(store: store),
    ),
  ),
);

void main() {
  setUpAll(() async {
    await loadFonts();
    HttpOverrides.global = FakeImageHttpOverrides(
      await portraits(_handles.keys.toList()),
    );
  });

  tearDownAll(() => HttpOverrides.global = null);

  for (final state in ['before', 'after']) {
    for (final (size, label) in [
      (const Size(1360, 640), 'wide'),
      (const Size(390, 844), 'narrow'),
    ]) {
      testWidgets('renders the handle_granted Events row $state, $label', (
        tester,
      ) async {
        await tester.runAsync(() async {
          final fx = _fixture(state);
          final holder = (fx['actors'] as List).first['id'] as String;
          final api = FakeApi()
            ..threadsResult = _threads(fx)
            ..eventPages = [
              EventPage.fromJson(fx['page'] as Map<String, dynamic>),
            ];
          final store = DashboardStore(api: api, stream: FakeStream());
          await store.init();
          addTearDown(store.dispose);

          await tester.binding.setSurfaceSize(size);
          addTearDown(() => tester.binding.setSurfaceSize(null));

          final key = GlobalKey();
          await tester.pumpWidget(_app(store, key));
          if (label == 'wide') {
            await tester.tap(find.text('Actors'));
          } else {
            await tester.tap(find.byIcon(Icons.menu));
            await tester.pump();
            await tester.pump(const Duration(milliseconds: 400));
            await tester.tap(find.byKey(const ValueKey('drawer-nav-actors')));
          }
          await tester.pump();
          await tester.pump(const Duration(milliseconds: 400));
          store.clickActor(holder);
          for (var i = 0; i < 6; i++) {
            await tester.pump(const Duration(milliseconds: 50));
          }

          await tester.ensureVisible(find.text('Events Log'));
          await tester.tap(find.text('Events Log'));
          for (var i = 0; i < 10; i++) {
            await tester.pump(const Duration(milliseconds: 50));
          }

          await settleImages(tester, portraitUrls(_handles.keys.toList()));
          await tester.pump(const Duration(milliseconds: 500));
          expect(find.byType(EventsTab), findsOneWidget);
          expect(find.text('handle_granted'), findsWidgets);
          expect(find.text('→ quiet-lynx'), findsOneWidget);
          expect(
            find.text('reviewer for your patch'),
            state == 'before' ? findsOneWidget : findsNothing,
          );
          await captureBoundary(
            key,
            '$_outDir/868_handle_granted_${state}_$label.png',
          );
          expect(tester.takeException(), isNull);
        });
      });
    }
  }
}
