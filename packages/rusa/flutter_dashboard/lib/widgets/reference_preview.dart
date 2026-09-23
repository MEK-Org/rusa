import 'package:flutter/material.dart';

import '../actor_display.dart';
import '../link_opener.dart';
import '../models.dart';
import '../theme.dart';
import '../util.dart';

/// One rendering for any resolved reference.
class ReferencePreview extends StatefulWidget {
  const ReferencePreview({
    super.key,
    required this.reference,
    this.label,
    this.attachedBy,
    this.lookupActorHandle,
    this.isHuman,
    this.humanDisplayName,
    this.openLink = openInNewTab,
    this.action,
    this.margin = const EdgeInsets.only(bottom: 10),
    this.kindLabel,
    this.detail,
    this.summary,
    this.showBody = true,
  });

  /// Entity types this widget renders specifically rather than as a generic
  /// title and body.
  static const _renderedEntityTypes = {
    'github_issue',
    'github_pull_request',
    'github_comment',
    'github_review',
    'gchat_message',
    'slack_message',
    'mesh_message',
  };

  /// Whether [reference] resolved to content this widget renders on its own
  /// terms, so a surface citing it can show this card in place of its own
  /// generic framing instead of nesting one inside the other.
  static bool rendersOwnContent(ReferenceDto? reference) =>
      reference != null &&
      reference.isResolved &&
      _renderedEntityTypes.contains(reference.entity?['type']);

  final ReferenceDto reference;

  /// Optional gloss from whoever cited it: why this is attached.
  final String? label;
  final String? attachedBy;

  /// Looks up a raw actor/thread id's display handle, or null if unknown.
  /// Fed through [actorDisplayLabel] so a raw id never renders bare — an
  /// unresolved lookup still falls back to "Unknown actor", never the id.
  final String? Function(String id)? lookupActorHandle;

  /// Whether an id belongs to a human operator.
  final bool Function(String id)? isHuman;
  final String? humanDisplayName;

  /// Opens a reference's url. Injectable so tests can assert exactly what
  /// gets opened without touching a real browser/platform channel.
  final void Function(String url) openLink;

  /// Optional action widget rendered at the trailing edge of the header row.
  final Widget? action;

  /// Space around the card; flush when it stands in for a surrounding frame.
  final EdgeInsetsGeometry margin;

  /// Chip text in place of the reference's own kind — e.g. an inbox event's
  /// `GITHUB PR COMMENT`, naming what happened to [reference].
  final String? kindLabel;

  /// Something within [reference] (a comment, a review) whose content is the
  /// body instead, with [reference] kept as the title for context.
  final ReferenceDto? detail;

  /// A line shown as the body when there is no [detail] content to show.
  final String? summary;

  /// False for a card that is just its header — an event whose chip already
  /// says everything, with no content worth a body.
  final bool showBody;

  @override
  State<ReferencePreview> createState() => _ReferencePreviewState();
}

class _ReferencePreviewState extends State<ReferencePreview> {
  bool _expanded = false;
  bool _overflows = false;

  String _handle(String id) =>
      actorDisplayLabel(id, widget.lookupActorHandle, widget.isHuman, widget.humanDisplayName);

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
    } else if (entityType == 'gchat_space' || entityType == 'slack_channel') {
      displayTitle = entity?['name'] as String? ?? displayTitle;
      displayBody = '';
    } else if (entityType == 'gchat_message' || entityType == 'slack_message') {
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

    final detail = widget.detail;
    final detailBody = detail != null && detail.isResolved
        ? _contentOf(detail)
        : '';
    if (detailBody.isNotEmpty) {
      displayBody = detailBody;
    } else if (widget.summary != null) {
      displayBody = widget.summary!;
    }
    final linkUrl = [
      detail?.url,
      widget.reference.url,
    ].firstWhere((u) => u != null && u.trim().isNotEmpty, orElse: () => null);

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
    // A mesh message's subtitle is when it was sent. Its title already names
    // who wrote to whom — unless a citer's label took the header, in which
    // case the participants still belong on the card.
    final timestamp = widget.reference.timestamp;
    final sentAt = timestamp != null && timestamp.isNotEmpty
        ? formatTs(timestamp)
        : null;
    final meshSubtitle = [
      if (headerLabel != displayTitle) meshParticipants,
      sentAt,
    ].whereType<String>().join(' · ');
    final subtitle = widget.reference.scheme == 'mesh'
        ? (meshSubtitle.isEmpty ? null : meshSubtitle)
        : _byline(detail != null ? detail.author : widget.reference.author);

    return Container(
      width: double.infinity,
      margin: widget.margin,
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
              ReferenceKindChip(
                widget.kindLabel ??
                    referenceKindLabel(widget.reference.scheme, entityType),
              ),
              if (linkUrl != null) ...[
                const SizedBox(width: 4),
                IconButton(
                  onPressed: () => widget.openLink(linkUrl),
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
              if (widget.action != null) ...[
                const SizedBox(width: 8),
                widget.action!,
              ],
            ],
          ),
          if (subtitle != null) ...[
            const SizedBox(height: 6),
            Text(
              subtitle,
              style: const TextStyle(
                color: MeshColors.textMuted,
                fontSize: 10.5,
              ),
            ),
          ],
          if (widget.showBody) ...[
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
        ],
      ),
    );
  }
}

