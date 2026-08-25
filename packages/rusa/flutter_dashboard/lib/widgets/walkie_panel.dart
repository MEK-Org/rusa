import 'package:flutter/material.dart';
import 'package:flutter/scheduler.dart';
import 'package:rxdart/rxdart.dart';

import '../models.dart';
import '../store.dart';
import '../theme.dart';
import '../walkie_controller.dart';
import 'status_dot.dart';

/// The walkie-mode toggle shown in the chat input row while the mode is OFF.
/// Disabled with an explanatory tooltip when voice is unconfigured on the
/// instance (503 probe).
class WalkieToggleButton extends StatefulWidget {
  const WalkieToggleButton({super.key, required this.controller});

  final WalkieController controller;

  @override
  State<WalkieToggleButton> createState() => _WalkieToggleButtonState();
}

class _WalkieToggleButtonState extends State<WalkieToggleButton> {
  @override
  void initState() {
    super.initState();
    widget.controller.init();
  }

  @override
  void didUpdateWidget(WalkieToggleButton oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.controller != widget.controller) {
      widget.controller.init();
    }
  }

  @override
  Widget build(BuildContext context) {
    return StreamBuilder<bool?>(
      stream: widget.controller.available,
      builder: (_, _) {
        final available = widget.controller.available.valueOrNull;
        final disabled = available == false;
        return Tooltip(
          message: disabled
              ? 'Voice is not configured on this instance'
              : 'Walkie-talkie mode',
          child: IconButton(
            key: const ValueKey('walkie-toggle'),
            icon: Icon(
              disabled ? Icons.mic_off : Icons.headset_mic_outlined,
              color: disabled ? MeshColors.textMuted : MeshColors.textSecondary,
            ),
            onPressed: disabled ? null : () => widget.controller.enable(),
          ),
        );
      },
    );
  }
}

/// The full-mode surface replacing the text input while walkie mode is ON:
/// status strip (connection, queue depth, persistent last error), the
/// glanceable now-playing/last-reply text, replay/skip, and the big
/// glove-friendly tap-toggle record button. Phone-first: large targets, high
/// contrast, minimal chrome.
class WalkiePanel extends StatelessWidget {
  const WalkiePanel({
    super.key,
    required this.controller,
    this.expanded = false,
    this.store,
  });

  final WalkieController controller;
  final bool expanded;
  final DashboardStore? store;

