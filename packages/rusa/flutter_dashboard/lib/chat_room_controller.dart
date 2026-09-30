import 'dart:async';
import 'dart:convert';

import 'package:rxdart/rxdart.dart';

import 'api.dart';
import 'models.dart';
import 'voice_platform.dart';
import 'walkie_controller.dart';

/// Dashboard-global multi-actor voice mode.
///
/// This intentionally uses the existing multi-actor presence/backlog surface
/// without passing a `sessionId`: leased voice authority remains a one-actor
/// contract owned by [WalkieController]. A room capture therefore snapshots its
/// recipient at the first tap and can never be redirected by a later avatar tap.
class ChatRoomController {
  ChatRoomController({
    required Iterable<String> initialParticipants,
    required WalkieDeps deps,
  }) : _deps = deps,
       _participants = BehaviorSubject<List<String>>.seeded(
         _normalizedParticipants(initialParticipants),
       ),
       _recipient = BehaviorSubject<String?>.seeded(
         _firstParticipant(initialParticipants),
       ),
       _available = BehaviorSubject<bool?>.seeded(deps.voiceAvailable);

  static List<String> _normalizedParticipants(Iterable<String> ids) {
    final seen = <String>{};
    for (final id in ids) {
      final trimmed = id.trim();
      if (trimmed.isNotEmpty) seen.add(trimmed);
    }
    return List.unmodifiable(seen);
  }

  static String? _firstParticipant(Iterable<String> ids) {
    final normalized = _normalizedParticipants(ids);
    return normalized.isEmpty ? null : normalized.first;
  }

  final WalkieDeps _deps;
  final _enabled = BehaviorSubject<bool>.seeded(false);
  final _connection = BehaviorSubject<WalkieConnection>.seeded(
    WalkieConnection.off,
  );
  final _record = BehaviorSubject<RecordStatus>.seeded(const RecordStatus());
  late final BehaviorSubject<List<String>> _participants;
  late final BehaviorSubject<String?> _recipient;
  final _recordingRecipient = BehaviorSubject<String?>.seeded(null);
  final _queueDepth = BehaviorSubject<int>.seeded(0);
  final _nowPlaying = BehaviorSubject<VoiceAnnouncement?>.seeded(null);
  final _lastError = BehaviorSubject<String?>.seeded(null);
  final BehaviorSubject<bool?> _available;

  final _queue = <VoiceAnnouncement>[];
  final _seenIds = <String>{};
  final _streamSubs = <StreamSubscription<dynamic>>[];
  VoiceStreamSource? _stream;
  Timer? _recordTicker;
  Timer? _deliveredReset;
  DateTime? _recordStartedAt;
  bool _draining = false;
  bool _droppedSinceConnect = false;
  bool _requeueCurrentForRecording = false;
  String? _interruptedAnnouncementId;
  bool _disposed = false;

  ValueStream<bool> get enabled => _enabled.stream;
  ValueStream<WalkieConnection> get connection => _connection.stream;
  ValueStream<RecordStatus> get record => _record.stream;
  ValueStream<List<String>> get participants => _participants.stream;
  ValueStream<String?> get recipient => _recipient.stream;
  ValueStream<String?> get recordingRecipient => _recordingRecipient.stream;
  ValueStream<int> get queueDepth => _queueDepth.stream;
  ValueStream<VoiceAnnouncement?> get nowPlaying => _nowPlaying.stream;
  ValueStream<String?> get lastError => _lastError.stream;
  ValueStream<bool?> get available => _available.stream;

  bool get isRecording => switch (_record.value.phase) {
    RecordPhase.starting ||
    RecordPhase.recording ||
    RecordPhase.sending => true,
    _ => false,
  };

  /// Probe a single participant only to discover instance-wide voice support.
  Future<void> init() async {
    if (_available.value != null || _participants.value.isEmpty) return;
    try {
      await _deps.api.fetchVoiceBacklog(_participants.value.first);
      _setAvailable(true);
    } on DashboardApiException catch (e) {
      if (e.status == 503) _setAvailable(false);
    } catch (_) {
      // Network failure leaves the room tappable; a real attempt reports it.
    }
  }

