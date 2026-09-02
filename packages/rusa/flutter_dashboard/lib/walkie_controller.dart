import 'dart:async';
import 'dart:convert';

import 'package:rxdart/rxdart.dart';

import 'api.dart';
import 'models.dart';
import 'voice_platform.dart';

// ── Session transcript entries  ────────────────────────────────────────

/// Sealed base for one row in the walkie session transcript.
sealed class WalkieEntry {
  const WalkieEntry({required this.timestamp});
  final DateTime timestamp;
}

/// A user voice memo as transcribed by the server.
final class UserMemoEntry extends WalkieEntry {
  const UserMemoEntry({
    required super.timestamp,
    required this.transcript,
    required this.delivered,
  });

  /// Exactly what the server transcribed — the text Operator needs to verify.
  final String transcript;

  /// Whether the actor was woken (false = queued while asleep).
  final bool delivered;
}

/// One actor reply that has finished playing.
final class ActorReplyEntry extends WalkieEntry {
  const ActorReplyEntry({required super.timestamp, required this.announcement});

  final VoiceAnnouncement announcement;
}

/// Walkie-mode connection state (the SSE presence link).
enum WalkieConnection { off, connecting, connected, reconnecting }

/// The tap-toggle record flow's phases (Operator's ruling: tap to start, tap to
/// stop — NOT hold-to-talk).
enum RecordPhase { idle, starting, recording, sending, delivered, error }

/// Immutable record-flow snapshot for the big button + status line.
class RecordStatus {
  const RecordStatus({
    this.phase = RecordPhase.idle,
    this.elapsed = Duration.zero,
    this.transcript,
    this.delivered = false,
    this.message,
  });

  final RecordPhase phase;

  /// Recording time so far (ticks once a second while recording).
  final Duration elapsed;

  /// The server's transcript, present in [RecordPhase.delivered].
  final String? transcript;

  /// Whether the actor was actually woken (memo route `delivered` flag).
  final bool delivered;

  /// Human-readable error, present in [RecordPhase.error].
  final String? message;
}

class _QueueItem {
  _QueueItem(this.frame, {this.ackNeeded = true});
  final VoiceAnnouncement frame;
  final bool ackNeeded;
}

/// How long the delivered-with-transcript confirmation stays on the record
/// button before it returns to idle (the transcript also lands in the chat log
/// via the normal mesh_event SSE push, so nothing is lost).
const Duration kDeliveredResetDelay = Duration(seconds: 4);

/// Per-actor walkie-talkie brain : owns the mode toggle lifecycle
/// (presence SSE + wake lock + autoplay priming), the tap-toggle record state
/// machine, and the ordered auto-advancing playback queue with ack-after-play
/// and dedupe-by-announcement-id. Pure Dart — every browser API sits behind the
/// `voice_platform.dart` seams, so this is fully testable headless.
class WalkieController {
  WalkieController({required this.actorId, required WalkieDeps deps})
    : _deps = deps,
      _available = BehaviorSubject<bool?>.seeded(deps.voiceAvailable);

  final String actorId;
  final WalkieDeps _deps;

  final _enabled = BehaviorSubject<bool>.seeded(false);
  final _connection = BehaviorSubject<WalkieConnection>.seeded(
    WalkieConnection.off,
  );
  final _record = BehaviorSubject<RecordStatus>.seeded(const RecordStatus());
  final _queueDepth = BehaviorSubject<int>.seeded(0);
  final _nowPlaying = BehaviorSubject<VoiceAnnouncement?>.seeded(null);
  final _lastPlayed = BehaviorSubject<VoiceAnnouncement?>.seeded(null);
  final _lastError = BehaviorSubject<String?>.seeded(null);
  final BehaviorSubject<bool?> _available;

  /// Ordered session transcript for ISSUE_NUM — appended in real time, never
  /// persisted, cleared on disable so each walkie session starts fresh.
  final _transcript = BehaviorSubject<List<WalkieEntry>>.seeded(const []);

  final _queue = <_QueueItem>[];

  /// Announcement ids ever enqueued this session — the dedupe set that makes
  /// SSE frames vs backlog re-fetches (reconnect catch-up) idempotent.
  final _seenIds = <String>{};

  VoiceStreamSource? _stream;
  final _streamSubs = <StreamSubscription<dynamic>>[];
  bool _draining = false;
  bool _droppedSinceConnect = false;
  Timer? _recordTicker;
  Timer? _deliveredReset;
  DateTime? _recordStartedAt;
  bool _disposed = false;