String? _byline(String? author) =>
    author != null && author.trim().isNotEmpty ? 'by $author' : null;

/// What a comment, review or message actually says, for showing a [detail]
/// reference's content under its parent's title.
String _contentOf(ReferenceDto reference) {
  final entity = reference.entity;
  final text = switch (entity?['type']) {
    'github_comment' => entity?['body'] as String?,
    'github_review' =>
      ((entity?['body'] as String?)?.trim().isNotEmpty ?? false)
          ? entity!['body'] as String
          : _reviewVerdictText(entity?['state'] as String?),
    'gchat_message' || 'slack_message' => entity?['contents'] as String?,
    _ => reference.body,
  };
  return text?.trim() ?? '';
}

/// A human-safe, generic label for a reference whose title is otherwise the
/// raw canonical ref — an unresolved or unrecognized source, or an entity
/// type this widget has no specific title rule for. Never the ref itself.
String _genericTitle(String scheme, String? entityType) => switch (entityType) {
  'github_comment' => 'GitHub comment',
  'github_review' => 'GitHub review',
  'gchat_message' => 'Chat message',
  'gchat_space' => 'Chat space',
  'slack_message' => 'Slack message',
  'slack_channel' => 'Slack channel',
  _ => switch (scheme) {
    'github' => 'GitHub reference',
    'gchat' => 'Chat reference',
    'slack' => 'Slack reference',
    'mesh' => 'Mesh message',
    _ => 'Reference unavailable',
  },
};

/// An approval/rejection with no written comment still has content: the
/// verdict itself. Returns null for an unrecognized or missing state, so the
/// caller's "no content" fallback still applies there.
String? _reviewVerdictText(String? state) => switch (state?.toUpperCase()) {
  'APPROVED' => 'Approved.',
  'CHANGES_REQUESTED' => 'Changes requested.',
  'COMMENTED' => 'Commented, no summary.',
  'DISMISSED' => 'Review dismissed.',
  _ => null,
};

/// What a reference is, for its card's chip: the kind of thing where the
/// entity says, e.g. `MESH MESSAGE` or `GITHUB PR`, else just its source.
String referenceKindLabel(String scheme, String? entityType) =>
    switch (entityType) {
      'mesh_message' => 'MESH MESSAGE',
      'github_issue' => 'GITHUB ISSUE',
      'github_pull_request' => 'GITHUB PR',
      'github_comment' => 'GITHUB COMMENT',
      'github_review' => 'GITHUB REVIEW',
      'gchat_message' => 'GCHAT MESSAGE',
      'gchat_space' => 'GCHAT SPACE',
      'slack_message' => 'SLACK MESSAGE',
      'slack_channel' => 'SLACK CHANNEL',
      _ => scheme.toUpperCase(),
    };

/// The chip that opens a reference card's header, naming what it cites.
class ReferenceKindChip extends StatelessWidget {
  const ReferenceKindChip(this.label, {super.key});
  final String label;

  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
    decoration: BoxDecoration(
      color: MeshColors.bgPrimary,
      borderRadius: BorderRadius.circular(4),
      border: Border.all(color: MeshColors.border),
    ),
    child: Text(
      label,
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
