// #940: the obligation detail and Recent Activity answer with ref keys and
// actor ids alone. The client paints from that, then resolves the keys through
// `POST /api/mesh/references` and fills the references in as they arrive;
// actors are labelled from the threads snapshot.

import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/scheduler.dart';
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
  test('DashboardApi.fetchReferences asks for each ref once, one batch at a '
      'time, and keeps earlier answers when a later batch fails', () async {
    final requested = <List<String>>[];
    final first = Completer<void>();
    final client = MockClient((req) async {
      expect(req.url.path, '/api/mesh/references');
      expect(req.method, 'POST');
      final body = jsonDecode(req.body) as Map<String, dynamic>;
      final refs = (body['refs'] as List<dynamic>).cast<String>();
      requested.add(refs);
      if (requested.length == 1) await first.future;
      if (requested.length > 1) return http.Response('offline', 503);
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

    final resolved = api.fetchReferences([...refs, refs.first]);
    await Future<void>.delayed(Duration.zero);
    // One server budget at a time: the second batch waits for the first.
    expect(requested, hasLength(1));
    first.complete();

    try {
      await resolved;
      fail('expected a partial batch failure');
    } on PartialReferenceFetchException catch (error) {
      expect(error.resolved.keys, refs.take(referenceBatchLimit));
      expect(error.unresolved, {refs.last});
    }
    expect(requested.map((batch) => batch.length), [referenceBatchLimit, 1]);
    expect(requested.expand((batch) => batch), refs);
    expect(await api.fetchReferences(const []), isEmpty);
    expect(requested, hasLength(2));
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
        SchedulerPhase? fetchPhase;
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
          ..onFetchReferences = () {
            fetchPhase = SchedulerBinding.instance.schedulerPhase;
          }
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

        expect(fetchPhase, SchedulerPhase.postFrameCallbacks);
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
        api.referencesResult = {
          _cited: _issue(_cited, 'The updated bug title'),
        };
        await store.refreshRecentActivity();
        await tester.pump();
        await Future<void>.delayed(Duration.zero);
        await tester.pump();
        expect(find.text('The updated bug title'), findsOneWidget);
        expect(api.referenceRequests, hasLength(2));
        await store.dispose();
      });
    },
  );

  testWidgets(
    'Recent Activity asks for a frame and resolves once for refreshes made '
    'while Overview is not mounted',
    (tester) async {
      await tester.runAsync(() async {
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
          ..referencesResult = {_cited: _issue(_cited, 'The cited bug')};
        final store = DashboardStore(api: api, stream: FakeStream());
        await tester.pumpWidget(const SizedBox());

        await store.refreshRecentActivity();
        await store.refreshRecentActivity();
        // Nothing on screen listens to the feed, so only the store's own
        // request schedules the frame its fill waits for.
        expect(tester.binding.hasScheduledFrame, isTrue);
        expect(api.referenceRequests, isEmpty);

        await tester.pump();
        await Future<void>.delayed(Duration.zero);
        expect(api.referenceRequests, [
          [_cited],
        ]);
        expect(
          store.recentActivity.value.single.reference?.title,
          'The cited bug',
        );
        await store.dispose();
      });
    },
  );

  test(
    'Recent Activity replaces a pending placeholder after a later transport failure',
    () async {
      final pending = ReferenceDto.loading(_cited);
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
        ..referencesResult = {_cited: pending};
      final store = DashboardStore(api: api, stream: FakeStream());

      await store.refreshRecentActivity(deferUntilPostFrame: false);
      expect(
        store.recentActivity.value.single.reference?.cacheState,
        'pending',
      );

      api.referencesError = StateError('offline');
      await store.refreshRecentActivity(deferUntilPostFrame: false);
      final item = store.recentActivity.value.single;
      expect(item.reference?.cacheState, 'unavailable');
      expect(item.reference?.unavailable, 'could not load context');
      await store.dispose();
    },
  );

  test(
    'a stale feed, reference answer or failure never replaces a newer refresh',
    () async {
      const current = RecentActivityItem(
        id: 'inbox_1',
        kind: 'handled_inbox',
        time: '2026-09-23T14:21:37.000Z',
        actorId: 'actor-1',
        referenceKey: _cited,
      );
      const obsolete = ReferenceDto(
        ref: _cited,
        scheme: 'github',
        title: 'Obsolete title',
        cacheState: 'fresh',
      );
      final staleFeed = Completer<void>();
      final staleAnswer = Completer<void>();
      final staleFailure = Completer<void>();
      final revalidation = Completer<void>();
      final api = FakeApi()
        ..recentActivityResult = const [current]
        ..scriptedRecentActivity.add(() async {
          await staleFeed.future;
          return const [
            RecentActivityItem(
              id: 'inbox_old',
              kind: 'handled_inbox',
              time: '2026-09-23T14:20:00.000Z',
              actorId: 'actor-1',
            ),
          ];
        })
        ..scriptedReferenceResponses.addAll([
          (_) async {
            await staleAnswer.future;
            return {_cited: obsolete};
          },
          (_) async {
            await staleFailure.future;
            throw const PartialReferenceFetchException(
              resolved: {_cited: obsolete},
              unresolved: {},
            );
          },
          (_) => {_cited: _issue(_cited, 'Current title')},
          (_) async {
            await revalidation.future;
            return {_cited: _issue(_cited, 'Revalidated title')};
          },
        ]);
      final store = DashboardStore(api: api, stream: FakeStream());

      // Each refresh reaches its own scripted answer before the next starts.
      final pending = <Future<void>>[];
      for (var i = 0; i < 3; i++) {
        pending.add(store.refreshRecentActivity(deferUntilPostFrame: false));
        await Future<void>.delayed(Duration.zero);
      }
      await store.refreshRecentActivity(deferUntilPostFrame: false);
      staleFeed.complete();
      staleAnswer.complete();
      staleFailure.complete();
      await Future.wait(pending);

      final item = store.recentActivity.value.single;
      expect(item.id, 'inbox_1');
      expect(item.reference?.title, 'Current title');

      // A later refresh paints from the cache while it revalidates, so a
      // stale answer that reached the cache would show here.
      final refresh = store.refreshRecentActivity(deferUntilPostFrame: false);
      await Future<void>.delayed(Duration.zero);
      expect(
        store.recentActivity.value.single.reference?.title,
        'Current title',
      );
      revalidation.complete();
      await refresh;
      expect(
        store.recentActivity.value.single.reference?.title,
        'Revalidated title',
      );
      await store.dispose();
    },
  );
}
