import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:rxdart/rxdart.dart';

import '../models.dart';
import '../store.dart';
import '../theme.dart';
import '../util.dart';
import '../walkie_controller.dart';
import 'avatar.dart';
import 'status_dot.dart';
import 'walkie_panel.dart';

/// Interactive Chat tab: shows the chat interface between the human operator
/// and a single selected actor.
class ChatTab extends StatefulWidget {
  const ChatTab({super.key, required this.store});

  final DashboardStore store;

  @override
  State<ChatTab> createState() => _ChatTabState();
}

class _ChatTabState extends State<ChatTab> {
  WalkieController? _controller;
  StreamSubscription<bool>? _enabledSub;
  StreamSubscription<(Set<String>, ActorStateSnapshot)>? _selectionSub;
  String? _actorId;

  @visibleForTesting
  WalkieController? get debugController => _controller;

  @override
  void initState() {
    super.initState();
    _listenToSelection();
  }

  @override
  void didUpdateWidget(ChatTab oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.store != widget.store) {
      _selectionSub?.cancel();
      _listenToSelection();
    }
  }

  void _listenToSelection() {
    _selectionSub =
        Rx.combineLatest2<
              Set<String>,
              ActorStateSnapshot,
              (Set<String>, ActorStateSnapshot)
            >(
              widget.store.selection,
              widget.store.actorStates,
              (s, t) => (s, t),
            )
            .listen((data) {
              final selection = data.$1;
              final actorStates = data.$2;
              if (selection.length == 1) {
                final selectedId = selection.first;
                final actor = actorStates.actors[selectedId]?.thread;
                if (actor != null) {
                  _updateController(selectedId, actor.chatDisabled);
                  return;
                }
              }
              _updateController(null, false);
            });
  }

  void _updateController(String? newActorId, bool chatDisabled) {
    if (_actorId == newActorId) return;

    _cleanupController();

    _actorId = newActorId;
    if (newActorId == null) return;

    final deps = widget.store.walkie;
    if (deps != null && !chatDisabled) {
      final controller = WalkieController(actorId: newActorId, deps: deps);
      _controller = controller;
      _enabledSub = controller.enabled.listen((val) {
        widget.store.setWalkieActive(val);
      });
    }
  }

  void _cleanupController() {
    _enabledSub?.cancel();
    _enabledSub = null;
    if (_controller != null) {
      _controller!.dispose();
      _controller = null;
    }
    widget.store.setWalkieActive(false);
  }

  @override
  void dispose() {
    _selectionSub?.cancel();
    _cleanupController();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return StreamBuilder<List<Object?>>(
      stream: Rx.combineLatestList<Object?>([
        widget.store.operatorChat,
        widget.store.selection,
        widget.store.actorStates,
        widget.store.actorStates,
        widget.store.walkieActive,
      ]),
      builder: (_, snap) {
        final view = widget.store.operatorChat.value;
        final selection = widget.store.selection.value;
        final actorStates = widget.store.actorStates.value.actors.values;

        if (selection.length != 1) {
          return const Center(
            child: Text(
              'Select an actor to start chatting.',
              style: TextStyle(color: MeshColors.textMuted),
            ),
          );
        }

        final selectedId = selection.first;
        final actor = widget.store.actorStates.value.actors[selectedId]?.thread;
        if (actor == null) {
          return const Center(
            child: Text(
              'Actor not found.',
              style: TextStyle(color: MeshColors.textMuted),
            ),
          );
        }

        final handles = {
          for (final a in actorStates) a.thread.id: a.thread.handle,
        };

        final height = MediaQuery.of(context).size.height;
        final walkieActive = widget.store.walkieActive.valueOrNull ?? false;
        final isFullScreenWalkie = walkieActive && height < 500;

        if (isFullScreenWalkie) {
          return Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Expanded(
                child: _WalkieSection(
                  key: ValueKey('walkie-section-$selectedId'),
                  store: widget.store,
                  actorId: selectedId,
                  chatDisabled: actor.chatDisabled,
                  controller: _controller,
                  isFullScreen: true,
                ),
              ),
            ],
          );
        }

        return Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Expanded(
              child: view.chat.isEmpty && !view.loading
                  ? const Center(
                      child: Text(
                        'No messages in this chat.',
                        style: TextStyle(color: MeshColors.textMuted),
                      ),
                    )
                  : ListView.builder(
                      reverse: true,
                      padding: const EdgeInsets.symmetric(
                        horizontal: 16,
                        vertical: 12,
                      ),
                      itemCount: view.chat.length + (view.hasMore ? 1 : 0),
                      itemBuilder: (context, i) {
                        if (i == view.chat.length) {
                          if (!view.loading) {
                            WidgetsBinding.instance.addPostFrameCallback((_) {
                              widget.store.loadMoreOperatorChatEvents();
                            });
                          }
                          return const Padding(
                            padding: EdgeInsets.symmetric(vertical: 24),
                            child: Center(
                              child: SizedBox(
                                width: 20,
                                height: 20,
                                child: CircularProgressIndicator(
                                  strokeWidth: 2,
                                  color: MeshColors.accent,
                                ),
                              ),
                            ),
                          );
                        }

                        final m = view.chat[i];
                        final senderId = m.senderId;
                        final isPrimarySender = senderId == 'human:operator';
                        final senderHandle = isPrimarySender
                            ? 'Operator'
                            : (handles[senderId] ?? senderId);

                        return _MessageBubble(
                          message: m,
                          senderId: senderId,
                          senderHandle: senderHandle,
                          isPrimarySender: isPrimarySender,
                          store: widget.store,
                        );
                      },
                    ),
            ),
            if (widget.store.actor(selectedId)?.isActiveRun ?? false)
              _BusyHint(handle: actor.handle),
            // Keyed by actor: switching chats disposes the section, which
            // tears the walkie mode down (presence SSE, wake lock, recorder).
            _WalkieSection(
              key: ValueKey('walkie-section-$selectedId'),
              store: widget.store,
              actorId: selectedId,
              chatDisabled: actor.chatDisabled,
              controller: _controller,
            ),
          ],
        );
      },
    );
  }
}

