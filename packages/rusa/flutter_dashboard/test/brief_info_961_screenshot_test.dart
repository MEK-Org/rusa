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

const _briefContent = '''## WHAT
- Maintain portable brief continuity across actor lifecycle boundaries.
- Render active brief sections in dashboard actor Info tab with markdown formatting.
- Preserve supersession accounting and source citations without DDL migrations.

## HOW
- Execute bounded single-delta rewrites using `gemini-3.8-flash`.
- Format WHAT/HOW/DOMAIN sections inside styled panels.
- Retain audit records for human and ancestor direction.

## DOMAIN
- Actor portable context protocol (mode: `brief`).
- Dashboard inspection panels and responsive mobile layouts.''';

const _charterContent = '''# Standing Coder Charter
You are an autonomous mesh worker actor responsible for portable context maintenance, regression verification, and dashboard appearance compliance.''';

final _revisions = [
  const BriefRevision(
    generation: 1,
    updatedAt: '2026-10-10T13:00:00Z',
    explanation: 'Initial brief seed from parent charter and intent',
    text: '''## WHAT
- Seed portable brief for autonomous worker.

## HOW
- Execute commands and report milestones to parent steward.

## DOMAIN
- Standalone actor context.''',
  ),
  const BriefRevision(
    generation: 2,
    updatedAt: '2026-10-10T13:30:00Z',
    explanation: 'Consolidated domain guidelines and added Option B revision history inspectability',
    text: _briefContent,
  ),
];

