import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:rxdart/rxdart.dart';

import '../chat_room_controller.dart';
import '../models.dart';
import '../store.dart';
import '../theme.dart';
import '../walkie_controller.dart';
import 'avatar.dart';

/// The dashboard-global V1 Chat Room. It intentionally does not reuse the
/// selected actor's chat pane: the room owns one multi-actor receive queue,
/// while the existing single-actor walkie keeps its leased-session behavior.
///
/// Membership is read-only here. Root adds and removes participants on the
/// server (#663), and the tab re-reads that roster while it is open so every
/// dashboard shows the same room.
class ChatRoomTab extends StatefulWidget {
  const ChatRoomTab({
    super.key,
    required this.store,
    this.rosterPollInterval = const Duration(seconds: 10),
  });

  final DashboardStore store;
  final Duration rosterPollInterval;

  @override
  State<ChatRoomTab> createState() => _ChatRoomTabState();
}

class _ChatRoomTabState extends State<ChatRoomTab> {
  ChatRoomController? _controller;
  StreamSubscription<void>? _participantsSub;
  Timer? _rosterPoll;

  @override
  void initState() {
    super.initState();
    _watch();
  }

  @override
  void didUpdateWidget(ChatRoomTab oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.store == widget.store &&
        oldWidget.rosterPollInterval == widget.rosterPollInterval) {
      return;
    }
    if (oldWidget.store != widget.store) {
      unawaited(_controller?.dispose() ?? Future<void>.value());
      _controller = null;
    }
    _watch();
  }

  /// Follows the server roster, and the thread list that says which of its
  /// actors are live; the roster can land before the threads do.
  void _watch() {
    _participantsSub?.cancel();
    _rosterPoll?.cancel();
    _participantsSub = Rx.combineLatest2(
      widget.store.chatRoomParticipants,
      widget.store.actorStates,
      (_, _) {},
    ).listen((_) => _syncParticipants(widget.store.chatRoomParticipants.value));
    unawaited(widget.store.refreshChatRoom());
    _rosterPoll = Timer.periodic(
      widget.rosterPollInterval,
      (_) => unawaited(widget.store.refreshChatRoom()),
    );
  }

  void _syncParticipants(List<String> participantIds) {
    final valid = participantIds.where((id) {
      final actor = widget.store.actor(id);
      return actor != null && !actor.thread.isRetired;
    }).toList();
    final deps = widget.store.walkie;
    if (deps == null) return;
    final current = _controller;
    if (current == null) {
      if (valid.isEmpty) return;
      final controller = ChatRoomController(
        initialParticipants: valid,
        deps: deps,
      );
      _controller = controller;
      unawaited(controller.init());
      if (mounted) setState(() {});
      return;
    }
    unawaited(current.replaceParticipants(valid));
  }

  @override
  void dispose() {
    _participantsSub?.cancel();
    _rosterPoll?.cancel();
    unawaited(_controller?.dispose() ?? Future<void>.value());
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final controller = _controller;
    if (widget.store.walkie == null) {
      return const _RoomUnavailable(
        'Voice is unavailable in this dashboard build.',
      );
    }
    if (controller == null) {
      return const _RoomUnavailable('Waiting for the room participant list…');
    }

    return StreamBuilder<List<Object?>>(
      stream: Rx.combineLatestList<Object?>([
        widget.store.actorStates,
        controller.available,
        controller.record,
        controller.participants,
        controller.recipient,
        controller.recordingRecipient,
        controller.nowPlaying,
        controller.lastError,
      ]),
      builder: (context, _) {
        final actorSnapshot = widget.store.actorStates.value;
        final participantIds = controller.participants.value;
        final actors = participantIds
            .map((id) => actorSnapshot.actors[id]?.thread)
            .whereType<ThreadDto>()
            .toList();
        final available = controller.available.valueOrNull;
        final record = controller.record.valueOrNull ?? const RecordStatus();
        final nowPlaying = controller.nowPlaying.valueOrNull;
        final selectedRecipient = controller.recipient.valueOrNull;
        final recordingRecipient = controller.recordingRecipient.valueOrNull;
        final handleFor = <String, String>{
          for (final actor in actors) actor.id: actor.handle,
        };
        final status = _roomStatus(
          record: record,
          selectedRecipient: selectedRecipient,
          recordingRecipient: recordingRecipient,
          handles: handleFor,
          available: available,
        );
        // cancelRecord() only discards a capture that is opening or live; a
        // memo already sending cannot be pulled back.
        final canCancel =
            record.phase == RecordPhase.starting ||
            record.phase == RecordPhase.recording;

        return Container(
          key: const ValueKey('chat-room'),
          color: MeshColors.bgPrimary,
          padding: const EdgeInsets.all(16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Expanded(
                child: _AvatarGrid(
                  actors: actors,
                  store: widget.store,
                  recordingRecipient: recordingRecipient,
                  speakingActorId: nowPlaying?.actorId,
                  // A tap was accepted and the room is waiting on the mic or
                  // the memo; the tapped tile spins until the phase moves on.
                  busyActorId:
                      record.phase == RecordPhase.starting ||
                          record.phase == RecordPhase.sending
                      ? recordingRecipient
                      : null,
                  disabled:
                      available == false ||
                      record.phase == RecordPhase.starting ||
                      record.phase == RecordPhase.sending,
                  onTap: (actorId) =>
                      unawaited(controller.tapParticipant(actorId)),
                ),
              ),
              const SizedBox(height: 12),
              _RoomControls(
                status: status,
                error: controller.lastError.valueOrNull,
                onCancel: canCancel
                    ? () => unawaited(controller.cancelRecord())
                    : null,
              ),
            ],
          ),
        );
      },
    );
  }
}

