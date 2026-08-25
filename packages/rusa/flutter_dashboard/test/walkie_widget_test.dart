import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rusa_dashboard/api.dart';
import 'package:rusa_dashboard/models.dart';
import 'package:rusa_dashboard/store.dart';
import 'package:rusa_dashboard/voice_platform.dart';
import 'package:rusa_dashboard/walkie_controller.dart';
import 'package:rusa_dashboard/widgets/chat_tab.dart';
import 'package:rusa_dashboard/widgets/status_dot.dart';

import 'fakes.dart';

/// Widget-level coverage for the walkie-talkie surface on the actor chat
/// : toggle rendering/disabling, mode entry/exit, the record button
/// states, and teardown on leaving the screen.
void main() {
  late FakeApi api;
  late FakeStream stream;
  late FakeWalkie walkie;
  late DashboardStore store;

  setUp(() {
    api = FakeApi()..threadsResult = [makeThread('a')];
    stream = FakeStream();
    walkie = FakeWalkie(api);
    store = DashboardStore(api: api, stream: stream, walkie: walkie.deps);
  });

  tearDown(() async {
    await store.dispose();
  });

  Widget harness() => MaterialApp(
    home: Scaffold(body: ChatTab(store: store)),
  );

  Future<void> selectActor(WidgetTester tester) async {
    await store.refreshThreads();
    store.clickActor('a');
    await tester.pumpWidget(harness());
    await tester.pump();
  }

  testWidgets('shows the walkie toggle next to the chat input', (tester) async {
    await selectActor(tester);
    expect(find.byKey(const ValueKey('walkie-toggle')), findsOneWidget);
    expect(find.byKey(const ValueKey('walkie-panel')), findsNothing);
  });

  testWidgets('renders no toggle when the store has no walkie deps', (
    tester,
  ) async {
    final bare = DashboardStore(api: api, stream: FakeStream());
    addTearDown(bare.dispose);
    await bare.refreshThreads();
    bare.clickActor('a');
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(body: ChatTab(store: bare)),
      ),
    );
    await tester.pump();
    expect(find.byKey(const ValueKey('walkie-toggle')), findsNothing);
  });

  testWidgets('503 probe disables the toggle with an explanatory tooltip', (
    tester,
  ) async {
    api.backlogError = DashboardApiException(
      Uri.parse('/voice'),
      503,
      '{"error":"voice unavailable: geminiApiKey is not configured"}',
    );
    await selectActor(tester);
    await tester.pump();

    final button = tester.widget<IconButton>(
      find.byKey(const ValueKey('walkie-toggle')),
    );
    expect(button.onPressed, isNull);
    expect(
      find.byTooltip('Voice is not configured on this instance'),
      findsOneWidget,
    );

    // A dead tap does not enter the mode.
    await tester.tap(
      find.byKey(const ValueKey('walkie-toggle')),
      warnIfMissed: false,
    );
    await tester.pump();
    expect(find.byKey(const ValueKey('walkie-panel')), findsNothing);
    expect(walkie.streams, isEmpty);
  });

  testWidgets('toggle ON swaps the input for the walkie panel and opens the '
      'presence stream; the off button restores it', (tester) async {
    await selectActor(tester);
    await tester.tap(find.byKey(const ValueKey('walkie-toggle')));
    await tester.pump();
    await tester.pump();

    expect(find.byKey(const ValueKey('walkie-panel')), findsOneWidget);
    expect(find.byType(TextField), findsNothing);
    expect(walkie.streams, hasLength(1));
    expect(walkie.stream.connectCalls, [
      ['a'],
    ]);
    expect(walkie.wakeLock.acquireCalls, 1);
    expect(walkie.player.primeCalls, 1);

    await tester.tap(find.byKey(const ValueKey('walkie-off')));
    await tester.pump();
    await tester.pump();

    expect(find.byKey(const ValueKey('walkie-panel')), findsNothing);
    expect(find.byType(TextField), findsOneWidget);
    expect(walkie.stream.disposed, isTrue);
    expect(walkie.wakeLock.releaseCalls, 1);
  });

  testWidgets('record button walks idle → recording → sending → delivered', (
    tester,
  ) async {
    await selectActor(tester);
    await tester.tap(find.byKey(const ValueKey('walkie-toggle')));
    await tester.pump();
    await tester.pump();

    await tester.tap(find.byKey(const ValueKey('walkie-record')));
    await tester.pump();
    await tester.pump();
    expect(walkie.recorder.startCalls, 1);
    expect(
      tester
          .widget<Text>(find.byKey(const ValueKey('walkie-record-caption')))
          .data,
      contains('Recording'),
    );

    await tester.tap(find.byKey(const ValueKey('walkie-record')));
    await tester.pump();
    await tester.pump();
    expect(api.memoSends, hasLength(1));
    expect(
      tester
          .widget<Text>(find.byKey(const ValueKey('walkie-record-caption')))
          .data,
      contains('Delivered: "hello"'),
    );

    // The whole point of ISSUE_NUM: the sent memo lands in the transcript as its
    // server-side transcription, so it survives the delivered→idle reset and
    // Operator can read back what the transcriber actually heard.
    expect(
      find.byKey(const ValueKey('walkie-transcript-memo')),
      findsOneWidget,
    );
    expect(find.text('YOU SAID'), findsOneWidget);
    expect(find.text('hello'), findsOneWidget);

    // Let the delivered→idle reset timer fire so no timer is left pending.
    await tester.pump(kDeliveredResetDelay + const Duration(seconds: 1));
  });

  testWidgets(
    'a queued announcement shows its text large with a working skip',
    (tester) async {
      api.backlogPages = [
        [makeAnnouncement('m1', text: 'On it, boss.')],
      ];
      await selectActor(tester);
      await tester.tap(find.byKey(const ValueKey('walkie-toggle')));
      await tester.pump();
      await tester.pump();

      expect(
        find.byKey(const ValueKey('walkie-transcript-reply')),
        findsOneWidget,
      );
      expect(find.text('On it, boss.'), findsOneWidget);
      expect(find.text('NOW PLAYING'), findsOneWidget);

      await tester.tap(find.byKey(const ValueKey('walkie-skip')));
      await tester.pump();
      await tester.pump();
      expect(api.ackedIds, ['m1']);
      // Skipped: the text stays glanceable — it lands in the transcript as a
      // played reply rather than vanishing with the now-playing tail .
      expect(find.text('REPLY'), findsOneWidget);
      expect(find.text('On it, boss.'), findsOneWidget);
    },
  );

  testWidgets('leaving the chat screen tears walkie mode down', (tester) async {
    await selectActor(tester);
    await tester.tap(find.byKey(const ValueKey('walkie-toggle')));
    await tester.pump();
    await tester.pump();
    expect(walkie.streams, hasLength(1));

    await tester.pumpWidget(const MaterialApp(home: SizedBox()));
    await tester.pump();
    await tester.pump();

    expect(walkie.stream.disposed, isTrue);
    expect(walkie.wakeLock.releaseCalls, 1);
  });

  testWidgets(
    'at short viewport height, toggling walkie ON preserves the controller '
    'and switches to full-screen layout and stays',
    (tester) async {
      await tester.binding.setSurfaceSize(const Size(800, 400));
      addTearDown(() => tester.binding.setSurfaceSize(null));

      await selectActor(tester);

      // Initial state: walkie is OFF, normal input area is present
      expect(find.byKey(const ValueKey('walkie-toggle')), findsOneWidget);
      expect(find.byKey(const ValueKey('walkie-panel')), findsNothing);

      // Find the ChatTab state to retrieve the controller reference
      final stateFinder = find.byType(ChatTab);
      expect(stateFinder, findsOneWidget);
      final chatTabState = tester.state(stateFinder) as dynamic;

      // Check initial controller is not null
      final controllerBefore = chatTabState.debugController;
      expect(controllerBefore, isNotNull);

      // Toggle walkie ON
      await tester.tap(find.byKey(const ValueKey('walkie-toggle')));
      await tester.pump();
      await tester.pump();

      // Now walkie is ON. Because height (400) < 500, we should be in fullscreen
      // walkie mode. Check that walkie-panel is present, and chat list view is hidden.
      expect(find.byKey(const ValueKey('walkie-panel')), findsOneWidget);
      expect(find.byType(ListView), findsNothing);

      // Assert that the controller instance was NOT disposed or recreated
      final controllerAfter = chatTabState.debugController;
      expect(controllerAfter, same(controllerBefore));

      // Pump more frames to verify that the fullscreen layout STAYS
      await tester.pump(const Duration(milliseconds: 100));
      await tester.pump();

      expect(find.byKey(const ValueKey('walkie-panel')), findsOneWidget);
      expect(find.byType(ListView), findsNothing);
      expect(chatTabState.debugController, same(controllerBefore));
    },
  );

  testWidgets(
    'shows actor status indicator next to Connected in walkie panel ',
    (tester) async {
      api.threadsResult = [makeThread('a', runState: RunState.running)];
      await selectActor(tester);
      await tester.tap(find.byKey(const ValueKey('walkie-toggle')));
      await tester.pump();
      await tester.pump();
      walkie.stream.statusCtrl.add(VoiceStreamStatus.connected);
      await tester.pump();

      expect(find.text('Connected'), findsOneWidget);
      expect(find.text('active'), findsOneWidget);
      expect(
        find.descendant(
          of: find.byKey(const ValueKey('walkie-panel')),
          matching: find.byType(StatusDot),
        ),
        findsOneWidget,
      );
    },
  );

  testWidgets(
    'cancelling while recording turns replay into cancel and discards recording ',
    (tester) async {
      await selectActor(tester);
      await tester.tap(find.byKey(const ValueKey('walkie-toggle')));
      await tester.pump();
      await tester.pump();

      // Before recording: replay button exists (disabled if nothing played yet)
      expect(find.byKey(const ValueKey('walkie-replay')), findsOneWidget);
      expect(find.byKey(const ValueKey('walkie-cancel')), findsNothing);

      // Start recording
      await tester.tap(find.byKey(const ValueKey('walkie-record')));
      await tester.pump();
      await tester.pump();

      // While recording: replay button is replaced by cancel button
      expect(find.byKey(const ValueKey('walkie-replay')), findsNothing);
      expect(find.byKey(const ValueKey('walkie-cancel')), findsOneWidget);
      expect(find.text('Cancel'), findsOneWidget);

      // Tap cancel
      await tester.tap(find.byKey(const ValueKey('walkie-cancel')));
      await tester.pump();
      await tester.pump();

      // Cancelled: recorder.cancel called, no memo sent, replay button restored
      expect(walkie.recorder.cancelCalls, 1);
      expect(api.memoSends, isEmpty);
      expect(find.byKey(const ValueKey('walkie-replay')), findsOneWidget);
      expect(find.byKey(const ValueKey('walkie-cancel')), findsNothing);
    },
  );
}
