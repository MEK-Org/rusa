import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rusa_dashboard/api.dart';
import 'package:rusa_dashboard/assistant_io.dart';
import 'package:rusa_dashboard/assistant_page.dart';
import 'package:rusa_dashboard/assistant_platform.dart';
import 'package:rusa_dashboard/models.dart';
import 'package:rusa_dashboard/store.dart';
import 'package:rusa_dashboard/widgets/header.dart';
import 'package:rusa_dashboard/widgets/mobile_nav_drawer.dart';
import 'package:rusa_dashboard/widgets/walkie_panel.dart';

import 'fakes.dart';

// #1193: the Android assist trigger opens walkie recording to root, and the
// phone drawer leads to the system page that assigns the assistant role.

void main() {
  group('resolveRootActorId', () {
    ThreadsSnapshot snapshot(String? rootActorId, List<ThreadDto> threads) =>
        ThreadsSnapshot(
          halted: false,
          threads: threads,
          rootActorId: rootActorId,
        );

    test('is the actor the server names, whatever its id', () {
      expect(
        resolveRootActorId(
          snapshot('imported-id', [
            makeThread('detached'),
            makeThread('imported-id'),
            makeThread('child', parent: 'imported-id'),
          ]),
        ),
        'imported-id',
      );
    });

    test('is null when the named root is retired, even with another top', () {
      expect(
        resolveRootActorId(
          snapshot('imported-id', [
            makeThread('imported-id', status: 'retired'),
            makeThread('detached'),
          ]),
        ),
        isNull,
      );
    });

    test('is null when the named root is missing, even with another top', () {
      expect(
        resolveRootActorId(snapshot('imported-id', [makeThread('detached')])),
        isNull,
      );
    });

    test('is null when the server names no root, even with a `root` id', () {
      expect(resolveRootActorId(snapshot(null, [makeThread('root')])), isNull);
    });

    test('reads the root id from the threads response', () {
      final parsed = ThreadsSnapshot.fromJson({
        'threads': <Object>[],
        'rootActorId': 'imported-id',
      });
      expect(parsed.rootActorId, 'imported-id');
      expect(
        ThreadsSnapshot.fromJson({'threads': <Object>[]}).rootActorId,
        isNull,
      );
    });
  });

  group('AssistantPage', () {
    late FakeApi api;
    late FakeWalkie walkie;
    late FakeAssistant assistant;
    late int closed;

    setUp(() {
      api = FakeApi()
        ..threadsResult = [
          makeThread('root'),
          makeThread('worker', parent: 'root'),
        ];
      walkie = FakeWalkie(api);
      assistant = FakeAssistant();
      closed = 0;
    });

    Future<void> pumpPage(WidgetTester tester, {bool voice = true}) async {
      await tester.pumpWidget(
        MaterialApp(
          home: AssistantPage(
            createApi: () => api,
            createWalkieDeps: (_) => voice ? walkie.deps : null,
            signals: assistant,
            onClose: () => closed++,
          ),
        ),
      );
      await tester.pump();
      await tester.pump();
    }

    Future<void> unmount(WidgetTester tester) async {
      await tester.pumpWidget(const SizedBox.shrink());
      await tester.pump();
    }

    testWidgets('opens walkie to root and starts recording', (tester) async {
      await pumpPage(tester);

      expect(find.byKey(const ValueKey('walkie-panel')), findsOneWidget);
      expect(walkie.stream.connectCalls.single.actors, ['root']);
      expect(walkie.recorder.startCalls, 1);
      expect(walkie.wakeLock.acquireCalls, 1);
      await unmount(tester);
    });

    testWidgets('another trigger stops and sends the memo to root', (
      tester,
    ) async {
      await pumpPage(tester);

      assistant.triggerCtrl.add(null);
      await tester.pump();
      await tester.pump();

      expect(walkie.recorder.stopCalls, 1);
      expect(api.memoSends.single.actorId, 'root');
      await unmount(tester);
    });

    testWidgets('a lost headset route sends what was recorded', (tester) async {
      await pumpPage(tester);

      assistant.routeLostCtrl.add(null);
      await tester.pump();
      await tester.pump();
      expect(api.memoSends.single.actorId, 'root');

      // Not recording any more: a second loss starts nothing.
      assistant.routeLostCtrl.add(null);
      await tester.pump();
      expect(walkie.recorder.startCalls, 1);
      await unmount(tester);
    });

    testWidgets('turning walkie off closes the assist screen', (tester) async {
      await pumpPage(tester);

      await tester.tap(find.byKey(const ValueKey('walkie-off')));
      await tester.pump();
      await tester.pump();

      expect(closed, 1);
      expect(walkie.recorder.cancelCalls, 1);
      await unmount(tester);
      expect(closed, 1);
    });

    testWidgets('leaving the screen discards the take and ends the session', (
      tester,
    ) async {
      await pumpPage(tester);
      expect(walkie.recorder.startCalls, 1);

      var ended = false;
      unawaited(assistant.onEnd!().then((_) => ended = true));
      await tester.pump();
      await tester.pump();

      expect(ended, isTrue);
      expect(walkie.recorder.cancelCalls, 1);
      expect(walkie.recorder.stopCalls, 0);
      expect(api.memoSends, isEmpty);
      expect(api.disabledVoiceSessions, hasLength(1));
      expect(walkie.wakeLock.releaseCalls, 1);
      // Native closes the screen; the page does not close it a second time.
      expect(closed, 0);
      // A trigger can bring the closing screen back to the front before it
      // finishes; it shows no panel of the ended session to tap.
      expect(find.byType(WalkiePanel), findsNothing);

      // A trigger reaching the closing screen starts nothing.
      assistant.triggerCtrl.add(null);
      await tester.pump();
      expect(walkie.recorder.startCalls, 1);
      await unmount(tester);
      expect(assistant.onEnd, isNull);
    });

    testWidgets('leaving the screen during the root lookup starts nothing', (
      tester,
    ) async {
      final gate = Completer<ThreadsSnapshot>();
      api.threadSnapshotGates.add(gate);
      await pumpPage(tester);

      var ended = false;
      unawaited(assistant.onEnd!().then((_) => ended = true));
      await tester.pump();
      // Ending waits for the start in flight to settle.
      expect(ended, isFalse);

      gate.complete(
        ThreadsSnapshot(
          halted: false,
          threads: api.threadsResult,
          rootActorId: 'root',
        ),
      );
      await tester.pump();
      await tester.pump();

      expect(ended, isTrue);
      expect(walkie.streams, isEmpty);
      expect(walkie.recorder.startCalls, 0);
      await unmount(tester);
    });

    testWidgets('says so when there is no root actor to address', (
      tester,
    ) async {
      api.threadsResult = [makeThread('child', parent: 'gone')];
      await pumpPage(tester);

      expect(find.byKey(const ValueKey('assistant-error')), findsOneWidget);
      expect(find.text('No active root actor'), findsOneWidget);
      expect(walkie.recorder.startCalls, 0);

      api.threadsResult = [makeThread('root')];
      await tester.tap(find.text('Retry'));
      await tester.pump();
      await tester.pump();
      expect(walkie.recorder.startCalls, 1);
      await unmount(tester);
    });

    testWidgets('never sends to another top-level actor in root\'s place', (
      tester,
    ) async {
      api
        ..rootActorId = 'imported-id'
        ..threadsResult = [
          makeThread('imported-id', status: 'retired'),
          makeThread('detached'),
        ];
      await pumpPage(tester);

      expect(find.text('No active root actor'), findsOneWidget);
      expect(walkie.recorder.startCalls, 0);
      expect(walkie.streams, isEmpty);
      assistant.triggerCtrl.add(null);
      await tester.pump();
      expect(api.memoSends, isEmpty);
      await unmount(tester);
    });

    testWidgets('shows a fixed message, not the raw failure', (tester) async {
      api.threadsError = DashboardApiException(
        Uri.parse('https://dash.example/api/mesh/threads'),
        500,
        'internal detail',
      );
      await pumpPage(tester);

      expect(find.text("Couldn't reach Rusa"), findsOneWidget);
      expect(find.textContaining('dash.example'), findsNothing);
      expect(find.textContaining('internal detail'), findsNothing);
      expect(walkie.recorder.startCalls, 0);
      await unmount(tester);
    });

    testWidgets('says so when the instance has no voice', (tester) async {
      api.backlogError = DashboardApiException(
        Uri.parse('https://dash.example/api/mesh/voice/backlog'),
        503,
        '',
      );
      await pumpPage(tester);

      expect(find.text('Voice is not configured on this instance'), findsOne);
      expect(walkie.recorder.startCalls, 0);
      await unmount(tester);
    });

    testWidgets('closing during the root lookup starts nothing', (
      tester,
    ) async {
      final gate = Completer<ThreadsSnapshot>();
      api.threadSnapshotGates.add(gate);
      await pumpPage(tester);
      await unmount(tester);

      gate.complete(
        ThreadsSnapshot(
          halted: false,
          threads: api.threadsResult,
          rootActorId: 'root',
        ),
      );
      await tester.pump();
      await tester.pump();

      expect(walkie.streams, isEmpty);
      expect(walkie.wakeLock.acquireCalls, 0);
      expect(walkie.recorder.startCalls, 0);
    });

    testWidgets('closing during a Retry start starts nothing', (tester) async {
      api.threadsResult = [makeThread('child', parent: 'gone')];
      await pumpPage(tester);
      expect(find.text('No active root actor'), findsOneWidget);

      api.threadsResult = [makeThread('root')];
      final gate = Completer<ThreadsSnapshot>();
      api.threadSnapshotGates.add(gate);
      await tester.tap(find.text('Retry'));
      await tester.pump();
      await unmount(tester);

      gate.complete(
        ThreadsSnapshot(
          halted: false,
          threads: api.threadsResult,
          rootActorId: 'root',
        ),
      );
      await tester.pump();
      await tester.pump();

      expect(walkie.streams, isEmpty);
      expect(walkie.recorder.startCalls, 0);
    });

    testWidgets('a superseded Retry leaves the current start\'s walkie off', (
      tester,
    ) async {
      api.threadsResult = [makeThread('child', parent: 'gone')];
      await pumpPage(tester);
      expect(find.text('No active root actor'), findsOneWidget);

      api.threadsResult = [makeThread('root')];
      final first = Completer<ThreadsSnapshot>();
      final second = Completer<ThreadsSnapshot>();
      api.threadSnapshotGates.addAll([first, second]);
      await tester.tap(find.text('Retry'));
      await tester.pump();
      await tester.tap(find.text('Retry'));
      await tester.pump();

      ThreadsSnapshot snapshot() => ThreadsSnapshot(
        halted: false,
        threads: api.threadsResult,
        rootActorId: 'root',
      );
      second.complete(snapshot());
      await tester.pump();
      await tester.pump();
      expect(walkie.recorder.startCalls, 1);
      first.complete(snapshot());
      await tester.pump();
      await tester.pump();

      await tester.tap(find.byKey(const ValueKey('walkie-off')));
      await tester.pump();
      await tester.pump();
      expect(closed, 1);
      expect(walkie.recorder.startCalls, 1);
      await unmount(tester);
    });

    testWidgets('closing while voice starts releases it unrecorded', (
      tester,
    ) async {
      final probe = Completer<List<VoiceAnnouncement>>();
      api.backlogGates.add(probe);
      await pumpPage(tester);
      await unmount(tester);

      probe.complete(const []);
      await tester.pump();
      await tester.pump();

      expect(walkie.streams, isEmpty);
      expect(walkie.wakeLock.acquireCalls, 0);
      expect(walkie.recorder.startCalls, 0);
    });

    testWidgets('plays only replies to this assist session', (tester) async {
      final probe = Completer<List<VoiceAnnouncement>>();
      final backlog = Completer<List<VoiceAnnouncement>>();
      api.backlogGates.addAll([probe, backlog]);
      await pumpPage(tester);
      probe.complete(const []);
      await tester.pump();
      await tester.pump();

      // The backlog holds a root reply left unplayed before this trigger, and
      // one answering this session.
      final sessionId = walkie.stream.connectCalls.single.sessionId;
      backlog.complete([
        makeAnnouncement('earlier', actor: 'root'),
        makeAnnouncement('elsewhere', actor: 'root', sessionId: 'other'),
        makeAnnouncement('answer', actor: 'root', sessionId: sessionId),
      ]);
      await tester.pump();
      await tester.pump();

      expect(walkie.player.playedUrls, ['/api/mesh/voice/audio/answer']);
      expect(find.text('reply earlier'), findsNothing);
      expect(api.ackedIds, isNot(contains('earlier')));
      await unmount(tester);
    });

    testWidgets('says so when the device has no voice adapters', (
      tester,
    ) async {
      await pumpPage(tester, voice: false);

      expect(find.text('Voice is not available on this device'), findsOne);
      expect(api.threadsCallCount, 0);
      await unmount(tester);
    });
  });

  group('drawer assistant entry', () {
    Future<DashboardStore> pumpDrawer(
      WidgetTester tester,
      AssistantRole? role,
    ) async {
      final store = DashboardStore(api: FakeApi(), stream: FakeStream());
      addTearDown(store.dispose);
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: SizedBox(
              width: 304,
              child: MobileNavDrawer(
                store: store,
                selected: DashboardView.overview,
                onSelect: (_) {},
                assistantRole: role,
              ),
            ),
          ),
        ),
      );
      await tester.pump();
      return store;
    }

    final entry = find.byKey(const ValueKey('drawer-assistant'));

    testWidgets('offers setup when Rusa is not the assistant', (tester) async {
      final role = FakeAssistant(
        roleStatus: const AssistantRoleStatus(available: true, held: false),
      );
      await pumpDrawer(tester, role);

      expect(entry, findsOneWidget);
      expect(find.text('Not set. Choose Rusa in Android settings'), findsOne);
      await tester.tap(entry);
      await tester.pump();
      expect(role.settingsOpened, 1);
    });

    testWidgets('shows when Rusa holds the role', (tester) async {
      await pumpDrawer(
        tester,
        FakeAssistant(
          roleStatus: const AssistantRoleStatus(available: true, held: true),
        ),
      );

      expect(find.text('The assist gesture opens walkie to root'), findsOne);
      expect(find.byIcon(Icons.check), findsOneWidget);
    });

    testWidgets('is absent without the role or the platform', (tester) async {
      await pumpDrawer(
        tester,
        FakeAssistant(
          roleStatus: const AssistantRoleStatus(available: false, held: false),
        ),
      );
      expect(entry, findsNothing);

      await pumpDrawer(tester, FakeAssistant());
      expect(entry, findsNothing);

      await pumpDrawer(tester, null);
      expect(entry, findsNothing);
    });
  });

  group('IoAssistantChannel', () {
    TestWidgetsFlutterBinding.ensureInitialized();
    const channel = MethodChannel(IoAssistantChannel.kName);
    final messenger =
        TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
    final calls = <String>[];
    Object? Function(MethodCall call)? answer;

    setUp(() {
      calls.clear();
      answer = null;
      messenger.setMockMethodCallHandler(channel, (call) async {
        calls.add(call.method);
        return answer?.call(call);
      });
    });
    tearDown(() => messenger.setMockMethodCallHandler(channel, null));

    Future<void> fromNative(String method) => messenger.handlePlatformMessage(
      channel.name,
      const StandardMethodCodec().encodeMethodCall(MethodCall(method)),
      (_) {},
    );

    test('reads the role status', () async {
      answer = (_) => {'available': true, 'held': true};
      final status = await IoAssistantChannel(channel: channel).status();
      expect(status.available, isTrue);
      expect(status.held, isTrue);
      expect(calls, ['roleStatus']);
    });

    test('a failed headset route records from the phone', () async {
      answer = (_) => throw PlatformException(code: 'audio');
      final assistant = IoAssistantChannel(channel: channel);
      expect(await assistant.acquire(), isFalse);
      await assistant.release();
      expect(calls, ['acquireHeadset', 'releaseHeadset']);
    });

    test('answers native\'s end once the session has ended', () async {
      final assistant = IoAssistantChannel(channel: channel);
      final ending = Completer<void>();
      assistant.onEnd = () => ending.future;
      var replied = false;
      unawaited(
        messenger.handlePlatformMessage(
          channel.name,
          const StandardMethodCodec().encodeMethodCall(const MethodCall('end')),
          (_) => replied = true,
        ),
      );
      await pumpEventQueue();
      expect(replied, isFalse);

      ending.complete();
      await pumpEventQueue();
      expect(replied, isTrue);

      // With no page to end, native gets its answer at once.
      assistant.onEnd = null;
      replied = false;
      await messenger.handlePlatformMessage(
        channel.name,
        const StandardMethodCodec().encodeMethodCall(const MethodCall('end')),
        (_) => replied = true,
      );
      expect(replied, isTrue);
    });

    test('forwards native triggers and route loss', () async {
      final assistant = IoAssistantChannel(channel: channel);
      final triggers = <void>[];
      final losses = <void>[];
      assistant.triggers.listen(triggers.add);
      assistant.routeLost.listen(losses.add);

      await fromNative('trigger');
      await fromNative('routeLost');
      await fromNative('trigger');
      await pumpEventQueue();

      expect(triggers, hasLength(2));
      expect(losses, hasLength(1));
    });
  });
}