  // ── Exposed streams ──
  ValueStream<bool> get enabled => _enabled.stream;
  ValueStream<WalkieConnection> get connection => _connection.stream;
  ValueStream<RecordStatus> get record => _record.stream;
  ValueStream<int> get queueDepth => _queueDepth.stream;
  ValueStream<VoiceAnnouncement?> get nowPlaying => _nowPlaying.stream;
  ValueStream<VoiceAnnouncement?> get lastPlayed => _lastPlayed.stream;
  ValueStream<String?> get lastError => _lastError.stream;

  /// Running session transcript : grows as memos are delivered and
  /// replies are played. Starts empty each time the mode is enabled.
  ValueStream<List<WalkieEntry>> get transcript => _transcript.stream;

  /// null = not yet probed, false = voice unconfigured on this instance (503)
  /// → the toggle renders disabled with an explanatory label.
  ValueStream<bool?> get available => _available.stream;

  /// One-time availability probe (a cheap backlog GET — 503 means voice is
  /// unconfigured instance-wide). Cached on the shared [WalkieDeps] so
  /// switching actors doesn't re-probe.
  Future<void> init() async {
    if (_available.value != null) return;
    try {
      await _deps.api.fetchVoiceBacklog(actorId);
      _setAvailable(true);
    } on DashboardApiException catch (e) {
      if (e.status == 503) {
        _setAvailable(false);
      }
      // Any other failure: leave unknown — the toggle stays tappable and a
      // real attempt will surface the error.
    } catch (_) {
      // Network error: same as above.
    }
  }

  void _setAvailable(bool value) {
    _deps.voiceAvailable = value;
    if (!_disposed) _available.add(value);
  }

  // ── Mode toggle ──

  Future<void> toggle() => _enabled.value ? disable() : enable();

  /// Enter walkie mode: prime autoplay (this call rides the toggle tap — the
  /// user gesture), grab the wake lock, open the presence SSE stream, and pull
  /// the backlog into the queue.
  Future<void> enable() async {
    if (_disposed || _enabled.value || _available.value == false) return;
    _enabled.add(true);
    _lastError.add(null);
    _connection.add(WalkieConnection.connecting);
    unawaited(_deps.player.prime());
    unawaited(_deps.wakeLock.acquire());

    final stream = _deps.createStream();
    _stream = stream;
    _streamSubs.add(stream.frames.listen(_onFrame));
    _streamSubs.add(stream.status.listen(_onStreamStatus));
    stream.connect([actorId]);

    await _fetchBacklog();
  }

  /// Leave walkie mode: drop the presence connection (starts the server's
  /// 2-minute reply-TTS grace window), stop playback, release the wake lock,
  /// and abort any in-flight recording. Queued-but-unplayed announcements are
  /// NOT acked — they come back via the backlog on the next mode entry.
  Future<void> disable() async {
    if (!_enabled.value) return;
    _enabled.add(false);
    _connection.add(WalkieConnection.off);
    _teardownStream();
    _deps.player.stop();
    _queue.clear();
    _queueDepth.add(0);
    _nowPlaying.add(null);
    // Clear the session transcript so each mode entry starts fresh.
    _transcript.add(const []);
    // Unplayed ids must not be deduped away on re-entry (played ones are acked
    // server-side, so the backlog can't resurrect them anyway).
    _seenIds.clear();
    _stopRecordTimers();
    if (_record.value.phase == RecordPhase.recording ||
        _record.value.phase == RecordPhase.starting) {
      try {
        await _deps.recorder.cancel();
      } catch (_) {}
    }
    _record.add(const RecordStatus());
    await _deps.wakeLock.release();
  }

