// #940: the obligation detail and Recent Activity answer with ref keys and
// actor ids alone. The client paints from that, then resolves the keys through
// `POST /api/mesh/references` and fills the references in as they arrive;
// actors are labelled from the threads snapshot.

import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart' show MockClient;
import 'package:rusa_dashboard/api.dart';
import 'package:rusa_dashboard/models.dart';
import 'package:rusa_dashboard/store.dart';
import 'package:rusa_dashboard/widgets/overview_tab.dart';
import 'package:rusa_dashboard/widgets/work_tab.dart';

import 'fakes.dart';

const _cited = 'github:o/r/issues/1';
const _claimed = 'github:o/r/issues/2';

ReferenceDto _issue(String ref, String title) => ReferenceDto(
  ref: ref,
  scheme: 'github',
  title: title,
  url: 'https://github.com/o/r/issues/${ref.split('/').last}',
  entity: {'type': 'github_issue', 'title': title},
  cacheState: 'fresh',
);

void main() {
  group('DashboardApi.fetchReferences', () {
    test('asks for each ref once, in batches the server accepts', () async {
      final requested = <List<String>>[];
      final client = MockClient((req) async {
        expect(req.url.path, '/api/mesh/references');
        expect(req.method, 'POST');
        final body = jsonDecode(req.body) as Map<String, dynamic>;
        final refs = (body['refs'] as List<dynamic>).cast<String>();
        requested.add(refs);
        return http.Response(
          jsonEncode({
            'references': {
              for (final ref in refs)
                ref: {'ref': ref, 'scheme': 'github', 'title': 'T $ref'},
            },
          }),
          200,
        );
      });
      final api = DashboardApi(
        client: client,
        base: Uri.parse('http://localhost:3000'),
      );
      final refs = [for (var i = 1; i <= 35; i++) 'github:o/r/issues/$i'];

      final resolved = await api.fetchReferences([...refs, refs.first]);

      expect(requested.map((batch) => batch.length), [
        referenceBatchLimit,
        35 - referenceBatchLimit,
      ]);
      expect(requested.expand((batch) => batch), refs);
      expect(resolved.keys, refs);
      expect(resolved[refs.last]!.title, 'T ${refs.last}');
      expect(await api.fetchReferences(const []), isEmpty);
      expect(requested, hasLength(2));
    });

    test(
      'serializes batches so a large fill-in uses one server budget at a time',
      () async {
        final requested = <List<String>>[];
        final first = Completer<void>();
        final client = MockClient((req) async {
          final body = jsonDecode(req.body) as Map<String, dynamic>;
          final refs = (body['refs'] as List<dynamic>).cast<String>();
          requested.add(refs);
          if (requested.length == 1) await first.future;
          return http.Response(
            jsonEncode({
              'references': {
                for (final ref in refs) ref: {'ref': ref, 'scheme': 'github'},
              },
            }),
            200,
          );
        });
        final api = DashboardApi(
          client: client,
          base: Uri.parse('http://localhost:3000'),
        );
        final refs = [for (var i = 1; i <= 21; i++) 'github:o/r/issues/$i'];

        final resolved = api.fetchReferences(refs);
        await Future<void>.delayed(Duration.zero);
        expect(requested, hasLength(1));

        first.complete();
        await resolved;
        expect(requested.map((batch) => batch.length), [20, 1]);
      },
    );
  });

  testWidgets(
    'the obligation detail paints before its references, then fills them in',
    (tester) async {
      final ob = makeObligation(
        'ob-a',
        intent: 'Cites an issue',
        externalRef: _claimed,
      );
      final gate = Completer<void>();
      final api = FakeApi()
        ..threadsResult = [makeThread('root')]
        ..obligationsResult = [ob]
        ..obligationDetails = {
          ob.id: ObligationDetailSnapshot(
            obligation: ob,
            children: const [],
            blockingChildren: const [],
            artifacts: const [ObligationArtifactDto(ref: _cited)],
          ),
        }
        ..referencesGate = gate
        ..referencesResult = {
          _cited: _issue(_cited, 'The cited bug'),
          _claimed: _issue(_claimed, 'The claimed issue'),
        };
      final store = DashboardStore(api: api, stream: FakeStream());
      await store.init();
      await tester.binding.setSurfaceSize(const Size(1400, 900));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: WorkTab(store: store, onSelectView: (_) {}),
          ),
        ),
      );
      await tester.pump();
      await tester.tap(find.text('Cites an issue'));
      await tester.pump();
      await tester.pump();

      // The pane is up from the detail alone, both references still loading
      // and neither shown as its raw key.
      expect(find.text('EXTERNAL LINK'), findsOneWidget);
      expect(find.text('ARTIFACTS'), findsOneWidget);
      expect(find.text('loading context'), findsNWidgets(2));
      expect(find.text(_cited), findsNothing);
      expect(api.referenceRequests, [
        unorderedEquals([_cited, _claimed]),
      ]);

      gate.complete();
      await tester.pump();
      await tester.pump();

      expect(find.text('loading context'), findsNothing);
      expect(find.text('The cited bug'), findsOneWidget);
      expect(find.text('The claimed issue'), findsOneWidget);
      // Resolved references are not asked for again, and the detail itself
      // was fetched once.
      await tester.pump(const Duration(seconds: 30));
      expect(api.referenceRequests, hasLength(1));
      expect(api.obligationDetailCallCount, 1);
      await tester.runAsync(store.dispose);
    },
  );

  testWidgets(
    'Recent Activity labels actors from the threads snapshot and fills in references after paint',
    (tester) async {
      await tester.runAsync(() async {
        const actor = '11111111-1111-4111-8111-111111111111';
        final gate = Completer<void>();
        final api = FakeApi()
          ..threadsResult = [
            makeThread(
              actor,
              modelConfig: const [
                ProviderModelConfig(
                  provider: 'claude',
                  model: 'claude-opus-4-6',
                  effort: 'high',
                ),
              ],
            ),
          ]
          ..recentActivityResult = [
            const RecentActivityItem(
              id: 'inbox_1',
              kind: 'handled_inbox',
              time: '2026-09-23T14:21:37.000Z',
              actorId: actor,
              sourceKind: 'GITHUB ISSUE',
              sourceRef: _cited,
              referenceKey: _cited,
              summary: 'issues.opened',
              handledTime: '2026-09-23T14:21:37.000Z',
              addressedNote: 'Triaged it',
            ),
          ]
          ..referencesGate = gate
          ..referencesResult = {_cited: _issue(_cited, 'The cited bug')};
        final store = DashboardStore(api: api, stream: FakeStream());
        await store.init();
        await tester.binding.setSurfaceSize(const Size(1500, 1400));
        addTearDown(() => tester.binding.setSurfaceSize(null));

        await tester.pumpWidget(
          MaterialApp(
            home: Scaffold(body: OverviewTab(store: store)),
          ),
        );
        await tester.pump();
        await tester.pump();

        expect(find.text('$actor-handle'), findsOneWidget);
        expect(find.text('claude-opus-4-6, high'), findsOneWidget);
        expect(find.textContaining('Triaged it'), findsOneWidget);
        expect(find.text('The cited bug'), findsNothing);
        expect(find.text(_cited), findsNothing);
        expect(api.referenceRequests, [
          [_cited],
        ]);

        gate.complete();
        await Future<void>.delayed(Duration.zero);
        await tester.pump();

        expect(find.text('The cited bug'), findsOneWidget);

        // A later refresh keeps the shown card preview while revalidating
        // in the background.
        api.referencesResult = {_cited: _issue(_cited, 'The updated bug title')};
        await store.refreshRecentActivity();
        await Future<void>.delayed(Duration.zero);
        await tester.pump();
        expect(find.text('The updated bug title'), findsOneWidget);
        expect(api.referenceRequests, hasLength(2));
        await store.dispose();
      });
    },
  );

  test('refreshRecentActivity generation check guards against out-of-order responses', () async {
    final completer1 = Completer<List<RecentActivityItem>>();
    final completer2 = Completer<List<RecentActivityItem>>();
    var callCount = 0;
    final client = MockClient((req) async {
      if (req.url.path == '/api/mesh/recent-activity') {
        callCount++;
        final items = callCount == 1
            ? await completer1.future
            : await completer2.future;
        return http.Response(
          jsonEncode({
            'items': items
                .map((i) => {
                  'id': i.id,
                  'kind': i.kind,
                  'time': i.time,
                  'actorId': i.actorId,
                  'referenceKey': i.referenceKey,
                })
                .toList(),
          }),
          200,
        );
      }
      return http.Response(jsonEncode({'references': {}}), 200);
    });
    final api = DashboardApi(client: client, base: Uri.parse('http://localhost:3000'));
    final store = DashboardStore(api: api, stream: FakeStream());
    await store.init();

    final f1 = store.refreshRecentActivity();
    final f2 = store.refreshRecentActivity();

    completer2.complete([
      const RecentActivityItem(
        id: 'inbox_2',
        kind: 'handled_inbox',
        time: '2026-09-23T14:22:00.000Z',
        actorId: 'actor-2',
        referenceKey: 'github:o/r/issues/2',
      ),
    ]);
    await f2;

    completer1.complete([
      const RecentActivityItem(
        id: 'inbox_1',
        kind: 'handled_inbox',
        time: '2026-09-23T14:21:00.000Z',
        actorId: 'actor-1',
        referenceKey: 'github:o/r/issues/1',
      ),
    ]);
    await f1;

    final items = await store.recentActivity.first;
    expect(items.map((i) => i.id), ['inbox_2']);
    await store.dispose();
  });

  test(
    'Recent Activity settles a reference request failure as unavailable',
    () async {
      final api = FakeApi()
        ..recentActivityResult = const [
          RecentActivityItem(
            id: 'inbox_1',
            kind: 'handled_inbox',
            time: '2026-09-23T14:21:37.000Z',
            actorId: 'actor-1',
            referenceKey: _cited,
          ),
        ]
        ..referencesError = StateError('offline');
      final store = DashboardStore(api: api, stream: FakeStream());

      await store.refreshRecentActivity();

      final item = store.recentActivity.value.single;
      expect(item.reference?.cacheState, 'unavailable');
      expect(item.reference?.unavailable, 'could not load context');
      await store.dispose();
    },
  );

  test('DashboardApi.fetchReferences posts a JSON ref batch', () async {
    http.Request? capturedRequest;
    final client = MockClient((req) async {
      if (req.url.path == '/api/mesh/references') {
        capturedRequest = req;
        return http.Response(
          jsonEncode({
            'references': {
              'github:o/r/issues/1': {
                'ref': 'github:o/r/issues/1',
                'scheme': 'github',
                'title': 'Test Issue',
                'cacheState': 'fresh',
              },
            },
          }),
          200,
        );
      }
      return http.Response('not found', 404);
    });
    final api = DashboardApi(
      client: client,
      base: Uri.parse('http://localhost:3000'),
    );
    final result = await api.fetchReferences(['github:o/r/issues/1']);

    expect(capturedRequest, isNotNull);
    expect(capturedRequest!.method, 'POST');
    expect(capturedRequest!.url.path, '/api/mesh/references');
    expect(jsonDecode(capturedRequest!.body), {
      'refs': ['github:o/r/issues/1'],
    });
    expect(result['github:o/r/issues/1']?.title, 'Test Issue');
  });
}
