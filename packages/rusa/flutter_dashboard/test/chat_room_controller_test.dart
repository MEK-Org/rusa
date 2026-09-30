import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:rusa_dashboard/chat_room_controller.dart';
import 'package:rusa_dashboard/models.dart';
import 'package:rusa_dashboard/walkie_controller.dart';

import 'fakes.dart';

void main() {
  late FakeApi api;
  late FakeWalkie walkie;
  late ChatRoomController controller;

  setUp(() {
    api = FakeApi();
    walkie = FakeWalkie(api);
    controller = ChatRoomController(
      initialParticipants: const ['root', 'actor-b'],
      deps: walkie.deps,
    );
  });

  tearDown(() async {
    await controller.dispose();
  });

  test(
    'opens one multi-actor presence stream without a leased session',
    () async {
      await controller.enable();
      await pumpEventQueue();

      expect(controller.enabled.value, isTrue);
      expect(walkie.stream.connectCalls, hasLength(1));
      expect(walkie.stream.connectCalls.single.actors, ['root', 'actor-b']);
      expect(walkie.stream.connectCalls.single.sessionId, isNull);
      expect(walkie.player.primeCalls, 1);
      expect(walkie.wakeLock.acquireCalls, 1);

      await controller.disable();
      expect(api.disabledVoiceSessions, isEmpty);
    },
  );

  test(
    'captures the first avatar recipient and cannot retarget mid-recording',
    () async {
      await controller.tapParticipant('root');
      await pumpEventQueue();

      expect(controller.record.value.phase, RecordPhase.recording);
      expect(controller.recordingRecipient.value, 'root');

      await controller.tapParticipant('actor-b');
      await pumpEventQueue();
      expect(api.memoSends, isEmpty);
      expect(controller.recordingRecipient.value, 'root');
      expect(controller.lastError.value, contains('Tap its avatar to send'));

      await controller.tapParticipant('root');
      await pumpEventQueue();
      expect(api.memoSends, hasLength(1));
      expect(api.memoSends.single.actorId, 'root');
      expect(api.memoSends.single.sessionId, isNull);
      expect(controller.lastError.value, isNull);
    },
  );

  test(
    'recording pauses shared playback and resumes the same reply afterward',
    () async {
      await controller.enable();
      await pumpEventQueue();
      walkie.stream.framesCtrl.add(makeAnnouncement('reply-a', actor: 'root'));
      await pumpEventQueue();

      expect(walkie.player.playedUrls, ['/api/mesh/voice/audio/reply-a']);
      expect(controller.nowPlaying.value?.id, 'reply-a');

      await controller.tapParticipant('actor-b');
      await pumpEventQueue();
      expect(controller.record.value.phase, RecordPhase.recording);
      expect(api.ackedIds, isEmpty);
      expect(controller.nowPlaying.value, isNull);

      await controller.tapParticipant('actor-b');
      await pumpEventQueue();
      expect(walkie.player.playedUrls, [
        '/api/mesh/voice/audio/reply-a',
        '/api/mesh/voice/audio/reply-a',
      ]);
      expect(api.memoSends.single.actorId, 'actor-b');

      walkie.player.finishCurrent();
      await pumpEventQueue();
      expect(api.ackedIds, ['reply-a']);
    },
  );

  test(
    'incoming replies from room actors share one FIFO playback queue',
    () async {
      await controller.enable();
      await pumpEventQueue();

      walkie.stream.framesCtrl.add(makeAnnouncement('one', actor: 'root'));
      walkie.stream.framesCtrl.add(makeAnnouncement('two', actor: 'actor-b'));
      await pumpEventQueue();

      expect(walkie.player.playedUrls, ['/api/mesh/voice/audio/one']);
      expect(controller.queueDepth.value, 1);

      walkie.player.finishCurrent();
      await pumpEventQueue();
      expect(api.ackedIds, ['one']);
      expect(walkie.player.playedUrls.last, '/api/mesh/voice/audio/two');

      walkie.player.finishCurrent();
      await pumpEventQueue();
      expect(api.ackedIds, ['one', 'two']);
    },
  );

  test('cancelling discards a recording and resumes queued playback', () async {
    await controller.enable();
    await pumpEventQueue();
    walkie.stream.framesCtrl.add(makeAnnouncement('reply-a', actor: 'root'));
    await pumpEventQueue();

    await controller.tapParticipant('actor-b');
    await pumpEventQueue();
    await controller.tapParticipant('root');
    await pumpEventQueue();
    expect(controller.lastError.value, isNotNull);
    await controller.cancelRecord();
    await pumpEventQueue();

    expect(controller.lastError.value, isNull);
    expect(api.memoSends, isEmpty);
    expect(walkie.recorder.cancelCalls, 1);
    expect(walkie.player.playedUrls, [
      '/api/mesh/voice/audio/reply-a',
      '/api/mesh/voice/audio/reply-a',
    ]);
  });

  test(
    'a rejected microphone start still resumes the interrupted reply',
    () async {
      await controller.enable();
      await pumpEventQueue();
      walkie.stream.framesCtrl.add(makeAnnouncement('reply-a', actor: 'root'));
      await pumpEventQueue();

      walkie.recorder.startError = StateError('permission denied');
      await controller.tapParticipant('actor-b');
      await pumpEventQueue();

      expect(controller.record.value.phase, RecordPhase.error);
      expect(walkie.player.playedUrls, [
        '/api/mesh/voice/audio/reply-a',
        '/api/mesh/voice/audio/reply-a',
      ]);
    },
  );

  test(
    'cancelling while recorder start is pending discards recording and does not revive',
    () async {
      final startCompleter = Completer<void>();
      walkie.recorder.startCompleter = startCompleter;

      final tapFuture = controller.tapParticipant('root');
      await pumpEventQueue();

      expect(controller.record.value.phase, RecordPhase.starting);
      expect(controller.recordingRecipient.value, 'root');

      await controller.cancelRecord();
      await pumpEventQueue();

      expect(controller.record.value.phase, RecordPhase.idle);
      expect(controller.recordingRecipient.value, isNull);

      startCompleter.complete();
      await tapFuture;
      await pumpEventQueue();

      expect(controller.record.value.phase, RecordPhase.idle);
      expect(controller.recordingRecipient.value, isNull);
      expect(walkie.recorder.cancelCalls, greaterThanOrEqualTo(1));
    },
  );

  test(
    'live frames arriving during backlog fetch are queued and played in chronological order after backlog completes',
    () async {
      final backlogGate = Completer<List<VoiceAnnouncement>>();
      api.backlogGates.add(backlogGate);
      api.backlogPages.add(const []);

      final enableFuture = controller.enable();
      await pumpEventQueue();

      // Live frame arrives with later timestamp while backlog is still pending.
      walkie.stream.framesCtrl.add(
        makeAnnouncement(
          'live-late',
          actor: 'root',
          createdAt: '2026-07-17T00:00:10Z',
        ),
      );
      await pumpEventQueue();

      // Drain should not play yet because backlog fetch is in progress.
      expect(walkie.player.playedUrls, isEmpty);

      // Complete backlog with an earlier frame.
      backlogGate.complete([
        makeAnnouncement(
          'backlog-early',
          actor: 'root',
          createdAt: '2026-07-17T00:00:01Z',
        ),
      ]);
      await enableFuture;
      await pumpEventQueue();

      // The earlier backlog frame must play first!
      expect(walkie.player.playedUrls, [
        '/api/mesh/voice/audio/backlog-early',
      ]);
      expect(controller.queueDepth.value, 1);

      walkie.player.finishCurrent();
      await pumpEventQueue();

      // Then the later live frame plays.
      expect(walkie.player.playedUrls.last, '/api/mesh/voice/audio/live-late');
      expect(api.ackedIds, ['backlog-early']);

      walkie.player.finishCurrent();
      await pumpEventQueue();
      expect(api.ackedIds, ['backlog-early', 'live-late']);
    },
  );

  test(
    'complete user sequence: send to A, send to B, play both replies in arrival order',
    () async {
      await controller.enable();
      await pumpEventQueue();

      // 1. Record and send to actor A (root).
      await controller.tapParticipant('root');
      await pumpEventQueue();
      expect(controller.record.value.phase, RecordPhase.recording);
      expect(controller.recordingRecipient.value, 'root');

      await controller.tapParticipant('root');
      await pumpEventQueue();
      expect(api.memoSends, hasLength(1));
      expect(api.memoSends.single.actorId, 'root');

      // 2. Record and send to actor B (actor-b).
      await controller.tapParticipant('actor-b');
      await pumpEventQueue();
      expect(controller.record.value.phase, RecordPhase.recording);
      expect(controller.recordingRecipient.value, 'actor-b');

      await controller.tapParticipant('actor-b');
      await pumpEventQueue();
      expect(api.memoSends, hasLength(2));
      expect(api.memoSends.last.actorId, 'actor-b');

      // 3. Receive replies from both root and actor-b.
      walkie.stream.framesCtrl.add(
        makeAnnouncement(
          'reply-from-a',
          actor: 'root',
          createdAt: '2026-07-17T00:01:00Z',
        ),
      );
      walkie.stream.framesCtrl.add(
        makeAnnouncement(
          'reply-from-b',
          actor: 'actor-b',
          createdAt: '2026-07-17T00:01:05Z',
        ),
      );
      await pumpEventQueue();

      // 4. Replies play without overlap in arrival order.
      expect(walkie.player.playedUrls, [
        '/api/mesh/voice/audio/reply-from-a',
      ]);
      expect(controller.nowPlaying.value?.id, 'reply-from-a');

      walkie.player.finishCurrent();
      await pumpEventQueue();
      expect(api.ackedIds, ['reply-from-a']);
      expect(walkie.player.playedUrls.last, '/api/mesh/voice/audio/reply-from-b');
      expect(controller.nowPlaying.value?.id, 'reply-from-b');

      walkie.player.finishCurrent();
      await pumpEventQueue();
      expect(api.ackedIds, ['reply-from-a', 'reply-from-b']);
    },
  );
}
