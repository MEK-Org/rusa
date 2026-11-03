import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'api.dart';
import 'assistant_platform.dart';
import 'models.dart';
import 'theme.dart';
import 'voice_platform.dart';
import 'walkie_controller.dart';
import 'widgets/walkie_panel.dart';

/// The screen Android's assist trigger opens (`AssistActivity.kt`): walkie mode
/// to the root actor, recording immediately on entry over the lock screen. It
/// reaches nothing else of the dashboard. Another trigger, or the headset
/// ending its voice recognition, stops and sends; turning walkie off closes the
/// screen.
class AssistantPage extends StatefulWidget {
  const AssistantPage({
    super.key,
    required this.createApi,
    required this.createWalkieDeps,
    this.signals,
    this.onClose,
  });

  final DashboardApi Function() createApi;
  final WalkieDeps? Function(DashboardApi api) createWalkieDeps;
  final AssistantSignals? signals;

  /// Leaves the assist screen; defaults to finishing the activity.
  final VoidCallback? onClose;

  @override
  State<AssistantPage> createState() => _AssistantPageState();
}

class _AssistantPageState extends State<AssistantPage> {
  late final DashboardApi _api;
  WalkieDeps? _deps;
  WalkieController? _controller;

  /// The controller triggers reach: set once its start has begun recording,
  /// so a trigger while voice starts is dropped rather than racing it.
  WalkieController? _live;
  late Future<WalkieController> _ready;
  final _subs = <StreamSubscription<Object?>>[];
  StreamSubscription<bool>? _enabledSub;
  int _attempt = 0;
  bool _ended = false;
  bool _disposed = false;
  bool _recordingActive = false;

  Future<void> _cancelCapture() async {
    if (!_recordingActive) return;
    _recordingActive = false;
    try {
      await _deps?.recorder.cancel();
    } catch (_) {}
  }

  @override
  void initState() {
    super.initState();
    _api = widget.createApi();
    _deps = widget.createWalkieDeps(_api);
    final signals = widget.signals;
    if (signals != null) {
      _subs.add(signals.triggers.listen((_) => unawaited(_onTrigger())));
      _subs.add(signals.routeLost.listen((_) => unawaited(_onRouteLost())));
      signals.onEnd = _end;
    }
    _ready = _start();
  }

  Future<WalkieController> _start() async {
    // Each start owns its controller until the page is disposed or a Retry
    // supersedes it; a stale start discards what it built instead of recording.
    final attempt = ++_attempt;
    bool stale() => _disposed || attempt != _attempt;
    final deps = _deps;
    if (deps == null) {
      throw StateError('Voice is not available on this device');
    }

    // Capture starts immediately on assist entry (#1223): local microphone
    // recording begins at once without waiting on network readiness, with the
    // session and root actor resolution catching up in parallel.
    _recordingActive = true;
    final captureStartedAt = DateTime.now();
    Object? captureError;
    final captureFuture = () async {
      try {
        await deps.recorder.start();
        if (stale() || !_recordingActive) {
          await _cancelCapture();
          return;
        }
        // Play audible ready cue at observed capture readiness for assist entry only.
        await widget.signals?.playReadyCue();
      } catch (e) {
        _recordingActive = false;
        captureError = e;
      }
    }();

    ThreadsSnapshot snapshot;
    try {
      snapshot = await _api.fetchThreads();
    } catch (e) {
      await _cancelCapture();
      rethrow;
    }

    // Only the current start may drop the previous walkie-off listener.
    if (stale()) {
      await _cancelCapture();
      throw StateError('Assist screen closed');
    }
    final previousEnabled = _enabledSub;
    _enabledSub = null;
    await previousEnabled?.cancel();
    if (stale()) {
      await _cancelCapture();
      throw StateError('Assist screen closed');
    }

    final root = resolveRootActorId(snapshot);
    if (root == null) {
      await _cancelCapture();
      throw StateError('No active root actor');
    }

    unawaited(_controller?.dispose());
    final controller = WalkieController(
      actorId: root,
      deps: deps,
      sessionRepliesOnly: true,
    );
    _controller = controller;
    Future<Never> discard([String reason = 'Assist screen closed']) async {
      if (_controller == controller) _controller = null;
      await controller.dispose();
      await _cancelCapture();
      throw StateError(reason);
    }

    await controller.init();
    if (stale()) return discard();
    if (controller.available.valueOrNull == false) {
      return discard('Voice is not configured on this instance');
    }
    await controller.enable();
    if (stale()) return discard();

    await captureFuture;
    if (captureError != null) {
      if (stale()) return discard();
      await controller.dispose();
      if (captureError is StateError) throw captureError!;
      throw StateError('Mic unavailable: $captureError');
    }
    if (stale()) return discard();

    _recordingActive = false;
    controller.adoptRecording(startedAt: captureStartedAt);

    // Walkie off (the panel's power button) ends the assist session.
    _enabledSub = controller.enabled.skip(1).listen((enabled) {
      if (!enabled) _close();
    });
    _live = controller;
    return controller;
  }

