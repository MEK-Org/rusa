// First-actor bootstrap on an empty mesh (#1260).
//
// The dashboard mounts FirstActorBootstrap below every view in DashboardBody.
// Once the first authoritative actor snapshot has landed and the mesh has no
// actors at all, the shared spawn dialog is offered with the first-actor
// framing; creating the actor goes through the ordinary spawn path
// (store.spawnRootChild → POST /api/mesh/actors). A non-empty mesh never sees
// the modal, and a mesh that empties after actors existed offers it again.

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rusa_dashboard/dashboard_url.dart';
import 'package:rusa_dashboard/store.dart';
import 'package:rusa_dashboard/theme.dart';
import 'package:rusa_dashboard/widgets/dashboard_body.dart';

import 'fakes.dart';

Widget _harness(DashboardStore store) => MaterialApp(
  debugShowCheckedModeBanner: false,
  theme: buildMeshTheme(),
  home: Scaffold(
    body: DashboardBody(
      store: store,
      understandingBuilder: (_) => const SizedBox(),
      reportsBuilder: (_) => const SizedBox(),
    ),
  ),
);

Future<DashboardStore> _startedStore(FakeApi api) async {
  final store = DashboardStore(api: api, stream: FakeStream());
  addTearDown(store.dispose);
  await store.init();
  return store;
}

void main() {
  setUp(() {
    debugDashboardUrl = null;
  });

  testWidgets(
    'empty mesh offers the first-actor modal and submitting creates the actor',
    (tester) async {
      await tester.runAsync(() async {
        final api = FakeApi()..rootControlProviders = ['agy', 'codex'];
        final store = await _startedStore(api);

        await tester.pumpWidget(_harness(store));
        await tester.pump(const Duration(milliseconds: 100));

        expect(find.text('Create your first actor'), findsOneWidget);
        expect(
          find.textContaining("This mesh doesn't have any actors yet"),
          findsOneWidget,
        );

        await tester.enterText(
          find.widgetWithText(TextFormField, 'Charter'),
          'Bootstrap the mesh',
        );
        await tester.enterText(
          find.widgetWithText(TextFormField, 'Title'),
          'First actor',
        );
        await tester.tap(find.widgetWithText(FilledButton, 'Create'));
        await tester.pump(const Duration(milliseconds: 100));
        await tester.pump(const Duration(milliseconds: 100));

        expect(api.rootSpawnCalls.single, (
          charter: 'Bootstrap the mesh',
          title: 'First actor',
          provider: 'agy',
          model: null,
        ));
        expect(find.text('Create your first actor'), findsNothing);
        expect(store.primary.value, 'spawned-child');
      });
    },
  );

  testWidgets('a non-empty mesh never sees the modal', (tester) async {
    await tester.runAsync(() async {
      final api = FakeApi()
        ..threadsResult = [makeThread('actor-1', created: 't0')];
      final store = await _startedStore(api);

      await tester.pumpWidget(_harness(store));
      await tester.pump(const Duration(milliseconds: 100));
      await tester.pump(const Duration(milliseconds: 300));

      expect(find.text('Create your first actor'), findsNothing);
      // The tree is not the landing view here; the invariant is simply that
      // no first-actor dialog ever appears for a non-empty mesh.
      expect(store.actorStates.value.actors, isNotEmpty);
    });
  });

  testWidgets('the modal does not flash before the first snapshot lands', (
    tester,
  ) async {
    await tester.runAsync(() async {
      final api = FakeApi();
      // No store.init(): the authoritative snapshot never lands, so an empty
      // actor list is "not loaded yet", not an empty mesh.
      final store = DashboardStore(api: api, stream: FakeStream());
      addTearDown(store.dispose);

      await tester.pumpWidget(_harness(store));
      await tester.pump(const Duration(milliseconds: 100));
      await tester.pump(const Duration(milliseconds: 300));

      expect(find.text('Create your first actor'), findsNothing);
    });
  });

  testWidgets(
    'cancelling dismisses the modal until actors exist, and an emptied mesh is offered again',
    (tester) async {
      await tester.runAsync(() async {
        final api = FakeApi();
        final store = await _startedStore(api);

        await tester.pumpWidget(_harness(store));
        await tester.pump(const Duration(milliseconds: 100));
        expect(find.text('Create your first actor'), findsOneWidget);

        await tester.tap(find.widgetWithText(TextButton, 'Cancel'));
        await tester.pump(const Duration(milliseconds: 100));
        expect(find.text('Create your first actor'), findsNothing);

        // The mesh is still empty, but the dismissal holds: no re-offer.
        await tester.pump(const Duration(milliseconds: 300));
        expect(find.text('Create your first actor'), findsNothing);

        // An actor appears (e.g. created elsewhere) and is then retired:
        // the gate re-arms and the emptied mesh is offered again.
        api.threadsResult = [makeThread('actor-1', created: 't0')];
        await store.refreshThreads();
        await tester.pump(const Duration(milliseconds: 100));
        expect(find.text('Create your first actor'), findsNothing);

        api.threadsResult = [];
        await store.refreshThreads();
        // The offer runs on the store's async stream delivery; give the real
        // async zone a second turn before expecting the dialog.
        await tester.pump(const Duration(milliseconds: 100));
        await tester.pump(const Duration(milliseconds: 100));
        expect(find.text('Create your first actor'), findsOneWidget);
      });
    },
  );

  testWidgets('a retired-only mesh counts as non-empty and sees no modal', (
    tester,
  ) async {
    await tester.runAsync(() async {
      final api = FakeApi()
        ..threadsResult = [
          makeThread('retired-1', status: 'retired', created: 't0'),
        ];
      final store = await _startedStore(api);

      await tester.pumpWidget(_harness(store));
      await tester.pump(const Duration(milliseconds: 100));
      await tester.pump(const Duration(milliseconds: 300));

      expect(find.text('Create your first actor'), findsNothing);
    });
  });
}