  @override
  Widget build(BuildContext context) {
    final streams = <Stream<dynamic>>[
      controller.connection,
      controller.record,
      controller.queueDepth,
      controller.nowPlaying,
      controller.lastPlayed,
      controller.lastError,
      controller.transcript,
    ];
    if (store != null) {
      streams.add(store!.actorStates);
      streams.add(store!.actorStates);
    }
    return StreamBuilder<List<Object?>>(
      stream: Rx.combineLatestList<Object?>(streams),
      builder: (_, _) {
        final connection =
            controller.connection.valueOrNull ?? WalkieConnection.off;
        final record = controller.record.valueOrNull ?? const RecordStatus();
        final queueDepth = controller.queueDepth.valueOrNull ?? 0;
        final nowPlaying = controller.nowPlaying.valueOrNull;
        final lastError = controller.lastError.valueOrNull;
        final entries = controller.transcript.valueOrNull ?? const [];

        final actor = store?.actorStates.valueOrNull?.actors[controller.actorId]?.thread;
        final dot = actor != null && store != null ? store!.dotFor(actor) : null;

        return Container(
          key: const ValueKey('walkie-panel'),
          decoration: const BoxDecoration(
            color: MeshColors.bgSecondary,
            border: Border(top: BorderSide(color: MeshColors.border)),
          ),
          padding: const EdgeInsets.fromLTRB(16, 10, 16, 16),
          child: Column(
            mainAxisSize: expanded ? MainAxisSize.max : MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              _statusRow(connection, queueDepth, dot),
              if (lastError != null) _errorBanner(lastError),
              if (expanded)
                Expanded(
                  child: _transcriptView(
                    entries,
                    nowPlaying: nowPlaying,
                  ),
                )
              else
                _transcriptView(
                  entries,
                  nowPlaying: nowPlaying,
                  constrained: true,
                ),
              const SizedBox(height: 10),
              _controlsRow(record, nowPlaying),
            ],
          ),
        );
      },
    );
  }

  Widget _statusRow(
    WalkieConnection connection,
    int queueDepth,
    DotState? dot,
  ) {
    final (color, label) = switch (connection) {
      WalkieConnection.connected => (MeshColors.statusActive, 'Connected'),
      WalkieConnection.connecting => (MeshColors.statusIdle, 'Connecting…'),
      WalkieConnection.reconnecting => (MeshColors.statusIdle, 'Reconnecting…'),
      WalkieConnection.off => (MeshColors.textMuted, 'Off'),
    };
    final (dotColor, dotLabel) = switch (dot) {
      DotState.active => (MeshColors.statusActive, 'active'),
      DotState.queued => (MeshColors.statusIdle, 'queued'),
      DotState.idle => (MeshColors.statusRetired, 'idle'),
      DotState.retired => (MeshColors.statusRetired, 'retired'),
      null => (MeshColors.textMuted, ''),
    };
    return Row(
      children: [
        Icon(Icons.headset_mic, size: 16, color: MeshColors.accent),
        const SizedBox(width: 6),
        const Text(
          'WALKIE',
          style: TextStyle(
            color: MeshColors.accent,
            fontSize: 11,
            fontWeight: FontWeight.w800,
            letterSpacing: 1,
          ),
        ),
        const SizedBox(width: 12),
        Container(
          width: 8,
          height: 8,
          decoration: BoxDecoration(color: color, shape: BoxShape.circle),
        ),
        const SizedBox(width: 6),
        Text(label, style: TextStyle(color: color, fontSize: 12)),
        if (dot != null) ...[
          const SizedBox(width: 12),
          StatusDot(state: dot, size: 8),
          const SizedBox(width: 6),
          Text(
            dotLabel,
            style: TextStyle(color: dotColor, fontSize: 12),
          ),
        ],
        const SizedBox(width: 12),
        if (queueDepth > 0)
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
            decoration: BoxDecoration(
              color: MeshColors.bgTertiary,
              borderRadius: BorderRadius.circular(10),
            ),
            child: Text(
              '$queueDepth queued',
              style: const TextStyle(
                color: MeshColors.textSecondary,
                fontSize: 11,
              ),
            ),
          ),
        const Spacer(),
        IconButton(
          key: const ValueKey('walkie-off'),
          tooltip: 'Turn walkie mode off',
          icon: const Icon(Icons.power_settings_new, color: MeshColors.accent),
          onPressed: () => controller.disable(),
        ),
      ],
    );
  }

  /// Persistent (driving-context) error surface — no vanishing toasts.
  Widget _errorBanner(String message) => Container(
    key: const ValueKey('walkie-error'),
    margin: const EdgeInsets.only(bottom: 8),
    padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
    decoration: BoxDecoration(
      color: MeshColors.statusHalted.withValues(alpha: 0.15),
      borderRadius: BorderRadius.circular(8),
      border: Border.all(color: MeshColors.statusHalted.withValues(alpha: 0.5)),
    ),
    child: Text(
      message,
      style: const TextStyle(color: MeshColors.statusHalted, fontSize: 13),
    ),
  );

  /// Scrollable session transcript : all user memos and actor replies,
  /// newest at bottom, auto-scrolled. Shows a placeholder when empty.
  Widget _transcriptView(
    List<WalkieEntry> entries, {
    VoiceAnnouncement? nowPlaying,
    bool constrained = false,
  }) {
    if (entries.isEmpty && nowPlaying == null) {
      return const Padding(
        padding: EdgeInsets.symmetric(vertical: 12),
        child: Text(
          'Tap the mic, talk, tap again to send.',
          textAlign: TextAlign.center,
          style: TextStyle(color: MeshColors.textMuted, fontSize: 14),
        ),
      );
    }
    return _WalkieTranscriptView(
      entries: entries,
      nowPlaying: nowPlaying,
      constrained: constrained,
    );
  }

  Widget _controlsRow(
    RecordStatus record,
    VoiceAnnouncement? nowPlaying,
  ) {
    final lastPlayed = controller.lastPlayed.valueOrNull;
    final isRecording =
        record.phase == RecordPhase.recording ||
        record.phase == RecordPhase.starting;
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        Row(
          mainAxisAlignment: MainAxisAlignment.spaceEvenly,
          children: [
            if (isRecording)
              _sideButton(
                key: const ValueKey('walkie-cancel'),
                icon: Icons.close,
                label: 'Cancel',
                enabled: true,
                onTap: controller.cancelRecord,
              )
            else
              _sideButton(
                key: const ValueKey('walkie-replay'),
                icon: Icons.replay,
                label: 'Replay',
                enabled: lastPlayed != null,
                onTap: controller.replayLast,
              ),
            _RecordButton(record: record, onTap: controller.toggleRecord),
            _sideButton(
              key: const ValueKey('walkie-skip'),
              icon: Icons.skip_next,
              label: 'Skip',
              enabled: nowPlaying != null,
              onTap: controller.skip,
            ),
          ],
        ),
        const SizedBox(height: 6),
        _recordCaption(record),
      ],
    );
  }

  Widget _recordCaption(RecordStatus record) {
    final (text, color) = switch (record.phase) {
      RecordPhase.idle => ('', MeshColors.textMuted),
      RecordPhase.starting => ('Opening mic…', MeshColors.textSecondary),
      RecordPhase.recording => (
        'Recording ${_fmtElapsed(record.elapsed)} — tap to send',
        MeshColors.statusHalted,
      ),
      RecordPhase.sending => ('Sending…', MeshColors.textSecondary),
      RecordPhase.delivered => (
        record.delivered
            ? 'Delivered: "${record.transcript ?? ''}"'
            : 'Queued (actor asleep): "${record.transcript ?? ''}"',
        MeshColors.statusActive,
      ),
      RecordPhase.error => (record.message ?? 'Error', MeshColors.statusHalted),
    };
    if (text.isEmpty) return const SizedBox(height: 16);
    return Text(
      text,
      key: const ValueKey('walkie-record-caption'),
      textAlign: TextAlign.center,
      maxLines: 3,
      overflow: TextOverflow.ellipsis,
      style: TextStyle(color: color, fontSize: 13),
    );
  }

  Widget _sideButton({
    required Key key,
    required IconData icon,
    required String label,
    required bool enabled,
    required VoidCallback onTap,
  }) {
    final color = enabled ? MeshColors.textSecondary : MeshColors.textMuted;
    return InkWell(
      key: key,
      onTap: enabled ? onTap : null,
      borderRadius: BorderRadius.circular(12),
      child: Padding(
        padding: const EdgeInsets.all(10),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(icon, size: 30, color: color),
            const SizedBox(height: 2),
            Text(label, style: TextStyle(color: color, fontSize: 11)),
          ],
        ),
      ),
    );
  }
}

