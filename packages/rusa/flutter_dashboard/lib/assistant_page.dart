import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'api.dart';
import 'assistant_platform.dart';
import 'models.dart';
import 'session.dart';
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
    this.initialReply,
    this.notificationOpening = false,
    this.restoringFromRecents = false,
    this.session,
    this.onClose,
  });

  final DashboardApi Function() createApi;
  final WalkieDeps? Function(DashboardApi api) createWalkieDeps;
  final AssistantSignals? signals;
  final AssistantReplyTarget? initialReply;

  /// A notification was opened while the keyguard was locked; native code
  /// supplies its target only after the user unlocks.
  final bool notificationOpening;

  /// Android restored this task from Recents. It mounts an inert restricted
  /// session rather than treating the historical route as a new assist.
  final bool restoringFromRecents;

  /// The independently mounted assist engine observes the shared Firebase
  /// session too. A dashboard logout therefore closes this retained task rather
  /// than leaving its transcript, capture, or transport alive on the device.
  final DashboardSession? session;

  /// Leaves the assist screen; defaults to finishing the activity.
  final VoidCallback? onClose;

  @override
  State<AssistantPage> createState() => _AssistantPageState();
}

class _AssistantPageState extends State<AssistantPage> {
  late final DashboardApi _api;
  WalkieDeps? _deps;
  WalkieController? _controller;

  /// The controller triggers reach once network and session readiness resolve.
  /// Triggers arriving before adoption buffer into [_pendingStop] and complete
  /// on adopt rather than being dropped.
  WalkieController? _live;
  late Future<WalkieController> _ready;
  final _subs = <StreamSubscription<Object?>>[];
  StreamSubscription<bool>? _enabledSub;
  int _attempt = 0;
  bool _disposed = false;
  bool _backgrounded = false;
  bool _suppressInitialCapture = false;
  bool _pendingStop = false;
  bool _closingForLogout = false;
  Future<void> Function()? _cancelCurrentCapture;
  AssistantReplyTarget? _pendingReply;

  @override
  void initState() {
    super.initState();
    _api = widget.createApi();
    _deps = widget.createWalkieDeps(_api);
    _pendingReply = widget.initialReply;
    _suppressInitialCapture =
        widget.initialReply != null ||
        widget.notificationOpening ||
        widget.restoringFromRecents;
    final signals = widget.signals;
    if (signals != null) {
      _subs.add(signals.triggers.listen((_) => unawaited(_onTrigger())));
      _subs.add(signals.routeLost.listen((_) => unawaited(_onRouteLost())));
      signals.onBackground = _background;
      signals.onForeground = _foreground;
      signals.onLockedAssist = _restartLockedAssist;
      signals.onReply = _receiveReply;
    }
    widget.session?.addListener(_onSessionChanged);
    _ready = _start();
  }

  void _onSessionChanged() {
    if (widget.session?.status == DashboardSessionStatus.signedOut) {
      unawaited(_closeForLogout());
    }
  }