  void _setAvailable(bool value) {
    _deps.voiceAvailable = value;
    if (!_disposed) _available.add(value);
  }

  /// Add a live participant and, when the room is open, widen the existing
  /// presence stream before fetching that actor's queued replies.
  Future<bool> addParticipant(String actorId) async {
    final trimmed = actorId.trim();
    if (trimmed.isEmpty || _participants.value.contains(trimmed)) return false;
    _participants.add([..._participants.value, trimmed]);
    _recipient.add(_recipient.value ?? trimmed);
    if (_enabled.value) {
      _connection.add(WalkieConnection.connecting);
      _stream?.connect(_participants.value, null);
      await _fetchBacklogs([trimmed]);
    }
    return true;
  }

  /// Reconcile the UI-owned room roster against the live actor snapshot. This
  /// is intentionally not a server-side room mutation: it only reconnects the
  /// existing presence stream with its current actor filter.
  Future<void> replaceParticipants(Iterable<String> actorIds) async {
    final next = _normalizedParticipants(actorIds);
    final current = _participants.value;
    if (next.length == current.length &&
        next.asMap().entries.every(
          (entry) => current[entry.key] == entry.value,
        )) {
      return;
    }
    final recordingTarget = _recordingRecipient.value;
    if (recordingTarget != null && !next.contains(recordingTarget)) {
      await cancelRecord();
    }
    _participants.add(next);
    final selected = _recipient.value;
    if (selected == null || !next.contains(selected)) {
      _recipient.add(next.isEmpty ? null : next.first);
    }
    if (!_enabled.value) return;
    if (next.isEmpty) {
      await disable();
      return;
    }
    _connection.add(WalkieConnection.connecting);
    _stream?.connect(next, null);
    await _fetchBacklogs(next);
  }

  Future<void> enable() async {
    if (_disposed || _enabled.value || _available.value == false) return;
    if (_participants.value.isEmpty) {
      _lastError.add('Add an actor before starting the Chat Room.');
      return;
    }
    _enabled.add(true);
    _lastError.add(null);
    _connection.add(WalkieConnection.connecting);
    unawaited(_deps.player.prime());
    unawaited(_deps.wakeLock.acquire());

    final stream = _deps.createStream();
    _stream = stream;
    _streamSubs.add(stream.frames.listen(_onFrame));
    _streamSubs.add(stream.status.listen(_onStreamStatus));
    stream.connect(_participants.value, null);
    await _fetchBacklogs(_participants.value);
  }

  Future<void> disable() async {
    if (!_enabled.value) return;
    _enabled.add(false);
    _connection.add(WalkieConnection.off);
    _teardownStream();
    _deps.player.stop();
    _queue.clear();
    _queueDepth.add(0);
    _nowPlaying.add(null);
    _seenIds.clear();
    _stopRecordTimers();
    if (isRecording) {
      try {
        await _deps.recorder.cancel();
      } catch (_) {}
    }
    _recordingRecipient.add(null);
    _record.add(const RecordStatus());
    await _deps.wakeLock.release();
  }

  void _teardownStream() {
    for (final sub in _streamSubs) {
      sub.cancel();
    }
    _streamSubs.clear();
    _stream?.dispose();
    _stream = null;
  }

  void _onStreamStatus(VoiceStreamStatus status) {
    if (!_enabled.value) return;
    switch (status) {
      case VoiceStreamStatus.connected:
        _connection.add(WalkieConnection.connected);
        if (_droppedSinceConnect) {
          _droppedSinceConnect = false;
          unawaited(_fetchBacklogs(_participants.value));
        }
      case VoiceStreamStatus.reconnecting:
        _droppedSinceConnect = true;
        _connection.add(WalkieConnection.reconnecting);
    }
  }