class _BusyHint extends StatelessWidget {
  const _BusyHint({required this.handle});
  final String handle;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
      decoration: const BoxDecoration(
        color: MeshColors.bgSecondary,
        border: Border(top: BorderSide(color: MeshColors.border)),
      ),
      child: Row(
        children: [
          const SizedBox(
            width: 10,
            height: 10,
            child: StatusDot(state: DotState.active, size: 8),
          ),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              '$handle is working...',
              style: const TextStyle(
                color: MeshColors.textSecondary,
                fontSize: 12,
                fontStyle: FontStyle.italic,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// The chat's voice seam : renders the plain input area, adding a
/// walkie-talkie toggle when the store carries walkie deps; while the mode is
/// ON the input is replaced by the [WalkiePanel] (record button + auto-playing
/// reply queue). Owns the per-actor [WalkieController]; disposing this widget
/// (leaving the chat, switching actor) turns the mode off.
class _WalkieSection extends StatelessWidget {
  const _WalkieSection({
    super.key,
    required this.store,
    required this.actorId,
    required this.chatDisabled,
    required this.controller,
    this.isFullScreen = false,
  });

  final DashboardStore store;
  final String actorId;
  final bool chatDisabled;
  final WalkieController? controller;
  final bool isFullScreen;

  @override
  Widget build(BuildContext context) {
    final controller = this.controller;
    if (controller == null) {
      return _ChatInputArea(
        store: store,
        actorId: actorId,
        chatDisabled: chatDisabled,
      );
    }
    return StreamBuilder<bool>(
      stream: controller.enabled,
      builder: (_, _) {
        if (controller.enabled.valueOrNull ?? false) {
          return WalkiePanel(
            controller: controller,
            expanded: isFullScreen,
            store: store,
          );
        }
        return _ChatInputArea(
          store: store,
          actorId: actorId,
          chatDisabled: chatDisabled,
          walkieToggle: WalkieToggleButton(controller: controller),
        );
      },
    );
  }
}

class _ChatInputArea extends StatefulWidget {
  const _ChatInputArea({
    required this.store,
    required this.actorId,
    required this.chatDisabled,
    this.walkieToggle,
  });

  final DashboardStore store;
  final String actorId;
  final bool chatDisabled;

  /// The walkie-mode entry button, when the feature is wired .
  final Widget? walkieToggle;

  @override
  State<_ChatInputArea> createState() => _ChatInputAreaState();
}

class _ChatInputAreaState extends State<_ChatInputArea> {
  final _controller = TextEditingController();
  late final FocusNode _focusNode;
  bool _sending = false;

  @override
  void initState() {
    super.initState();
    _focusNode = FocusNode(
      onKeyEvent: (node, event) {
        if (event is KeyDownEvent &&
            event.logicalKey == LogicalKeyboardKey.enter) {
          if (HardwareKeyboard.instance.isShiftPressed) {
            // Shift + Enter: allow newline insertion
            return KeyEventResult.ignored;
          }
          if (!HardwareKeyboard.instance.isControlPressed &&
              !HardwareKeyboard.instance.isMetaPressed &&
              !HardwareKeyboard.instance.isAltPressed) {
            // Plain Enter: send message
            _send();
            return KeyEventResult.handled;
          }
        }
        return KeyEventResult.ignored;
      },
    );
  }

  @override
  void dispose() {
    _controller.dispose();
    _focusNode.dispose();
    super.dispose();
  }

  Future<void> _send() async {
    final text = _controller.text.trim();
    if (text.isEmpty || _sending) return;

    setState(() {
      _sending = true;
    });

    try {
      await widget.store.sendOperatorChatMessage(text);
      _controller.clear();
      _focusNode.requestFocus();
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text('Failed to send message: $e'),
            backgroundColor: MeshColors.statusHalted,
          ),
        );
      }
    } finally {
      if (mounted) {
        setState(() {
          _sending = false;
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    if (widget.chatDisabled) {
      return Container(
        color: MeshColors.bgSecondary,
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
        alignment: Alignment.center,
        child: const Text(
          'Actor is retired — chat disabled',
          style: TextStyle(
            color: MeshColors.textMuted,
            fontSize: 13,
            fontStyle: FontStyle.italic,
          ),
        ),
      );
    }

    return Container(
      decoration: const BoxDecoration(
        color: MeshColors.bgSecondary,
        border: Border(top: BorderSide(color: MeshColors.border)),
      ),
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.end,
        children: [
          if (widget.walkieToggle != null) ...[
            Padding(
              padding: const EdgeInsets.only(bottom: 4),
              child: widget.walkieToggle!,
            ),
            const SizedBox(width: 8),
          ],
          Expanded(
            child: TextField(
              controller: _controller,
              focusNode: _focusNode,
              enabled: !_sending,
              minLines: 1,
              maxLines: 5,
              keyboardType: TextInputType.multiline,
              textInputAction: TextInputAction.newline,
              style: const TextStyle(
                color: MeshColors.textPrimary,
                fontSize: 13,
              ),
              decoration: InputDecoration(
                hintText: 'Type a message to chat...',
                hintStyle: const TextStyle(color: MeshColors.textMuted),
                filled: true,
                fillColor: MeshColors.bgTertiary,
                contentPadding: const EdgeInsets.symmetric(
                  horizontal: 14,
                  vertical: 10,
                ),
                border: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(8),
                  borderSide: const BorderSide(color: MeshColors.border),
                ),
                focusedBorder: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(8),
                  borderSide: const BorderSide(color: MeshColors.accent),
                ),
                enabledBorder: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(8),
                  borderSide: const BorderSide(color: MeshColors.border),
                ),
              ),
            ),
          ),
          const SizedBox(width: 12),
          Padding(
            padding: const EdgeInsets.only(bottom: 4),
            child: IconButton(
              icon: _sending
                  ? const SizedBox(
                      width: 18,
                      height: 18,
                      child: CircularProgressIndicator(
                        strokeWidth: 2,
                        color: MeshColors.accent,
                      ),
                    )
                  : const Icon(Icons.send, color: MeshColors.accent),
              onPressed: _sending ? null : _send,
            ),
          ),
        ],
      ),
    );
  }
}

class _MessageBubble extends StatelessWidget {
  const _MessageBubble({
    required this.message,
    required this.senderId,
    required this.senderHandle,
    required this.isPrimarySender,
    this.store,
  });