String _roomStatus({
  required RecordStatus record,
  required String? selectedRecipient,
  required String? recordingRecipient,
  required Map<String, String> handles,
  required bool? available,
}) {
  if (available == false) return 'Voice is not configured on this instance.';
  final selected = selectedRecipient == null
      ? 'an actor'
      : (handles[selectedRecipient] ?? selectedRecipient);
  final recording = recordingRecipient == null
      ? selected
      : (handles[recordingRecipient] ?? recordingRecipient);
  return switch (record.phase) {
    RecordPhase.starting => 'Opening the mic for $recording…',
    RecordPhase.recording =>
      'Recording for $recording — tap the avatar again to send.',
    RecordPhase.sending => 'Sending the memo to $recording…',
    RecordPhase.delivered =>
      record.delivered
          ? 'Delivered to $selected.'
          : 'Queued for $selected while they are asleep.',
    RecordPhase.error => record.message ?? 'Voice action failed.',
    RecordPhase.idle => '',
  };
}

/// Height of the bottom status/cancel strip. It is reserved in every phase,
/// idle included, so starting, sending, or cancelling a recording never moves
/// or resizes the actor tiles (#803).
const double _controlsHeight = 64;

class _RoomControls extends StatelessWidget {
  const _RoomControls({required this.status, this.error, this.onCancel});
  final String status;
  final String? error;
  final VoidCallback? onCancel;

  @override
  Widget build(BuildContext context) {
    final onCancel = this.onCancel;
    return SizedBox(
      key: const ValueKey('chat-room-controls'),
      height: _controlsHeight,
      child: Row(
        children: [
          Expanded(
            child: Text(
              error ?? status,
              key: const ValueKey('chat-room-status'),
              maxLines: 3,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(
                color: error == null
                    ? MeshColors.textSecondary
                    : MeshColors.statusHalted,
                fontSize: 13,
              ),
            ),
          ),
          if (onCancel != null) ...[
            const SizedBox(width: 12),
            FilledButton.tonalIcon(
              key: const ValueKey('chat-room-cancel'),
              onPressed: onCancel,
              icon: const Icon(Icons.close),
              label: const Text('Cancel recording'),
              style: FilledButton.styleFrom(
                foregroundColor: MeshColors.statusHalted,
              ),
            ),
          ],
        ],
      ),
    );
  }
}