Widget _desktopApp(DashboardStore store, Key boundaryKey) => RepaintBoundary(
  key: boundaryKey,
  child: MaterialApp(
    debugShowCheckedModeBanner: false,
    theme: buildMeshTheme(),
    home: Scaffold(
      backgroundColor: MeshColors.bgPrimary,
      body: SizedBox(
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

Widget _mobileApp(DashboardStore store, Key boundaryKey) => RepaintBoundary(
  key: boundaryKey,
  child: MaterialApp(
    debugShowCheckedModeBanner: false,
    theme: buildMeshTheme(),
    home: Scaffold(
      backgroundColor: MeshColors.bgPrimary,
      body: SizedBox(
        width: 390,
        height: 844,
        child: DetailPanel(store: store, narrow: true),
      ),
    ),
  ),
);

void main() {
  setUpAll(loadFonts);

  testWidgets('961 brief info desktop before', (tester) async {
    await tester.runAsync(() async {
      HttpOverrides.global = FakeImageHttpOverrides(await portraits([_parentId, _actorId]));
      addTearDown(() => HttpOverrides.global = null);

      final key = GlobalKey();
      tester.view
        ..physicalSize = const Size(1180, 820)
        ..devicePixelRatio = 1.0;
      addTearDown(tester.view.reset);

      final api = FakeApi()
        ..threadsResult = [
          makeThread(_parentId, created: 't0'),
          makeThread(
            _actorId,
            parent: _parentId,
            provider: 'agy',
            model: 'gemini-3.8-flash',
            commitmentKind: 'running',
            created: 't1',
          ),
        ]
        ..charters[_actorId] = _charterContent;

      final store = DashboardStore(api: api, stream: FakeStream());
      addTearDown(store.dispose);
      await store.init();
      store.clickActor(_actorId);

      await tester.pumpWidget(_desktopApp(store, key));
      await settleImages(tester, portraitUrls([_parentId, _actorId]));
      await tester.tap(find.text('Info'));
      for (var i = 0; i < 10; i++) {
        await tester.pump(const Duration(milliseconds: 100));
      }

      expect(find.text('Charter'), findsOneWidget);
      expect(find.text('Brief'), findsNothing);

      await captureBoundary(key, '$_outDir/961_brief_info_desktop_before.png');
    });
  });

  testWidgets('961 brief info desktop after', (tester) async {
    await tester.runAsync(() async {
      HttpOverrides.global = FakeImageHttpOverrides(await portraits([_parentId, _actorId]));
      addTearDown(() => HttpOverrides.global = null);

      final key = GlobalKey();
      tester.view
        ..physicalSize = const Size(1180, 820)
        ..devicePixelRatio = 1.0;
      addTearDown(tester.view.reset);

      final api = FakeApi()
        ..threadsResult = [
          makeThread(_parentId, created: 't0'),
          makeThread(
            _actorId,
            parent: _parentId,
            provider: 'agy',
            model: 'gemini-3.8-flash',
            commitmentKind: 'running',
            created: 't1',
          ),
        ]
        ..charters[_actorId] = _charterContent
        ..briefs[_actorId] = _briefContent
        ..briefGenerations[_actorId] = 2
        ..briefUpdatedAts[_actorId] = '2026-10-10T13:30:00Z'
        ..briefRevisions[_actorId] = _revisions;

      final store = DashboardStore(api: api, stream: FakeStream());
      addTearDown(store.dispose);
      await store.init();
      store.clickActor(_actorId);

      await tester.pumpWidget(_desktopApp(store, key));
      await settleImages(tester, portraitUrls([_parentId, _actorId]));
      await tester.tap(find.text('Info'));
      for (var i = 0; i < 10; i++) {
        await tester.pump(const Duration(milliseconds: 100));
      }

      expect(find.text('Charter'), findsOneWidget);
      expect(find.text('Brief'), findsOneWidget);
      expect(find.text('Gen 2'), findsOneWidget);
      expect(find.byKey(const ValueKey('brief-history-button')), findsOneWidget);

      await captureBoundary(key, '$_outDir/961_brief_info_desktop_after.png');
    });
  });

  testWidgets('961 brief info desktop history', (tester) async {
    await tester.runAsync(() async {
      HttpOverrides.global = FakeImageHttpOverrides(await portraits([_parentId, _actorId]));
      addTearDown(() => HttpOverrides.global = null);

      final key = GlobalKey();
      tester.view
        ..physicalSize = const Size(1180, 820)
        ..devicePixelRatio = 1.0;
      addTearDown(tester.view.reset);

      final api = FakeApi()
        ..threadsResult = [
          makeThread(_parentId, created: 't0'),
          makeThread(
            _actorId,
            parent: _parentId,
            provider: 'agy',
            model: 'gemini-3.8-flash',
            commitmentKind: 'running',
            created: 't1',
          ),
        ]
        ..charters[_actorId] = _charterContent
        ..briefs[_actorId] = _briefContent
        ..briefGenerations[_actorId] = 2
        ..briefUpdatedAts[_actorId] = '2026-10-10T13:30:00Z'
        ..briefRevisions[_actorId] = _revisions;

      final store = DashboardStore(api: api, stream: FakeStream());
      addTearDown(store.dispose);
      await store.init();
      store.clickActor(_actorId);

      await tester.pumpWidget(_desktopApp(store, key));
      await settleImages(tester, portraitUrls([_parentId, _actorId]));
      await tester.tap(find.text('Info'));
      for (var i = 0; i < 10; i++) {
        await tester.pump(const Duration(milliseconds: 100));
      }

      await tester.tap(find.byKey(const ValueKey('brief-history-button')));
      for (var i = 0; i < 8; i++) {
        await tester.pump(const Duration(milliseconds: 100));
      }

      expect(find.text('Brief Revision History — $_actorId-handle'), findsOneWidget);
      expect(find.text('2 revisions'), findsOneWidget);
      expect(find.text('Current'), findsOneWidget);

      await captureBoundary(key, '$_outDir/961_brief_info_desktop_history.png');
    });
  });

  testWidgets('961 brief info mobile before', (tester) async {
    await tester.runAsync(() async {
      HttpOverrides.global = FakeImageHttpOverrides(await portraits([_parentId, _actorId]));
      addTearDown(() => HttpOverrides.global = null);

      final key = GlobalKey();
      tester.view
        ..physicalSize = const Size(390, 844)
        ..devicePixelRatio = 1.0;
      addTearDown(tester.view.reset);

      final api = FakeApi()
        ..threadsResult = [
          makeThread(_parentId, created: 't0'),
          makeThread(
            _actorId,
            parent: _parentId,
            provider: 'agy',
            model: 'gemini-3.8-flash',
            commitmentKind: 'running',
            created: 't1',
          ),
        ]
        ..charters[_actorId] = _charterContent;

      final store = DashboardStore(api: api, stream: FakeStream());
      addTearDown(store.dispose);
      await store.init();
      store.clickActor(_actorId);

      await tester.pumpWidget(_mobileApp(store, key));
      await settleImages(tester, portraitUrls([_parentId, _actorId]));
      await tester.tap(find.text('Info'));
      for (var i = 0; i < 10; i++) {
        await tester.pump(const Duration(milliseconds: 100));
      }

      expect(find.text('Charter'), findsOneWidget);
      expect(find.text('Brief'), findsNothing);

      await captureBoundary(key, '$_outDir/961_brief_info_mobile_before.png');
    });
  });

  testWidgets('961 brief info mobile after', (tester) async {
    await tester.runAsync(() async {
      HttpOverrides.global = FakeImageHttpOverrides(await portraits([_parentId, _actorId]));
      addTearDown(() => HttpOverrides.global = null);

      final key = GlobalKey();
      tester.view
        ..physicalSize = const Size(390, 844)
        ..devicePixelRatio = 1.0;
      addTearDown(tester.view.reset);

      final api = FakeApi()
        ..threadsResult = [
          makeThread(_parentId, created: 't0'),
          makeThread(
            _actorId,
            parent: _parentId,
            provider: 'agy',
            model: 'gemini-3.8-flash',
            commitmentKind: 'running',
            created: 't1',
          ),
        ]
        ..charters[_actorId] = _charterContent
        ..briefs[_actorId] = _briefContent
        ..briefGenerations[_actorId] = 2
        ..briefUpdatedAts[_actorId] = '2026-10-10T13:30:00Z'
        ..briefRevisions[_actorId] = _revisions;

      final store = DashboardStore(api: api, stream: FakeStream());
      addTearDown(store.dispose);
      await store.init();
      store.clickActor(_actorId);

      await tester.pumpWidget(_mobileApp(store, key));
      await settleImages(tester, portraitUrls([_parentId, _actorId]));
      await tester.tap(find.text('Info'));
      for (var i = 0; i < 10; i++) {
        await tester.pump(const Duration(milliseconds: 100));
      }

      expect(find.text('Charter'), findsOneWidget);
      expect(find.text('Brief'), findsOneWidget);
      expect(find.text('Gen 2'), findsOneWidget);

      await captureBoundary(key, '$_outDir/961_brief_info_mobile_after.png');
    });
  });

  testWidgets('961 brief info mobile history', (tester) async {
    await tester.runAsync(() async {
      HttpOverrides.global = FakeImageHttpOverrides(await portraits([_parentId, _actorId]));
      addTearDown(() => HttpOverrides.global = null);

      final key = GlobalKey();
      tester.view
        ..physicalSize = const Size(390, 844)
        ..devicePixelRatio = 1.0;
      addTearDown(tester.view.reset);

      final api = FakeApi()
        ..threadsResult = [
          makeThread(_parentId, created: 't0'),
          makeThread(
            _actorId,
            parent: _parentId,
            provider: 'agy',
            model: 'gemini-3.8-flash',
            commitmentKind: 'running',
            created: 't1',
          ),
        ]
        ..charters[_actorId] = _charterContent
        ..briefs[_actorId] = _briefContent
        ..briefGenerations[_actorId] = 2
        ..briefUpdatedAts[_actorId] = '2026-10-10T13:30:00Z'
        ..briefRevisions[_actorId] = _revisions;

      final store = DashboardStore(api: api, stream: FakeStream());
      addTearDown(store.dispose);
      await store.init();
      store.clickActor(_actorId);

      await tester.pumpWidget(_mobileApp(store, key));
      await settleImages(tester, portraitUrls([_parentId, _actorId]));
      await tester.tap(find.text('Info'));
      for (var i = 0; i < 10; i++) {
        await tester.pump(const Duration(milliseconds: 100));
      }

      await tester.tap(find.byKey(const ValueKey('brief-history-button')));
      for (var i = 0; i < 8; i++) {
        await tester.pump(const Duration(milliseconds: 100));
      }

      expect(find.text('Brief Revision History — $_actorId-handle'), findsOneWidget);
      expect(find.text('2 revisions'), findsOneWidget);

      await captureBoundary(key, '$_outDir/961_brief_info_mobile_history.png');
    });
  });
}
