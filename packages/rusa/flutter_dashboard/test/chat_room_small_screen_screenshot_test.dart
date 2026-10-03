// Rendered review artifacts for the Room on a small phone screen (#825
// operator feedback). Run with:
//
//   flutter test test/chat_room_small_screen_screenshot_test.dart
//
// It writes `flutter_dashboard/screenshots/chat_room_small_three_<state>.png`:
// the real dashboard body, with the Room's header removed (#859), with three
// actors, idle, recording and speaking. The viewport approximates a flip
// phone's cover screen: a 1080x1272 px panel at an assumed device pixel ratio
// of 2.625 is about 411x485 logical px.

import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rusa_dashboard/models.dart';
import 'package:rusa_dashboard/store.dart';
import 'package:rusa_dashboard/theme.dart';
import 'package:rusa_dashboard/widgets/chat_room.dart';
import 'package:rusa_dashboard/widgets/dashboard_body.dart';

import 'fakes.dart';
import 'screenshot_support.dart';

final String _outDir = '${Directory.current.path}/screenshots';
const _actorIds = ['root', 'actor-b', 'actor-c'];
const _coverScreen = Size(411, 485);

enum _Shot { idle, recording, speaking }

void main() {
  setUpAll(loadFonts);

  for (final shot in _Shot.values) {
    testWidgets('renders the three-actor Room on a small screen ${shot.name}', (
      tester,
    ) async {
      await tester.runAsync(() async {
        HttpOverrides.global = FakeImageHttpOverrides(
          await portraits(_actorIds),
        );
        addTearDown(() => HttpOverrides.global = null);
        addTearDown(() => tester.binding.setSurfaceSize(null));

        final api = FakeApi()
          ..threadsResult = [
            makeThread('root', voiceName: 'Puck', runState: RunState.running),
            makeThread('actor-b', voiceName: 'Kore', runState: RunState.queued),
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
        await tester.binding.setSurfaceSize(_coverScreen);
        await tester.pumpWidget(
          MaterialApp(
            debugShowCheckedModeBanner: false,
            theme: buildMeshTheme(),
            home: Scaffold(
              backgroundColor: MeshColors.bgPrimary,
              body: RepaintBoundary(
                key: key,
                child: DashboardBody(store: store),
              ),
            ),
          ),
        );
        // On a phone the destinations live in the drawer behind the header's
        // hamburger.
        await tester.tap(find.byIcon(Icons.menu));
        await tester.pump();
        await tester.pump(const Duration(milliseconds: 400));
        await tester.tap(find.byKey(const ValueKey('drawer-nav-chatRoom')));
        await tester.pump();
        await tester.pump(const Duration(milliseconds: 400));
        await settleImages(tester, portraitUrls(_actorIds));
        expect(find.byType(ChatRoomTab), findsOneWidget);

        switch (shot) {
          case _Shot.idle:
            break;
          case _Shot.recording:
            await tester.tap(
              find.byKey(const ValueKey('chat-room-avatar-actor-b')),
            );
            await tester.pump();
            await tester.pump();
            expect(
              find.byKey(const ValueKey('chat-room-recording-badge')),
              findsOneWidget,
            );
          case _Shot.speaking:
            // The first tap enters room presence and starts a capture; cancel
            // it so the queued reply can play.
            await tester.tap(
              find.byKey(const ValueKey('chat-room-avatar-root')),
            );
            await tester.pump();
            await tester.pump();
            await tester.tap(find.byKey(const ValueKey('chat-room-cancel')));
            await tester.pump();
            await tester.pump();
            walkie.stream.framesCtrl.add(
              makeAnnouncement('reply-a', actor: 'actor-b'),
            );
            await tester.pump();
            await tester.pump();
            expect(
              find.byKey(const ValueKey('chat-room-speaking-badge')),
              findsOneWidget,
            );
        }
        // Let the tile's 180ms border animation finish.
        await tester.pump(const Duration(milliseconds: 250));

        for (final id in _actorIds) {
          expect(find.byKey(ValueKey('chat-room-avatar-$id')), findsOneWidget);
        }
        await captureBoundary(
          key,
          '$_outDir/chat_room_small_three_${shot.name}.png',
        );
        expect(tester.takeException(), isNull);
      });
    });
  }
}