class _AvatarGrid extends StatelessWidget {
  const _AvatarGrid({
    required this.actors,
    required this.store,
    required this.recordingRecipient,
    required this.speakingActorId,
    required this.busyActorId,
    required this.disabled,
    required this.onTap,
  });

  final List<ThreadDto> actors;
  final DashboardStore store;
  final String? recordingRecipient;
  final String? speakingActorId;
  final String? busyActorId;
  final bool disabled;
  final ValueChanged<String> onTap;

  @override
  Widget build(BuildContext context) {
    if (actors.isEmpty) {
      return const Center(
        child: Text(
          'Root will appear here when the actor list loads.',
          style: TextStyle(color: MeshColors.textMuted),
        ),
      );
    }
    final count = actors.length;
    return LayoutBuilder(
      builder: (context, constraints) {
        final columns = chatRoomColumns(count, constraints.biggest);
        final rows = (count / columns).ceil();
        const gap = 12.0;
        final tileWidth =
            (constraints.maxWidth - gap * (columns - 1)) / columns;
        final tileHeight = (constraints.maxHeight - gap * (rows - 1)) / rows;
        return GridView.builder(
          key: const ValueKey('chat-room-grid'),
          physics: const NeverScrollableScrollPhysics(),
          gridDelegate: SliverGridDelegateWithFixedCrossAxisCount(
            crossAxisCount: columns,
            crossAxisSpacing: gap,
            mainAxisSpacing: gap,
            // Fit the whole V1 room on screen rather than hiding a tile below
            // a scroll boundary; see [chatRoomColumns].
            childAspectRatio: tileWidth / tileHeight,
          ),
          itemCount: count,
          itemBuilder: (context, index) {
            final actor = actors[index];
            return _RoomAvatarButton(
              actor: actor,
              state: store.dotFor(actor),
              store: store,
              recording: actor.id == recordingRecipient,
              speaking: actor.id == speakingActorId,
              busy: actor.id == busyActorId,
              disabled: disabled,
              onTap: () => onTap(actor.id),
            );
          },
        );
      },
    );
  }
}

class _RoomAvatarButton extends StatelessWidget {
  const _RoomAvatarButton({
    required this.actor,
    required this.state,
    required this.store,
    required this.recording,
    required this.speaking,
    required this.busy,
    required this.disabled,
    required this.onTap,
  });