  Future<void> _fetchBacklogs(Iterable<String> actorIds) async {
    final ids = _normalizedParticipants(actorIds);
    if (ids.isEmpty) return;
    try {
      final batches = await Future.wait(
        ids.map((actorId) => _deps.api.fetchVoiceBacklog(actorId)),
      );
      if (!_enabled.value || _disposed) return;
      final frames = [for (final batch in batches) ...batch]
        ..sort((a, b) {
          final time = a.createdAt.compareTo(b.createdAt);
          return time != 0 ? time : a.id.compareTo(b.id);
        });
      for (final frame in frames) {
        _enqueue(frame);
      }
      if (_lastError.value?.startsWith('Backlog fetch failed') ?? false) {
        _lastError.add(null);
      }
    } on DashboardApiException catch (e) {
      if (e.status == 503) {
        _setAvailable(false);
        await disable();
        return;
      }
      _lastError.add('Backlog fetch failed: ${_apiErrorText(e)}');
    } catch (e) {
      _lastError.add('Backlog fetch failed: $e');
    }
  }

  void _onFrame(VoiceAnnouncement frame) {
    if (_enabled.value) _enqueue(frame);
  }

  void _enqueue(VoiceAnnouncement frame) {
    if (!_participants.value.contains(frame.actorId) ||
        !_seenIds.add(frame.id)) {
      return;
    }
    _queue.add(frame);
    _queueDepth.add(_queue.length);
    unawaited(_drain());
  }

  Future<void> _drain() async {
    if (_draining) return;
    _draining = true;
    try {
      while (_enabled.value && _queue.isNotEmpty) {
        // Capturing (and the immediate send) gets a quiet room. Frames still
        // arrive and retain their FIFO position; they play after the memo ends.
        if (isRecording) break;
        final frame = _queue.removeAt(0);
        _queueDepth.add(_queue.length);
        _nowPlaying.add(frame);
        var played = false;
        try {
          await _deps.player.play(frame.audioUrl);
          played = true;
        } catch (e) {
          _lastError.add('Playback failed: $e');
        }
        if (played &&
            (_lastError.value?.startsWith('Playback failed') ?? false)) {
          _lastError.add(null);
        }
        if (_disposed) return;
        if (_requeueCurrentForRecording &&
            frame.id == _interruptedAnnouncementId) {
          _requeueCurrentForRecording = false;
          _interruptedAnnouncementId = null;
          _nowPlaying.add(null);
          _queue.insert(0, frame);
          _queueDepth.add(_queue.length);
          break;
        }
        _nowPlaying.add(null);
        if (!_enabled.value) break;
        try {
          await _deps.api.ackVoiceAnnouncement(frame.id);
          if (_lastError.value?.startsWith('Ack failed') ?? false) {
            _lastError.add(null);
          }
        } catch (e) {
          if (_disposed) return;
          _lastError.add('Ack failed: $e');
        }
      }
    } finally {
      _draining = false;
      // A recorder failure can race the stopped player's completion: it puts
      // the interrupted clip back at the head just after its own attempt to
      // resume returned because this drain was active. Re-check once the
      // active drain has released its guard so an unrecorded clip never gets
      // stranded in the shared queue.
      if (_enabled.value && _queue.isNotEmpty && !isRecording) {
        unawaited(_drain());
      }
    }
  }

  /// One avatar is both record and send. A different avatar during an active
  /// capture is deliberately ignored: only the captured recipient can stop it.
  Future<void> tapParticipant(String actorId) async {
    if (!_participants.value.contains(actorId)) return;
    if (!_enabled.value) await enable();
    if (!_enabled.value || _disposed) return;
    switch (_record.value.phase) {
      case RecordPhase.recording:
        if (_recordingRecipient.value == actorId) {
          await _stopAndSend();
        } else {
          _lastError.add(
            'Recording for the selected actor. Tap its avatar to send or X to cancel.',
          );
        }
        return;
      case RecordPhase.idle || RecordPhase.delivered || RecordPhase.error:
        _recipient.add(actorId);
        await _startRecording(actorId);
        return;
      case RecordPhase.starting || RecordPhase.sending:
        return;
    }
  }