String _fmtElapsed(Duration d) {
  final m = d.inMinutes;
  final s = d.inSeconds % 60;
  return '$m:${s.toString().padLeft(2, '0')}';
}

// ── Transcript widgets  ───────────────────────────────────────────────────

/// Scrollable list of [WalkieEntry] items that auto-scrolls to the newest
/// entry.  Owns its [ScrollController] so it is properly disposed.
class _WalkieTranscriptView extends StatefulWidget {
  const _WalkieTranscriptView({
    required this.entries,
    required this.nowPlaying,
    required this.constrained,
  });

  final List<WalkieEntry> entries;
  final VoiceAnnouncement? nowPlaying;
  final bool constrained;

  @override
  State<_WalkieTranscriptView> createState() => _WalkieTranscriptViewState();
}

class _WalkieTranscriptViewState extends State<_WalkieTranscriptView> {
  final _scroll = ScrollController();

  @override
  void didUpdateWidget(_WalkieTranscriptView oldWidget) {
    super.didUpdateWidget(oldWidget);
    final oldCount = oldWidget.entries.length + (oldWidget.nowPlaying != null ? 1 : 0);
    final newCount = widget.entries.length + (widget.nowPlaying != null ? 1 : 0);
    if (newCount <= oldCount) return;
    // Capture "was at bottom" synchronously, while _scroll.position still
    // reflects the pre-update extent (before the new entry is laid out).
    // If the user has scrolled up to read back a transcript entry, leave their
    // position alone — a new memo/reply should NOT yank them to the bottom.
    // hasClients==false → first entries ever, treat as at-bottom so they scroll.
    // Content shorter than viewport → maxScrollExtent==0, pixels==0 ≥ -40 → true.
    final wasAtBottom = !_scroll.hasClients ||
        _scroll.position.pixels >= _scroll.position.maxScrollExtent - 40;
    if (!wasAtBottom) return;
    SchedulerBinding.instance.addPostFrameCallback((_) {
      if (_scroll.hasClients) {
        _scroll.animateTo(
          _scroll.position.maxScrollExtent,
          duration: const Duration(milliseconds: 200),
          curve: Curves.easeOut,
        );
      }
    });
  }



