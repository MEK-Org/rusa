import 'package:flutter/material.dart';
import 'package:rxdart/rxdart.dart';

import '../models.dart';
import '../store.dart';
import '../theme.dart';
import '../util.dart';
import 'avatar.dart';

/// Conversation tab: shows the messages passed back and forth between TWO selected actors.
/// Lists messages chronologically (newest at bottom, oldest at top), and lazy-loads
/// older messages when the user scrolls to the top (which triggers the end of the reverse list).
class ConversationTab extends StatelessWidget {
  const ConversationTab({super.key, required this.store});

  final DashboardStore store;

  @override
  Widget build(BuildContext context) {
    return StreamBuilder<List<Object?>>(
      stream: Rx.combineLatestList<Object?>([
        store.conversation,
        store.selection,
        store.actorStates,
        store.primary,
      ]),
      builder: (_, snap) {
        final view = store.conversation.value;
        final selection = store.selection.value;
        final actorStates = store.actorStates.value;
        final primary = store.primary.value;

        if (selection.length != 2) {
          return const Center(
            child: Text(
              'Select exactly two actors to see their conversation.',
              style: TextStyle(color: MeshColors.textMuted),
            ),
          );
        }

        final handles = {
          for (final a in actorStates.actors.values)
            a.thread.id: a.thread.handle,
        };

        if (view.chat.isEmpty && !view.loading) {
          return const Center(
            child: Text(
              'No messages exchanged between these two actors.',
              style: TextStyle(color: MeshColors.textMuted),
            ),
          );
        }

        final messages = view.chat;

        return ListView.builder(
          reverse: true,
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
          itemCount: messages.length + (view.hasMore ? 1 : 0),
          itemBuilder: (context, i) {
            if (i == messages.length) {
              if (!view.loading) {
                WidgetsBinding.instance.addPostFrameCallback((_) {
                  store.loadMoreConversationEvents();
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

            final m = messages[i];
            final senderId = m.senderId;
            final senderHandle = handles[senderId] ?? senderId;
            final isPrimarySender = senderId == primary;

            return _MessageBubble(
              message: m,
              senderId: senderId,
              senderHandle: senderHandle,
              isPrimarySender: isPrimarySender,
              store: store,
            );
          },
        );
      },
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
