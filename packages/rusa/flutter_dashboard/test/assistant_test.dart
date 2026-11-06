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
import 'package:rusa_dashboard/walkie_controller.dart';
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

    testWidgets(
      'backgrounding cancels capture but retains the session and queues its reply for return',
      (tester) async {
        await pumpPage(tester);
        final sessionId = walkie.stream.connectCalls.single.sessionId;

        await assistant.onBackground!();
        await tester.pump();

        expect(walkie.recorder.cancelCalls, 1);
        expect(api.disabledVoiceSessions, isEmpty);
        expect(walkie.stream.disposed, isFalse);
        expect(find.byKey(const ValueKey('walkie-panel')), findsOneWidget);

        walkie.stream.framesCtrl.add(
          makeAnnouncement('answer', actor: 'root', sessionId: sessionId),
        );
        await tester.pump();
        await tester.pump();
        expect(walkie.player.playedUrls, isEmpty);

        await assistant.onForeground!();
        await tester.pump();
        await tester.pump();
        expect(walkie.player.playedUrls, ['/api/mesh/voice/audio/answer']);

        await unmount(tester);
      },
    );

    testWidgets(
      'notification tap restores its exact reply without opening capture',
      (tester) async {
        api.notificationReply = makeAnnouncement(
          'durable-reply',
          actor: 'root',
          sessionId: 'ended-session',
        );
        await tester.pumpWidget(
          MaterialApp(
            home: AssistantPage(
              createApi: () => api,
              createWalkieDeps: (_) => walkie.deps,
              signals: assistant,
              initialReply: const AssistantReplyTarget(
                actorId: 'root',
                announcementId: 'durable-reply',
              ),
            ),
          ),
        );
        await tester.pump();
        await tester.pump();
        await tester.pump();

        expect(walkie.recorder.startCalls, 0);
        expect(api.notificationReplyCalls, [
          (actorId: 'root', announcementId: 'durable-reply'),
        ]);
        expect(walkie.player.playedUrls, [
          '/api/mesh/voice/audio/durable-reply',
        ]);
        await unmount(tester);
      },
    );

    testWidgets(
      'notification tap restores the recent root conversation with its reply',
      (tester) async {
        api
          ..chatPages = [
            ChatPage(
              // The API is newest-first. The assistant reverses it before
              // projecting it into the chronological walkie transcript.
              chat: [
                makeChat(
                  'durable-reply',
                  sender: 'root',
                  body: 'The durable answer',
                ),
                makeChat(
                  'recent-memo',
                  sender: '00000000-0000-4000-8000-000000000001',
                  body: '🎙️ [voice memo — reply for the ear]: My question',
                ),
              ],
              nextCursor: null,
            ),
          ]
          ..notificationReply = makeAnnouncement(
            'durable-reply',
            actor: 'root',
            text: 'The durable answer',
            sessionId: 'ended-session',
          );

        await tester.pumpWidget(
          MaterialApp(
            home: AssistantPage(
              createApi: () => api,
              createWalkieDeps: (_) => walkie.deps,
              signals: assistant,
              initialReply: const AssistantReplyTarget(
                actorId: 'root',
                announcementId: 'durable-reply',
              ),
            ),
          ),
        );
        await tester.pump();
        await tester.pump();
        await tester.pump();

        expect(api.chatActorCalls, [
          ['root'],
        ]);
        expect(find.text('My question'), findsOneWidget);
        expect(find.text('The durable answer'), findsOneWidget);
        expect(walkie.player.playedUrls, [
          '/api/mesh/voice/audio/durable-reply',
        ]);
        await unmount(tester);
      },
    );

    testWidgets(
      'locked notification opening waits for a post-unlock reply target',
      (tester) async {
        api.notificationReply = makeAnnouncement(
          'durable-reply',
          actor: 'root',
        );
        await tester.pumpWidget(
          MaterialApp(
            home: AssistantPage(
              createApi: () => api,
              createWalkieDeps: (_) => walkie.deps,
              signals: assistant,
              notificationOpening: true,
            ),
          ),
        );
        await tester.pump();
        await tester.pump();

        expect(walkie.recorder.startCalls, 0);
        expect(api.notificationReplyCalls, isEmpty);

        await assistant.onReply!(
          const AssistantReplyTarget(
            actorId: 'root',
            announcementId: 'durable-reply',
          ),
        );
        await tester.pump();
        await tester.pump();

        expect(api.notificationReplyCalls, [
          (actorId: 'root', announcementId: 'durable-reply'),
        ]);
        expect(walkie.player.playedUrls, [
          '/api/mesh/voice/audio/durable-reply',
        ]);
        await unmount(tester);
      },
    );

    testWidgets('notification input cannot rebind the root-only assistant', (
      tester,
    ) async {
      await tester.pumpWidget(
        MaterialApp(
          home: AssistantPage(
            createApi: () => api,
            createWalkieDeps: (_) => walkie.deps,
            signals: assistant,
            initialReply: const AssistantReplyTarget(
              actorId: 'worker',
              announcementId: 'foreign-conversation-reply',
            ),
          ),
        ),
      );
      await tester.pump();
      await tester.pump();
      await tester.pump();

      expect(walkie.stream.connectCalls.single.actors, ['root']);
      expect(walkie.recorder.startCalls, 0);
      expect(api.notificationReplyCalls, isEmpty);
      await unmount(tester);
    });

    testWidgets('backgrounding during startup returns with an idle session', (
      tester,
    ) async {
      final gate = Completer<ThreadsSnapshot>();
      api.threadSnapshotGates.add(gate);
      await tester.pumpWidget(
        MaterialApp(
          home: AssistantPage(
            createApi: () => api,
            createWalkieDeps: (_) => walkie.deps,
            signals: assistant,
            onClose: () => closed++,
          ),
        ),
      );
      await tester.pump();

      await assistant.onBackground!();
      gate.complete(
        ThreadsSnapshot(
          halted: false,
          threads: api.threadsResult,
          rootActorId: 'root',
        ),
      );
      await tester.pump();
      await tester.pump();
      await tester.pump();

      expect(walkie.recorder.cancelCalls, 1);
      expect(api.disabledVoiceSessions, isEmpty);
      final panel = tester.widget<WalkiePanel>(find.byType(WalkiePanel));
      expect(panel.controller.record.value.phase, RecordPhase.idle);

      await unmount(tester);
    });

    testWidgets('says so when there is no root actor to address', (
      tester,
    ) async {
      api.threadsResult = [makeThread('child', parent: 'gone')];
      await pumpPage(tester);

      expect(find.byKey(const ValueKey('assistant-error')), findsOneWidget);
      expect(find.text('No active root actor'), findsOneWidget);
      expect(walkie.recorder.startCalls, 1);
      expect(walkie.recorder.cancelCalls, 1);

      api.threadsResult = [makeThread('root')];
      await tester.tap(find.text('Retry'));
      await tester.pump();
      await tester.pump();
      expect(walkie.recorder.startCalls, 2);
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
      expect(walkie.recorder.startCalls, 1);
      expect(walkie.recorder.cancelCalls, 1);
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
      expect(walkie.recorder.startCalls, 1);
      expect(walkie.recorder.cancelCalls, 1);
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
      expect(walkie.recorder.startCalls, 1);
      expect(walkie.recorder.cancelCalls, 1);
      await unmount(tester);
    });

    testWidgets('closing during the root lookup cancels capture', (
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
      expect(walkie.recorder.startCalls, 1);
      expect(walkie.recorder.cancelCalls, 1);
    });

    testWidgets('closing during a Retry start cancels capture', (tester) async {
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
      expect(walkie.recorder.startCalls, 2);
      expect(walkie.recorder.cancelCalls, 2);
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
      expect(walkie.recorder.startCalls, 3);
      final cancelCallsBeforeFirst = walkie.recorder.cancelCalls;
      first.complete(snapshot());
      await tester.pump();
      await tester.pump();
      expect(walkie.recorder.cancelCalls, cancelCallsBeforeFirst);
      expect(find.byKey(const ValueKey('walkie-panel')), findsOneWidget);
      final panel = tester.widget<WalkiePanel>(find.byType(WalkiePanel));
      expect(panel.controller.record.value.phase, RecordPhase.recording);

      await tester.tap(find.byKey(const ValueKey('walkie-off')));
      await tester.pump();
      await tester.pump();
      expect(closed, 1);
      expect(walkie.recorder.startCalls, 3);
      expect(walkie.recorder.cancelCalls, cancelCallsBeforeFirst + 1);
      await unmount(tester);
    });

    testWidgets(
      'closing screen while a newer retry is in lookup cancels capture after superseded retry completes',
      (tester) async {
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

        // First (superseded) attempt completes while second is still awaiting threads lookup:
        first.complete(snapshot());
        await tester.pump();
        await tester.pump();

        // Screen is unmounted while second attempt is still in flight:
        await unmount(tester);

        expect(walkie.recorder.startCalls, 3);
        // Initial failed attempt cancelled (1), then unmount cancels the active retry handle (2):
        expect(walkie.recorder.cancelCalls, 2);
      },
    );

    testWidgets(
      'a 503 during enable cancels capture and displays voice not configured',
      (tester) async {
        final probe = Completer<List<VoiceAnnouncement>>();
        final backlog = Completer<List<VoiceAnnouncement>>();
        api.backlogGates.addAll([probe, backlog]);
        await pumpPage(tester);

        // First backlog fetch (init probe) succeeds:
        probe.complete(const []);
        await tester.pump();

        // Second backlog fetch (enable backlog) fails with 503:
        backlog.completeError(
          DashboardApiException(
            Uri.parse('https://dash.example/api/mesh/voice/backlog'),
            503,
            'service unavailable',
          ),
        );
        await tester.pump();
        await tester.pump();

        expect(
          find.text('Voice is not configured on this instance'),
          findsOneWidget,
        );
        expect(walkie.recorder.startCalls, 1);
        expect(walkie.recorder.cancelCalls, 1);
        await unmount(tester);
      },
    );

    testWidgets(
      'a trigger while voice starts buffers stop and sends once adopted',
      (tester) async {
        final probe = Completer<List<VoiceAnnouncement>>();
        final backlog = Completer<List<VoiceAnnouncement>>();
        api.backlogGates.addAll([probe, backlog]);
        await pumpPage(tester);
        probe.complete(const []);
        await tester.pump();

        // Trigger arrives while voice network setup is still in flight:
        assistant.triggerCtrl.add(null);
        await tester.pump();
        await tester.pump();

        // Network finishes and adoptRecording runs:
        backlog.complete(const []);
        await tester.pump();
        await tester.pump();

        expect(walkie.recorder.startCalls, 1);
        expect(walkie.recorder.stopCalls, 1);
        expect(api.memoSends, hasLength(1));
        await unmount(tester);
      },
    );

    testWidgets(
      'multiple triggers while voice starts keep stop buffered and do not toggle',
      (tester) async {
        final probe = Completer<List<VoiceAnnouncement>>();
        final backlog = Completer<List<VoiceAnnouncement>>();
        api.backlogGates.addAll([probe, backlog]);
        await pumpPage(tester);
        probe.complete(const []);
        await tester.pump();

        // Trigger twice while voice network setup is still in flight:
        assistant.triggerCtrl.add(null);
        await tester.pump();
        assistant.triggerCtrl.add(null);
        await tester.pump();

        // Network finishes and adoptRecording runs:
        backlog.complete(const []);
        await tester.pump();
        await tester.pump();

        // It should stop and send (not toggled back to recording):
        expect(walkie.recorder.startCalls, 1);
        expect(walkie.recorder.stopCalls, 1);
        expect(api.memoSends, hasLength(1));
        await unmount(tester);
      },
    );

    testWidgets(
      'stop trigger while lookup is in flight does not carry over to Retry after failure',
      (tester) async {
        final gate = Completer<ThreadsSnapshot>();
        api.threadSnapshotGates.add(gate);
        await pumpPage(tester);
        expect(walkie.recorder.startCalls, 1);

        // Stop triggered while lookup is in flight:
        assistant.triggerCtrl.add(null);
        await tester.pump();

        // Lookup fails:
        gate.completeError(Exception('network dropped'));
        await tester.pump();
        await tester.pump();

        expect(find.byKey(const ValueKey('assistant-error')), findsOneWidget);
        expect(walkie.recorder.cancelCalls, 1);

        // Pressing trigger while error screen is showing is ignored:
        assistant.triggerCtrl.add(null);
        await tester.pump();

        // User taps Retry:
        await tester.tap(find.text('Retry'));
        await tester.pump();
        await tester.pump();

        // Fresh capture started; not immediately stopped/sent:
        expect(walkie.recorder.startCalls, 2);
        expect(walkie.recorder.stopCalls, 0);
        expect(api.memoSends, isEmpty);
        await unmount(tester);
      },
    );

    testWidgets('a trigger after walkie off starts nothing', (tester) async {
      await pumpPage(tester);
      await tester.tap(find.byKey(const ValueKey('walkie-off')));
      await tester.pump();
      await tester.pump();
      expect(closed, 1);

      assistant.triggerCtrl.add(null);
      await tester.pump();
      await tester.pump();

      expect(walkie.streams, hasLength(1));
      expect(walkie.recorder.startCalls, 1);
      await unmount(tester);
    });

    testWidgets('closing while voice starts cancels capture', (tester) async {
      final probe = Completer<List<VoiceAnnouncement>>();
      api.backlogGates.add(probe);
      await pumpPage(tester);
      await unmount(tester);

      probe.complete(const []);
      await tester.pump();
      await tester.pump();

      expect(walkie.streams, isEmpty);
      expect(walkie.wakeLock.acquireCalls, 0);
      expect(walkie.recorder.startCalls, 1);
      expect(walkie.recorder.cancelCalls, 1);
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

    testWidgets(
      'plays ready cue only once capture is live, and only on assist entry',
      (tester) async {
        final micGate = Completer<void>();
        walkie.recorder.startGates.add(micGate);

        await tester.pumpWidget(
          MaterialApp(
            home: AssistantPage(
              createApi: () => api,
              createWalkieDeps: (_) => walkie.deps,
              signals: assistant,
              onClose: () {},
            ),
          ),
        );
        await tester.pump();

        // While mic is still acquiring, no ready cue has fired yet
        expect(walkie.recorder.startCalls, 1);
        expect(assistant.readyCueCalls, 0);

        // Mic finishes acquiring -> capture is now live
        micGate.complete();
        await tester.pump();
        await tester.pump();

        // Ready cue fires after capture is live
        expect(assistant.readyCueCalls, 1);
        expect(walkie.recorder.startCalls, 1);

        await unmount(tester);
      },
    );

    testWidgets('does not play ready cue if mic acquisition fails', (
      tester,
    ) async {
      walkie.recorder.startError = StateError('mic permission denied');
      await pumpPage(tester);

      expect(assistant.readyCueCalls, 0);
      expect(find.byKey(const ValueKey('assistant-error')), findsOneWidget);
      await unmount(tester);
    });

    testWidgets(
      'capture starts immediately and ready cue fires before network resolves',
      (tester) async {
        final threadsGate = Completer<ThreadsSnapshot>();
        api.threadSnapshotGates.add(threadsGate);

        await tester.pumpWidget(
          MaterialApp(
            home: AssistantPage(
              createApi: () => api,
              createWalkieDeps: (_) => walkie.deps,
              signals: assistant,
              onClose: () {},
            ),
          ),
        );

        // Before any network responds:
        // Recorder start has already completed locally and ready cue fired.
        expect(walkie.recorder.startCalls, 1);
        expect(assistant.readyCueCalls, 1);

        // Verify network is still blocked
        expect(threadsGate.isCompleted, isFalse);
        expect(walkie.streams, isEmpty);

        // Unblock network
        threadsGate.complete(
          ThreadsSnapshot(
            halted: false,
            threads: api.threadsResult,
            rootActorId: 'root',
          ),
        );
        await tester.pump();
        await tester.pump();
        await tester.pump();

        expect(walkie.streams, hasLength(1));
        await unmount(tester);
      },
    );

    testWidgets(
      'ready cue is specific to assist entry and does not fire on manual record toggle',
      (tester) async {
        await pumpPage(tester);

        // Initial assist entry fired cue once
        expect(assistant.readyCueCalls, 1);

        // User stops recording via trigger
        assistant.triggerCtrl.add(null);
        await tester.pump();
        await tester.pump();

        // User resumes recording manually via trigger
        assistant.triggerCtrl.add(null);
        await tester.pump();
        await tester.pump();

        // Ready cue must NOT fire again on subsequent manual toggles
        expect(assistant.readyCueCalls, 1);
        await unmount(tester);
      },
    );

    testWidgets(
      'locked-phone assist screen provides restricted UI only (dashboard unreachable)',
      (tester) async {
        await pumpPage(tester);

        // The assist page only renders WalkiePanel to root actor
        expect(find.byType(WalkiePanel), findsOneWidget);

        // Dashboard views, navigation drawers, and app bars are absent
        expect(find.byType(AppBar), findsNothing);
        expect(find.byType(Drawer), findsNothing);
        expect(find.text('Overview'), findsNothing);
        expect(find.text('Chat'), findsNothing);
        expect(find.text('Settings'), findsNothing);
        await unmount(tester);
      },
    );

    testWidgets(
      'stale recorder start settles cancelled directly without leaking',
      (tester) async {
        final gate = Completer<void>();
        walkie.recorder.startGates.add(gate);

        await tester.pumpWidget(
          MaterialApp(
            home: AssistantPage(
              createApi: () => api,
              createWalkieDeps: (_) => walkie.deps,
              signals: assistant,
              onClose: () {},
            ),
          ),
        );
        await tester.pump();

        // Start 1 is in flight waiting on gate
        expect(walkie.recorder.startCalls, 1);
        expect(walkie.recorder.cancelCalls, 0);

        // Screen is closed before start completes -> triggers cancellation
        await unmount(tester);
        expect(walkie.recorder.cancelCalls, 1);

        // Start completes asynchronously after unmount
        gate.complete();
        await tester.pump();

        // Cancelled cleanly, did not fire ready cue
        expect(assistant.readyCueCalls, 0);
      },
    );
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

    test('plays ready cue via platform channel', () async {
      final assistant = IoAssistantChannel(channel: channel);
      await assistant.playReadyCue();
      expect(calls, ['playReadyCue']);
    });
  });
}
