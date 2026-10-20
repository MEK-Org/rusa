import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rusa_dashboard/store.dart';
import 'package:rusa_dashboard/theme.dart';
import 'package:rusa_dashboard/widgets/actor_tree.dart';
import 'package:rusa_dashboard/widgets/detail_panel.dart';

import 'fakes.dart';
import 'screenshot_support.dart';

final String _outDir = '${Directory.current.path}/screenshots';

const _actorId = '22222222-2222-4222-8222-222222222222';
const _parentId = '00000000-0000-4000-8000-000000000000';

// Synthetic fixture: each statement line ends in a structured citation, as the
// brief grammar requires of an accepted write.
const _brief = '''## WHAT
Create abstract SVG art for the assigned gallery. [mesh:messages/fixture-purpose]

## HOW
Keep each piece to two colours and one accent. [mesh:messages/fixture-palette]

## DOMAIN
The gallery renders at 1:1 pixel density. [mesh:messages/fixture-gallery]''';

const _charter = '''# Gallery Worker Charter
Create abstract SVG art for the assigned gallery and report each finished piece to the coordinator.''';

const _shadowNote =
    'This actor runs in Ledger mode. Its brief is saved and can evolve, '
    'but takes effect only in Brief mode.';

Widget _app(DashboardStore store, Key boundaryKey, {required bool mobile}) =>
    RepaintBoundary(
      key: boundaryKey,
      child: MaterialApp(
        debugShowCheckedModeBanner: false,
        theme: buildMeshTheme(),
        home: Scaffold(
          backgroundColor: MeshColors.bgPrimary,
          body: mobile
              ? SizedBox(
                  width: 390,
                  height: 844,
                  child: DetailPanel(store: store, narrow: true),
                )
              : SizedBox(
                  width: 1180,
                  height: 820,
                  child: Row(
                    children: [
                      ActorTree(store: store),
                      Expanded(child: DetailPanel(store: store)),
                    ],
                  ),
                ),
        ),
      ),
    );

/// Opens Info for one synthetic actor in [mode], with [_brief] saved unless
/// [withBrief] is false, and captures it when [capture] names a file.
Future<FakeApi> _openInfo(
  WidgetTester tester, {
  required String mode,
  required bool mobile,
  bool withBrief = true,
  String? capture,
}) async {
  late FakeApi api;
  await tester.runAsync(() async {
    HttpOverrides.global = FakeImageHttpOverrides(
      await portraits([_parentId, _actorId]),
    );
    addTearDown(() => HttpOverrides.global = null);
    tester.view
      ..physicalSize = mobile ? const Size(390, 844) : const Size(1180, 820)
      ..devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);

    api = FakeApi()
      ..threadsResult = [
        makeThread(_parentId, created: 't0'),
        // A set work state exercises the title-only placement below.
        makeThread(
          _actorId,
          parent: _parentId,
          commitmentKind: 'running',
          created: 't1',
        ),
      ]
      ..charters[_actorId] = _charter
      ..contextModes[_actorId] = mode;
    if (withBrief) {
      api
        ..briefs[_actorId] = _brief
        ..briefGenerations[_actorId] = 2
        ..briefUpdatedAts[_actorId] = '2026-10-20T16:30:00Z';
    }
    final store = DashboardStore(api: api, stream: FakeStream());
    addTearDown(store.dispose);
    await store.init();
    store.clickActor(_actorId);

    final key = GlobalKey();
    await tester.pumpWidget(_app(store, key, mobile: mobile));
    await settleImages(tester, portraitUrls([_parentId, _actorId]));
    await tester.tap(find.text('Info'));
    for (var i = 0; i < 10; i++) {
      await tester.pump(const Duration(milliseconds: 100));
    }
    expect(find.text('Charter'), findsOneWidget);
    expect(tester.takeException(), isNull);
    if (capture != null) {
      await captureBoundary(key, '$_outDir/$capture.png');
    }
  });
  return api;
}

void main() {
  setUpAll(loadFonts);

  for (final mobile in [false, true]) {
    final device = mobile ? 'phone' : 'desktop';
    testWidgets('$device Info shows a ledger brief as a readable shadow', (
      tester,
    ) async {
      final api = await _openInfo(
        tester,
        mode: 'ledger',
        mobile: mobile,
        capture: '1126_shadow_brief_${device}_after',
      );
      expect(find.text('Context mode: Ledger'), findsOneWidget);
      expect(find.text('Brief'), findsOneWidget);
      expect(find.text('Shadow · not active'), findsOneWidget);
      expect(find.text(_shadowNote), findsOneWidget);
      expect(find.text('Active'), findsNothing);
      expect(find.text('Gen 2'), findsOneWidget);
      expect(find.text('WHAT'), findsOneWidget);
      expect(
        find.text(
          'Create abstract SVG art for the assigned gallery. '
          '[mesh:messages/fixture-purpose]',
        ),
        findsOneWidget,
      );
      // Work state stays in the page title; Info does not repeat it.
      expect(find.textContaining('Work state'), findsNothing);
      // Viewing reads one snapshot and nothing else.
      expect(api.charterCalls, [_actorId]);
    });
  }

  testWidgets('Info labels the brief Active in brief mode', (tester) async {
    await _openInfo(
      tester,
      mode: 'brief',
      mobile: false,
      capture: '1126_active_brief_desktop_after',
    );
    expect(find.text('Context mode: Brief'), findsOneWidget);
    expect(find.text('Active'), findsOneWidget);
    expect(find.text('Shadow · not active'), findsNothing);
    expect(find.textContaining('takes effect only'), findsNothing);
    expect(find.text('Gen 2'), findsOneWidget);
  });

  testWidgets('Info keeps a distinct empty brief for a native actor', (
    tester,
  ) async {
    await _openInfo(
      tester,
      mode: 'native',
      mobile: true,
      withBrief: false,
      capture: '1126_empty_brief_phone_after',
    );
    expect(find.text('Context mode: Native'), findsOneWidget);
    expect(find.text('Brief'), findsOneWidget);
    expect(find.text('No brief yet.'), findsOneWidget);
    expect(find.text('Active'), findsNothing);
    expect(find.text('Shadow · not active'), findsNothing);
    expect(find.textContaining('Gen '), findsNothing);
  });

  testWidgets('Info names every context mode the server reports', (
    tester,
  ) async {
    for (final (mode, label) in [
      ('tail', 'Tail'),
      ('ledger', 'Ledger'),
      ('native', 'Native'),
      ('brief', 'Brief'),
    ]) {
      await _openInfo(tester, mode: mode, mobile: false);
      expect(find.text('Context mode: $label'), findsOneWidget);
      await tester.pumpWidget(const SizedBox.shrink());
    }
  });
}