  Future<void> _onTrigger() async {
    final controller = _live;
    // Walkie off is closing the screen; a trigger does not reopen it.
    if (controller == null || !controller.enabled.value) return;
    await controller.toggleRecord();
  }

  Future<void> _onRouteLost() async {
    final controller = _controller;
    if (controller?.record.value.phase == RecordPhase.recording) {
      await controller!.toggleRecord();
    }
  }

  /// The screen is closing because it left the screen. End the session
  /// before the engine goes, as walkie off does: the recorder cancels, which
  /// deletes the partial take, and the server's voice session is disabled.
  Future<void> _end() async {
    // A start still in flight is now stale and discards what it built.
    _attempt++;
    // A trigger can bring the closing screen back to the front before it
    // finishes; it shows nothing of the ended session to tap.
    if (mounted) setState(() => _ended = true);
    // Cancelled now, walkie off below cannot also close the screen.
    unawaited(_enabledSub?.cancel());
    _enabledSub = null;
    final controller = _controller;
    _controller = null;
    _live = null;
    final pending = _ready;
    if (controller != null) {
      await controller.dispose();
    } else {
      await _cancelCapture();
    }
    try {
      await pending;
    } catch (_) {
      // A failed or discarded start holds nothing.
    }
  }

  void _close() {
    final onClose = widget.onClose;
    if (onClose != null) {
      onClose();
    } else {
      unawaited(SystemNavigator.pop());
    }
  }

  @override
  void dispose() {
    _disposed = true;
    final signals = widget.signals;
    if (signals != null && signals.onEnd == _end) signals.onEnd = null;
    for (final sub in _subs) {
      unawaited(sub.cancel());
    }
    unawaited(_enabledSub?.cancel());
    if (_controller != null) {
      unawaited(_controller?.dispose());
    } else {
      unawaited(_cancelCapture());
    }
    super.dispose();
  }

  /// An unexpected failure (a socket error naming the server, an HTTP error
  /// body) goes to the log, not this minimal screen. The page's own
  /// [StateError]s are written to be shown.
  String _errorText(Object? error) {
    if (error is StateError) return error.message;
    debugPrint('Assist screen failed to start: $error');
    return "Couldn't reach Rusa";
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: MeshColors.bgPrimary,
      body: SafeArea(
        child: FutureBuilder<WalkieController>(
          future: _ready,
          builder: (context, snapshot) {
            if (_ended) return const SizedBox.shrink();
            final controller = snapshot.data;
            if (controller != null) {
              return WalkiePanel(controller: controller, expanded: true);
            }
            if (snapshot.hasError) {
              return Center(
                key: const ValueKey('assistant-error'),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(
                      _errorText(snapshot.error),
                      style: const TextStyle(color: MeshColors.textSecondary),
                    ),
                    TextButton(
                      onPressed: () => setState(() {
                        _ready = _start();
                      }),
                      child: const Text('Retry'),
                    ),
                  ],
                ),
              );
            }
            return const Center(child: CircularProgressIndicator());
          },
        ),
      ),
    );
  }
}
