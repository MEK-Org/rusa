// Matched synthetic review captures for #859. The same fixture runs against
// staging (before) and the repair (after):
// ROOM_HEADER_SCREENSHOT_LABEL=before flutter test test/room_header_screenshot_test.dart
// flutter test test/room_header_screenshot_test.dart
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rusa_dashboard/dashboard_url.dart';
import 'package:rusa_dashboard/store.dart';
import 'package:rusa_dashboard/theme.dart';
import 'package:rusa_dashboard/widgets/chat_room.dart';
import 'package:rusa_dashboard/widgets/dashboard_body.dart';

import 'fakes.dart';
import 'screenshot_support.dart';

const _ids = ['root', 'actor-b', 'actor-c'];

void main() {
  setUpAll(loadFonts);
  for (final entry in {
    'cover': const Size(411, 485),
    'phone': const Size(390, 800),
    'wide': const Size(1200, 800),
  }.entries) {
    testWidgets('captures Room header ${entry.key} (#859)', (tester) async {
      await tester.runAsync(() async {
        HttpOverrides.global = FakeImageHttpOverrides(await portraits(_ids));
        addTearDown(() => HttpOverrides.global = null);
        addTearDown(() => tester.binding.setSurfaceSize(null));
        debugDashboardUrl = '/chat-room';
        addTearDown(() => debugDashboardUrl = null);

        final api = FakeApi()
          ..threadsResult = [for (final id in _ids) makeThread(id)]
          ..chatRoomParticipants = _ids;
        final walkie = FakeWalkie(api);
        final store = DashboardStore(
          api: api,
          stream: FakeStream(),
          walkie: walkie.deps,
        );
        await store.init();
        addTearDown(store.dispose);
        final boundary = GlobalKey();
        await tester.binding.setSurfaceSize(entry.value);
        await tester.pumpWidget(
          MaterialApp(
            debugShowCheckedModeBanner: false,
            theme: buildMeshTheme(),
            home: Scaffold(
              body: RepaintBoundary(
                key: boundary,
                child: DashboardBody(store: store),
              ),
            ),
          ),
        );
        await settleImages(tester, portraitUrls(_ids));
        // Let ActorAvatar's 200 ms decoded-frame fade finish so the capture
        // shows settled portraits rather than the silhouette mid-transition.
        await tester.pump(const Duration(milliseconds: 250));
        expect(find.byType(ChatRoomTab), findsOneWidget);
        for (final id in _ids) {
          expect(find.byKey(ValueKey('chat-room-avatar-$id')), findsOneWidget);
        }
        final label =
            Platform.environment['ROOM_HEADER_SCREENSHOT_LABEL'] ?? 'after';
        await captureBoundary(
          boundary,
          'screenshots/859_room_${entry.key}_$label.png',
        );
        expect(tester.takeException(), isNull);
      });
    });
  }
}
