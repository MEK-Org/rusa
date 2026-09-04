import 'package:flutter/material.dart';

import '../actor_display.dart';
import '../link_opener.dart';
import '../models.dart';
import '../theme.dart';

/// One rendering for any resolved reference.
class ReferencePreview extends StatefulWidget {
  const ReferencePreview({
    super.key,
    required this.reference,
    this.label,
    this.attachedBy,
    this.lookupActorHandle,
    this.openLink = openInNewTab,
  });

  final ReferenceDto reference;

  /// Optional gloss from whoever cited it: why this is attached.
  final String? label;
  final String? attachedBy;

  /// Looks up a raw actor/thread id's display handle, or null if unknown.
  /// Fed through [actorDisplayLabel] so a raw id never renders bare — an
  /// unresolved lookup still falls back to "Unknown actor", never the id.
  final String? Function(String id)? lookupActorHandle;

  /// Opens a reference's url. Injectable so tests can assert exactly what
  /// gets opened without touching a real browser/platform channel.
  final void Function(String url) openLink;

  @override
  State<ReferencePreview> createState() => _ReferencePreviewState();
}

class _ReferencePreviewState extends State<ReferencePreview> {
  bool _expanded = false;
  bool _overflows = false;

  String _handle(String id) => actorDisplayLabel(id, widget.lookupActorHandle);

  @override
  Widget build(BuildContext context) {
    var displayTitle = widget.reference.title;
    var displayBody = widget.reference.body?.trim() ?? '';
    final entity = widget.reference.entity;
    final entityType = entity?['type'] as String?;

    String? meshParticipants;
    if (entityType == 'github_issue' || entityType == 'github_pull_request') {
      displayTitle = entity?['title'] as String? ?? displayTitle;
      displayBody = (entity?['description'] as String?)?.trim() ?? '';
    } else if (entityType == 'github_comment') {
      displayBody = (entity?['body'] as String?)?.trim() ?? displayBody;
    } else if (entityType == 'github_review') {
      final reviewBody = (entity?['body'] as String?)?.trim() ?? '';
      displayBody = reviewBody.isNotEmpty
          ? reviewBody
          : _reviewVerdictText(entity?['state'] as String?) ?? displayBody;
    } else if (entityType == 'gchat_space') {
      displayTitle = entity?['name'] as String? ?? displayTitle;
      displayBody = '';
    } else if (entityType == 'gchat_message') {
      displayBody = (entity?['contents'] as String?)?.trim() ?? displayBody;
    } else if (entityType == 'mesh_message') {
      final senderId = entity?['senderId'] as String?;
      final recipientId = entity?['recipientId'] as String?;
      final senderHandle = senderId != null ? _handle(senderId) : null;
      final recipientHandle = recipientId != null ? _handle(recipientId) : null;
      meshParticipants = [
        senderHandle,
        recipientHandle,
      ].whereType<String>().join(' → ');
      if (meshParticipants.isEmpty) meshParticipants = null;
      // The server's raw "senderId → recipientId" title is never rendered —
      // both ids are resolved through the actor projection before display.
      if (meshParticipants != null) displayTitle = meshParticipants;
    }

    // Defense in depth: whatever the entity-specific overrides above did,
    // a title that still equals the raw canonical ref means nothing safe
    // was resolved for it. Never render that ref — fall back to a
    // scheme/type-derived generic label instead.
    if (displayTitle == widget.reference.ref) {
      displayTitle = _genericTitle(widget.reference.scheme, entityType);
    }

    final hasBody = displayBody.isNotEmpty;
    // The header's single label slot: the citer's own gloss for why this was
    // attached, when they gave one, else the resolved title of the thing
    // itself.
    final headerLabel = widget.label != null && widget.label!.trim().isNotEmpty
        ? widget.label!
        : displayTitle;
    final citedByHandle = widget.attachedBy != null
        ? _handle(widget.attachedBy!)
        : null;
    final authorHandle = widget.reference.scheme == 'mesh'
        ? meshParticipants
        : (widget.reference.author != null &&
                  widget.reference.author!.trim().isNotEmpty
              ? widget.reference.author
              : null);

    return Container(
      width: double.infinity,
      margin: const EdgeInsets.only(bottom: 10),
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
      decoration: BoxDecoration(
        color: MeshColors.bgTertiary,
        borderRadius: BorderRadius.circular(6),
        border: Border.all(color: MeshColors.border),
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              _SchemeChip(widget.reference.scheme),
              if (widget.reference.url != null &&
                  widget.reference.url!.trim().isNotEmpty) ...[
                const SizedBox(width: 4),
                IconButton(
                  onPressed: () => widget.openLink(widget.reference.url!),
                  icon: const Icon(Icons.open_in_new, size: 14),
                  color: MeshColors.accent,
                  padding: EdgeInsets.zero,
                  constraints: const BoxConstraints(
                    minWidth: 24,
                    minHeight: 24,
                  ),
                  tooltip: 'Open in new tab',
                  visualDensity: VisualDensity.compact,
                ),
              ],
              const SizedBox(width: 6),
              Expanded(
                child: Text(
                  headerLabel,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(
                    color: MeshColors.textPrimary,
                    fontSize: 12.5,
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ),
              if (citedByHandle != null) ...[
                const SizedBox(width: 8),
                Text(
                  'cited by $citedByHandle',
                  style: const TextStyle(
                    color: MeshColors.textMuted,
                    fontSize: 10.5,
                  ),
                ),
              ],
            ],
          ),
          if (authorHandle != null) ...[
            const SizedBox(height: 6),
            Text(
              widget.reference.scheme == 'mesh'
                  ? authorHandle
                  : 'by $authorHandle',
              style: const TextStyle(
                color: MeshColors.textMuted,
                fontSize: 10.5,
              ),
            ),
          ],
          const SizedBox(height: 8),
          if (hasBody)
            Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                LayoutBuilder(
                  builder: (context, constraints) {
                    final style = const TextStyle(
                      color: Color(0xFFCBD5E1),
                      fontSize: 12,
                      height: 1.45,
                    );
                    final painter = TextPainter(
                      text: TextSpan(text: displayBody, style: style),
                      maxLines: 5,
                      textDirection: Directionality.of(context),
                      textScaler: MediaQuery.textScalerOf(context),
                      locale: Localizations.maybeLocaleOf(context),
                    )..layout(maxWidth: constraints.maxWidth);
                    final overflows = painter.didExceedMaxLines;
                    if (overflows != _overflows) {
                      WidgetsBinding.instance.addPostFrameCallback((_) {
                        if (mounted) setState(() => _overflows = overflows);
                      });
                    }

                    return _expanded || !overflows
                        ? SelectableText(displayBody, style: style)
                        : Text(
                            displayBody,
                            maxLines: 5,
                            overflow: TextOverflow.ellipsis,
                            style: style,
                          );
                  },
                ),
                if (_overflows) ...[
                  const SizedBox(height: 6),
                  InkWell(
                    onTap: () => setState(() => _expanded = !_expanded),
                    child: Text(
                      _expanded ? 'Show less' : 'Show more',
                      style: const TextStyle(
                        color: MeshColors.accent,
                        fontSize: 11,
                        fontWeight: FontWeight.w500,
                      ),
                    ),
                  ),
                ],
              ],
            )
          else
            Text(
              widget.reference.unavailable ?? 'No content.',
              style: const TextStyle(
                color: MeshColors.textMuted,
                fontSize: 11.5,
                fontStyle: FontStyle.italic,
              ),
            ),
        ],
      ),
    );
  }
}

