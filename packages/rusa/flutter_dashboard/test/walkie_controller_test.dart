import 'package:flutter_test/flutter_test.dart';
import 'package:rusa_dashboard/api.dart';
import 'package:rusa_dashboard/voice_platform.dart';
import 'package:rusa_dashboard/walkie_controller.dart';

import 'fakes.dart';

DashboardApiException apiError(int status, [String body = '{}']) =>
    DashboardApiException(Uri.parse('/voice'), status, body);

void main() {
  late FakeApi api;
  late FakeWalkie walkie;
  late WalkieController controller;

  setUp(() {
    api = FakeApi();
    walkie = FakeWalkie(api);
    controller = WalkieController(actorId: 'a', deps: walkie.deps);
  });

  tearDown(() async {
    await controller.dispose();
  });

  group('toggle lifecycle', () {
    test('enable opens the voice SSE stream, primes autoplay, grabs the wake '
        'lock, and fetches the backlog', () async {
      await controller.enable();
      await pumpEventQueue();

      expect(controller.enabled.value, isTrue);
      expect(walkie.streams, hasLength(1));
      expect(walkie.stream.connectCalls, [
        ['a'],
      ]);
      expect(walkie.player.primeCalls, 1);
      expect(walkie.wakeLock.acquireCalls, 1);
      expect(api.backlogCalls, 1);
      expect(controller.connection.value, WalkieConnection.connecting);

      walkie.stream.statusCtrl.add(VoiceStreamStatus.connected);
      await pumpEventQueue();
      expect(controller.connection.value, WalkieConnection.connected);
    });

    test('disable closes the stream (presence teardown) and releases the wake '
        'lock', () async {
      await controller.enable();
      await pumpEventQueue();
      await controller.disable();

      expect(controller.enabled.value, isFalse);
      expect(controller.connection.value, WalkieConnection.off);
      expect(walkie.stream.disposed, isTrue);
      expect(walkie.wakeLock.releaseCalls, 1);
    });

    test('dispose (leaving the screen) tears the mode down', () async {
      await controller.enable();
      await pumpEventQueue();
      await controller.dispose();

      expect(walkie.stream.disposed, isTrue);
      expect(walkie.wakeLock.releaseCalls, 1);
    });

    test('disable mid-recording cancels the recorder', () async {
      await controller.enable();
      await pumpEventQueue();
      await controller.toggleRecord();
      await pumpEventQueue();
      expect(controller.record.value.phase, RecordPhase.recording);

      await controller.disable();
      expect(walkie.recorder.cancelCalls, greaterThanOrEqualTo(1));
      expect(controller.record.value.phase, RecordPhase.idle);
    });

    test('each mode entry creates a fresh stream', () async {
      await controller.enable();
      await pumpEventQueue();
      await controller.disable();
      await controller.enable();
      await pumpEventQueue();
      expect(walkie.streams, hasLength(2));
      expect(walkie.streams[0].disposed, isTrue);
      expect(walkie.streams[1].disposed, isFalse);
    });
  });

  group('playback queue', () {
    test(
      'backlog + SSE frames play in order, acked only after each finishes',
      () async {
        api.backlogPages = [
          [makeAnnouncement('m1'), makeAnnouncement('m2')],
        ];
        await controller.enable();
        await pumpEventQueue();

        // m1 playing, m2 queued; nothing acked yet.
        expect(walkie.player.playedUrls, ['/api/mesh/voice/audio/m1']);
        expect(controller.nowPlaying.value?.id, 'm1');
        expect(controller.queueDepth.value, 1);
        expect(api.ackedIds, isEmpty);

        // A live frame arrives while playing: goes to the back of the queue.
        walkie.stream.framesCtrl.add(makeAnnouncement('m3'));
        await pumpEventQueue();
        expect(controller.queueDepth.value, 2);

        walkie.player.finishCurrent();
        await pumpEventQueue();
        expect(api.ackedIds, ['m1']);
        expect(walkie.player.playedUrls.last, '/api/mesh/voice/audio/m2');

        walkie.player.finishCurrent();
        await pumpEventQueue();
        walkie.player.finishCurrent();
        await pumpEventQueue();
        expect(api.ackedIds, ['m1', 'm2', 'm3']);
        expect(controller.nowPlaying.value, isNull);
        expect(controller.lastPlayed.value?.id, 'm3');
        expect(controller.queueDepth.value, 0);
      },
    );

    test(
      'duplicate announcement ids are dropped (SSE vs backlog overlap)',
      () async {
        api.backlogPages = [
          [makeAnnouncement('m1')],
        ];
        await controller.enable();
        await pumpEventQueue();

        walkie.stream.framesCtrl.add(makeAnnouncement('m1'));
        await pumpEventQueue();
        expect(walkie.player.playedUrls, hasLength(1));
        expect(controller.queueDepth.value, 0);
      },
    );

    test('frames for another actor are ignored', () async {
      await controller.enable();
      await pumpEventQueue();
      walkie.stream.framesCtrl.add(makeAnnouncement('x1', actor: 'other'));
      await pumpEventQueue();
      expect(walkie.player.playedUrls, isEmpty);
    });

    test('skip completes the current announcement and still acks it', () async {
      api.backlogPages = [
        [makeAnnouncement('m1'), makeAnnouncement('m2')],
      ];
      await controller.enable();
      await pumpEventQueue();
      expect(controller.nowPlaying.value?.id, 'm1');

      controller.skip();
      await pumpEventQueue();
      expect(api.ackedIds, ['m1']);
      expect(controller.nowPlaying.value?.id, 'm2');
    });

    test('replayLast replays without re-acking', () async {
      api.backlogPages = [
        [makeAnnouncement('m1')],
      ];
      await controller.enable();
      await pumpEventQueue();
      walkie.player.finishCurrent();
      await pumpEventQueue();
      expect(api.ackedIds, ['m1']);

      controller.replayLast();
      await pumpEventQueue();
      expect(walkie.player.playedUrls, [
        '/api/mesh/voice/audio/m1',
        '/api/mesh/voice/audio/m1',
      ]);
      walkie.player.finishCurrent();
      await pumpEventQueue();
      expect(api.ackedIds, ['m1']); // no second ack
    });

    test(
      'a playback failure surfaces on lastError and the queue advances',
      () async {
        api.backlogPages = [
          [makeAnnouncement('m1'), makeAnnouncement('m2')],
        ];
        await controller.enable();
        await pumpEventQueue();

        walkie.player.failCurrent();
        await pumpEventQueue();
        expect(controller.lastError.value, contains('Playback failed'));
        expect(controller.nowPlaying.value?.id, 'm2');
      },
    );

    test(
      'turning the mode off mid-play does not ack the interrupted item',
      () async {
        api.backlogPages = [
          [makeAnnouncement('m1')],
        ];
        await controller.enable();
        await pumpEventQueue();
        expect(controller.nowPlaying.value?.id, 'm1');

        await controller.disable();
        await pumpEventQueue();
        expect(api.ackedIds, isEmpty);
      },
    );
  });

  group('reconnect', () {
    test('re-fetches the backlog after a drop and dedupes the merge', () async {
      api.backlogPages = [
        [makeAnnouncement('m1')],
        [makeAnnouncement('m1'), makeAnnouncement('m2')],
      ];
      await controller.enable();
      await pumpEventQueue();
      expect(api.backlogCalls, 1);

      walkie.stream.statusCtrl.add(VoiceStreamStatus.connected);
      await pumpEventQueue();
      // First connect is not a reconnect — no extra fetch.
      expect(api.backlogCalls, 1);

      walkie.stream.statusCtrl.add(VoiceStreamStatus.reconnecting);
      await pumpEventQueue();
      expect(controller.connection.value, WalkieConnection.reconnecting);

      walkie.stream.statusCtrl.add(VoiceStreamStatus.connected);
      await pumpEventQueue();
      expect(controller.connection.value, WalkieConnection.connected);
      expect(api.backlogCalls, 2);

      // m1 (already queued/playing) deduped; only m2 was added.
      expect(controller.nowPlaying.value?.id, 'm1');
      expect(controller.queueDepth.value, 1);
      walkie.player.finishCurrent();
      await pumpEventQueue();
      walkie.player.finishCurrent();
      await pumpEventQueue();
      expect(api.ackedIds, ['m1', 'm2']);
    });
  });

  group('record flow', () {
    setUp(() async {
      await controller.enable();
      await pumpEventQueue();
    });

    test(
      'tap → recording, tap → sending → delivered with transcript',
      () async {
        await controller.toggleRecord();
        expect(controller.record.value.phase, RecordPhase.recording);
        expect(walkie.recorder.startCalls, 1);

        await controller.toggleRecord();
        await pumpEventQueue();
        expect(walkie.recorder.stopCalls, 1);
        expect(api.memoSends, hasLength(1));
        expect(api.memoSends.single.actorId, 'a');
        expect(api.memoSends.single.byteLength, 3);
        expect(api.memoSends.single.mimeType, 'audio/webm;codecs=opus');
        expect(controller.record.value.phase, RecordPhase.delivered);
        expect(controller.record.value.transcript, 'hello');
        expect(controller.record.value.delivered, isTrue);
      },
    );

    test('mic failure lands in the error phase', () async {
      walkie.recorder.startError = StateError('denied');
      await controller.toggleRecord();
      expect(controller.record.value.phase, RecordPhase.error);
      expect(controller.record.value.message, contains('Mic unavailable'));
    });

    test(
      'a 502 (transcription failed, audio saved) is called out as such',
      () async {
        api.memoError = apiError(
          502,
          '{"error":"transcription failed: boom","audioSaved":true}',
        );
        await controller.toggleRecord();
        await controller.toggleRecord();
        await pumpEventQueue();
        expect(controller.record.value.phase, RecordPhase.error);
        expect(controller.record.value.message, contains('audio saved'));
        expect(
          controller.record.value.message,
          contains('transcription failed: boom'),
        );
      },
    );

    test('a plain send failure lands in the error phase and recording can '
        'restart', () async {
      api.memoError = apiError(500, '{"error":"kaput"}');
      await controller.toggleRecord();
      await controller.toggleRecord();
      await pumpEventQueue();
      expect(controller.record.value.phase, RecordPhase.error);
      expect(controller.record.value.message, contains('kaput'));

      api.memoError = null;
      await controller.toggleRecord();
      expect(controller.record.value.phase, RecordPhase.recording);
    });

    test('cancelRecord aborts recording and resets to idle ', () async {
      await controller.toggleRecord();
      expect(controller.record.value.phase, RecordPhase.recording);
      expect(walkie.recorder.startCalls, 1);

      await controller.cancelRecord();
      expect(walkie.recorder.cancelCalls, 1);
      expect(controller.record.value.phase, RecordPhase.idle);
      expect(api.memoSends, isEmpty);
    });
  });

  group('voice unavailable (503)', () {
    test('init probe: 503 marks the instance unavailable and caches it on the '
        'shared deps', () async {
      api.backlogError = apiError(503, '{"error":"voice unavailable"}');
      await controller.init();
      expect(controller.available.value, isFalse);
      expect(walkie.deps.voiceAvailable, isFalse);

      // A second controller (another actor's chat) starts pre-disabled
      // without re-probing.
      final other = WalkieController(actorId: 'b', deps: walkie.deps);
      expect(other.available.value, isFalse);
      final callsBefore = api.backlogCalls;
      await other.init();
      expect(api.backlogCalls, callsBefore);
      await other.dispose();
    });

    test('init probe: success marks available', () async {
      await controller.init();
      expect(controller.available.value, isTrue);
    });

    test('init probe: a network error leaves availability unknown', () async {
      api.backlogError = apiError(500, 'boom');
      await controller.init();
      expect(controller.available.value, isNull);
    });

    test('enable is refused once unavailable', () async {
      api.backlogError = apiError(503, '{}');
      await controller.init();
      await controller.enable();
      expect(controller.enabled.value, isFalse);
      expect(walkie.streams, isEmpty);
    });

    test('a 503 mid-mode (backlog) disables the mode', () async {
      await controller.enable();
      await pumpEventQueue();
      expect(controller.enabled.value, isTrue);

      api.backlogError = apiError(503, '{}');
      walkie.stream.statusCtrl.add(VoiceStreamStatus.reconnecting);
      await pumpEventQueue();
      walkie.stream.statusCtrl.add(VoiceStreamStatus.connected);
      await pumpEventQueue();

      expect(controller.available.value, isFalse);
      expect(controller.enabled.value, isFalse);
      expect(walkie.stream.disposed, isTrue);
    });
  });
}
