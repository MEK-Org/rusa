// Rendered review artifacts for #1084's empty-store boot state (#1003). Run with:
//
//   flutter test test/empty_store_1003_screenshot_test.dart
//
// It writes `flutter_dashboard/screenshots/1003_empty_store_<tree|room>_<viewport>_<state>.png`
// for a wide and a 390px phone viewport. `before` is staging behaviour: a fresh
// install whose config still carries the legacy rootActor syntax boots one
// imported configured actor, so the tree shows its tile and the voice room
// lists it as the implicit participant. `after` is this PR: the same fresh
// install boots no actor at all, so the tree renders the existing "No actors"
// empty state and the voice room renders its empty-state text.
//
// It also renders an upgraded install whose room previously showed only the
// configured actor: `before` is staging (that actor is the implicit
// participant), `after` is this PR's first boot (no stored row, so the tab
// waits on an empty roster although the actor is still in the tree), and
// `restored` follows a room-admin holder re-adding it by durable id. The tab
// renders from the roster alone, so those frames are pixel-identical to the
// empty-store room captures above (`restored` matches `before`); the test
// asserts each state without writing duplicate files.

import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rusa_dashboard/models.dart';
import 'package:rusa_dashboard/store.dart';
import 'package:rusa_dashboard/theme.dart';
import 'package:rusa_dashboard/widgets/actor_tree.dart';
import 'package:rusa_dashboard/widgets/chat_room.dart';

import 'fakes.dart';
import 'screenshot_support.dart';

final String _outDir = '${Directory.current.path}/screenshots';
const _importedId = 'f42e93fb-94c7-4c2a-bb16-7161b3a9d346';
const _handle = 'ember-familiar';
const _charter = 'configured charter';

const _viewports = {'wide': Size(1360, 840), 'phone': Size(390, 844)};

void main() {
  setUpAll(loadFonts);

  for (final MapEntry(key: viewport, value: size) in _viewports.entries) {
    for (final phase in ['before', 'after']) {
      testWidgets('empty-store boot $viewport $phase', (tester) async {
        await tester.runAsync(() async {
          final imported = phase == 'before';
          final ids = imported ? [_importedId] : const <String>[];
          HttpOverrides.global = FakeImageHttpOverrides(await portraits(ids));
          addTearDown(() => HttpOverrides.global = null);
          tester.view
            ..physicalSize = size
            ..devicePixelRatio = 1.0;
          addTearDown(tester.view.reset);

          final api = FakeApi()
            ..threadsResult = imported
                ? [
                    ThreadDto(
                      id: _importedId,
                      handle: _handle,
                      parentId: null,
                      status: 'active',
                      provider: 'antigravity',
                      model: 'Gemini 3.7 Flash',
                      charterPreview: _charter,
                      title: _charter,
                      createdAt: '2026-01-01T00:00:00Z',
                      runState: RunState.idle,
                    ),
                  ]
                : []
            ..charters[_importedId] = _charter
            ..chatRoomParticipants = ids;
          final walkie = FakeWalkie(api);
          final store = DashboardStore(
            api: api,
            stream: FakeStream(),
            walkie: walkie.deps,
          );
          await store.refreshThreads();
          addTearDown(store.dispose);

          final treeKey = GlobalKey();
          final wide = viewport == 'wide';
          await tester.pumpWidget(
            MaterialApp(
              debugShowCheckedModeBanner: false,
              theme: buildMeshTheme(),
              home: Scaffold(
                backgroundColor: MeshColors.bgPrimary,
                body: RepaintBoundary(
                  key: treeKey,
                  child: wide
                      ? Row(
                          children: [
                            SizedBox(
                              width: 320,
                              child: ActorTree(store: store),
                            ),
                            const Expanded(
                              child: ColoredBox(color: MeshColors.bgPrimary),
                            ),
                          ],
                        )
                      : ActorTree(store: store, touchTargets: true),
                ),
              ),
            ),
          );
          await settleImages(tester, portraitUrls(ids));
          if (imported) {
            expect(find.text(_handle), findsWidgets);
          } else {
            expect(find.text('No actors'), findsOneWidget);
          }
          expect(tester.takeException(), isNull);
          await captureBoundary(
            treeKey,
            '$_outDir/1003_empty_store_tree_${viewport}_$phase.png',
          );
          await tester.pumpWidget(const SizedBox.shrink());

          final roomKey = GlobalKey();
          await tester.pumpWidget(
            MaterialApp(
              debugShowCheckedModeBanner: false,
              theme: buildMeshTheme(),
              home: Scaffold(
                backgroundColor: MeshColors.bgPrimary,
                body: RepaintBoundary(
                  key: roomKey,
                  child: ChatRoomTab(store: store),
                ),
              ),
            ),
          );
          await tester.pump(const Duration(milliseconds: 250));
          if (imported) {
            expect(find.text(_handle), findsWidgets);
          } else {
            // No participants -> no controller: the tab waits on a roster that
            // only an operator-created actor can ever populate (#1003).
            expect(
              find.text('Waiting for the room participant list…'),
              findsOneWidget,
            );
          }
          expect(tester.takeException(), isNull);
          await captureBoundary(
            roomKey,
            '$_outDir/1003_empty_store_room_${viewport}_$phase.png',
          );
          await tester.pumpWidget(const SizedBox.shrink());
        });
      });
    }

    for (final phase in ['before', 'after', 'restored']) {
      testWidgets('upgraded room $viewport $phase', (tester) async {
        await tester.runAsync(() async {
          final roster = phase == 'after' ? const <String>[] : [_importedId];
          HttpOverrides.global = FakeImageHttpOverrides(
            await portraits([_importedId]),
          );
          addTearDown(() => HttpOverrides.global = null);
          tester.view
            ..physicalSize = size
            ..devicePixelRatio = 1.0;
          addTearDown(tester.view.reset);

          final api = FakeApi()
            ..threadsResult = [
              ThreadDto(
                id: _importedId,
                handle: _handle,
                parentId: null,
                status: 'active',
                provider: 'antigravity',
                model: 'Gemini 3.7 Flash',
                charterPreview: _charter,
                title: _charter,
                createdAt: '2026-01-01T00:00:00Z',
                runState: RunState.idle,
              ),
            ]
            ..charters[_importedId] = _charter
            ..chatRoomParticipants = roster;
          final walkie = FakeWalkie(api);
          final store = DashboardStore(
            api: api,
            stream: FakeStream(),
            walkie: walkie.deps,
          );
          await store.refreshThreads();
          addTearDown(store.dispose);

          final roomKey = GlobalKey();
          await tester.pumpWidget(
            MaterialApp(
              debugShowCheckedModeBanner: false,
              theme: buildMeshTheme(),
              home: Scaffold(
                backgroundColor: MeshColors.bgPrimary,
                body: RepaintBoundary(
                  key: roomKey,
                  child: ChatRoomTab(store: store),
                ),
              ),
            ),
          );
          await tester.pump(const Duration(milliseconds: 250));
          if (roster.isEmpty) {
            // The actor still exists in the tree; only its implicit seat is gone.
            expect(
              find.text('Waiting for the room participant list…'),
              findsOneWidget,
            );
          } else {
            expect(find.text(_handle), findsWidgets);
          }
          expect(tester.takeException(), isNull);
          await tester.pumpWidget(const SizedBox.shrink());
        });
      });
    }
  }
}
