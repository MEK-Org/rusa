import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rusa_dashboard/api.dart';
import 'package:rusa_dashboard/store.dart';
import 'package:rusa_dashboard/theme.dart';
import 'package:rusa_dashboard/widgets/actor_tree.dart';
import 'package:rusa_dashboard/widgets/detail_panel.dart';

import 'fakes.dart';
import 'screenshot_support.dart';

final String _outDir = '${Directory.current.path}/screenshots';

const _actorId = '11111111-1111-4111-8111-111111111111';
const _parentId = '00000000-0000-4000-8000-000000000000';

// Synthetic fixtures: each statement line ends in a structured citation, as the
// brief grammar requires of an accepted write.
const _seed = '''## WHAT

## HOW

## DOMAIN''';

const _gen1 = '''## WHAT
Draw abstract SVG art for the assigned gallery. [mesh:messages/m-purpose]

## HOW
Keep each piece to three colours. [mesh:messages/m-palette]
Report each finished piece to the parent. [mesh:messages/m-report]

## DOMAIN
The gallery renders at 1:1 pixel density. [github:MEK-Org/rusa/issues/954]''';

const _gen2 = '''## WHAT
Draw abstract SVG art for the assigned gallery. [mesh:messages/m-purpose]

## HOW
Keep each piece to two colours and one accent. [mesh:messages/m-palette-2]
Report each finished piece to the parent. [mesh:messages/m-report]

## DOMAIN
The gallery renders at 1:1 pixel density. [github:MEK-Org/rusa/issues/954]
Pieces over 200 KB are rejected by the gallery. [mesh:messages/m-size]''';

const _charterContent = '''# Gallery Worker Charter
You draw abstract SVG art for the assigned gallery and report each finished piece to your parent.''';

// Newest first, as the API pages them.
final _revisions = [
  const BriefRevision(
    generation: 2,
    updatedAt: '2026-10-10T13:30:00Z',
    actingPrincipal: _actorId,
    before: _gen1,
    after: _gen2,
    explanation:
        'The parent narrowed the palette, and the gallery size limit is now known.',
  ),
  const BriefRevision(
    generation: 1,
    updatedAt: '2026-10-10T13:00:00Z',
    actingPrincipal: _actorId,
    before: _seed,
    after: _gen1,
  ),
];

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

enum _Step { before, after, history, detail }

Future<void> _capture(
  WidgetTester tester, {
  required bool mobile,
  required _Step step,
}) async {
  await tester.runAsync(() async {
    HttpOverrides.global = FakeImageHttpOverrides(
      await portraits([_parentId, _actorId]),
    );
    addTearDown(() => HttpOverrides.global = null);

    final key = GlobalKey();
    tester.view
      ..physicalSize = mobile ? const Size(390, 844) : const Size(1180, 820)
      ..devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);

    final api = FakeApi()
      ..threadsResult = [
        makeThread(_parentId, created: 't0'),
        makeThread(
          _actorId,
          parent: _parentId,
          commitmentKind: 'running',
          created: 't1',
        ),
      ]
      ..charters[_actorId] = _charterContent;
    if (step != _Step.before) {
      api
        ..briefs[_actorId] = _gen2
        ..briefGenerations[_actorId] = 2
        ..briefUpdatedAts[_actorId] = '2026-10-10T13:30:00Z'
        ..briefRevisions[_actorId] = _revisions;
    }

    final store = DashboardStore(api: api, stream: FakeStream());
    addTearDown(store.dispose);
    await store.init();
    store.clickActor(_actorId);

    await tester.pumpWidget(_app(store, key, mobile: mobile));
    await settleImages(tester, portraitUrls([_parentId, _actorId]));
    await tester.tap(find.text('Info'));
    for (var i = 0; i < 10; i++) {
      await tester.pump(const Duration(milliseconds: 100));
    }
    expect(find.text('Charter'), findsOneWidget);

    switch (step) {
      case _Step.before:
        expect(find.text('Brief'), findsNothing);
      case _Step.after:
        expect(find.text('Brief'), findsOneWidget);
        expect(find.text('Gen 2'), findsOneWidget);
        expect(
          find.byKey(const ValueKey('brief-history-time')),
          findsOneWidget,
        );
      case _Step.history || _Step.detail:
        await tester.tap(find.byKey(const ValueKey('brief-history-time')));
        for (var i = 0; i < 8; i++) {
          await tester.pump(const Duration(milliseconds: 100));
        }
        expect(find.text('Brief history — $_actorId-handle'), findsOneWidget);
        expect(find.text('Latest 2 changes'), findsOneWidget);
        expect(find.text('No explanation given.'), findsOneWidget);
        if (step == _Step.detail) {
          await tester.tap(find.byKey(const ValueKey('brief-revision-2')));
          for (var i = 0; i < 4; i++) {
            await tester.pump(const Duration(milliseconds: 100));
          }
          expect(find.text('Generation 2 change'), findsOneWidget);
          expect(
            find.text(
              '− Keep each piece to three colours. [mesh:messages/m-palette]',
            ),
            findsOneWidget,
          );
          expect(
            find.text(
              '+ Keep each piece to two colours and one accent. [mesh:messages/m-palette-2]',
            ),
            findsOneWidget,
          );
        }
    }

    final device = mobile ? 'mobile' : 'desktop';
    await captureBoundary(
      key,
      '$_outDir/961_brief_info_${device}_${step.name}.png',
    );
  });
}