  final ThreadDto actor;
  final DotState state;
  final DashboardStore store;
  final bool recording;
  final bool speaking;
  final bool busy;
  final bool disabled;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final ring = chatRoomBorderColor(state: state, speaking: speaking);
    final action = recording ? 'Tap to send' : 'Tap to record';
    return Semantics(
      button: true,
      label: '${actor.handle}, ${_voiceLabel(actor)}, $action',
      child: Material(
        color: Colors.transparent,
        child: InkWell(
          key: ValueKey('chat-room-avatar-${actor.id}'),
          onTap: disabled ? null : onTap,
          borderRadius: BorderRadius.circular(18),
          child: AnimatedContainer(
            duration: const Duration(milliseconds: 180),
            decoration: BoxDecoration(
              color: MeshColors.bgSecondary,
              borderRadius: BorderRadius.circular(18),
              border: Border.all(
                color: ring,
                width: speaking
                    ? 3
                    : ring == MeshColors.border
                    ? 1.5
                    : 2.5,
              ),
              boxShadow: speaking
                  ? [
                      BoxShadow(
                        color: ring.withValues(alpha: 0.55),
                        blurRadius: 16,
                      ),
                    ]
                  : const [],
            ),
            padding: const EdgeInsets.all(12),
            child: Stack(
              fit: StackFit.expand,
              children: [
                Column(
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: [
                    Expanded(
                      child: AspectRatio(
                        aspectRatio: 1,
                        child: Center(
                          child: LayoutBuilder(
                            builder: (context, constraints) {
                              final size = math.min(
                                constraints.maxWidth,
                                constraints.maxHeight,
                              );
                              // The spinner rings the avatar in the avatar's
                              // own box, so it never moves or resizes the
                              // tile, and leaves the state border alone (#816).
                              return AbsorbPointer(
                                child: Stack(
                                  alignment: Alignment.center,
                                  children: [
                                    ActorAvatar(
                                      id: actor.id,
                                      size: size,
                                      store: store,
                                    ),
                                    if (busy)
                                      SizedBox.square(
                                        dimension: size,
                                        child: CircularProgressIndicator(
                                          key: ValueKey(
                                            'chat-room-busy-${actor.id}',
                                          ),
                                          strokeWidth: 5,
                                          color: MeshColors.textPrimary,
                                        ),
                                      ),
                                  ],
                                ),
                              );
                            },
                          ),
                        ),
                      ),
                    ),
                    const SizedBox(height: 8),
                    Text(
                      actor.handle,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(
                        color: MeshColors.textPrimary,
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                    const SizedBox(height: 2),
                    // The tile shows only the avatar and name (#825 operator
                    // feedback). The line below stays reserved, empty unless
                    // the actor is speaking, so the avatar never shrinks.
                    Text(
                      speaking ? 'Speaking' : '',
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(
                        color: MeshColors.accent,
                        fontSize: 12,
                      ),
                    ),
                  ],
                ),
                // The border belongs to the actor's run state, so the capture
                // this tile is recording is marked by a badge instead.
                if (recording)
                  const Positioned(top: 0, right: 0, child: _RecordingBadge()),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _RecordingBadge extends StatelessWidget {
  const _RecordingBadge();

  @override
  Widget build(BuildContext context) => Container(
    key: const ValueKey('chat-room-recording-badge'),
    padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
    decoration: BoxDecoration(
      color: MeshColors.statusHalted,
      borderRadius: BorderRadius.circular(999),
    ),
    child: const Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Icon(Icons.mic, size: 14, color: MeshColors.textPrimary),
        SizedBox(width: 4),
        Text(
          'REC',
          style: TextStyle(
            color: MeshColors.textPrimary,
            fontSize: 11,
            fontWeight: FontWeight.w800,
            letterSpacing: 0.8,
          ),
        ),
      ],
    ),
  );
}

/// Columns for [count] room tiles in an area of [size]: one actor fills the
/// room; two sit side by side when the room is wider than tall and stack when
/// it is taller (#803); three or more use the smallest square grid, so three
/// show as a 2x2 with the last cell intentionally empty.
@visibleForTesting
int chatRoomColumns(int count, Size size) {
  if (count <= 1) return 1;
  if (count == 2) return size.height > size.width ? 1 : 2;
  return math.sqrt(count).ceil();
}

/// A tile's border: the actor's run state in the dashboard's colours (green
/// while active, amber while queued), except that a speaking actor keeps the
/// speaking border (#803). Choosing a recipient does not change it.
@visibleForTesting
Color chatRoomBorderColor({required DotState state, required bool speaking}) {
  if (speaking) return MeshColors.accent;
  return switch (state) {
    DotState.active => MeshColors.statusActive,
    DotState.queued => MeshColors.statusQueued,
    DotState.idle || DotState.retired => MeshColors.border,
  };
}

String _voiceLabel(ThreadDto actor) {
  final voice = actor.voiceConfig;
  if (voice == null) return 'Instance voice';
  final config = voice.config;
  final name = config['voiceName'] ?? config['voiceId'];
  return name is String && name.isNotEmpty ? 'Voice: $name' : 'Actor voice';
}

class _RoomUnavailable extends StatelessWidget {
  const _RoomUnavailable(this.message);
  final String message;

  @override
  Widget build(BuildContext context) => Center(
    child: Text(message, style: const TextStyle(color: MeshColors.textMuted)),
  );
}
