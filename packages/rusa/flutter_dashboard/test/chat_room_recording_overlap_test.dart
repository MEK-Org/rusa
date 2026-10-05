import 'dart:async';

import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rusa_dashboard/chat_room_controller.dart';
import 'package:rusa_dashboard/voice_platform.dart';
import 'package:rusa_dashboard/walkie_controller.dart';

import 'fakes.dart';

/// A player whose `play` future stays pending until the test releases it, and
/// whose `stop` deliberately does NOT settle the pending future. This models
/// any player backend whose stop→settle path has real latency (native audio
/// teardown, an `ended`-event-driven future that stop only requests, ...).
/// The shipped `WebVoicePlayer.stop` completes its future synchronously, which
/// is exactly why the production overlap window is usually sub-frame — and why
/// the controller's correctness must not depend on it.
class HoldingVoicePlayer implements VoicePlayer {
  final playedUrls = <String>[];
  int stopCalls = 0;
  Completer<void>? _current;

  bool get isPlaying => _current != null && !_current!.isCompleted;

  @override
  Future<void> prime() async {}

  @override
  Future<void> play(String url) {
    playedUrls.add(url);
    final c = Completer<void>();
    _current = c;
    return c.future;
  }

  @override
  void stop() {
    stopCalls++;
    // Intentionally no complete(): the settle is held by the test.
  }

  void settleCurrent() {
    final c = _current;
    if (c != null && !c.isCompleted) c.complete();
  }
}

void main() {
  late FakeApi api;
  late FakeVoiceRecorder recorder;
  late HoldingVoicePlayer player;
  late List<FakeVoiceStream> streams;
  late ChatRoomController controller;

  setUp(() {
    api = FakeApi();
    recorder = FakeVoiceRecorder();
    player = HoldingVoicePlayer();
    streams = <FakeVoiceStream>[];
    controller = ChatRoomController(
      initialParticipants: const ['root', 'actor-b'],
      deps: WalkieDeps(
        api: api,
        recorder: recorder,
        player: player,
        wakeLock: FakeWakeLock(),
        createStream: () {
          final s = FakeVoiceStream();
          streams.add(s);
          return s;
        },
      ),
    );
  });

  tearDown(() async {
    await controller.dispose();
  });

  test(
    'starting a recording clears the speaking state without waiting for '
    'the player to settle',
    () async {
      await controller.enable();
      await pumpEventQueue();
      streams.single.framesCtrl.add(makeAnnouncement('reply-a', actor: 'root'));
      await pumpEventQueue();
      expect(player.playedUrls, ['/api/mesh/voice/audio/reply-a']);
      expect(controller.nowPlaying.value?.id, 'reply-a');

      await controller.tapParticipant('root');
      await pumpEventQueue();

      // Mic acquisition resolved; the room is recording the speaking actor.
      expect(controller.record.value.phase, RecordPhase.recording);
      expect(controller.recordingRecipient.value, 'root');
      // The stop was requested, but the play future has not settled.
      expect(player.stopCalls, 1);
      expect(player.isPlaying, isTrue);

      // The tapped tile is simultaneously `speaking` (nowPlaying) and
      // `recording` (recordingRecipient): the Speaking badge, accent border
      // and glow render beside REC and the spinner (#825 review comment
      // 4173401505). The controller should drop nowPlaying when it stops
      // playback for the recording, not when the play future happens to
      // settle — that window is the player's stop latency, which the shipped
      // web player makes synchronously small but a slower backend can make
      // arbitrarily long.
      expect(
        controller.nowPlaying.value,
        isNull,
        reason: 'Speaking must clear when the recording starts, not when the '
            'stopped play() future settles',
      );
    },
  );

  test('the speaking/recording overlap lasts the whole settle delay', () {
    fakeAsync((async) {
      unawaited(controller.enable());
      async.elapse(Duration.zero);
      streams.single.framesCtrl.add(makeAnnouncement('reply-a', actor: 'root'));
      async.elapse(Duration.zero);
      expect(controller.nowPlaying.value?.id, 'reply-a');

      unawaited(controller.tapParticipant('root'));
      async.elapse(Duration.zero);
      expect(controller.record.value.phase, RecordPhase.recording);

      // Thirty seconds of recording with the play future still unsettled:
      // the stale Speaking state persists for the entire window.
      async.elapse(const Duration(seconds: 30));
      expect(player.isPlaying, isTrue);
      expect(
        controller.nowPlaying.value,
        isNull,
        reason: 'after 30s of recording the speaking state is still stale',
      );

      // When the stopped future finally settles, the drain requeues the
      // interrupted clip — recovery does not depend on the overlap.
      player.settleCurrent();
      async.elapse(Duration.zero);
      expect(controller.nowPlaying.value, isNull);
      expect(controller.queueDepth.value, 1);
    });
  });
}
