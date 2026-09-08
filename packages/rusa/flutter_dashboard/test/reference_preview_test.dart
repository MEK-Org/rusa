import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:rusa_dashboard/models.dart';
import 'package:rusa_dashboard/widgets/reference_preview.dart';

Widget _host(Widget child) => MaterialApp(
  home: Scaffold(body: SingleChildScrollView(child: child)),
);

/// Every string actually rendered by a `Text`/`SelectableText` in the tree,
/// joined with a separator. Substring checks against this catch a raw id
/// hiding inside a composite string (e.g. "human:operator → root"), which
/// `find.text(rawId)` — an exact-match finder — cannot.
String _allRenderedText(WidgetTester tester) {
  final texts = tester
      .widgetList<Text>(find.byType(Text))
      .map((w) => w.data ?? '');
  final selectable = tester
      .widgetList<SelectableText>(find.byType(SelectableText))
      .map((w) => w.data ?? '');
  return [...texts, ...selectable].join('|');
}

void main() {
  group('ReferenceDto', () {
    test('parses a resolved reference', () {
      final dto = ReferenceDto.fromJson(const {
        'ref': 'mesh:messages/abc',
        'scheme': 'mesh',
        'title': 'human:operator → root',
        'body': 'A monster-catching JRPG in a cave.',
        'author': 'human:operator',
        'timestamp': '2026-08-30T12:00:00.000Z',
        'url': null,
        'unavailable': null,
      });

      expect(dto.isResolved, true);
      expect(dto.body, 'A monster-catching JRPG in a cave.');
    });

    test('an unresolvable reference is not the same as an empty one', () {
      final dto = ReferenceDto.fromJson(const {
        'ref': 'github:MEK-Org/rusa/issues/33',
        'scheme': 'github',
        'title': 'github:MEK-Org/rusa/issues/33',
        'unavailable': 'tracker not configured',
      });

      expect(dto.isResolved, false);
      expect(dto.unavailable, 'tracker not configured');
    });
  });

  group('ObligationArtifactDto', () {
    test('reads the server shape of artifact plus resolved reference', () {
      final dto = ObligationArtifactDto.fromJson(const {
        'artifact': {
          'ref': 'mesh:messages/abc',
          'label': "Operator's opening ask",
          'attachedBy': 'root',
          'attachedAt': '2026-08-30T12:00:00.000Z',
        },
        'reference': {
          'ref': 'mesh:messages/abc',
          'scheme': 'mesh',
          'title': 'human:operator → root',
          'body': 'the answer',
        },
      });

      expect(dto.ref, 'mesh:messages/abc');
      expect(dto.label, "Operator's opening ask");
      expect(dto.reference?.body, 'the answer');
    });

    test('tolerates an artifact whose reference could not be resolved', () {
      final dto = ObligationArtifactDto.fromJson(const {
        'artifact': {'ref': 'github:MEK-Org/rusa/issues/33'},
        'reference': null,
      });

      expect(dto.ref, 'github:MEK-Org/rusa/issues/33');
      expect(dto.reference, isNull);
    });
  });

  group('ReferencePreview', () {
    testWidgets(
      'renders a compact header — scheme, link button, label, then the '
      'resolved cited-by handle — with no footer, raw ref, url, or cache '
      'status anywhere',
      (tester) async {
        await tester.pumpWidget(
          _host(
            ReferencePreview(
              reference: const ReferenceDto(
                ref: 'github:MEK-Org/rusa/issues/204',
                scheme: 'github',
                title: 'github:MEK-Org/rusa/issues/204',
                entity: {
                  'type': 'github_issue',
                  'title': 'Polish obligation artifact previews',
                  'description': 'Some description body.',
                },
                url: 'https://github.com/MEK-Org/rusa/issues/204',
                cacheState: 'fresh',
              ),
              attachedBy: 'raw-actor-id',
              lookupActorHandle: (id) =>
                  id == 'raw-actor-id' ? 'operator-handle' : null,
            ),
          ),
        );
        await tester.pumpAndSettle();

        // The four header elements are present...
        expect(find.text('GITHUB'), findsOneWidget);
        expect(find.byIcon(Icons.open_in_new), findsOneWidget);
        expect(
          find.text('Polish obligation artifact previews'),
          findsOneWidget,
        );
        expect(find.text('cited by operator-handle'), findsOneWidget);

        // ...and appear left to right in that order.
        final schemeX = tester.getCenter(find.text('GITHUB')).dx;
        final linkX = tester.getCenter(find.byIcon(Icons.open_in_new)).dx;
        final labelX = tester
            .getCenter(find.text('Polish obligation artifact previews'))
            .dx;
        final citedByX = tester
            .getCenter(find.text('cited by operator-handle'))
            .dx;
        expect(schemeX, lessThan(linkX));
        expect(linkX, lessThan(labelX));
        expect(labelX, lessThan(citedByX));

        // No cache-state badge, no raw ref/url text, no raw attachedBy id,
        // and no footer row of any kind.
        expect(find.text('FRESH'), findsNothing);
        expect(find.text('github:MEK-Org/rusa/issues/204'), findsNothing);
        expect(
          find.text('https://github.com/MEK-Org/rusa/issues/204'),
          findsNothing,
        );
        expect(find.text('raw-actor-id'), findsNothing);
        expect(find.text('cited by raw-actor-id'), findsNothing);
      },
    );

    testWidgets(
      "the citer's own label wins the header slot over the resolved title",
      (tester) async {
        await tester.pumpWidget(
          _host(
            const ReferencePreview(
              reference: ReferenceDto(
                ref: 'github:foo/bar/issues/1',
                scheme: 'github',
                title: 'fallback title',
                entity: {
                  'type': 'github_issue',
                  'title': 'Resolved Issue Title',
                  'description': 'desc',
                },
              ),
              label: "Operator's own gloss",
            ),
          ),
        );

        expect(find.text("Operator's own gloss"), findsOneWidget);
        expect(find.text('Resolved Issue Title'), findsNothing);
      },
    );

    testWidgets('omits the link button when the reference has no url', (
      tester,
    ) async {
      await tester.pumpWidget(
        _host(
          const ReferencePreview(
            reference: ReferenceDto(
              ref: 'mesh:messages/abc',
              scheme: 'mesh',
              title: 'title',
              body: 'body',
            ),
          ),
        ),
      );

      expect(find.byIcon(Icons.open_in_new), findsNothing);
    });

    testWidgets(
      'tapping the link button opens exactly the reference URL, via the '
      'injected opener',
      (tester) async {
        final openedUrls = <String>[];
        await tester.pumpWidget(
          _host(
            ReferencePreview(
              reference: const ReferenceDto(
                ref: 'github:foo/bar/issues/1',
                scheme: 'github',
                title: 'Issue 1',
                url: 'https://example.test/issue/1',
              ),
              openLink: openedUrls.add,
            ),
          ),
        );

        await tester.tap(find.byIcon(Icons.open_in_new));
        await tester.pump();

        expect(openedUrls, ['https://example.test/issue/1']);
      },
    );

    testWidgets(
      'resolves both mesh message sender and recipient to handles, shown '
      'with no "by" prefix, and never leaks either raw id — even with no '
      'lookup supplied',
      (tester) async {
        await tester.pumpWidget(
          _host(
            const ReferencePreview(
              reference: ReferenceDto(
                ref: 'mesh:messages/abc',
                scheme: 'mesh',
                title: 'human:operator → root',
                body: 'A monster-catching JRPG in a cave.',
                entity: {
                  'type': 'mesh_message',
                  'senderId': 'human:operator',
                  'recipientId': 'root',
                },
              ),
            ),
          ),
        );

        expect(find.text('Operator → Unknown actor'), findsWidgets);
        expect(find.textContaining('by Operator'), findsNothing);
        final rendered = _allRenderedText(tester);
        expect(rendered.contains('human:operator'), false);
        expect(rendered.contains('root'), false);
      },
    );

    testWidgets(
      'resolves a known mesh sender and recipient to their handles via the '
      'actor lookup, never the raw ids',
      (tester) async {
        await tester.pumpWidget(
          _host(
            ReferencePreview(
              reference: const ReferenceDto(
                ref: 'mesh:messages/abc',
                scheme: 'mesh',
                title: 'actor-1 → actor-2',
                body: 'known participants',
                entity: {
                  'type': 'mesh_message',
                  'senderId': 'actor-1',
                  'recipientId': 'actor-2',
                },
              ),
              lookupActorHandle: (id) => switch (id) {
                'actor-1' => 'alice',
                'actor-2' => 'bob',
                _ => null,
              },
            ),
          ),
        );

        expect(find.text('alice → bob'), findsWidgets);
        final rendered = _allRenderedText(tester);
        expect(rendered.contains('actor-1'), false);
        expect(rendered.contains('actor-2'), false);
      },
    );

    testWidgets(
      'resolves a mesh message sender and recipient that no lookup can find '
      'to "Unknown actor", never the raw ids — and a citer label does not '
      'hide the participant context',
      (tester) async {
        await tester.pumpWidget(
          _host(
            ReferencePreview(
              reference: const ReferenceDto(
                ref: 'mesh:messages/abc',
                scheme: 'mesh',
                title: 'retired-actor-77 → retired-actor-88',
                body: 'gone from this mesh view',
                entity: {
                  'type': 'mesh_message',
                  'senderId': 'retired-actor-77',
                  'recipientId': 'retired-actor-88',
                },
              ),
              label: "Operator's opening ask",
              lookupActorHandle: (id) => null,
            ),
          ),
        );

        // The citer's label takes the header slot, but the resolved
        // participant context still appears elsewhere on the card.
        expect(find.text("Operator's opening ask"), findsOneWidget);
        expect(find.text('Unknown actor → Unknown actor'), findsWidgets);
        final rendered = _allRenderedText(tester);
        expect(rendered.contains('retired-actor-77'), false);
        expect(rendered.contains('retired-actor-88'), false);
      },
    );

    testWidgets(
      'shows "cited by Unknown actor", never the raw id, when the citer '
      'cannot be resolved',
      (tester) async {
        await tester.pumpWidget(
          _host(
            const ReferencePreview(
              reference: ReferenceDto(
                ref: 'github:foo/bar/issues/1',
                scheme: 'github',
                title: 'Issue 1',
              ),
              attachedBy: 'retired-actor-77',
            ),
          ),
        );

        expect(find.text('cited by Unknown actor'), findsOneWidget);
        expect(find.text('cited by retired-actor-77'), findsNothing);
        expect(find.text('retired-actor-77'), findsNothing);
      },
    );

    testWidgets('shows a github author with the "by" prefix, unresolved', (
      tester,
    ) async {
      await tester.pumpWidget(
        _host(
          const ReferencePreview(
            reference: ReferenceDto(
              ref: 'github:foo/bar/issues/1',
              scheme: 'github',
              title: 'Issue 1',
              author: 'octocat',
            ),
          ),
        ),
      );

      expect(find.text('by octocat'), findsOneWidget);
    });

    testWidgets(
      'shows "Show more" only when the body genuinely overflows five lines '
      'at the rendered width, not from a character-count heuristic',
      (tester) async {
        // Long enough to run past five lines when wrapped narrow, but short
        // enough to fit within five lines at a wide layout — proving the
        // toggle tracks actual layout, not body length.
        const body =
            'The quick brown fox jumps over the lazy dog near the riverbank '
            'while the sun sets slowly behind the distant hills.';

        await tester.pumpWidget(
          _host(
            SizedBox(
              width: 220,
              child: ReferencePreview(
                reference: const ReferenceDto(
                  ref: 'mesh:messages/narrow',
                  scheme: 'mesh',
                  title: 'title',
                  body: body,
                ),
              ),
            ),
          ),
        );
        await tester.pump();
        await tester.pump();

        expect(find.text('Show more'), findsOneWidget);

        await tester.pumpWidget(
          _host(
            SizedBox(
              width: 900,
              child: ReferencePreview(
                reference: const ReferenceDto(
                  ref: 'mesh:messages/wide',
                  scheme: 'mesh',
                  title: 'title',
                  body: body,
                ),
              ),
            ),
          ),
        );
        await tester.pump();
        await tester.pump();

        expect(find.text('Show more'), findsNothing);
      },
    );

    testWidgets('expanding "Show more" reveals the full text', (tester) async {
      final longBody = List.filled(10, 'Long line of text').join('\n');
      await tester.pumpWidget(
        _host(
          ReferencePreview(
            reference: ReferenceDto(
              ref: 'mesh:123',
              scheme: 'mesh',
              title: 'title',
              body: longBody,
            ),
          ),
        ),
      );
      await tester.pump();
      await tester.pump();

      expect(find.text('Show more'), findsOneWidget);
      await tester.tap(find.text('Show more'));
      await tester.pumpAndSettle();
      expect(find.text('Show less'), findsOneWidget);
    });

    testWidgets(
      'measures overflow with the ambient text scaler, so text that fits at '
      '1x but would visually clip under larger accessibility scaling is not '
      'reported as fitting',
      (tester) async {
        const body =
            'The quick brown fox jumps over the lazy dog near the riverbank '
            'while the sun sets slowly behind the distant hills.';

        Widget hostScaled(double scale) => MaterialApp(
          home: Scaffold(
            body: SingleChildScrollView(
              child: MediaQuery(
                data: MediaQueryData(textScaler: TextScaler.linear(scale)),
                child: const SizedBox(
                  width: 900,
                  child: ReferencePreview(
                    reference: ReferenceDto(
                      ref: 'mesh:messages/scaled',
                      scheme: 'mesh',
                      title: 'title',
                      body: body,
                    ),
                  ),
                ),
              ),
            ),
          ),
        );

        await tester.pumpWidget(hostScaled(1));
        await tester.pump();
        await tester.pump();
        expect(find.text('Show more'), findsNothing);

        await tester.pumpWidget(hostScaled(3));
        await tester.pump();
        await tester.pump();
        expect(find.text('Show more'), findsOneWidget);
      },
    );

    testWidgets('displays different entity types properly', (tester) async {
      await tester.pumpWidget(
        _host(
          const ReferencePreview(
            reference: ReferenceDto(
              ref: 'github:foo/bar/issues/1',
              scheme: 'github',
              title: 'Issue 1',
              entity: {
                'type': 'github_issue',
                'title': 'My Issue',
                'description': 'The desc',
              },
            ),
          ),
        ),
      );
      expect(find.text('My Issue'), findsOneWidget);
      expect(find.text('The desc'), findsOneWidget);

      await tester.pumpWidget(
        _host(
          const ReferencePreview(
            reference: ReferenceDto(
              ref: 'github:foo/bar/pulls/2',
              scheme: 'github',
              title: 'PR 2',
              entity: {
                'type': 'github_pull_request',
                'title': 'My PR',
                'description': 'The PR desc',
              },
            ),
          ),
        ),
      );
      expect(find.text('My PR'), findsOneWidget);
      expect(find.text('The PR desc'), findsOneWidget);

      await tester.pumpWidget(
        _host(
          const ReferencePreview(
            reference: ReferenceDto(
              ref: 'github:foo/bar/issues/1/comments/9',
              scheme: 'github',
              title: 'Comment',
              entity: {'type': 'github_comment', 'body': 'A comment body'},
            ),
          ),
        ),
      );
      expect(find.text('A comment body'), findsOneWidget);

      await tester.pumpWidget(
        _host(
          const ReferencePreview(
            reference: ReferenceDto(
              ref: 'github:foo/bar/pulls/2/reviews/7',
              scheme: 'github',
              title: 'Review',
              entity: {
                'type': 'github_review',
                'body': 'Ship it.',
                'state': 'APPROVED',
              },
            ),
          ),
        ),
      );
      expect(find.text('Ship it.'), findsOneWidget);

      await tester.pumpWidget(
        _host(
          const ReferencePreview(
            reference: ReferenceDto(
              ref: 'gchat:spaces/abc',
              scheme: 'gchat',
              title: 'Space',
              entity: {'type': 'gchat_space', 'name': 'My Space'},
            ),
          ),
        ),
      );
      expect(find.text('My Space'), findsOneWidget);

      await tester.pumpWidget(
        _host(
          const ReferencePreview(
            reference: ReferenceDto(
              ref: 'gchat:spaces/abc/messages/123',
              scheme: 'gchat',
              title: 'Message',
              entity: {'type': 'gchat_message', 'contents': 'Msg content'},
            ),
          ),
        ),
      );
      expect(find.text('Msg content'), findsOneWidget);
    });

    testWidgets(
      'an unlabeled cached comment/review never shows the raw canonical ref '
      'as its title — a cache-boundary response with no title override still '
      'gets a safe generic label',
      (tester) async {
        await tester.pumpWidget(
          _host(
            const ReferencePreview(
              reference: ReferenceDto(
                ref: 'github:foo/bar/issues/1/comments/9',
                scheme: 'github',
                // As a cache-boundary response would look before its title
                // was resolved server-side: the raw canonical ref.
                title: 'github:foo/bar/issues/1/comments/9',
                entity: {'type': 'github_comment', 'body': 'A comment body'},
              ),
            ),
          ),
        );

        expect(find.text('github:foo/bar/issues/1/comments/9'), findsNothing);
        expect(find.text('GitHub comment'), findsOneWidget);

        await tester.pumpWidget(
          _host(
            const ReferencePreview(
              reference: ReferenceDto(
                ref: 'github:foo/bar/pulls/2/reviews/7',
                scheme: 'github',
                title: 'github:foo/bar/pulls/2/reviews/7',
                entity: {
                  'type': 'github_review',
                  'body': 'Ship it.',
                  'state': 'APPROVED',
                },
              ),
            ),
          ),
        );

        expect(find.text('github:foo/bar/pulls/2/reviews/7'), findsNothing);
        expect(find.text('GitHub review'), findsOneWidget);
      },
    );

    testWidgets(
      'a generic unavailable/unrecognized reference never shows the raw '
      'canonical ref as its title',
      (tester) async {
        await tester.pumpWidget(
          _host(
            const ReferencePreview(
              reference: ReferenceDto(
                ref: 'github:foo/bar/branch@main',
                scheme: 'github',
                title: 'github:foo/bar/branch@main',
                unavailable: 'branch content is not fetched',
              ),
            ),
          ),
        );

        expect(find.text('github:foo/bar/branch@main'), findsNothing);
        expect(find.text('GitHub reference'), findsOneWidget);

        await tester.pumpWidget(
          _host(
            const ReferencePreview(
              reference: ReferenceDto(
                ref: 'gchat:spaces/abc/messages/999',
                scheme: 'gchat',
                title: 'gchat:spaces/abc/messages/999',
                unavailable: 'could not load context',
              ),
            ),
          ),
        );

        expect(find.text('gchat:spaces/abc/messages/999'), findsNothing);
        expect(find.text('Chat reference'), findsOneWidget);
      },
    );

    testWidgets(
      'an empty-body review shows its verdict as content, not "No content."',
      (tester) async {
        await tester.pumpWidget(
          _host(
            const ReferencePreview(
              reference: ReferenceDto(
                ref: 'github:foo/bar/pulls/2/reviews/9002',
                scheme: 'github',
                title: 'Review',
                entity: {
                  'type': 'github_review',
                  'body': '',
                  'state': 'APPROVED',
                },
              ),
            ),
          ),
        );

        expect(find.text('No content.'), findsNothing);
        expect(find.text('Approved.'), findsOneWidget);
      },
    );

    testWidgets('says why it could not expand, rather than showing nothing', (
      tester,
    ) async {
      await tester.pumpWidget(
        _host(
          const ReferencePreview(
            reference: ReferenceDto(
              ref: 'github:MEK-Org/rusa/issues/33',
              scheme: 'github',
              title: 'github:MEK-Org/rusa/issues/33',
              unavailable:
                  'Not resolvable yet — only mesh chat is read back so far.',
            ),
          ),
        ),
      );

      expect(find.text('GITHUB'), findsOneWidget);
      expect(
        find.text('Not resolvable yet — only mesh chat is read back so far.'),
        findsOneWidget,
      );
      expect(find.text('No attached contents.'), findsNothing);
    });

    testWidgets(
      'renders trailing action widget at the trailing edge of header row when supplied',
      (tester) async {
        var actionTapped = false;
        await tester.pumpWidget(
          _host(
            ReferencePreview(
              reference: const ReferenceDto(
                ref: 'github:MEK-Org/rusa/issues/345',
                scheme: 'github',
                title: 'Reference Card Title',
                url: 'https://github.com/MEK-Org/rusa/issues/345',
              ),
              attachedBy: 'raw-actor-id',
              lookupActorHandle: (_) => 'operator-handle',
              action: IconButton(
                icon: const Icon(Icons.edit_outlined),
                tooltip: 'Change or unlink',
                onPressed: () => actionTapped = true,
              ),
            ),
          ),
        );
        await tester.pumpAndSettle();

        expect(find.byTooltip('Change or unlink'), findsOneWidget);
        final labelX = tester.getCenter(find.text('Reference Card Title')).dx;
        final citedByX = tester.getCenter(find.text('cited by operator-handle')).dx;
        final actionX = tester.getCenter(find.byTooltip('Change or unlink')).dx;

        expect(labelX, lessThan(citedByX));
        expect(citedByX, lessThan(actionX));

        await tester.tap(find.byTooltip('Change or unlink'));
        expect(actionTapped, isTrue);
      },
    );
  });
}
