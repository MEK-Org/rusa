import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:rusa_dashboard/store.dart';
import 'package:rusa_dashboard/widgets/inbox_tab.dart';

import 'fakes.dart';

Map<String, dynamic> entry(
  String id, {
  String source = 'mesh:root',
  Map<String, dynamic>? reference,
}) => {
  'id': id,
  'source': source,
  'deliveredAt': '2026-09-05T12:00:00.000Z',
  'handledAt': null,
  'handledNote': null,
  'payload': {'type': 'mesh.message', 'content': 'Body of $id'},
  'reference': ?reference,
};

/// Both an inbox signal and a ready obligation, so the layout has real
/// content on both sides of the split.
DashboardStore _storeWithBothSections() {
  final api = FakeApi()
    ..inboxResultsByStatus['unhandled'] = {
      'entries': [
        entry(
          'entry-1',
          reference: {
            'ref': 'github:MEK-Org/rusa/issues/1',
            'scheme': 'github',
            'title': 'Issue 1',
            'url': 'https://github.com/MEK-Org/rusa/issues/1',
          },
        ),
      ],
    }
    ..inboxResultsByStatus['handled'] = {'entries': []}
    ..obligationsResult = [
      makeObligation('ob-1', ownerId: 'actor-a', intent: 'Ready obligation'),
    ];

  return DashboardStore(
    api: api,
    stream: FakeStream(),
    quotaCache: FakeQuotaCache(),
    treePreferencesCache: FakeTreePreferencesCache(),
  );
}

Future<void> _pump(
  WidgetTester tester,
  DashboardStore store, {
  required Size size,
  void Function(String url)? openLink,
}) async {
  tester.view.physicalSize = size;
  tester.view.devicePixelRatio = 1.0;
  addTearDown(tester.view.resetDevicePixelRatio);
  addTearDown(tester.view.resetPhysicalSize);

  await tester.pumpWidget(
    MaterialApp(
      home: Scaffold(
        body: InboxTab(
          actorId: 'actor-a',
          store: store,
          openLink: openLink ?? (_) {},
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
}

void main() {
  group('InboxTab responsive layout', () {
    testWidgets(
      'wide layout places inbox signals left of obligations, side by side',
      (tester) async {
        await _pump(
          tester,
          _storeWithBothSections(),
          size: const Size(1200, 900),
        );

        expect(find.text('Outstanding inbox signals'), findsOneWidget);
        expect(find.text('Ready Obligations'), findsOneWidget);

        final inboxLeft = tester.getTopLeft(
          find.text('Outstanding inbox signals'),
        );
        final obligationsLeft = tester.getTopLeft(
          find.text('Ready Obligations'),
        );

        // Side by side: same row, inbox strictly to the left.
        expect(inboxLeft.dx, lessThan(obligationsLeft.dx));
        expect((inboxLeft.dy - obligationsLeft.dy).abs(), lessThan(2));
      },
    );

    testWidgets(
      'narrow layout stacks inbox signals above obligations in one column',
      (tester) async {
        await _pump(
          tester,
          _storeWithBothSections(),
          size: const Size(500, 900),
        );

        expect(find.text('Outstanding inbox signals'), findsOneWidget);
        expect(find.text('Ready Obligations'), findsOneWidget);

        final inboxTop = tester.getTopLeft(
          find.text('Outstanding inbox signals'),
        );
        final obligationsTop = tester.getTopLeft(
          find.text('Ready Obligations'),
        );

        // Stacked: same column, inbox strictly above.
        expect((inboxTop.dx - obligationsTop.dx).abs(), lessThan(2));
        expect(inboxTop.dy, lessThan(obligationsTop.dy));
      },
    );

    testWidgets(
      'a wide layout with only obligations does not reserve an empty inbox column',
      (tester) async {
        final api = FakeApi()
          ..inboxResultsByStatus['unhandled'] = {'entries': []}
          ..inboxResultsByStatus['handled'] = {'entries': []}
          ..obligationsResult = [
            makeObligation('ob-1', ownerId: 'actor-a', intent: 'Solo ready'),
          ];
        final store = DashboardStore(
          api: api,
          stream: FakeStream(),
          quotaCache: FakeQuotaCache(),
          treePreferencesCache: FakeTreePreferencesCache(),
        );

        await _pump(tester, store, size: const Size(1200, 900));

        expect(find.text('Outstanding inbox signals'), findsNothing);
        expect(find.text('Ready Obligations'), findsOneWidget);
      },
    );
  });

  group('InboxTab external ref links', () {
    testWidgets(
      'a resolved external ref renders as a link that opens exactly its URL '
      'via the injected new-tab opener',
      (tester) async {
        final openedUrls = <String>[];
        await _pump(
          tester,
          _storeWithBothSections(),
          size: const Size(1200, 900),
          openLink: openedUrls.add,
        );

        final linkIcon = find.byIcon(Icons.open_in_new);
        expect(linkIcon, findsOneWidget);
        expect(find.byTooltip('Open in new tab'), findsOneWidget);

        await tester.tap(linkIcon);
        await tester.pump();

        expect(openedUrls, ['https://github.com/MEK-Org/rusa/issues/1']);
      },
    );

    testWidgets(
      'an inbox entry with no resolvable reference falls back to raw content, '
      'with no link button',
      (tester) async {
        final api = FakeApi()
          ..inboxResultsByStatus['unhandled'] = {
            'entries': [entry('entry-1')],
          }
          ..inboxResultsByStatus['handled'] = {'entries': []};
        final store = DashboardStore(
          api: api,
          stream: FakeStream(),
          quotaCache: FakeQuotaCache(),
          treePreferencesCache: FakeTreePreferencesCache(),
        );

        await _pump(tester, store, size: const Size(1200, 900));

        expect(find.byIcon(Icons.open_in_new), findsNothing);
        expect(find.textContaining('Body of entry-1'), findsOneWidget);
      },
    );
  });
}