/// A human-safe, generic label for a reference whose title is otherwise the
/// raw canonical ref — an unresolved or unrecognized source, or an entity
/// type this widget has no specific title rule for. Never the ref itself.
String _genericTitle(String scheme, String? entityType) => switch (entityType) {
  'github_comment' => 'GitHub comment',
  'github_review' => 'GitHub review',
  'gchat_message' => 'Chat message',
  'gchat_space' => 'Chat space',
  _ => switch (scheme) {
    'github' => 'GitHub reference',
    'gchat' => 'Chat reference',
    'mesh' => 'Mesh message',
    _ => 'Reference unavailable',
  },
};

/// An approval/rejection with no written comment still has content: the
/// verdict itself. Returns null for an unrecognized or missing state, so the
/// caller's "no content" fallback still applies there.
String? _reviewVerdictText(String? state) => switch (state) {
  'APPROVED' => 'Approved.',
  'CHANGES_REQUESTED' => 'Changes requested.',
  'COMMENTED' => 'Commented, no summary.',
  'DISMISSED' => 'Review dismissed.',
  _ => null,
};

class _SchemeChip extends StatelessWidget {
  const _SchemeChip(this.scheme);
  final String scheme;

  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
    decoration: BoxDecoration(
      color: MeshColors.bgPrimary,
      borderRadius: BorderRadius.circular(4),
      border: Border.all(color: MeshColors.border),
    ),
    child: Text(
      scheme.toUpperCase(),
      style: const TextStyle(
        color: MeshColors.accent,
        fontSize: 9.5,
        fontWeight: FontWeight.bold,
        letterSpacing: 0.5,
        fontFamily: kMonoFontFamily,
      ),
    ),
  );
}
