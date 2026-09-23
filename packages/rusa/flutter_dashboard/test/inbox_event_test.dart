import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rusa_dashboard/models.dart';
import 'package:rusa_dashboard/widgets/inbox_event.dart';
import 'package:rusa_dashboard/widgets/reference_preview.dart';

const _pr = ReferenceDto(
  ref: 'github:rusa-e2e/scratch/pulls/3',
  scheme: 'github',
  title: 'rusa-e2e/scratch#3 — Tighten inbox payload validation',
  body: 'Rejects unknown event shapes.',
  url: 'https://github.com/rusa-e2e/scratch/pull/3',
  entity: {
    'type': 'github_pull_request',
    'title': 'Tighten inbox payload validation',
    'description': 'Rejects unknown event shapes.',
  },
);

const _issue = ReferenceDto(
  ref: 'github:rusa-e2e/scratch/issues/7',
  scheme: 'github',
  title: 'rusa-e2e/scratch#7 — Dashboard shows a raw UUID',
  entity: {
    'type': 'github_issue',
    'title': 'Dashboard shows a raw UUID',
    'description': 'Seen on an obligation citation.',
  },
);

const _comment = ReferenceDto(
  ref: 'github:rusa-e2e/scratch/pulls/3/comments/4',
  scheme: 'github',
  title: 'rusa-e2e/scratch pulls/3 — comment',
  url: 'https://github.com/rusa-e2e/scratch/pull/3#discussion_r4',
  entity: {
    'type': 'github_comment',
    'body': 'Nit: this branch can never be reached.',
  },
);

InboxEventPresentation? _present(
  String type, {
  ReferenceDto reference = _pr,
  ReferenceDto? eventReference,
  Map<String, dynamic> extra = const {},
}) => presentGitHubInboxEvent(
  payload: {'type': type, ...extra},
  reference: reference,
  eventReference: eventReference,
);

void main() {
  group('presentGitHubInboxEvent', () {
    test('names the thing and what happened to it', () {
      expect(_present('issue_comment.created')?.kindLabel, 'GITHUB PR COMMENT');
      expect(
        _present('pull_request_review_comment.created')?.kindLabel,
        'GITHUB PR REVIEW COMMENT',
      );
      expect(
        _present('pull_request_review.submitted')?.kindLabel,
        'GITHUB PR REVIEW',
      );
      expect(_present('pull_request.synchronize')?.kindLabel, 'GITHUB PR PUSH');
      expect(
        _present('pull_request.closed', extra: {'merged': true})?.kindLabel,
        'GITHUB PR MERGED',
      );
      expect(
        _present('issues.closed', reference: _issue)?.kindLabel,
        'GITHUB ISSUE CLOSED',
      );
      expect(
        _present('pull_request.ready_for_review')?.kindLabel,
        'GITHUB PR READY FOR REVIEW',
      );
    });

    test('shows what was written for a comment, and nothing for a state '
        'change', () {
      final comment = _present(
        'pull_request_review_comment.created',
        eventReference: _comment,
      );
      expect(comment?.detail, _comment);
      expect(comment?.bodyless, isFalse);

      for (final type in [
        'pull_request.synchronize',
        'pull_request.closed',
        'pull_request.labeled',
      ]) {
        expect(_present(type)?.bodyless, isTrue, reason: type);
      }
      expect(_present('issues.closed', reference: _issue)?.bodyless, isTrue);
      // Opening or editing shows the description: that is what changed.
      expect(_present('pull_request.opened')?.bodyless, isFalse);
      expect(_present('pull_request.edited')?.bodyless, isFalse);
    });

    test('says why a comment it could not load is missing', () {
      const missing = ReferenceDto(
        ref: 'github:rusa-e2e/scratch/pulls/3/comments/9',
        scheme: 'github',
        title: 'comment',
        unavailable: 'comment not found on the tracker',
      );
      expect(
        _present(
          'pull_request_review_comment.created',
          eventReference: missing,
        )?.summary,
        'Could not load it: comment not found on the tracker',
      );
    });

    test('leaves non-GitHub entries to render as themselves', () {
      const mesh = ReferenceDto(
        ref: 'mesh:messages/m-1',
        scheme: 'mesh',
        title: 'a → b',
      );
      expect(_present('mesh.message', reference: mesh), isNull);
      expect(
        presentGitHubInboxEvent(
          payload: {'type': 'obligation.ready_head'},
          reference: null,
        ),
        isNull,
      );
    });
  });

  group('ReferencePreview with an inbox event', () {
    Widget host(Widget child) => MaterialApp(
      home: Scaffold(body: SingleChildScrollView(child: child)),
    );

    testWidgets('titles the card with the PR but shows the comment, linking '
        'to it', (tester) async {
      String? opened;
      final event = _present(
        'pull_request_review_comment.created',
        eventReference: _comment,
      )!;
      await tester.pumpWidget(
        host(
          ReferencePreview(
            reference: _pr,
            kindLabel: event.kindLabel,
            detail: event.detail,
            summary: event.summary,
            openLink: (url) => opened = url,
          ),
        ),
      );

      expect(find.text('GITHUB PR REVIEW COMMENT'), findsOneWidget);
      expect(find.text('Tighten inbox payload validation'), findsOneWidget);
      expect(find.text('Nit: this branch can never be reached.'), findsOne);
      expect(find.text('Rejects unknown event shapes.'), findsNothing);

      await tester.tap(find.byIcon(Icons.open_in_new));
      expect(
        opened,
        'https://github.com/rusa-e2e/scratch/pull/3#discussion_r4',
      );
    });

    testWidgets('is just its header for a push', (tester) async {
      final event = _present('pull_request.synchronize')!;
      await tester.pumpWidget(
        host(
          ReferencePreview(
            reference: _pr,
            kindLabel: event.kindLabel,
            showBody: !event.bodyless,
          ),
        ),
      );

      expect(find.text('GITHUB PR PUSH'), findsOneWidget);
      expect(find.text('Tighten inbox payload validation'), findsOneWidget);
      expect(find.text('Rejects unknown event shapes.'), findsNothing);
      expect(find.text('No content.'), findsNothing);
    });
  });
}
