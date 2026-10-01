import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rusa_dashboard/store.dart';
import 'package:rusa_dashboard/theme.dart';
import 'package:rusa_dashboard/widgets/chat_room.dart';

import 'fakes.dart';

void main() {
  late FakeApi api;
  late DashboardStore store;

  setUp(() async {
    api = FakeApi()
      ..threadsResult = [
        makeThread('root', voiceName: 'Puck'),
        makeThread('actor-b', voiceName: 'Kore'),
      ];
    store = DashboardStore(
      api: api,
      stream: FakeStream(),
      walkie: FakeWalkie(api).deps,
    );
    await store.refreshThreads();
  });

  tearDown(() => store.dispose());

  Future<void> pumpRoom(WidgetTester tester) async {
    await tester.binding.setSurfaceSize(const Size(800, 900));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(body: ChatRoomTab(store: store)),
      ),
    );
    await tester.pump();
  }

  testWidgets('starts with root filling the room grid', (tester) async {
    await pumpRoom(tester);

    expect(find.byKey(const ValueKey('chat-room')), findsOneWidget);
    expect(find.byKey(const ValueKey('chat-room-avatar-root')), findsOneWidget);
    expect(
      find.byKey(const ValueKey('chat-room-avatar-actor-b')),
      findsNothing,
    );
    expect(find.text('Voice: Puck'), findsOneWidget);

    final grid = tester.widget<GridView>(
      find.byKey(const ValueKey('chat-room-grid')),
    );
    final delegate =
        grid.gridDelegate as SliverGridDelegateWithFixedCrossAxisCount;
    expect(delegate.crossAxisCount, 1);
    final roomBounds = tester.getRect(
      find.byKey(const ValueKey('chat-room-grid')),
    );
    final rootBounds = tester.getRect(
      find.byKey(const ValueKey('chat-room-avatar-root')),
    );
    // Within layout rounding: the two-line header leaves a fractional height.
    expect(rootBounds.width, moreOrLessEquals(roomBounds.width, epsilon: 0.01));
    expect(
      rootBounds.height,
      moreOrLessEquals(roomBounds.height, epsilon: 0.01),
    );
  });

  testWidgets('idle voice labels meet WCAG AA contrast on the tile', (
    tester,
  ) async {
    api.chatRoomParticipants = ['root', 'actor-b'];
    await pumpRoom(tester);

    // Both the selected tile and the unselected idle tile.
    for (final text in ['Voice: Puck', 'Voice: Kore']) {
      final label = tester.widget<Text>(find.text(text));
      final ratio = contrastRatio(label.style!.color!, MeshColors.bgSecondary);
      expect(ratio, greaterThanOrEqualTo(4.5), reason: text);
    }
  });

  testWidgets(
    'shows the server roster read-only and follows it as root changes it',
    (tester) async {
      await pumpRoom(tester);

      // Membership is mesh state: the page offers no add control of its own.
      expect(find.byKey(const ValueKey('chat-room-add')), findsNothing);
      expect(find.byIcon(Icons.person_add_alt_1), findsNothing);
      expect(
        find.byKey(const ValueKey('chat-room-membership')),
        findsOneWidget,
      );
      expect(
        find.byKey(const ValueKey('chat-room-avatar-actor-b')),
        findsNothing,
      );

      // Root adds actor-b on the server; the next roster poll shows it.
      api.chatRoomParticipants = ['root', 'actor-b'];
      await tester.pump(const Duration(seconds: 10));
      await tester.pump();

      expect(
        find.byKey(const ValueKey('chat-room-avatar-root')),
        findsOneWidget,
      );
      expect(
        find.byKey(const ValueKey('chat-room-avatar-actor-b')),
        findsOneWidget,
      );
      final grid = tester.widget<GridView>(
        find.byKey(const ValueKey('chat-room-grid')),
      );
      final delegate =
          grid.gridDelegate as SliverGridDelegateWithFixedCrossAxisCount;
      expect(delegate.crossAxisCount, 2);

      await tester.tap(find.byKey(const ValueKey('chat-room-avatar-actor-b')));
      await tester.pump();
      await tester.pump();
      expect(
        find.textContaining('Recording for actor-b-handle'),
        findsOneWidget,
      );
      expect(find.byKey(const ValueKey('chat-room-cancel')), findsOneWidget);

      await tester.tap(find.byKey(const ValueKey('chat-room-cancel')));
      await tester.pump();
      expect(api.memoSends, isEmpty);

      // Root removes actor-b; the room drops it on the next poll.
      api.chatRoomParticipants = ['root'];
      await tester.pump(const Duration(seconds: 10));
      await tester.pump();
      expect(
        find.byKey(const ValueKey('chat-room-avatar-actor-b')),
        findsNothing,
      );
    },
  );

  testWidgets(
    'shows the distinct voice the server assigned when an actor joins',
    (tester) async {
      // actor-b starts on root's voice; joining the room reassigns it.
      api.threadsResult = [
        makeThread('root', voiceName: 'Puck'),
        makeThread('actor-b', voiceName: 'Puck'),
      ];
      await store.refreshThreads();
      await pumpRoom(tester);

      api
        ..chatRoomParticipants = ['root', 'actor-b']
        ..threadsResult = [
          makeThread('root', voiceName: 'Puck'),
          makeThread('actor-b', voiceName: 'Achernar'),
        ];
      await tester.pump(const Duration(seconds: 10));
      await tester.pump();
      await tester.pump();

      expect(find.text('Voice: Puck'), findsOneWidget);
      expect(find.text('Voice: Achernar'), findsOneWidget);
    },
  );
}

/// WCAG 2.x contrast ratio between two opaque colours.
double contrastRatio(Color a, Color b) {
  final la = a.computeLuminance();
  final lb = b.computeLuminance();
  final hi = la > lb ? la : lb;
  final lo = la > lb ? lb : la;
  return (hi + 0.05) / (lo + 0.05);
}