  @override
  void dispose() {
    _scroll.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final entries = widget.entries;
    final nowPlaying = widget.nowPlaying;
    final constrained = widget.constrained;

    final listView = ListView.builder(
      key: const ValueKey('walkie-transcript'),
      controller: _scroll,
      padding: const EdgeInsets.symmetric(vertical: 4),
      shrinkWrap: constrained,
      physics: constrained
          ? const NeverScrollableScrollPhysics()
          : const ClampingScrollPhysics(),
      itemCount: entries.length + (nowPlaying != null ? 1 : 0),
      itemBuilder: (context, index) {
        if (nowPlaying != null && index == entries.length) {
          return _WalkieTranscriptEntry(
            label: 'NOW PLAYING',
            labelColor: MeshColors.statusActive,
            labelIcon: Icons.volume_up,
            text: nowPlaying.text,
            textColor: MeshColors.textPrimary,
            isMemo: false,
          );
        }
        final entry = entries[index];
        return switch (entry) {
          UserMemoEntry e => _WalkieTranscriptEntry(
            label: 'YOU SAID',
            labelColor: MeshColors.accent,
            labelIcon: Icons.mic,
            text: e.transcript.isEmpty ? '(no transcript)' : e.transcript,
            textColor: MeshColors.textPrimary,
            isMemo: true,
          ),
          ActorReplyEntry e => _WalkieTranscriptEntry(
            label: 'REPLY',
            labelColor: MeshColors.textMuted,
            labelIcon: Icons.history,
            text: e.announcement.text,
            textColor: MeshColors.textSecondary,
            isMemo: false,
          ),
        };
      },
    );

    if (constrained) {
      return ConstrainedBox(
        constraints: const BoxConstraints(maxHeight: 180),
        child: SingleChildScrollView(reverse: true, child: listView),
      );
    }
    return listView;
  }
}

/// One row in the transcript: a small label + coloured bubble with the text.
class _WalkieTranscriptEntry extends StatelessWidget {
  const _WalkieTranscriptEntry({
    required this.label,
    required this.labelColor,
    required this.labelIcon,
    required this.text,
    required this.textColor,
    required this.isMemo,
  });

  final String label;
  final Color labelColor;
  final IconData labelIcon;
  final String text;
  final Color textColor;
  final bool isMemo;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 5),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(labelIcon, size: 13, color: labelColor),
              const SizedBox(width: 5),
              Text(
                label,
                style: TextStyle(
                  color: labelColor,
                  fontSize: 10,
                  fontWeight: FontWeight.w700,
                  letterSpacing: 1,
                ),
              ),
            ],
          ),
          const SizedBox(height: 3),
          Container(
            width: double.infinity,
            padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
            decoration: BoxDecoration(
              color: isMemo
                  ? MeshColors.accent.withValues(alpha: 0.08)
                  : MeshColors.bgTertiary,
              borderRadius: BorderRadius.circular(8),
              border: isMemo
                  ? Border.all(
                      color: MeshColors.accent.withValues(alpha: 0.25),
                    )
                  : null,
            ),
            child: Text(
              text,
              key: isMemo
                  ? const ValueKey('walkie-transcript-memo')
                  : const ValueKey('walkie-transcript-reply'),
              style: TextStyle(
                color: textColor,
                fontSize: 19,
                height: 1.35,
                fontWeight: FontWeight.w500,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// The big glove-friendly tap-toggle record button (88px target).
class _RecordButton extends StatelessWidget {
  const _RecordButton({required this.record, required this.onTap});

  final RecordStatus record;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final recording = record.phase == RecordPhase.recording;
    final busy =
        record.phase == RecordPhase.sending ||
        record.phase == RecordPhase.starting;
    final color = switch (record.phase) {
      RecordPhase.recording => MeshColors.statusHalted,
      RecordPhase.delivered => MeshColors.statusActive,
      RecordPhase.error => MeshColors.statusHalted,
      _ => MeshColors.accent,
    };
    return Material(
      color: color.withValues(alpha: recording ? 0.25 : 0.15),
      shape: CircleBorder(side: BorderSide(color: color, width: 2)),
      child: InkWell(
        key: const ValueKey('walkie-record'),
        customBorder: const CircleBorder(),
        onTap: busy ? null : onTap,
        child: SizedBox(
          width: 88,
          height: 88,
          child: busy
              ? const Center(
                  child: SizedBox(
                    width: 30,
                    height: 30,
                    child: CircularProgressIndicator(
                      strokeWidth: 3,
                      color: MeshColors.accent,
                    ),
                  ),
                )
              : Icon(
                  switch (record.phase) {
                    RecordPhase.recording => Icons.stop,
                    RecordPhase.delivered => Icons.check,
                    RecordPhase.error => Icons.refresh,
                    _ => Icons.mic,
                  },
                  size: 42,
                  color: color,
                ),
        ),
      ),
    );
  }
}
