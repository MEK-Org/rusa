// Rendered review artifact for #663's V1 Chat Room. Run with:
//
//   flutter test test/chat_room_screenshot_test.dart
//
// It writes `flutter_dashboard/screenshots/chat_room_three_actors.png` for the
// PR's visual review: a 2×2 three-actor grid with one active speaking ring and
// one queued voice reply.

import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rusa_dashboard/store.dart';
import 'package:rusa_dashboard/theme.dart';
import 'package:rusa_dashboard/widgets/chat_room.dart';
import 'package:rusa_dashboard/widgets/header.dart';

import 'fakes.dart';
import 'screenshot_support.dart';

final String _outDir = '${Directory.current.path}/screenshots';
const _actorIds = ['root', 'actor-b', 'actor-c'];

void main() {
  setUpAll(loadFonts);

  testWidgets('renders the three-actor Chat Room queue', (tester) async {
    await tester.runAsync(() async {
      HttpOverrides.global = FakeImageHttpOverrides(await portraits(_actorIds));
      addTearDown(() => HttpOverrides.global = null);
      addTearDown(() => tester.binding.setSurfaceSize(null));

      final api = FakeApi()
        ..threadsResult = [
          makeThread('root', voiceName: 'Puck'),
          makeThread('actor-b', voiceName: 'Kore'),
          makeThread('actor-c', voiceName: 'Fenrir'),
        ];
      final walkie = FakeWalkie(api);
      final store = DashboardStore(
        api: api,
        stream: FakeStream(),
        walkie: walkie.deps,
      );
      api.chatRoomParticipants = _actorIds;
      await store.refreshThreads();
      addTearDown(store.dispose);

      final key = GlobalKey();
      await tester.binding.setSurfaceSize(const Size(1180, 820));
      await tester.pumpWidget(
        MaterialApp(
          debugShowCheckedModeBanner: false,
          theme: buildMeshTheme(),
          home: Scaffold(
            backgroundColor: MeshColors.bgPrimary,
            body: RepaintBoundary(
              key: key,
              child: ChatRoomTab(store: store),
            ),
          ),
        ),
      );
      await settleImages(tester, portraitUrls(_actorIds));

      // The first avatar tap enters room presence and starts a capture. Cancel
      // it so the screenshot can prove reply A is speaking while reply B is
      // held in the one shared FIFO queue.
      await tester.tap(find.byKey(const ValueKey('chat-room-avatar-root')));
      await tester.pump();
      await tester.pump();
      await tester.tap(find.byKey(const ValueKey('chat-room-cancel')));
      await tester.pump();
      await tester.pump();
      walkie.stream.framesCtrl.add(makeAnnouncement('reply-a', actor: 'root'));
      walkie.stream.framesCtrl.add(
        makeAnnouncement('reply-b', actor: 'actor-b'),
      );
      await tester.pump();
      await tester.pump();
      // Let the tile's 180ms ring animation finish so the capture shows the
      // speaking ring rather than a mid-transition blend.
      await tester.pump(const Duration(milliseconds: 250));

      expect(find.text('Speaking'), findsOneWidget);
      expect(find.text('1 queued'), findsOneWidget);
      expect(find.byKey(const ValueKey('chat-room-avatar-root')), findsOneWidget);
      expect(
        find.byKey(const ValueKey('chat-room-avatar-actor-b')),
        findsOneWidget,
      );
      expect(
        find.byKey(const ValueKey('chat-room-avatar-actor-c')),
        findsOneWidget,
      );
      await captureBoundary(key, '$_outDir/chat_room_three_actors.png');
      expect(tester.takeException(), isNull);
    });
  });

  testWidgets('renders the Chat Room recording state', (tester) async {
    await tester.runAsync(() async {
      HttpOverrides.global = FakeImageHttpOverrides(await portraits(_actorIds));
      addTearDown(() => HttpOverrides.global = null);
      addTearDown(() => tester.binding.setSurfaceSize(null));

      final api = FakeApi()
        ..threadsResult = [
          makeThread('root', voiceName: 'Puck'),
          makeThread('actor-b', voiceName: 'Kore'),
          makeThread('actor-c', voiceName: 'Fenrir'),
        ];
      final walkie = FakeWalkie(api);
      final store = DashboardStore(
        api: api,
        stream: FakeStream(),
        walkie: walkie.deps,
      );
      api.chatRoomParticipants = _actorIds;
      await store.refreshThreads();
      addTearDown(store.dispose);

      final key = GlobalKey();
      await tester.binding.setSurfaceSize(const Size(1180, 820));
      await tester.pumpWidget(
        MaterialApp(
          debugShowCheckedModeBanner: false,
          theme: buildMeshTheme(),
          home: Scaffold(
            backgroundColor: MeshColors.bgPrimary,
            body: RepaintBoundary(
              key: key,
              child: ChatRoomTab(store: store),
            ),
          ),
        ),
      );
      await settleImages(tester, portraitUrls(_actorIds));

      // Tap root avatar to start recording.
      await tester.tap(find.byKey(const ValueKey('chat-room-avatar-root')));
      await tester.pump();
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 250));

      expect(find.text('Tap to send'), findsOneWidget);
      expect(find.byKey(const ValueKey('chat-room-cancel')), findsOneWidget);
      expect(find.text('Cancel recording'), findsOneWidget);
      await captureBoundary(key, '$_outDir/chat_room_recording.png');
      expect(tester.takeException(), isNull);
    });
  });

  testWidgets('renders desktop header at narrow breakpoint before and after', (
    tester,
  ) async {
    await tester.runAsync(() async {
      addTearDown(() => tester.binding.setSurfaceSize(null));

      final api = FakeApi()
        ..threadsResult = [makeThread('root', created: 't0')];
      final store = DashboardStore(api: api, stream: FakeStream());
      await store.init();
      addTearDown(store.dispose);

      final beforeDestinations = kDashboardDestinations
          .where((d) => d.view != DashboardView.chatRoom)
          .toList();

      final keyBefore = GlobalKey();
      await tester.binding.setSurfaceSize(const Size(700, 140));
      await tester.pumpWidget(
        MaterialApp(
          debugShowCheckedModeBanner: false,
          theme: buildMeshTheme().copyWith(
            visualDensity: VisualDensity.compact,
          ),
          home: Scaffold(
            backgroundColor: MeshColors.bgPrimary,
            body: RepaintBoundary(
              key: keyBefore,
              child: SizedBox(
                width: 700,
                child: MeshHeader(
                  store: store,
                  selected: DashboardView.overview,
                  onSelect: (_) {},
                  destinations: beforeDestinations,
                ),
              ),
            ),
          ),
        ),
      );
      await tester.pump();
      await tester.pump();
      await captureBoundary(
        keyBefore,
        '$_outDir/header_nav_desktop_narrow_before.png',
      );

      final keyAfter = GlobalKey();
      await tester.pumpWidget(
        MaterialApp(
          debugShowCheckedModeBanner: false,
          theme: buildMeshTheme().copyWith(
            visualDensity: VisualDensity.compact,
          ),
          home: Scaffold(
            backgroundColor: MeshColors.bgPrimary,
            body: RepaintBoundary(
              key: keyAfter,
              child: SizedBox(
                width: 700,
                child: MeshHeader(
                  store: store,
                  selected: DashboardView.overview,
                  onSelect: (_) {},
                  destinations: kDashboardDestinations,
                ),
              ),
            ),
          ),
        ),
      );
      await tester.pump();
      await tester.pump();
      await captureBoundary(
        keyAfter,
        '$_outDir/header_nav_desktop_narrow_after.png',
      );
      expect(tester.takeException(), isNull);
    });
  });
}
