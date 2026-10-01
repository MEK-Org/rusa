import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rusa_dashboard/api.dart';
import 'package:rusa_dashboard/models.dart';
import 'package:rusa_dashboard/store.dart';
import 'package:rusa_dashboard/theme.dart';
import 'package:rusa_dashboard/widgets/chat_room.dart';

import 'fakes.dart';

void main() {
  late FakeApi api;
  late FakeStream stream;
  late FakeWalkie walkie;
  late DashboardStore store;

  setUp(() async {
    api = FakeApi()
      ..threadsResult = [
        makeThread('root', voiceName: 'Puck'),
        makeThread('actor-b', voiceName: 'Kore'),
      ];
    stream = FakeStream();
    walkie = FakeWalkie(api);
    store = DashboardStore(api: api, stream: stream, walkie: walkie.deps);
    await store.refreshThreads();
  });

  tearDown(() => store.dispose());

  Future<void> pumpRoom(
    WidgetTester tester, {
    Size size = const Size(800, 900),
  }) async {
    await tester.binding.setSurfaceSize(size);
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
    // Within layout rounding.
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
      // The 800x900 room is taller than wide, so the two-up stacks (#803).
      expect(delegate.crossAxisCount, 1);

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

  Color borderOf(WidgetTester tester, String id) {
    final tile = tester.widget<AnimatedContainer>(
      find.descendant(
        of: find.byKey(ValueKey('chat-room-avatar-$id')),
        matching: find.byType(AnimatedContainer),
      ),
    );
    return ((tile.decoration! as BoxDecoration).border! as Border).top.color;
  }

  Rect tileRect(WidgetTester tester, String id) =>
      tester.getRect(find.byKey(ValueKey('chat-room-avatar-$id')));

  group('#803 appearance', () {
    testWidgets('has no room header or idle prompt', (tester) async {
      api.chatRoomParticipants = ['root', 'actor-b'];
      await pumpRoom(tester);

      expect(find.text('CHAT ROOM'), findsNothing);
      expect(find.text('Root adds and removes participants'), findsNothing);
      expect(find.textContaining('Tap an actor'), findsNothing);
      expect(
        tester
            .widget<Text>(find.byKey(const ValueKey('chat-room-status')))
            .data,
        isEmpty,
      );
    });

    testWidgets(
      'tile borders follow the dashboard run state, and speaking wins',
      (tester) async {
        api
          ..chatRoomParticipants = ['root', 'actor-b']
          ..runtimeCursor = const RuntimeCursor(
            streamId: 'stream-a',
            revision: 0,
          );
        await store.init();
        await pumpRoom(tester);

        expect(borderOf(tester, 'root'), MeshColors.border);
        expect(borderOf(tester, 'actor-b'), MeshColors.border);

        // The same runtime deltas that drive the actor tree's status dots.
        var revision = 0;
        final runStates = {
          'root': RunState.unknown,
          'actor-b': RunState.unknown,
        };
        Future<void> runState(String id, RunState state) async {
          revision++;
          // Keep the fake server in agreement with the delta, in case the
          // store re-fetches the snapshot.
          runStates[id] = state;
          api
            ..threadsResult = [
              makeThread(
                'root',
                voiceName: 'Puck',
                runState: runStates['root']!,
              ),
              makeThread(
                'actor-b',
                voiceName: 'Kore',
                runState: runStates['actor-b']!,
              ),
            ]
            ..runtimeCursor = RuntimeCursor(
              streamId: 'stream-a',
              revision: revision,
            );
          stream.runtimeStatesCtrl.add(
            ActorRuntimeStateDelta(
              streamId: 'stream-a',
              revision: revision,
              actorId: id,
              runState: state,
            ),
          );
          await tester.pump(const Duration(milliseconds: 50));
          await tester.pump(const Duration(milliseconds: 50));
        }

        await runState('root', RunState.running);
        expect(store.dotFor('root'), DotState.active);
        expect(borderOf(tester, 'root'), MeshColors.statusActive);

        await runState('actor-b', RunState.queued);
        expect(store.dotFor('actor-b'), DotState.queued);
        expect(borderOf(tester, 'actor-b'), MeshColors.statusQueued);

        await runState('root', RunState.queued);
        expect(borderOf(tester, 'root'), MeshColors.statusQueued);

        await runState('root', RunState.idle);
        expect(borderOf(tester, 'root'), MeshColors.border);

        // A queued actor that is speaking shows the speaking border; it
        // returns to its state colour when playback ends.
        await tester.tap(find.byKey(const ValueKey('chat-room-avatar-root')));
        await tester.pump();
        await tester.pump();
        await tester.tap(find.byKey(const ValueKey('chat-room-cancel')));
        await tester.pump();
        walkie.stream.framesCtrl.add(
          makeAnnouncement('reply-b', actor: 'actor-b'),
        );
        await tester.pump();
        await tester.pump();
        expect(find.text('Speaking'), findsOneWidget);
        expect(borderOf(tester, 'actor-b'), MeshColors.accent);
        expect(borderOf(tester, 'root'), MeshColors.border);

        walkie.player.finishCurrent();
        await tester.pump();
        await tester.pump();
        expect(find.text('Speaking'), findsNothing);
        expect(borderOf(tester, 'actor-b'), MeshColors.statusQueued);

        // init() started the store's polls; stop them before the pending
        // timer check.
        await tester.pumpWidget(const SizedBox());
        await tester.runAsync(store.dispose);
      },
    );

    testWidgets('recording an idle actor does not paint it active', (
      tester,
    ) async {
      api.chatRoomParticipants = ['root', 'actor-b'];
      await pumpRoom(tester);

      await tester.tap(find.byKey(const ValueKey('chat-room-avatar-actor-b')));
      await tester.pump();
      await tester.pump();

      expect(borderOf(tester, 'actor-b'), MeshColors.border);
      expect(
        find.descendant(
          of: find.byKey(const ValueKey('chat-room-avatar-actor-b')),
          matching: find.byKey(const ValueKey('chat-room-recording-badge')),
        ),
        findsOneWidget,
      );
      expect(
        find.descendant(
          of: find.byKey(const ValueKey('chat-room-avatar-actor-b')),
          matching: find.text('Tap to send'),
        ),
        findsOneWidget,
      );
      expect(
        find.byKey(const ValueKey('chat-room-recording-badge')),
        findsOneWidget,
      );
    });

    testWidgets('two participants stack when the room is taller than wide', (
      tester,
    ) async {
      api.chatRoomParticipants = ['root', 'actor-b'];
      await pumpRoom(tester, size: const Size(420, 860));

      final root = tileRect(tester, 'root');
      final other = tileRect(tester, 'actor-b');
      expect(other.left, root.left);
      expect(other.width, root.width);
      expect(other.top, greaterThan(root.bottom));
      expect(root.height, lessThan(root.width * 1.2));

      await pumpRoom(tester, size: const Size(1180, 820));
      final wideRoot = tileRect(tester, 'root');
      final wideOther = tileRect(tester, 'actor-b');
      expect(wideOther.top, wideRoot.top);
      expect(wideOther.left, greaterThan(wideRoot.right));
    });

    test('chatRoomColumns keeps one- and three-actor layouts', () {
      const tall = Size(400, 900);
      const wide = Size(1200, 800);
      expect(chatRoomColumns(1, tall), 1);
      expect(chatRoomColumns(1, wide), 1);
      expect(chatRoomColumns(2, tall), 1);
      expect(chatRoomColumns(2, wide), 2);
      expect(chatRoomColumns(2, const Size(800, 800)), 2);
      expect(chatRoomColumns(3, tall), 2);
      expect(chatRoomColumns(3, wide), 2);
      expect(chatRoomColumns(5, wide), 3);
    });

    testWidgets(
      'tiles hold still through starting, recording, sending, and cancel',
      (tester) async {
        api.chatRoomParticipants = ['root', 'actor-b'];
        await pumpRoom(tester, size: const Size(420, 860));

        final idle = {
          for (final id in ['root', 'actor-b']) id: tileRect(tester, id),
        };
        void expectStill(String phase) {
          for (final id in idle.keys) {
            expect(tileRect(tester, id), idle[id], reason: '$id while $phase');
          }
        }

        expect(find.byKey(const ValueKey('chat-room-cancel')), findsNothing);

        // Starting: the mic is still opening, and cancel can discard it.
        final mic = Completer<void>();
        walkie.recorder.startCompleter = mic;
        await tester.tap(find.byKey(const ValueKey('chat-room-avatar-root')));
        await tester.pump();
        await tester.pump();
        expect(find.textContaining('Opening the mic'), findsOneWidget);
        expect(find.byKey(const ValueKey('chat-room-cancel')), findsOneWidget);
        expectStill('starting');

        mic.complete();
        walkie.recorder.startCompleter = null;
        await tester.pump();
        await tester.pump();
        expect(
          find.textContaining('Recording for root-handle'),
          findsOneWidget,
        );
        expect(find.byKey(const ValueKey('chat-room-cancel')), findsOneWidget);
        expectStill('recording');

        await tester.tap(find.byKey(const ValueKey('chat-room-cancel')));
        await tester.pump();
        await tester.pump();
        expect(find.byKey(const ValueKey('chat-room-cancel')), findsNothing);
        expect(api.memoSends, isEmpty);
        expectStill('cancelled');

        // Record again and send: sending cannot be cancelled, so the control
        // goes away while its space stays reserved.
        await tester.tap(find.byKey(const ValueKey('chat-room-avatar-root')));
        await tester.pump();
        await tester.pump();
        final sending = Completer<void>();
        api.memoGate = sending;
        await tester.tap(find.byKey(const ValueKey('chat-room-avatar-root')));
        await tester.pump();
        await tester.pump();
        expect(find.textContaining('Sending the memo'), findsOneWidget);
        expect(find.byKey(const ValueKey('chat-room-cancel')), findsNothing);
        expectStill('sending');

        sending.complete();
        await tester.pump();
        await tester.pump();
        expect(api.memoSends, hasLength(1));
        expect(find.text('Delivered to root-handle.'), findsOneWidget);
        expectStill('delivered');
        // Let the delivered banner's reset timer run out.
        await tester.pump(const Duration(seconds: 10));
      },
    );
  });
  group('#816 tap spinner', () {
    Finder busy(String id) => find.byKey(ValueKey('chat-room-busy-$id'));

    testWidgets(
      'spins on the tapped tile only while starting and sending, in place',
      (tester) async {
        api.chatRoomParticipants = ['root', 'actor-b'];
        await pumpRoom(tester, size: const Size(420, 860));

        const ids = ['root', 'actor-b'];
        final idle = {for (final id in ids) id: tileRect(tester, id)};
        final idleBorder = {for (final id in ids) id: borderOf(tester, id)};
        void expectSpinner(String? on, String phase) {
          for (final id in ids) {
            expect(
              busy(id),
              id == on ? findsOneWidget : findsNothing,
              reason: '$id spinner while $phase',
            );
            expect(tileRect(tester, id), idle[id], reason: '$id while $phase');
            expect(
              borderOf(tester, id),
              idleBorder[id],
              reason: '$id border while $phase',
            );
          }
        }

        expectSpinner(null, 'idle');

        // Starting: the spinner is there on the first frame after the tap.
        final mic = Completer<void>();
        walkie.recorder.startCompleter = mic;
        await tester.tap(find.byKey(const ValueKey('chat-room-avatar-root')));
        await tester.pump();
        expect(find.textContaining('Opening the mic'), findsOneWidget);
        expectSpinner('root', 'starting');

        mic.complete();
        walkie.recorder.startCompleter = null;
        await tester.pump();
        await tester.pump();
        expect(find.textContaining('Recording for'), findsOneWidget);
        expectSpinner(null, 'recording');

        final sending = Completer<void>();
        api.memoGate = sending;
        await tester.tap(find.byKey(const ValueKey('chat-room-avatar-root')));
        await tester.pump();
        expect(find.textContaining('Sending the memo'), findsOneWidget);
        expectSpinner('root', 'sending');

        sending.complete();
        await tester.pump();
        await tester.pump();
        expect(find.text('Delivered to root-handle.'), findsOneWidget);
        expectSpinner(null, 'delivered');
        await tester.pump(const Duration(seconds: 10));
      },
    );

    testWidgets('clears when starting is cancelled or sending fails', (
      tester,
    ) async {
      api.chatRoomParticipants = ['root', 'actor-b'];
      await pumpRoom(tester, size: const Size(1180, 820));

      final mic = Completer<void>();
      walkie.recorder.startCompleter = mic;
      await tester.tap(find.byKey(const ValueKey('chat-room-avatar-actor-b')));
      await tester.pump();
      expect(busy('actor-b'), findsOneWidget);
      expect(busy('root'), findsNothing);

      await tester.tap(find.byKey(const ValueKey('chat-room-cancel')));
      await tester.pump();
      await tester.pump();
      expect(busy('actor-b'), findsNothing);
      mic.complete();
      walkie.recorder.startCompleter = null;
      await tester.pump();

      await tester.tap(find.byKey(const ValueKey('chat-room-avatar-actor-b')));
      await tester.pump();
      await tester.pump();
      final sending = Completer<void>();
      api
        ..memoGate = sending
        ..memoError = DashboardApiException(Uri.parse('/memo'), 500, 'boom');
      await tester.tap(find.byKey(const ValueKey('chat-room-avatar-actor-b')));
      await tester.pump();
      expect(busy('actor-b'), findsOneWidget);

      sending.complete();
      await tester.pump();
      await tester.pump();
      expect(find.textContaining('Send failed'), findsOneWidget);
      expect(busy('actor-b'), findsNothing);
      expect(busy('root'), findsNothing);
    });
  });
}

/// WCAG 2.x contrast ratio between two opaque colours.
double contrastRatio(Color a, Color b) {
  final la = a.computeLuminance();
  final lb = b.computeLuminance();
  final hi = la > lb ? la : lb;
  final lo = la > lb ? lb : la;
  return (hi + 0.05) / (lo + 0.05);
}