void main() {
  setUpAll(loadFonts);

  testWidgets(
    'Info distinguishes an empty seeded brief and caches it across mesh rebuilds',
    (tester) async {
      await tester.runAsync(() async {
        tester.view
          ..physicalSize = const Size(390, 844)
          ..devicePixelRatio = 1.0;
        addTearDown(tester.view.reset);
        final api = FakeApi()
          ..threadsResult = [makeThread(_actorId)]
          ..briefs[_actorId] = _seed
          ..briefGenerations[_actorId] = 0
          ..briefUpdatedAts[_actorId] = '2026-10-10T12:00:00Z';
        final store = DashboardStore(api: api, stream: FakeStream());
        await store.init();
        store.clickActor(_actorId);
        final boundaryKey = GlobalKey();
        await tester.pumpWidget(_app(store, boundaryKey, mobile: true));
        await tester.pumpAndSettle();
        await tester.tap(find.text('Info'));
        await tester.pumpAndSettle();
        expect(find.text('Gen 0'), findsOneWidget);
        expect(find.text('No brief yet.'), findsNothing);
        expect(
          find.byKey(const ValueKey('brief-history-button')),
          findsNothing,
        );
        await captureBoundary(
          boundaryKey,
          '$_outDir/961_brief_info_mobile_seed.png',
        );
        final calls = api.charterCalls.length;
        await store.refreshThreads();
        await tester.pumpAndSettle();
        expect(api.charterCalls, hasLength(calls));

        // Reopening reads fresh data; null is the distinct, unseeded state.
        await tester.tap(find.text('Live Output'));
        await tester.pumpAndSettle();
        api.briefs[_actorId] = null;
        api.briefGenerations[_actorId] = null;
        api.briefUpdatedAts[_actorId] = null;
        await tester.tap(find.text('Info'));
        await tester.pumpAndSettle();
        expect(find.text('No brief yet.'), findsOneWidget);
        expect(find.text('Gen 0'), findsNothing);
        expect(api.charterCalls, hasLength(calls + 1));
        await captureBoundary(
          boundaryKey,
          '$_outDir/961_brief_info_mobile_unseeded.png',
        );
        await tester.pumpWidget(const SizedBox.shrink());
        await store.dispose();
      });
    },
  );

  for (final mobile in [false, true]) {
    for (final step in _Step.values) {
      testWidgets(
        '961 brief info ${mobile ? 'mobile' : 'desktop'} ${step.name}',
        (tester) => _capture(tester, mobile: mobile, step: step),
      );
    }
  }
}