  Future<void> _startRecording(String actorId) async {
    _lastError.add(null);
    _deliveredReset?.cancel();
    _recordingRecipient.add(actorId);
    _record.add(const RecordStatus(phase: RecordPhase.starting));
    final playing = _nowPlaying.value;
    if (playing != null) {
      // VoicePlayer only exposes stop, so keep this item unacknowledged and
      // put it back at the queue head when its play future settles.
      _requeueCurrentForRecording = true;
      _interruptedAnnouncementId = playing.id;
      _deps.player.stop();
    }
    try {
      await _deps.recorder.start();
    } catch (e) {
      _recordingRecipient.add(null);
      _record.add(
        RecordStatus(phase: RecordPhase.error, message: 'Mic unavailable: $e'),
      );
      unawaited(_drain());
      return;
    }
    if (!_enabled.value || _disposed) return;
    _recordStartedAt = DateTime.now();
    _record.add(const RecordStatus(phase: RecordPhase.recording));
    _recordTicker = Timer.periodic(const Duration(seconds: 1), (_) {
      final started = _recordStartedAt;
      if (started == null) return;
      _record.add(
        RecordStatus(
          phase: RecordPhase.recording,
          elapsed: DateTime.now().difference(started),
        ),
      );
    });
  }

  Future<void> cancelRecord() async {
    if (_record.value.phase != RecordPhase.recording &&
        _record.value.phase != RecordPhase.starting) {
      return;
    }
    _stopRecordTimers();
    try {
      await _deps.recorder.cancel();
    } catch (_) {}
    if (!_disposed) {
      _recordingRecipient.add(null);
      _lastError.add(null);
      _record.add(const RecordStatus());
      unawaited(_drain());
    }
  }

  Future<void> _stopAndSend() async {
    final target = _recordingRecipient.value;
    if (target == null) return;
    _lastError.add(null);
    _stopRecordTimers();
    _record.add(const RecordStatus(phase: RecordPhase.sending));
    try {
      final clip = await _deps.recorder.stop();
      final result = await _deps.api.sendVoiceMemo(
        target,
        clip.bytes,
        mimeType: clip.mimeType,
      );
      if (_disposed) return;
      _recordingRecipient.add(null);
      _record.add(
        RecordStatus(
          phase: RecordPhase.delivered,
          transcript: result.transcript,
          delivered: result.delivered,
        ),
      );
      _deliveredReset = Timer(kDeliveredResetDelay, () {
        if (_record.value.phase == RecordPhase.delivered) {
          _record.add(const RecordStatus());
        }
      });
    } on DashboardApiException catch (e) {
      if (_disposed) return;
      _recordingRecipient.add(null);
      if (e.status == 503) {
        _setAvailable(false);
        _record.add(
          const RecordStatus(
            phase: RecordPhase.error,
            message: 'Voice is not configured on this instance',
          ),
        );
        await disable();
        return;
      }
      _record.add(
        RecordStatus(
          phase: RecordPhase.error,
          message: 'Send failed: ${_apiErrorText(e)}',
        ),
      );
    } catch (e) {
      if (_disposed) return;
      _recordingRecipient.add(null);
      _record.add(
        RecordStatus(phase: RecordPhase.error, message: 'Send failed: $e'),
      );
    } finally {
      unawaited(_drain());
    }
  }

  void _stopRecordTimers() {
    _recordTicker?.cancel();
    _recordTicker = null;
    _recordStartedAt = null;
    _deliveredReset?.cancel();
    _deliveredReset = null;
  }

  String _apiErrorText(DashboardApiException e) {
    try {
      final parsed = jsonDecode(e.body);
      if (parsed is Map<String, dynamic> && parsed['error'] is String) {
        return parsed['error'] as String;
      }
    } catch (_) {}
    return 'HTTP ${e.status}';
  }

  Future<void> dispose() async {
    if (_disposed) return;
    await disable();
    _disposed = true;
    await Future.wait([
      _enabled.close(),
      _connection.close(),
      _record.close(),
      _participants.close(),
      _recipient.close(),
      _recordingRecipient.close(),
      _queueDepth.close(),
      _nowPlaying.close(),
      _lastError.close(),
      _available.close(),
    ]);
  }
}