  void _teardownStream() {
    for (final s in _streamSubs) {
      s.cancel();
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
          // Catch anything rendered during the gap; dedupe makes this
          // idempotent against frames the reconnect already replayed.
          unawaited(_fetchBacklog());
        }
      case VoiceStreamStatus.reconnecting:
        _droppedSinceConnect = true;
        _connection.add(WalkieConnection.reconnecting);
    }
  }

  Future<void> _fetchBacklog() async {
    try {
      final items = await _deps.api.fetchVoiceBacklog(actorId);
      if (!_enabled.value) return;
      for (final frame in items) {
        _enqueue(frame);
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
    if (!_enabled.value) return;
    _enqueue(frame);
  }

  // ── Playback queue ──

  void _enqueue(VoiceAnnouncement frame) {
    if (frame.actorId != actorId) return; // stale frame across a reconnect
    if (!_seenIds.add(frame.id)) return; // already played or queued
    _queue.add(_QueueItem(frame));
    _queueDepth.add(_queue.length);
    unawaited(_drain());
  }

  Future<void> _drain() async {
    if (_draining) return;
    _draining = true;
    try {
      while (_enabled.value && _queue.isNotEmpty) {
        final item = _queue.removeAt(0);
        _queueDepth.add(_queue.length);
        _nowPlaying.add(item.frame);
        try {
          await _deps.player.play(item.frame.audioUrl);
        } catch (e) {
          // The text is still on screen (glanceable), so surface the error and
          // move on — retrying a broken clip forever would wedge the queue.
          _lastError.add('Playback failed: $e');
        }
        if (_disposed) return;
        _nowPlaying.add(null);
        _lastPlayed.add(item.frame);
        // Record the played reply in the session transcript .
        _appendTranscript(
          ActorReplyEntry(timestamp: DateTime.now(), announcement: item.frame),
        );
        // Turned off mid-play: leave it unacked so it replays next mode entry.
        if (!_enabled.value) break;
        if (item.ackNeeded) {
          try {
            await _deps.api.ackVoiceAnnouncement(item.frame.id);
          } catch (e) {
            if (_disposed) return;
            _lastError.add('Ack failed: $e');
          }
        }
      }
    } finally {
      _draining = false;
    }
  }

  /// Skip the announcement currently playing (it still gets acked — a manual
  /// skip counts as played).
  void skip() {
    if (_nowPlaying.value == null) return;
    _deps.player.stop();
  }

  /// Queue the most recently played announcement again (no re-ack).
  void replayLast() {
    final last = _lastPlayed.value;
    if (last == null || !_enabled.value) return;
    _queue.insert(0, _QueueItem(last, ackNeeded: false));
    _queueDepth.add(_queue.length);
    unawaited(_drain());
  }

  // ── Record flow (tap-toggle) ──

  /// The big button's action: idle/delivered/error → start recording;
  /// recording → stop + send. Ignored while starting or sending.
  Future<void> toggleRecord() async {
    switch (_record.value.phase) {
      case RecordPhase.recording:
        await _stopAndSend();
      case RecordPhase.idle:
      case RecordPhase.delivered:
      case RecordPhase.error:
        await _startRecording();
      case RecordPhase.starting:
      case RecordPhase.sending:
        return;
    }
  }

  /// Abort an in-progress recording and return to idle .
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
      _record.add(const RecordStatus());
    }
  }

  Future<void> _startRecording() async {
    if (!_enabled.value) return;
    _deliveredReset?.cancel();
    _record.add(const RecordStatus(phase: RecordPhase.starting));
    try {
      await _deps.recorder.start();
    } catch (e) {
      _record.add(
        RecordStatus(phase: RecordPhase.error, message: 'Mic unavailable: $e'),
      );
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

  Future<void> _stopAndSend() async {
    _stopRecordTimers();
    _record.add(const RecordStatus(phase: RecordPhase.sending));
    try {
      final clip = await _deps.recorder.stop();
      final result = await _deps.api.sendVoiceMemo(
        actorId,
        clip.bytes,
        mimeType: clip.mimeType,
      );
      if (_disposed) return;
      // Append the user's transcribed memo to the session transcript .
      _appendTranscript(
        UserMemoEntry(
          timestamp: DateTime.now(),
          transcript: result.transcript,
          delivered: result.delivered,
        ),
      );
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
      final saved = e.status == 502;
      _record.add(
        RecordStatus(
          phase: RecordPhase.error,
          message: saved
              ? 'Transcription failed — audio saved on the server: '
                    '${_apiErrorText(e)}'
              : 'Send failed: ${_apiErrorText(e)}',
        ),
      );
    } catch (e) {
      if (_disposed) return;
      _record.add(
        RecordStatus(phase: RecordPhase.error, message: 'Send failed: $e'),
      );
    }
  }

  /// Append [entry] to the session transcript list and emit the updated list.
  void _appendTranscript(WalkieEntry entry) {
    if (_disposed) return;
    _transcript.add([..._transcript.value, entry]);
  }

  void _stopRecordTimers() {
    _recordTicker?.cancel();
    _recordTicker = null;
    _recordStartedAt = null;
    _deliveredReset?.cancel();
    _deliveredReset = null;
  }

  /// Pull the server's `{error}` body out of an API exception for display.
  String _apiErrorText(DashboardApiException e) {
    try {
      final parsed = jsonDecode(e.body);
      if (parsed is Map<String, dynamic> && parsed['error'] is String) {
        return parsed['error'] as String;
      }
    } catch (_) {}
    return 'HTTP ${e.status}';
  }

  /// Tear everything down (leaving the chat screen turns the mode off).
  Future<void> dispose() async {
    if (_disposed) return;
    await disable();
    _disposed = true;
    await Future.wait([
      _enabled.close(),
      _connection.close(),
      _record.close(),
      _queueDepth.close(),
      _nowPlaying.close(),
      _lastPlayed.close(),
      _lastError.close(),
      _available.close(),
      _transcript.close(),
    ]);
  }
}