  Future<void> _closeForLogout() async {
    if (_disposed || _closingForLogout) return;
    _closingForLogout = true;
    ++_attempt;
    _pendingReply = null;
    _pendingStop = false;
    _backgrounded = true;
    final cancelCapture = _cancelCurrentCapture;
    _cancelCurrentCapture = null;
    await cancelCapture?.call();
    final previousEnabled = _enabledSub;
    _enabledSub = null;
    unawaited(previousEnabled?.cancel());
    final previous = _controller;
    _controller = null;
    _live = null;
    // Closing the activity unmounts WalkiePanel's stream listeners. Dispose
    // only after requesting that close: waiting for the subjects here would
    // deadlock against the still-mounted panel that owns those listeners.
    unawaited(previous?.dispose());
    if (!_disposed) _close();
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

    _pendingStop = false;

    // Capture starts immediately on assist entry (#1223): local microphone
    // recording begins at once without waiting on network readiness, with the
    // session and root actor resolution catching up in parallel.
    //
    // Scoped per attempt: cancellation only affects the active attempt;
    // a stale attempt never touches the shared recorder so it cannot cancel a
    // newer take, leaving dispose() and a newer start() to release it.
    // Notification and Recents routes suppress capture only for the route
    // that opened this task. A later ordinary locked assist is a new request,
    // so [_restartLockedAssist] clears this before replacement startup.
    final captureSuppressed = _suppressInitialCapture;
    var captureActive = !captureSuppressed;
    Future<void> cancelCapture() async {
      if (!captureActive) return;
      captureActive = false;
      try {
        await deps.recorder.cancel();
      } catch (_) {}
    }

    _cancelCurrentCapture = cancelCapture;

    final captureStartedAt = DateTime.now();
    Object? captureError;
    final captureFuture = captureSuppressed
        ? Future<void>.value()
        : () async {
            try {
              await deps.recorder.start();
              if (stale() || !captureActive) {
                if (!stale()) {
                  try {
                    await deps.recorder.cancel();
                  } catch (_) {}
                }
                return;
              }
              final elapsed = DateTime.now()
                  .difference(captureStartedAt)
                  .inMilliseconds;
              debugPrint('assistant_page: Capture live in ${elapsed}ms');
              // Play audible ready cue at observed capture readiness for assist entry only.
              await widget.signals?.playReadyCue();
            } catch (e) {
              if (!stale()) {
                captureActive = false;
                captureError = e;
              }
            }
          }();

    ThreadsSnapshot snapshot;
    try {
      snapshot = await _api.fetchThreads();
    } catch (e) {
      if (_cancelCurrentCapture == cancelCapture) {
        _cancelCurrentCapture = null;
      }
      if (!stale()) {
        await cancelCapture();
      }
      rethrow;
    }

    // Only the current start may drop the previous walkie-off listener.
    if (stale()) {
      if (_cancelCurrentCapture == cancelCapture) {
        _cancelCurrentCapture = null;
      }
      throw StateError('Assist screen closed');
    }
    final previousEnabled = _enabledSub;
    _enabledSub = null;
    await previousEnabled?.cancel();
    if (stale()) {
      if (_cancelCurrentCapture == cancelCapture) {
        _cancelCurrentCapture = null;
      }
      throw StateError('Assist screen closed');
    }

    final root = resolveRootActorId(snapshot);
    if (root == null) {
      if (_cancelCurrentCapture == cancelCapture) {
        _cancelCurrentCapture = null;
      }
      if (!stale()) {
        await cancelCapture();
      }
      throw StateError('No active root actor');
    }

    unawaited(_controller?.dispose());
    final controller = WalkieController(
      // This surface stays walkie-to-root. A reply target is accepted only
      // when it belongs to that same root conversation; it never rebinds the
      // recipient of a later assist gesture or headset trigger.
      actorId: root,
      deps: deps,
      sessionRepliesOnly: true,
      androidAssistantSession: true,
    );
    _controller = controller;
    if (_backgrounded || captureSuppressed) controller.suspendPlayback();
    Future<Never> discard([String reason = 'Assist screen closed']) async {
      if (_cancelCurrentCapture == cancelCapture) {
        _cancelCurrentCapture = null;
      }
      if (_controller == controller) _controller = null;
      await controller.dispose();
      if (!stale()) {
        await cancelCapture();
      }
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
      if (_cancelCurrentCapture == cancelCapture) {
        _cancelCurrentCapture = null;
      }
      if (stale()) return discard();
      if (_controller == controller) _controller = null;
      await controller.dispose();
      if (captureError is StateError) throw captureError!;
      throw StateError('Mic unavailable: $captureError');
    }
    if (stale()) return discard();
    if (!controller.enabled.value) {
      return discard('Voice is not configured on this instance');
    }

    final captureCancelled = !captureActive;
    captureActive = false;
    if (_cancelCurrentCapture == cancelCapture) {
      _cancelCurrentCapture = null;
    }
    // Backgrounding while startup is still resolving keeps the reply session,
    // but a discarded take must not be adopted as an active recording.
    if (!captureCancelled) {
      controller.adoptRecording(startedAt: captureStartedAt);
    }

    // Walkie off (the panel's power button) ends the assist session.
    late final StreamSubscription<bool> enabledSub;
    enabledSub = controller.enabled.skip(1).listen((enabled) {
      if (!enabled && identical(_enabledSub, enabledSub)) _close();
    });
    _enabledSub = enabledSub;
    _live = controller;
    final pendingReply = _pendingReply;
    _pendingReply = null;
    if (pendingReply != null) {
      unawaited(_receiveReply(pendingReply));
    }
    if (_pendingStop) {
      _pendingStop = false;
      unawaited(controller.toggleRecord());
    }
    return controller;
  }

  Future<void> _receiveReply(AssistantReplyTarget target) async {
    final controller = _live;
    if (controller == null) {
      _pendingReply = target;
      return;
    }
    // A notification never rebinds a retained walkie session. Reject a target
    // for another actor before it can interrupt this session's capture/audio.
    if (controller.actorId != target.actorId) return;
    _pendingReply = null;
    // A reply tap never sends a partial memo or resumes an older queued reply
    // first. It selects one reply and then resumes only that playback path.
    _backgrounded = false;
    _pendingStop = false;
    await _cancelCurrentCapture?.call();
    await controller.cancelRecord();
    controller.suspendPlayback();
    // History is chronological and gives the selected durable row a stable
    // place to replace. Do not race its mutation with exact-reply promotion.
    await _restoreNotificationConversation(controller);
    final presented = await _presentReply(controller, target);
    if (presented && !_disposed && identical(_controller, controller)) {
      controller.resumePlayback();
    }
  }

