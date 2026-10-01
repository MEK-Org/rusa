// Rendered review artifacts for #803's Room appearance pass. Run with:
//
//   flutter test test/chat_room_appearance_screenshot_test.dart
//
// It writes `flutter_dashboard/screenshots/chat_room_two_up_<viewport>_<state>.png`
// for a wide and a tall viewport, each idle, recording, speaking, starting and
// sending (#816: the mic or the memo held open after an accepted tap). root is
// running (green border) and actor-b is queued (yellow border); in the speaking
// shots actor-b's speaking border takes precedence over its queued colour.

import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rusa_dashboard/models.dart';
import 'package:rusa_dashboard/store.dart';
import 'package:rusa_dashboard/theme.dart';
import 'package:rusa_dashboard/widgets/chat_room.dart';

import 'fakes.dart';
import 'screenshot_support.dart';

final String _outDir = '${Directory.current.path}/screenshots';
const _actorIds = ['root', 'actor-b'];

const _viewports = {'wide': Size(1180, 820), 'tall': Size(420, 860)};

enum _Shot { idle, recording, speaking, starting, sending }

void main() {
  setUpAll(loadFonts);

  for (final MapEntry(key: viewport, value: size) in _viewports.entries) {
    for (final shot in _Shot.values) {
      testWidgets('renders the two-up Room $viewport ${shot.name}', (
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
              makeThread(
                'actor-b',
                voiceName: 'Kore',
                runState: RunState.queued,
              ),
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
          await tester.binding.setSurfaceSize(size);
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

          switch (shot) {
            case _Shot.idle:
              break;
            case _Shot.recording:
              await tester.tap(
                find.byKey(const ValueKey('chat-room-avatar-root')),
              );
              await tester.pump();
              await tester.pump();
            case _Shot.speaking:
              // The first tap enters room presence and starts a capture;
              // cancel it so the queued reply can play.
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
            case _Shot.starting:
              walkie.recorder.startCompleter = Completer<void>();
              await tester.tap(
                find.byKey(const ValueKey('chat-room-avatar-root')),
              );
              await tester.pump();
            case _Shot.sending:
              await tester.tap(
                find.byKey(const ValueKey('chat-room-avatar-root')),
              );
              await tester.pump();
              await tester.pump();
              api.memoGate = Completer<void>();
              await tester.tap(
                find.byKey(const ValueKey('chat-room-avatar-root')),
              );
              await tester.pump();
          }
          // Let the tile's 180ms border animation finish.
          await tester.pump(const Duration(milliseconds: 250));

          await captureBoundary(
            key,
            '$_outDir/chat_room_two_up_${viewport}_${shot.name}.png',
          );
          expect(tester.takeException(), isNull);
        });
      });
    }
  }
}
