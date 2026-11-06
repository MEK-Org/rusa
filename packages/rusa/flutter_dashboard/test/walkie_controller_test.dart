import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:rusa_dashboard/api.dart';
import 'package:rusa_dashboard/models.dart';
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
      expect(walkie.stream.connectCalls.single.actors, ['a']);
      expect(
        walkie.stream.connectCalls.single.sessionId,
        matches(
          RegExp(
            r'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
          ),
        ),
      );
      expect(walkie.player.primeCalls, 1);
      expect(walkie.wakeLock.acquireCalls, 1);
      expect(api.backlogCalls, 1);
      expect(controller.connection.value, WalkieConnection.connecting);

      walkie.stream.statusCtrl.add(VoiceStreamStatus.connected);
      await pumpEventQueue();
      expect(controller.connection.value, WalkieConnection.connected);
    });

    test(
      'an Android assistant session carries the durable reply marker',
      () async {
        await controller.dispose();
        controller = WalkieController(
          actorId: 'a',
          deps: walkie.deps,
          androidAssistantSession: true,
        );

        await controller.enable();
        await pumpEventQueue();

        expect(
          walkie.stream.connectCalls.single.sessionId,
          matches(
            RegExp(
              r'^android-assistant:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
            ),
          ),
        );
      },
    );

    test('disable closes the stream (presence teardown) and releases the wake '
        'lock', () async {
      await controller.enable();
      await pumpEventQueue();
      await controller.disable();

      expect(controller.enabled.value, isFalse);
      expect(controller.connection.value, WalkieConnection.off);
      expect(walkie.stream.disposed, isTrue);
      expect(walkie.wakeLock.releaseCalls, 1);
      expect(api.disabledVoiceSessions, [
        walkie.stream.connectCalls.single.sessionId,
      ]);
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

    test(
      'server handoff selects and reconnects to the recipient without closing the session',
      () async {
        await controller.dispose();
        final selected = <String>[];
        controller = WalkieController(
          actorId: 'a',
          deps: walkie.deps,
          onTransfer: selected.add,
        );
        await controller.enable();
        await pumpEventQueue();
        final first = walkie.stream;
        final sessionId = first.connectCalls.single.sessionId;

        first.controlsCtrl.add(const VoiceSessionControl(targetActorId: 'b'));
        await pumpEventQueue();

        expect(controller.actorId, 'b');
        expect(selected, ['b']);
        expect(first.disposed, isTrue);
        expect(walkie.streams, hasLength(2));
        expect(walkie.stream.connectCalls.single.actors, ['b']);
        expect(walkie.stream.connectCalls.single.sessionId, sessionId);
        expect(api.disabledVoiceSessions, isEmpty);
      },
    );

    test(
      'reply-then-transfer recovers and acks each source backlog clip once in both directions',
      () async {
        api.backlogPages = [
          const [],
          [makeAnnouncement('handoff-a', actor: 'a')],
          const [],
          [makeAnnouncement('handoff-b', actor: 'b')],
          const [],
        ];
        await controller.enable();
        await pumpEventQueue();

        walkie.stream.controlsCtrl.add(
          const VoiceSessionControl(targetActorId: 'b'),
        );
        await pumpEventQueue();

        expect(api.backlogActorIds, ['a', 'a', 'b']);
        expect(walkie.player.playedUrls, ['/api/mesh/voice/audio/handoff-a']);
        // A late non-backlog frame for the source remains stale after the handoff.
        walkie.stream.framesCtrl.add(makeAnnouncement('stale-a', actor: 'a'));
        await pumpEventQueue();
        expect(walkie.player.playedUrls, ['/api/mesh/voice/audio/handoff-a']);

        walkie.player.finishCurrent();
        await pumpEventQueue();
        expect(api.ackedIds, ['handoff-a']);

        walkie.stream.controlsCtrl.add(
          const VoiceSessionControl(targetActorId: 'a'),
        );
        await pumpEventQueue();

        expect(api.backlogActorIds, ['a', 'a', 'b', 'b', 'a']);
        expect(walkie.player.playedUrls, [
          '/api/mesh/voice/audio/handoff-a',
          '/api/mesh/voice/audio/handoff-b',
        ]);
        walkie.player.finishCurrent();
        await pumpEventQueue();

        expect(api.ackedIds, ['handoff-a', 'handoff-b']);
        expect(controller.lastError.value, isNull);
      },
    );

    test(
      'handoff recovery keeps source audio ahead of target backlog and SSE',
      () async {
        await controller.enable();
        await pumpEventQueue();

        final sourceBacklog = Completer<List<VoiceAnnouncement>>();
        final targetBacklog = Completer<List<VoiceAnnouncement>>();
        api.backlogGates.addAll([sourceBacklog, targetBacklog]);

        walkie.stream.controlsCtrl.add(
          const VoiceSessionControl(targetActorId: 'b'),
        );
        await pumpEventQueue();
        expect(api.backlogActorIds, ['a', 'a']);

        // The new actor can speak as soon as its stream connects, but it must
        // wait behind the source recovery that causally precedes the handoff.
        walkie.stream.framesCtrl.add(makeAnnouncement('live-b', actor: 'b'));
        await pumpEventQueue();
        expect(walkie.player.playedUrls, isEmpty);

        sourceBacklog.complete([makeAnnouncement('handoff-a', actor: 'a')]);
        await pumpEventQueue();
        expect(walkie.player.playedUrls, ['/api/mesh/voice/audio/handoff-a']);
        expect(api.backlogActorIds, ['a', 'a', 'b']);

        targetBacklog.complete([makeAnnouncement('backlog-b', actor: 'b')]);
        await pumpEventQueue();
        walkie.player.finishCurrent();
        await pumpEventQueue();
        expect(walkie.player.playedUrls, [
          '/api/mesh/voice/audio/handoff-a',
          '/api/mesh/voice/audio/backlog-b',
        ]);

        walkie.player.finishCurrent();
        await pumpEventQueue();
        expect(walkie.player.playedUrls.last, '/api/mesh/voice/audio/live-b');
      },
    );
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

    test(
      'history restoration skips a reply already received from the live stream',
      () async {
        await controller.enable();
        controller.suspendPlayback();
        walkie.stream.framesCtrl.add(makeAnnouncement('durable-reply'));
        await pumpEventQueue();

        controller.restoreConversation([
          makeChat('durable-reply', sender: 'a', body: 'The durable answer'),
        ]);

        expect(
          controller.transcript.value
              .where(
                (entry) => switch (entry) {
                  ActorReplyEntry(:final announcement) =>
                    announcement.id == 'durable-reply',
                  HistoricalChatEntry(:final id) => id == 'durable-reply',
                  UserMemoEntry() => false,
                },
              )
              .toList(),
          hasLength(1),
        );
      },
    );

    test(
      'history restoration skips only its matching retained voice memo',
      () async {
        await controller.enable();
        api.memoResult = const VoiceMemoResult(
          transcript: 'same words',
          delivered: true,
        );
        await controller.toggleRecord();
        await controller.toggleRecord();
        await pumpEventQueue();
        controller.restoreConversation([
          makeChat(
            'memo-1',
            sender: 'user',
            body: '🎙️ [voice memo — reply for the ear]: same words',
          ),
          makeChat('ordinary-chat', sender: 'user', body: 'same words'),
        ]);

        expect(
          controller.transcript.value.whereType<HistoricalChatEntry>().map(
            (entry) => entry.id,
          ),
          ['ordinary-chat'],
        );
      },
    );

    test(
      'history places a matching local memo in durable chronology',
      () async {
        await controller.enable();
        api.memoResult = const VoiceMemoResult(
          transcript: 'middle',
          delivered: true,
        );
        await controller.toggleRecord();
        await controller.toggleRecord();
        await pumpEventQueue();

        controller.restoreConversation([
          MeshChat(
            id: 'before',
            ts: DateTime.utc(2026, 1, 1),
            senderId: 'a',
            recipientId: 'user',
            body: 'Before',
            sessionId: null,
          ),
          MeshChat(
            id: 'memo',
            ts: DateTime.utc(2026, 1, 2),
            senderId: 'user',
            recipientId: 'a',
            body: '🎙️ [voice memo — reply for the ear]: middle',
            sessionId: null,
          ),
          MeshChat(
            id: 'after',
            ts: DateTime.utc(2026, 1, 3),
            senderId: 'a',
            recipientId: 'user',
            body: 'After',
            sessionId: null,
          ),
        ]);

        expect(
          controller.transcript.value.map(
            (entry) => switch (entry) {
              HistoricalChatEntry(:final id) => id,
              UserMemoEntry() => 'local-memo',
              ActorReplyEntry(:final announcement) => announcement.id,
            },
          ),
          ['before', 'local-memo', 'after'],
        );
      },
    );

    test(
      'history places an unmatched retained old row in chronological position',
      () async {
        await controller.enable();
        api.memoResult = const VoiceMemoResult(
          transcript: 'old memo',
          delivered: true,
        );
        await controller.toggleRecord();
        await controller.toggleRecord();
        await pumpEventQueue();

        final baseTime = DateTime.now();
        controller.restoreConversation([
          MeshChat(
            id: 'newer-1',
            ts: baseTime.add(const Duration(minutes: 5)),
            senderId: 'a',
            recipientId: 'user',
            body: 'Newer 1',
            sessionId: null,
          ),
          MeshChat(
            id: 'newer-2',
            ts: baseTime.add(const Duration(minutes: 10)),
            senderId: 'a',
            recipientId: 'user',
            body: 'Newer 2',
            sessionId: null,
          ),
        ]);

        expect(
          controller.transcript.value.map(
            (entry) => switch (entry) {
              HistoricalChatEntry(:final id) => id,
              UserMemoEntry() => 'old-local-memo',
              ActorReplyEntry(:final announcement) => announcement.id,
            },
          ),
          ['old-local-memo', 'newer-1', 'newer-2'],
        );
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
      'Replay targets received B after completed A when B is stalled mid-play',
      () async {
        api.backlogPages = [
          [makeAnnouncement('a')],
        ];
        await controller.enable();
        await pumpEventQueue();

        // A completes, then B arrives and begins playback but never finishes.
        walkie.player.finishCurrent();
        await pumpEventQueue();
        walkie.stream.framesCtrl.add(makeAnnouncement('b'));
        await pumpEventQueue();
        expect(controller.nowPlaying.value?.id, 'b');

        // Replay must restart the most recently received reply (B), rather
        // than the most recently completed reply (A).
        controller.replayLast();
        await pumpEventQueue();

        expect(walkie.player.playedUrls, [
          '/api/mesh/voice/audio/a',
          '/api/mesh/voice/audio/b',
          '/api/mesh/voice/audio/b',
        ]);
        expect(controller.nowPlaying.value?.id, 'b');
        final replies = controller.transcript.value
            .whereType<ActorReplyEntry>()
            .map((entry) => entry.announcement.id)
            .toList();
        expect(replies, ['a', 'b']);
      },
    );

    test(
      'Replay skips a later user memo and targets the latest reply',
      () async {
        api.backlogPages = [
          [makeAnnouncement('a')],
        ];
        await controller.enable();
        await pumpEventQueue();
        walkie.player.finishCurrent();
        await pumpEventQueue();

        // A memo recorded after A is the newest transcript row, but it is not
        // a reply, so Replay must still choose A.
        await controller.toggleRecord();
        await controller.toggleRecord();
        await pumpEventQueue();
        expect(controller.transcript.value.last, isA<UserMemoEntry>());

        controller.replayLast();
        await pumpEventQueue();
        expect(walkie.player.playedUrls, [
          '/api/mesh/voice/audio/a',
          '/api/mesh/voice/audio/a',
        ]);
        expect(controller.nowPlaying.value?.id, 'a');
      },
    );

    test(
      'replaying a reply still waiting in the queue keeps its first-play ack',
      () async {
        api.backlogPages = [
          [makeAnnouncement('b'), makeAnnouncement('c')],
        ];
        await controller.enable();
        await pumpEventQueue();
        expect(controller.nowPlaying.value?.id, 'b');

        // C has been received but never started. Tapping it is its first
        // playback, so the server acknowledgement must still happen.
        controller.replayAnnouncement(makeAnnouncement('c'));
        await pumpEventQueue();
        expect(controller.nowPlaying.value?.id, 'c');
        walkie.player.finishCurrent();
        await pumpEventQueue();

        expect(walkie.player.playedUrls, [
          '/api/mesh/voice/audio/b',
          '/api/mesh/voice/audio/c',
        ]);
        expect(api.ackedIds, ['b', 'c']);
      },
    );

    test(
      'a notification reply moves ahead of suspended older audio and acks once',
      () async {
        api.backlogPages = [
          [makeAnnouncement('old-a'), makeAnnouncement('old-b')],
        ];
        await controller.enable();
        await pumpEventQueue();
        expect(controller.nowPlaying.value?.id, 'old-a');

        controller.suspendPlayback();
        await pumpEventQueue();
        controller.presentNotificationReply(makeAnnouncement('selected'));
        controller.resumePlayback();
        await pumpEventQueue();

        expect(walkie.player.playedUrls, [
          '/api/mesh/voice/audio/old-a',
          '/api/mesh/voice/audio/selected',
        ]);
        expect(controller.nowPlaying.value?.id, 'selected');
        walkie.player.finishCurrent();
        await pumpEventQueue();
        expect(api.ackedIds, ['selected']);
        expect(
          walkie.player.playedUrls,
          ['/api/mesh/voice/audio/old-a', '/api/mesh/voice/audio/selected'],
          reason: 'a notification tap must not drain older suspended audio',
        );
      },
    );

    test(
      'recording and sending a new memo lifts suspension so new replies play',
      () async {
        api.backlogPages = [
          [makeAnnouncement('old-a'), makeAnnouncement('old-b')],
        ];
        await controller.enable();
        await pumpEventQueue();
        controller.suspendPlayback();
        await pumpEventQueue();
        controller.presentNotificationReply(makeAnnouncement('selected'));
        controller.resumePlayback();
        await pumpEventQueue();
        walkie.player.finishCurrent();
        await pumpEventQueue();

        await controller.toggleRecord();
        await pumpEventQueue();
        await controller.toggleRecord();
        await pumpEventQueue();

        walkie.stream.framesCtrl.add(makeAnnouncement('new-reply'));
        await pumpEventQueue();

        expect(controller.nowPlaying.value?.id, 'new-reply');
        expect(walkie.player.playedUrls, [
          '/api/mesh/voice/audio/old-a',
          '/api/mesh/voice/audio/selected',
          '/api/mesh/voice/audio/new-reply',
        ]);
      },
    );

    test('a disposed controller ignores a record tap', () async {
      await controller.enable();
      await pumpEventQueue();
      await controller.dispose();

      await controller.toggleRecord();
      await pumpEventQueue();

      expect(walkie.recorder.startCalls, 0);
    });

    test(
      'an ordinary memo send keeps replies queued behind the current one',
      () async {
        await controller.enable();
        await pumpEventQueue();
        walkie.stream.framesCtrl.add(makeAnnouncement('m1'));
        walkie.stream.framesCtrl.add(makeAnnouncement('m2'));
        await pumpEventQueue();
        expect(controller.nowPlaying.value?.id, 'm1');
        expect(controller.queueDepth.value, 1);

        await controller.toggleRecord();
        await pumpEventQueue();
        await controller.toggleRecord();
        await pumpEventQueue();

        expect(controller.queueDepth.value, 1);
        walkie.player.finishCurrent();
        await pumpEventQueue();
        expect(controller.nowPlaying.value?.id, 'm2');
      },
    );

    test('a memo sent during the selected reply clears its boundary', () async {
      await controller.enable();
      await pumpEventQueue();
      controller.suspendPlayback();
      walkie.stream.framesCtrl.add(makeAnnouncement('older'));
      await pumpEventQueue();
      controller.presentNotificationReply(makeAnnouncement('selected'));
      controller.resumePlayback();
      await pumpEventQueue();
      expect(controller.nowPlaying.value?.id, 'selected');

      await controller.toggleRecord();
      await pumpEventQueue();
      await controller.toggleRecord();
      await pumpEventQueue();
      expect(controller.queueDepth.value, 0);

      walkie.player.finishCurrent();
      await pumpEventQueue();
      walkie.stream.framesCtrl.add(makeAnnouncement('new-reply'));
      await pumpEventQueue();

      expect(controller.nowPlaying.value?.id, 'new-reply');
      expect(
        walkie.player.playedUrls,
        isNot(contains('/api/mesh/voice/audio/older')),
      );
    });

    test('a history and live-frame race promotes one selected reply', () async {
      await controller.enable();
      controller.suspendPlayback();
      controller.restoreConversation([
        makeChat('selected', sender: 'a', body: 'Durable selected reply'),
      ]);

      controller.presentNotificationReply(makeAnnouncement('selected'));
      walkie.stream.framesCtrl.add(makeAnnouncement('selected'));
      controller.resumePlayback();
      await pumpEventQueue();

      expect(
        controller.transcript.value.where(
          (entry) => switch (entry) {
            HistoricalChatEntry(:final id) => id == 'selected',
            ActorReplyEntry(:final announcement) =>
              announcement.id == 'selected',
            UserMemoEntry() => false,
          },
        ),
        hasLength(1),
      );
      expect(walkie.player.playedUrls, ['/api/mesh/voice/audio/selected']);
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
      'a successful later ack clears only a stale ack-failed banner',
      () async {
        api.backlogPages = [
          [makeAnnouncement('m1'), makeAnnouncement('m2')],
        ];
        await controller.enable();
        await pumpEventQueue();

        api.ackError = apiError(500, 'temporary outage');
        walkie.player.finishCurrent();
        await pumpEventQueue();
        expect(controller.lastError.value, contains('Ack failed'));

        api.ackError = null;
        walkie.player.finishCurrent();
        await pumpEventQueue();
        expect(api.ackedIds, ['m2']);
        expect(controller.lastError.value, isNull);
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
        expect(
          api.memoSends.single.sessionId,
          walkie.stream.connectCalls.single.sessionId,
        );
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

    test(
      'a new recording after a cancelled pending start survives when the new '
      'acquisition resolves first',
      () async {
        final cancelledStart = Completer<void>();
        final newStart = Completer<void>();
        walkie.recorder.startGates.addAll([cancelledStart, newStart]);

        final firstToggle = controller.toggleRecord();
        await pumpEventQueue();
        expect(controller.record.value.phase, RecordPhase.starting);

        await controller.cancelRecord();
        await pumpEventQueue();
        expect(controller.record.value.phase, RecordPhase.idle);

        final secondToggle = controller.toggleRecord();
        await pumpEventQueue();
        expect(controller.record.value.phase, RecordPhase.starting);

        // The newer acquisition wins the mic; the cancelled one rejects after.
        newStart.complete();
        await secondToggle;
        await pumpEventQueue();
        expect(controller.record.value.phase, RecordPhase.recording);

        cancelledStart.complete();
        await firstToggle;
        await pumpEventQueue();

        // The superseded start's rejection must not surface as B's mic error
        // nor touch the newer capture: exactly one seam cancel (cancelRecord).
        expect(walkie.recorder.cancelCalls, 1);
        expect(controller.record.value.phase, RecordPhase.recording);
        expect(controller.record.value.message, isNull);

        // The newer capture remains usable end to end.
        await controller.toggleRecord();
        await pumpEventQueue();
        expect(api.memoSends, hasLength(1));
        expect(api.memoSends.single.actorId, 'a');
        expect(controller.record.value.phase, RecordPhase.delivered);
      },
    );

    test('a new recording after a cancelled pending start survives when the '
        'cancelled acquisition resolves first', () async {
      final cancelledStart = Completer<void>();
      final newStart = Completer<void>();
      walkie.recorder.startGates.addAll([cancelledStart, newStart]);

      final firstToggle = controller.toggleRecord();
      await pumpEventQueue();

      await controller.cancelRecord();
      await pumpEventQueue();
      expect(controller.record.value.phase, RecordPhase.idle);

      final secondToggle = controller.toggleRecord();
      await pumpEventQueue();
      expect(controller.record.value.phase, RecordPhase.starting);

      // The cancelled acquisition settles first; its rejection must leave
      // the pending newer capture untouched.
      cancelledStart.complete();
      await firstToggle;
      await pumpEventQueue();
      expect(walkie.recorder.cancelCalls, 1);
      expect(controller.record.value.phase, RecordPhase.starting);

      newStart.complete();
      await secondToggle;
      await pumpEventQueue();
      expect(controller.record.value.phase, RecordPhase.recording);
      expect(controller.record.value.message, isNull);

      await controller.toggleRecord();
      await pumpEventQueue();
      expect(api.memoSends, hasLength(1));
      expect(api.memoSends.single.actorId, 'a');
      expect(controller.record.value.phase, RecordPhase.delivered);
    });

    test(
      'adoptRecording enters recording phase with given startedAt',
      () async {
        await controller.enable();
        final startedAt = DateTime.now().subtract(const Duration(seconds: 2));
        controller.adoptRecording(startedAt: startedAt);
        expect(controller.record.value.phase, RecordPhase.recording);
        expect(
          controller.record.value.elapsed.inSeconds,
          greaterThanOrEqualTo(2),
        );

        // Stopping adopted recording sends the memo
        await controller.toggleRecord();
        await pumpEventQueue();
        expect(walkie.recorder.stopCalls, 1);
        expect(controller.record.value.phase, RecordPhase.delivered);
      },
    );

    test('adoptRecording ignored when disabled or disposed', () async {
      await controller.disable();
      final startedAt = DateTime.now();
      controller.adoptRecording(startedAt: startedAt);
      expect(controller.record.value.phase, RecordPhase.idle);

      await controller.dispose();
      controller.adoptRecording(startedAt: startedAt);
      expect(controller.record.value.phase, RecordPhase.idle);
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
