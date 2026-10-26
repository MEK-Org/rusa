import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:audioplayers/audioplayers.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:wakelock_plus_platform_interface/messages.g.dart';

import 'package:rusa_dashboard/io_session.dart';
import 'package:rusa_dashboard/io_session_client.dart';
import 'package:rusa_dashboard/models.dart';
import 'package:rusa_dashboard/voice_io.dart';
import 'package:rusa_dashboard/voice_platform.dart';

// Each adapter runs through the real Dart half of its plugin; these tests
// answer the plugin's platform channels the way the Android side would.

TestDefaultBinaryMessenger get _messenger =>
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;

final _baseUrl = Uri.parse('https://dash.example');

IoDashboardSession _session(http.Client inner) {
  final jar = IoSessionCookieJar(initialSessionCookie: 'sess-1');
  return IoDashboardSession(
    client: IoSessionClient(inner: inner, baseUrl: _baseUrl, cookieJar: jar),
    baseUrl: _baseUrl,
    cookieJar: jar,
  );
}

/// The `record` plugin's method channel, with the recorder's state event
/// channel opened on `create` as the native side does.
class _FakeRecordPlugin {
  _FakeRecordPlugin() {
    _messenger.setMockMethodCallHandler(_channel, _handle);
  }

  static const _channel = MethodChannel('com.llfbandit.record/messages');
  static final clip = Uint8List.fromList([0, 0, 0, 0x20, 0x66, 0x74, 0x79]);

  final calls = <String>[];
  Map<Object?, Object?>? startArgs;
  Completer<bool> permission = Completer<bool>()..complete(true);

  Future<Object?> _handle(MethodCall call) async {
    calls.add(call.method);
    final args = call.arguments as Map<Object?, Object?>;
    switch (call.method) {
      case 'create':
        _messenger.setMockStreamHandler(
          EventChannel('com.llfbandit.record/events/${args['recorderId']}'),
          MockStreamHandler.inline(onListen: (_, _) {}),
        );
      case 'hasPermission':
        return permission.future;
      case 'start':
        startArgs = args;
        File(args['path']! as String).writeAsBytesSync(clip);
      case 'stop':
        return startArgs?['path'];
      case 'cancel':
        final path = startArgs?['path'] as String?;
        if (path != null && File(path).existsSync()) File(path).deleteSync();
    }
    return null;
  }

  void dispose() => _messenger.setMockMethodCallHandler(_channel, null);
}

/// The `audioplayers` method channels plus the player's event channel: a
/// source is reported prepared, and playback completes on `resume` unless
/// [completeOnResume] is off.
class _FakeAudioPlugin {
  _FakeAudioPlugin() {
    _messenger.setMockMethodCallHandler(_global, (_) async => null);
    _messenger.setMockStreamHandler(
      const EventChannel('xyz.luan/audioplayers.global/events'),
      MockStreamHandler.inline(onListen: (_, _) {}),
    );
    _messenger.setMockMethodCallHandler(_channel, _handle);
  }

  static const _global = MethodChannel('xyz.luan/audioplayers.global');
  static const _channel = MethodChannel('xyz.luan/audioplayers');

  final calls = <MethodCall>[];
  bool completeOnResume = true;
  final _resumed = StreamController<void>.broadcast();
  MockStreamHandlerEventSink? _events;

  Future<void> get resumed => _resumed.stream.first;
  List<String> get methods => [for (final c in calls) c.method];

  Future<Object?> _handle(MethodCall call) async {
    calls.add(call);
    final args = call.arguments as Map<Object?, Object?>;
    switch (call.method) {
      case 'create':
        _messenger.setMockStreamHandler(
          EventChannel('xyz.luan/audioplayers/events/${args['playerId']}'),
          MockStreamHandler.inline(onListen: (_, sink) => _events = sink),
        );
      case 'setSourceBytes':
        scheduleMicrotask(
          () => _events!.success({'event': 'audio.onPrepared', 'value': true}),
        );
      case 'resume':
        _resumed.add(null);
        if (completeOnResume) {
          scheduleMicrotask(
            () => _events!.success({'event': 'audio.onComplete'}),
          );
        }
    }
    return null;
  }

