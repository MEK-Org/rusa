import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rusa_dashboard/store.dart';
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
    expect(rootBounds.size, roomBounds.size);
  });

  testWidgets(
    'adds a second actor and makes each avatar a tap-to-record control',
    (tester) async {
      await pumpRoom(tester);

      await tester.tap(find.byKey(const ValueKey('chat-room-add')));
      await tester.pumpAndSettle();
      final actorOption = find.text('actor-b-handle');
      await tester.tap(actorOption);
      await tester.pumpAndSettle();

      expect(
        find.byKey(const ValueKey('chat-room-avatar-root')),
        findsOneWidget,
      );
      expect(
        find.byKey(const ValueKey('chat-room-avatar-actor-b')),
        findsOneWidget,
      );
      expect(find.text('Voice: Kore'), findsOneWidget);
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
    },
  );
}
