import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'api.dart';
import 'assistant_platform.dart';
import 'theme.dart';
import 'voice_platform.dart';
import 'walkie_controller.dart';
import 'widgets/walkie_panel.dart';

/// The screen Android's assist trigger opens: walkie mode to the root actor,
/// already recording. It can show over the lock screen, so it reaches nothing
/// else of the dashboard. Another trigger, or the headset ending its voice
/// recognition, stops and sends; turning walkie off closes the screen.
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
  late Future<WalkieController> _ready;
  final _subs = <StreamSubscription<Object?>>[];
  StreamSubscription<bool>? _enabledSub;
  int _attempt = 0;
  bool _disposed = false;

  @override
  void initState() {
    super.initState();
    _api = widget.createApi();
    _deps = widget.createWalkieDeps(_api);
    final signals = widget.signals;
    if (signals != null) {
      _subs.add(signals.triggers.listen((_) => unawaited(_onTrigger())));
      _subs.add(signals.routeLost.listen((_) => unawaited(_onRouteLost())));
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
    final snapshot = await _api.fetchThreads();
    await _enabledSub?.cancel();
    _enabledSub = null;
    if (stale()) throw StateError('Assist screen closed');
    final root = resolveRootActorId(snapshot.threads);
    if (root == null) throw StateError('No active root actor');
    unawaited(_controller?.dispose());
    final controller = WalkieController(
      actorId: root,
      deps: deps,
      sessionRepliesOnly: true,
    );
    _controller = controller;
    Future<Never> discard() async {
      if (_controller == controller) _controller = null;
      await controller.dispose();
      throw StateError('Assist screen closed');
    }

    await controller.init();
    if (stale()) return discard();
    if (controller.available.valueOrNull == false) {
      throw StateError('Voice is not configured on this instance');
    }
    await controller.enable();
    if (stale()) return discard();
    // Walkie off (the panel's power button) ends the assist session.
    _enabledSub = controller.enabled.skip(1).listen((enabled) {
      if (!enabled) _close();
    });
    unawaited(controller.toggleRecord());
    return controller;
  }

  Future<void> _onTrigger() async {
    final controller = _controller;
    if (controller == null) return;
    if (!controller.enabled.value) await controller.enable();
    await controller.toggleRecord();
  }

  Future<void> _onRouteLost() async {
    final controller = _controller;
    if (controller?.record.value.phase == RecordPhase.recording) {
      await controller!.toggleRecord();
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
    for (final sub in _subs) {
      unawaited(sub.cancel());
    }
    unawaited(_enabledSub?.cancel());
    unawaited(_controller?.dispose());
    super.dispose();
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
                    Text(switch (snapshot.error) {
                      StateError(:final message) => message,
                      final error => '$error',
                    }, style: const TextStyle(color: MeshColors.textSecondary)),
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