  Future<void> _restoreNotificationConversation(
    WalkieController controller,
  ) async {
    try {
      // This route applies the authenticated human participant server-side.
      // Delay it until native keyguard dismissal supplied the opaque target.
      final history = await _api.fetchChat(
        actors: [controller.actorId],
        limit: 20,
      );
      if (_disposed || _controller != controller) return;
      // Chat pages are newest-first; transcript rendering is chronological.
      controller.restoreConversation(history.chat.reversed.toList());
    } catch (_) {
      // The exact tapped reply remains independently recoverable. Do not
      // expand a history-fetch failure into broader dashboard access here.
    }
  }

  Future<bool> _presentReply(
    WalkieController controller,
    AssistantReplyTarget target,
  ) async {
    // The native intent carries opaque keys, but keep this UI boundary narrow:
    // only the current restricted conversation may receive its exact reply.
    if (controller.actorId != target.actorId) return false;
    try {
      final reply = await _api.fetchVoiceReply(
        target.actorId,
        target.announcementId,
      );
      if (_disposed || _controller != controller) return false;
      controller.presentNotificationReply(reply);
      return true;
    } catch (_) {
      // Failed/stale notification recovery reveals no wider dashboard state.
      return false;
    }
  }

  Future<void> _onTrigger() async {
    final controller = _live;
    if (controller != null) {
      // Walkie off is closing the screen; a trigger does not reopen it.
      if (!controller.enabled.value) return;
      await controller.toggleRecord();
      return;
    }
    // If the user triggers stop/send before network resolution completes,
    // buffer the stop request so adoption immediately stops and uploads.
    if (_cancelCurrentCapture != null) {
      _pendingStop = true;
    }
  }

  Future<void> _onRouteLost() async {
    final controller = _controller;
    if (controller?.record.value.phase == RecordPhase.recording) {
      await controller!.toggleRecord();
      return;
    }
    if (_cancelCurrentCapture != null) {
      _pendingStop = true;
    }
  }

  /// Leaving the visible assist task is not session termination: capture ends
  /// independently, and reply audio waits until the task is foregrounded.
  Future<void> _background() async {
    _backgrounded = true;
    _pendingStop = false;
    await _cancelCurrentCapture?.call();
    await _controller?.cancelRecord();
    _controller?.suspendPlayback();
  }

  Future<void> _foreground() async {
    _backgrounded = false;
    // Returning a stopped task (including from Recents) restores the visible
    // session, but not automatic audio. An explicit reply tap resumes audio.
  }

  /// A lock-screen assist gesture is a new restricted capture, not a return
  /// to whatever unlocked transcript and reply queue this returnable activity
  /// retained. Dispose that old session before starting capture again; this
  /// preserves the commissioned lock-screen path without exposing old state.
  Future<void> _restartLockedAssist() async {
    if (_disposed) return;
    ++_attempt;
    _pendingReply = null;
    _pendingStop = false;
    _backgrounded = false;
    _suppressInitialCapture = false;
    await _cancelCurrentCapture?.call();
    // Disposing a walkie controller emits `enabled: false`. Detach its
    // walkie-off listener before disposal so replacing a retained session does
    // not also finish the newly requested locked assist task.
    final previousEnabled = _enabledSub;
    _enabledSub = null;
    unawaited(previousEnabled?.cancel());
    final previous = _controller;
    _controller = null;
    _live = null;
    await previous?.dispose();
    if (_disposed) return;
    // Keep the replacement start observed by the visible FutureBuilder. That
    // also makes a later activity teardown own a stale-start error rather
    // than leaving it as an unhandled asynchronous exception.
    final restart = _start();
    setState(() {
      _ready = restart;
    });
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
    widget.session?.removeListener(_onSessionChanged);
    final signals = widget.signals;
    if (signals != null) {
      if (signals.onBackground == _background) signals.onBackground = null;
      if (signals.onForeground == _foreground) signals.onForeground = null;
      if (signals.onLockedAssist == _restartLockedAssist) {
        signals.onLockedAssist = null;
      }
      if (signals.onReply == _receiveReply) signals.onReply = null;
    }
    for (final sub in _subs) {
      unawaited(sub.cancel());
    }
    unawaited(_enabledSub?.cancel());
    if (_controller != null) {
      unawaited(_controller?.dispose());
    }
    if (_cancelCurrentCapture != null) {
      unawaited(_cancelCurrentCapture?.call());
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