  final MeshChat message;
  final String senderId;
  final String senderHandle;
  final bool isPrimarySender;
  final DashboardStore? store;

  @override
  Widget build(BuildContext context) {
    final alignment = isPrimarySender
        ? CrossAxisAlignment.end
        : CrossAxisAlignment.start;
    final bubbleBgColor = isPrimarySender
        ? MeshColors.bgSelected
        : MeshColors.bgTertiary;
    final bubbleBorderColor = isPrimarySender
        ? MeshColors.accent.withValues(alpha: 0.3)
        : MeshColors.border;
    final messageText = message.body;

    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 6.0),
      child: Column(
        crossAxisAlignment: alignment,
        children: [
          // Header with avatar, handle, and timestamp
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 4.0, vertical: 2.0),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                if (!isPrimarySender) ...[
                  ActorAvatar(id: senderId, size: 16, store: store),
                  const SizedBox(width: 6),
                ],
                Text(
                  senderHandle,
                  style: kMonoStyle.copyWith(
                    fontSize: 11,
                    fontWeight: FontWeight.w600,
                    color: isPrimarySender
                        ? MeshColors.accent
                        : MeshColors.textSecondary,
                  ),
                ),
                const SizedBox(width: 8),
                Text(
                  formatTs(message.ts.toIso8601String()),
                  style: kMonoStyle.copyWith(
                    fontSize: 10,
                    color: MeshColors.textMuted,
                  ),
                ),
                if (isPrimarySender) ...[
                  const SizedBox(width: 6),
                  ActorAvatar(id: senderId, size: 16, store: store),
                ],
              ],
            ),
          ),
          const SizedBox(height: 2),
          // Bubble container
          Container(
            constraints: BoxConstraints(
              maxWidth: MediaQuery.of(context).size.width * 0.75,
            ),
            decoration: BoxDecoration(
              color: bubbleBgColor,
              borderRadius: BorderRadius.circular(12).copyWith(
                topRight: isPrimarySender
                    ? const Radius.circular(0)
                    : const Radius.circular(12),
                topLeft: !isPrimarySender
                    ? const Radius.circular(0)
                    : const Radius.circular(12),
              ),
              border: Border.all(color: bubbleBorderColor),
            ),
            padding: const EdgeInsets.symmetric(
              horizontal: 12.0,
              vertical: 8.0,
            ),
            child: SelectableText(
              messageText,
              style: const TextStyle(
                color: MeshColors.textPrimary,
                fontSize: 13,
                height: 1.4,
              ),
            ),
          ),
        ],
      ),
    );
  }
}