  void dispose() {
    _messenger.setMockMethodCallHandler(_global, null);
    _messenger.setMockMethodCallHandler(_channel, null);
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('IoVoiceRecorder', () {
    late _FakeRecordPlugin plugin;
    late Directory tmp;
    late IoVoiceRecorder recorder;

    setUp(() {
      plugin = _FakeRecordPlugin();
      tmp = Directory.systemTemp.createTempSync('voice_io_test');
      recorder = IoVoiceRecorder(temporaryDirectory: () async => tmp);
    });
    tearDown(() {
      plugin.dispose();
      tmp.deleteSync(recursive: true);
    });

    test(
      'records AAC to a scratch file and hands back an audio/mp4 clip',
      () async {
        await recorder.start();
        final path = plugin.startArgs!['path']! as String;
        expect(plugin.startArgs!['encoder'], 'aacLc');
        expect(path, startsWith(tmp.path));
        expect(path, endsWith('.m4a'));

        final clip = await recorder.stop();

        expect(clip.bytes, _FakeRecordPlugin.clip);
        expect(clip.mimeType, 'audio/mp4');
        expect(File(path).existsSync(), isFalse);
        expect(plugin.calls, containsAllInOrder(['stop', 'dispose']));
      },
    );

    test('a denied microphone fails start and releases the recorder', () async {
      plugin.permission = Completer<bool>()..complete(false);

      await expectLater(recorder.start(), throwsStateError);
      expect(plugin.calls, isNot(contains('start')));
      expect(plugin.calls, contains('dispose'));
    });

    test(
      'cancel during the permission prompt fails the pending start',
      () async {
        plugin.permission = Completer<bool>();
        final start = recorder.start();
        await pumpEventQueue();

        await recorder.cancel();
        plugin.permission.complete(true);

        await expectLater(start, throwsStateError);
        expect(plugin.calls, isNot(contains('start')));
        expect(plugin.calls, contains('dispose'));
        await expectLater(recorder.stop(), throwsStateError);
      },
    );

    test('cancel discards an active recording', () async {
      await recorder.start();
      final path = plugin.startArgs!['path']! as String;

      await recorder.cancel();

      expect(plugin.calls, containsAllInOrder(['cancel', 'dispose']));
      expect(File(path).existsSync(), isFalse);
      await expectLater(recorder.stop(), throwsStateError);
    });
  });

  group('IoVoicePlayer', () {
    late _FakeAudioPlugin plugin;
    final audio = Uint8List.fromList(utf8.encode('RIFF....WAVE'));
    final requests = <http.BaseRequest>[];
    var status = 200;

    IoVoicePlayer player() {
      final session = _session(
        MockClient((req) async {
          requests.add(req);
          return http.Response.bytes(
            audio,
            status,
            headers: {'content-type': 'audio/wav'},
          );
        }),
      );
      return IoVoicePlayer(
        client: session.client,
        baseUrl: session.baseUrl,
        createPlayer: () => AudioPlayer(playerId: 'announcer'),
      );
    }

    setUp(() {
      plugin = _FakeAudioPlugin();
      requests.clear();
      status = 200;
    });
    tearDown(() => plugin.dispose());

    test('plays session-fetched announcement bytes to completion', () async {
      await player().play('/api/mesh/voice/audio/a1');

      final request = requests.single;
      expect(request.url, _baseUrl.resolve('/api/mesh/voice/audio/a1'));
      expect(request.headers['Cookie'], contains('sess-1'));
      final source = plugin.calls.singleWhere(
        (c) => c.method == 'setSourceBytes',
      );
      final args = source.arguments as Map<Object?, Object?>;
      expect(args['bytes'], audio);
      expect(args['mimeType'], 'audio/wav');
      expect(plugin.methods, contains('resume'));
    });

    test(
      'stop completes a pending play and stops the platform player',
      () async {
        plugin.completeOnResume = false;
        final p = player();
        final resumed = plugin.resumed;
        final play = p.play('/api/mesh/voice/audio/a1');
        await resumed;

        p.stop();

        await play;
        await pumpEventQueue();
        expect(plugin.methods, contains('stop'));
      },
    );

    test('an unavailable clip throws without touching the player', () async {
      status = 404;

      await expectLater(
        player().play('/api/mesh/voice/audio/gone'),
        throwsStateError,
      );
      expect(plugin.methods, isNot(contains('setSourceBytes')));
    });
  });

  group('IoScreenWakeLock', () {
    const toggle =
        'dev.flutter.pigeon.wakelock_plus_platform_interface.WakelockPlusApi.toggle';

    tearDown(() => _messenger.setMockMessageHandler(toggle, null));

    test('acquire and release toggle the Android wake lock', () async {
      final toggles = <bool?>[];
      const codec = WakelockPlusApi.pigeonChannelCodec;
      _messenger.setMockMessageHandler(toggle, (message) async {
        final args = codec.decodeMessage(message)! as List<Object?>;
        toggles.add((args.single! as ToggleMessage).enable);
        return codec.encodeMessage(<Object?>[null]);
      });

      final lock = IoScreenWakeLock();
      await lock.acquire();
      await lock.release();

      expect(toggles, [true, false]);
    });

    test('a missing wake lock leaves walkie mode usable', () async {
      final lock = IoScreenWakeLock();
      await lock.acquire();
      await lock.release();
    });
  });

  group('IoVoiceStream', () {
    test(
      'carries the session id and maps frames, controls and status',
      () async {
        final body = StreamController<List<int>>();
        http.BaseRequest? request;
        final client = MockClient.streaming((req, _) async {
          request = req;
          return http.StreamedResponse(body.stream, 200);
        });
        final stream = IoVoiceStream(
          session: _session(client),
          baseUrl: _baseUrl,
          clientFactory: () => client,
        );
        final frames = <VoiceAnnouncement>[];
        final controls = <VoiceSessionControl>[];
        final status = <VoiceStreamStatus>[];
        stream.frames.listen(frames.add);
        stream.controls.listen(controls.add);
        stream.status.listen(status.add);

        stream.connect(['actor-1'], 'walkie-1');
        await pumpEventQueue();

        expect(request!.url.path, '/api/mesh/voice/stream');
        expect(request!.url.queryParameters, {
          'actors': 'actor-1',
          'sessionId': 'walkie-1',
        });
        expect(status, [VoiceStreamStatus.connected]);

        body.add(
          utf8.encode(
            'event: voice\n'
            'data: {"id":"a1","actorId":"actor-1","text":"hi",'
            '"audioUrl":"/api/mesh/voice/audio/a1","mime":"audio/wav"}\n'
            '\n'
            'event: voice_control\n'
            'data: {"targetActorId":"actor-2"}\n'
            '\n'
            'event: voice\n'
            'data: not json\n'
            '\n',
          ),
        );
        await pumpEventQueue();

        expect(frames.single.audioUrl, '/api/mesh/voice/audio/a1');
        expect(controls.single.targetActorId, 'actor-2');

        await body.close();
        await pumpEventQueue();
        expect(status.last, VoiceStreamStatus.reconnecting);

        stream.dispose();
      },
    );
  });
}
