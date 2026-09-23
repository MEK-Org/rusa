import '../models.dart';
import 'reference_preview.dart';

/// How a GitHub inbox event shows on its reference card. The card's title is
/// still the issue or PR the event arrived through — the context — while the
/// chip says what happened to it and the body shows what was said, if anything.
class InboxEventPresentation {
  const InboxEventPresentation({
    required this.kindLabel,
    this.detail,
    this.summary,
    this.bodyless = false,
  });

  /// The thing and what happened to it, e.g. `GITHUB PR COMMENT`.
  final String kindLabel;

  /// The comment or review the event is about; its content is the body.
  final ReferenceDto? detail;

  /// A line shown as the body in place of content that could not be loaded.
  final String? summary;

  /// A state change (a push, a merge, a label) carries nothing written, and
  /// its chip already says what happened, so the card is just its header —
  /// never the issue or PR description shown as if it were the event.
  final bool bodyless;
}

/// The presentation for a GitHub-sourced inbox entry, or null for any other
/// source (a mesh message, an obligation), which renders as itself.
InboxEventPresentation? presentGitHubInboxEvent({
  required Map<String, dynamic> payload,
  required ReferenceDto? reference,
  ReferenceDto? eventReference,
}) {
  if (reference == null || reference.scheme != 'github') return null;
  final type = payload['type']?.toString() ?? '';
  final dot = type.indexOf('.');
  final event = dot < 0 ? type : type.substring(0, dot);
  final action = dot < 0 ? '' : type.substring(dot + 1);
  final subject = referenceKindLabel(
    reference.scheme,
    reference.entity?['type'] as String?,
  );
  final merged = payload['merged'] == true;

  final happened = switch (event) {
    'issue_comment' => 'COMMENT',
    'pull_request_review_comment' => 'REVIEW COMMENT',
    'pull_request_review' => 'REVIEW',
    'check_suite' || 'check_run' => 'CHECKS',
    'push' => 'PUSH',
    _ => switch (action) {
      '' => _words(event),
      'synchronize' => 'PUSH',
      'closed' => merged ? 'MERGED' : 'CLOSED',
      _ => _words(action),
    },
  };

  // Comments and reviews show what was written, and opening or editing shows
  // the description, since that is what changed. Anything else is a state
  // change with nothing written: header only.
  final shows =
      eventReference != null || action == 'opened' || action == 'edited';
  final summary = eventReference != null && !eventReference.isResolved
      ? 'Could not load it: ${eventReference.unavailable}'
      : null;

  return InboxEventPresentation(
    kindLabel: '$subject $happened',
    detail: eventReference,
    summary: summary,
    bodyless: !shows,
  );
}

String _words(String snake) => snake.replaceAll('_', ' ').toUpperCase();
