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
class ChatRoomTab extends StatefulWidget {
  const ChatRoomTab({super.key, required this.store});

  final DashboardStore store;

  @override
  State<ChatRoomTab> createState() => _ChatRoomTabState();
}

class _ChatRoomTabState extends State<ChatRoomTab> {
  ChatRoomController? _controller;
  StreamSubscription<Set<String>>? _participantsSub;

  @override
  void initState() {
    super.initState();
    _participantsSub = widget.store.chatRoomParticipants.listen(
      _syncParticipants,
    );
    _syncParticipants(widget.store.chatRoomParticipants.value);
  }

  @override
  void didUpdateWidget(ChatRoomTab oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.store == widget.store) return;
    _participantsSub?.cancel();
    unawaited(_controller?.dispose() ?? Future<void>.value());
    _controller = null;
    _participantsSub = widget.store.chatRoomParticipants.listen(
      _syncParticipants,
    );
    _syncParticipants(widget.store.chatRoomParticipants.value);
  }

  void _syncParticipants(Set<String> participantIds) {
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
        controller.connection,
        controller.record,
        controller.participants,
        controller.recipient,
        controller.recordingRecipient,
        controller.queueDepth,
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
        final queueDepth = controller.queueDepth.valueOrNull ?? 0;
        final nowPlaying = controller.nowPlaying.valueOrNull;
        final selectedRecipient = controller.recipient.valueOrNull;
        final recordingRecipient = controller.recordingRecipient.valueOrNull;
        final isRecording = controller.isRecording;
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

        return Container(
          key: const ValueKey('chat-room'),
          color: MeshColors.bgPrimary,
          padding: const EdgeInsets.all(16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              _RoomHeader(
                controller: controller,
                store: widget.store,
                queueDepth: queueDepth,
                nowPlaying: nowPlaying,
                participantIds: participantIds,
              ),
              const SizedBox(height: 12),
              _StatusBanner(
                status: status,
                error: controller.lastError.valueOrNull,
              ),
              const SizedBox(height: 12),
              Expanded(
                child: _AvatarGrid(
                  actors: actors,
                  store: widget.store,
                  selectedRecipient: selectedRecipient,
                  recordingRecipient: recordingRecipient,
                  speakingActorId: nowPlaying?.actorId,
                  disabled:
                      available == false ||
                      record.phase == RecordPhase.starting ||
                      record.phase == RecordPhase.sending,
                  onTap: (actorId) =>
                      unawaited(controller.tapParticipant(actorId)),
                ),
              ),
              if (isRecording) ...[
                const SizedBox(height: 12),
                FilledButton.tonalIcon(
                  key: const ValueKey('chat-room-cancel'),
                  onPressed: () => unawaited(controller.cancelRecord()),
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
      'Recording for $recording — tap that avatar to send. X discards this clip.',
    RecordPhase.sending => 'Sending the memo to $recording…',
    RecordPhase.delivered =>
      record.delivered
          ? 'Delivered to $selected.'
          : 'Queued for $selected while they are asleep.',
    RecordPhase.error => record.message ?? 'Voice action failed.',
    RecordPhase.idle =>
      'Tap an actor avatar to record a message for $selected.',
  };
}

class _RoomHeader extends StatelessWidget {
  const _RoomHeader({
    required this.controller,
    required this.store,
    required this.queueDepth,
    required this.nowPlaying,
    required this.participantIds,
  });

  final ChatRoomController controller;
  final DashboardStore store;
  final int queueDepth;
  final VoiceAnnouncement? nowPlaying;
  final List<String> participantIds;

  @override
  Widget build(BuildContext context) {
    final state = controller.connection.valueOrNull ?? WalkieConnection.off;
    final label = switch (state) {
      WalkieConnection.connected => 'Connected',
      WalkieConnection.connecting => 'Connecting…',
      WalkieConnection.reconnecting => 'Reconnecting…',
      WalkieConnection.off => 'Ready',
    };
    return Row(
      children: [
        const Icon(Icons.forum_outlined, color: MeshColors.accent),
        const SizedBox(width: 8),
        const Expanded(
          child: Text(
            'CHAT ROOM',
            style: TextStyle(
              color: MeshColors.textPrimary,
              fontWeight: FontWeight.w800,
              letterSpacing: 1.2,
            ),
          ),
        ),
        if (nowPlaying != null)
          const Padding(
            padding: EdgeInsets.only(right: 8),
            child: Icon(Icons.volume_up, color: MeshColors.accent, size: 18),
          ),
        if (queueDepth > 0)
          Text(
            '$queueDepth queued',
            style: const TextStyle(
              color: MeshColors.textSecondary,
              fontSize: 12,
            ),
          ),
        const SizedBox(width: 8),
        Text(
          label,
          style: const TextStyle(color: MeshColors.textMuted, fontSize: 12),
        ),
        IconButton(
          key: const ValueKey('chat-room-add'),
          tooltip: 'Add actor to Chat Room',
          onPressed: () => _chooseParticipant(context),
          icon: const Icon(Icons.person_add_alt_1, color: MeshColors.accent),
        ),
      ],
    );
  }

  Future<void> _chooseParticipant(BuildContext context) async {
    final actors =
        store.actorStates.value.actors.values
            .map((state) => state.thread)
            .where(
              (actor) => !actor.isRetired && !participantIds.contains(actor.id),
            )
            .toList()
          ..sort((a, b) => a.handle.compareTo(b.handle));
    await showModalBottomSheet<void>(
      context: context,
      backgroundColor: MeshColors.bgSecondary,
      builder: (context) => SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(16, 12, 16, 24),
          child: actors.isEmpty
              ? const Text(
                  'All live actors are already in the room.',
                  style: TextStyle(color: MeshColors.textMuted),
                )
              : ListView(
                  shrinkWrap: true,
                  children: [
                    const Text(
                      'Add actor to Chat Room',
                      style: TextStyle(
                        color: MeshColors.textPrimary,
                        fontSize: 16,
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                    const SizedBox(height: 8),
                    for (final actor in actors)
                      ListTile(
                        leading: AbsorbPointer(
                          child: ActorAvatar(
                            id: actor.id,
                            size: 34,
                            store: store,
                          ),
                        ),
                        title: Text(
                          actor.handle,
                          style: const TextStyle(color: MeshColors.textPrimary),
                        ),
                        subtitle: Text(
                          _voiceLabel(actor),
                          style: const TextStyle(color: MeshColors.textMuted),
                        ),
                        onTap: () {
                          store.addChatRoomParticipant(actor.id);
                          Navigator.of(context).pop();
                        },
                      ),
                  ],
                ),
        ),
      ),
    );
  }
}

class _StatusBanner extends StatelessWidget {
  const _StatusBanner({required this.status, this.error});
  final String status;
  final String? error;

  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
    decoration: BoxDecoration(
      color: MeshColors.bgSecondary,
      borderRadius: BorderRadius.circular(10),
      border: Border.all(
        color: error == null ? MeshColors.border : MeshColors.statusHalted,
      ),
    ),
    child: Text(
      error ?? status,
      key: const ValueKey('chat-room-status'),
      textAlign: TextAlign.center,
      style: TextStyle(
        color: error == null
            ? MeshColors.textSecondary
            : MeshColors.statusHalted,
        fontSize: 13,
      ),
    ),
  );
}

class _AvatarGrid extends StatelessWidget {
  const _AvatarGrid({
    required this.actors,
    required this.store,
    required this.selectedRecipient,
    required this.recordingRecipient,
    required this.speakingActorId,
    required this.disabled,
    required this.onTap,
  });

  final List<ThreadDto> actors;
  final DashboardStore store;
  final String? selectedRecipient;
  final String? recordingRecipient;
  final String? speakingActorId;
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
    final columns = count == 1 ? 1 : math.sqrt(count).ceil();
    return LayoutBuilder(
      builder: (context, constraints) {
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
            // Fit the whole V1 room on screen: one actor occupies the room;
            // three actors use the visible 2x2 with the last cell intentionally
            // empty, rather than hiding the third below a scroll boundary.
            childAspectRatio: tileWidth / tileHeight,
          ),
          itemCount: count,
          itemBuilder: (context, index) {
            final actor = actors[index];
            return _RoomAvatarButton(
              actor: actor,
              store: store,
              selected: actor.id == selectedRecipient,
              recording: actor.id == recordingRecipient,
              speaking: actor.id == speakingActorId,
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
    required this.store,
    required this.selected,
    required this.recording,
    required this.speaking,
    required this.disabled,
    required this.onTap,
  });

  final ThreadDto actor;
  final DashboardStore store;
  final bool selected;
  final bool recording;
  final bool speaking;
  final bool disabled;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final ring = recording
        ? MeshColors.statusHalted
        : speaking
        ? MeshColors.accent
        : selected
        ? MeshColors.statusActive
        : MeshColors.border;
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
                width: speaking || recording ? 3 : 1.5,
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
            child: Column(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                Expanded(
                  child: AspectRatio(
                    aspectRatio: 1,
                    child: Center(
                      child: AbsorbPointer(
                        child: ActorAvatar(
                          id: actor.id,
                          size: 88,
                          store: store,
                        ),
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
                Text(
                  speaking
                      ? 'Speaking'
                      : recording
                      ? 'Tap to send'
                      : _voiceLabel(actor),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(color: ring, fontSize: 12),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
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
