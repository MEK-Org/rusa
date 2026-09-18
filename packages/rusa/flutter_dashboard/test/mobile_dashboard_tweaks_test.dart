import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rusa_dashboard/actor_hierarchy_cache.dart';
import 'package:rusa_dashboard/models.dart';
import 'package:rusa_dashboard/store.dart';
import 'package:rusa_dashboard/widgets/actor_tree.dart';
import 'package:rusa_dashboard/widgets/dashboard_body.dart';
import 'package:rusa_dashboard/widgets/detail_panel.dart';
import 'package:rusa_dashboard/widgets/header.dart';
import 'package:rusa_dashboard/widgets/mobile_nav_drawer.dart';

import 'fakes.dart';

// Issue #516: Mobile Dashboard Tweaks
// 1. In drawer: place user profile link ("Account") with avatar below a separator
//    under the quota indicators.
// 2. On actor view: remove "active hierarchy" label altogether (even on desktop).
// 3. On desktop: remove the label but keep the control row.
// 4. On mobile: remove the entire row from the tree and move the controls up into
//    the app-level actor header.

const _actorId = 'root';

QuotaSnapshotDto _quotaSnapshot() => const QuotaSnapshotDto(
  generatedAt: '2026-07-09T00:00:00.000Z',
  providers: [
    ProviderQuotaDto(
      provider: 'claude',
      status: 'available',
      usedPercent: 12,
      tier: null,
      message: null,
      windows: [
        QuotaWindowDto(
          id: 'weekly',
          label: 'Weekly',
          usedPercent: 12,
          status: 'available',
          headline: true,
          windowMs: 604800000,
        ),
      ],
    ),
  ],
);

Future<({DashboardStore store, FakeApi api})> _createStore({
  QuotaSnapshotDto? quota,
  RunState runState = RunState.idle,
}) async {
  final api = FakeApi()
    ..threadsResult = [makeThread(_actorId, created: 't0', runState: runState)]
    ..quotaResult = quota;
  final store = DashboardStore(api: api, stream: FakeStream());
  await store.init();
  if (quota != null) await store.refreshQuota();
  return (store: store, api: api);
}

Widget _app(
  DashboardStore store, {
  required Size size,
  VoidCallback? onLogout,
  String? profilePhotoUrl,
}) => MaterialApp(
  home: MediaQuery(
    data: MediaQueryData(size: size),
    child: Scaffold(
      body: DashboardBody(
        store: store,
        onLogout: onLogout,
        profilePhotoUrl: profilePhotoUrl,
      ),
    ),
  ),
);

Future<void> _pumpApp(
  WidgetTester tester,
  DashboardStore store, {
  required Size size,
  VoidCallback? onLogout,
  String? profilePhotoUrl,
}) async {
  await tester.binding.setSurfaceSize(size);
  addTearDown(() => tester.binding.setSurfaceSize(null));
  await tester.pumpWidget(
    _app(
      store,
      size: size,
      onLogout: onLogout,
      profilePhotoUrl: profilePhotoUrl,
    ),
  );
  await tester.pump(const Duration(milliseconds: 50));
}

Future<void> _openMobileDrawer(WidgetTester tester) async {
  await tester.tap(find.byIcon(Icons.menu));
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 400));
}

Future<void> _navigateToActorsOnMobile(WidgetTester tester) async {
  await _openMobileDrawer(tester);
  await tester.tap(find.byKey(const ValueKey('drawer-nav-actors')));
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 400));
}

void main() {
  group('Issue #516: Desktop layout', () {
    testWidgets(
      'desktop actor view removes Active hierarchy label but retains control row',
      (tester) async {
        await tester.runAsync(() async {
          final (:store, :api) = await _createStore();
          await _pumpApp(tester, store, size: const Size(1200, 800));

          // Navigate to Actors view if not already there
          await tester.tap(find.text('Actors'));
          await tester.pump();
          await tester.pump(const Duration(milliseconds: 50));

          // The "Active Hierarchy" label is completely removed
          expect(find.text('Active Hierarchy'), findsNothing);
          expect(find.text('Active Hierarchy · cached'), findsNothing);

          // The ActorTree retains the control row: Spawn actor button and Retired switch
          final tree = find.byType(ActorTree);
          expect(tree, findsOneWidget);
          expect(
            find.descendant(of: tree, matching: find.byTooltip('Spawn actor')),
            findsOneWidget,
          );
          expect(
            find.descendant(of: tree, matching: find.text('Retired')),
            findsOneWidget,
          );
          expect(
            find.descendant(of: tree, matching: find.byType(Switch)),
            findsOneWidget,
          );

          // Desktop header does NOT contain the relocated actor tree controls
          final header = find.byType(MeshHeader);
          expect(
            find.descendant(of: header, matching: find.byTooltip('Spawn actor')),
            findsNothing,
          );
          expect(
            find.descendant(of: header, matching: find.text('Retired')),
            findsNothing,
          );

          await store.dispose();
        });
      },
    );

    testWidgets(
      'desktop ActorTree controls can spawn an actor',
      (tester) async {
        await tester.runAsync(() async {
          final (:store, :api) = await _createStore();
          await _pumpApp(tester, store, size: const Size(1200, 800));

          await tester.tap(find.text('Actors'));
          await tester.pump(const Duration(milliseconds: 50));

          final tree = find.byType(ActorTree);
          await tester.tap(
            find.descendant(of: tree, matching: find.byTooltip('Spawn actor')),
          );
          await tester.pump(const Duration(milliseconds: 100));

          expect(find.text('Spawn actor'), findsOneWidget);
          await tester.enterText(
            find.widgetWithText(TextFormField, 'Charter'),
            'Desktop test charter',
          );
          await tester.tap(find.widgetWithText(FilledButton, 'Spawn'));
          await tester.pump(const Duration(milliseconds: 100));

          expect(api.rootSpawnCalls.single.charter, 'Desktop test charter');

          await store.dispose();
        });
      },
    );
  });

  group('Issue #516: Mobile layout actor controls relocation', () {
    testWidgets(
      'mobile actor view removes the control row from ActorTree and relocates controls to header',
      (tester) async {
        await tester.runAsync(() async {
          final (:store, :api) = await _createStore();
          await _pumpApp(tester, store, size: const Size(390, 844));
          await _navigateToActorsOnMobile(tester);

          // In mobile ActorTree, the entire control row and label are gone
          final tree = find.byType(ActorTree);
          expect(tree, findsOneWidget);
          expect(find.text('Active Hierarchy'), findsNothing);
          expect(
            find.descendant(of: tree, matching: find.byTooltip('Spawn actor')),
            findsNothing,
          );
          expect(
            find.descendant(of: tree, matching: find.text('Retired')),
            findsNothing,
          );
          expect(
            find.descendant(of: tree, matching: find.byType(Switch)),
            findsNothing,
          );

          // Instead, controls are in the app-level header
          final header = find.byType(MeshHeader);
          expect(
            find.descendant(of: header, matching: find.byTooltip('Spawn actor')),
            findsOneWidget,
          );
          expect(
            find.descendant(of: header, matching: find.byTooltip('Show retired actors')),
            findsOneWidget,
          );
          expect(
            find.descendant(of: header, matching: find.byType(Switch)),
            findsOneWidget,
          );

          await store.dispose();
        });
      },
    );

    testWidgets(
      'mobile header controls can spawn an actor and toggle retired',
      (tester) async {
        await tester.runAsync(() async {
          final (:store, :api) = await _createStore();
          await _pumpApp(tester, store, size: const Size(390, 844));
          await _navigateToActorsOnMobile(tester);

          final header = find.byType(MeshHeader);

          // Toggle retired switch in header
          expect(store.showRetired.value, isFalse);
          final retiredSwitch = find.descendant(
            of: header,
            matching: find.byType(Switch),
          );
          await tester.tap(retiredSwitch);
          await tester.pump(const Duration(milliseconds: 50));
          expect(store.showRetired.value, isTrue);

          // Spawn an actor via header button
          final spawnBtn = find.descendant(
            of: header,
            matching: find.byTooltip('Spawn actor'),
          );
          await tester.tap(spawnBtn);
          await tester.pump(const Duration(milliseconds: 100));

          expect(find.text('Spawn actor'), findsOneWidget);
          await tester.enterText(
            find.widgetWithText(TextFormField, 'Charter'),
            'Mobile test charter',
          );
          await tester.tap(find.widgetWithText(FilledButton, 'Spawn'));
          await tester.pump(const Duration(milliseconds: 100));

          expect(api.rootSpawnCalls.single.charter, 'Mobile test charter');

          await store.dispose();
        });
      },
    );

    testWidgets(
      'mobile header does NOT show actor tree controls on Overview or in actor detail',
      (tester) async {
        await tester.runAsync(() async {
          final (:store, :api) = await _createStore();
          await _pumpApp(tester, store, size: const Size(390, 844));

          // On Overview page: no actor tree controls in header
          final header = find.byType(MeshHeader);
          expect(
            find.descendant(of: header, matching: find.byTooltip('Spawn actor')),
            findsNothing,
          );
          expect(
            find.descendant(of: header, matching: find.text('Retired')),
            findsNothing,
          );

          // Navigate to Actors, then open actor detail
          await _navigateToActorsOnMobile(tester);
          expect(
            find.descendant(of: header, matching: find.byTooltip('Spawn actor')),
            findsOneWidget,
          );

          store.clickActor(_actorId);
          await tester.pump();
          await tester.pump(const Duration(milliseconds: 50));

          // Inside actor detail: replaced with back button + detail actions
          expect(find.byType(DetailPanel), findsOneWidget);
          expect(
            find.descendant(of: header, matching: find.byTooltip('Spawn actor')),
            findsNothing,
          );
          expect(
            find.descendant(of: header, matching: find.text('Retired')),
            findsNothing,
          );
          expect(find.byTooltip('Back'), findsOneWidget);

          await store.dispose();
        });
      },
    );
  });

  group('Issue #516: Mobile drawer Account profile row', () {
    testWidgets(
      'drawer renders Account profile row below a separator under quota indicators',
      (tester) async {
        await tester.runAsync(() async {
          var loggedOut = false;
          final (:store, :api) = await _createStore(quota: _quotaSnapshot());
          await _pumpApp(
            tester,
            store,
            size: const Size(390, 844),
            onLogout: () => loggedOut = true,
            profilePhotoUrl: 'https://example.com/avatar.png',
          );

          await _openMobileDrawer(tester);

          final drawer = find.byType(MobileNavDrawer);
          expect(drawer, findsOneWidget);

          // Quota indicators and Account row both exist
          final quotaFinder = find.byKey(const ValueKey('drawer-quota'));
          final accountFinder = find.byKey(const ValueKey('drawer-account'));
          expect(quotaFinder, findsOneWidget);
          expect(accountFinder, findsOneWidget);

          // Label "Account" is visible
          expect(
            find.descendant(of: drawer, matching: find.text('Account')),
            findsOneWidget,
          );

          // Account row is below the quota indicators
          final quotaBottom = tester.getBottomLeft(quotaFinder).dy;
          final accountTop = tester.getTopLeft(accountFinder).dy;
          expect(accountTop, greaterThanOrEqualTo(quotaBottom));

          // There is a separator (Divider) between quota and Account
          final dividers = find.descendant(
            of: drawer,
            matching: find.byType(Divider),
          );
          expect(dividers, findsAtLeastNWidgets(2));

          // Tapping Account opens popup menu with 'Log out'
          expect(find.text('Log out'), findsNothing);
          await tester.tap(accountFinder);
          await tester.pumpAndSettle();

          expect(find.text('Log out'), findsOneWidget);
          expect(loggedOut, isFalse);

          await tester.tap(find.text('Log out'));
          await tester.pumpAndSettle();
          expect(loggedOut, isTrue);

          await store.dispose();
        });
      },
    );

    testWidgets(
      'drawer renders Account profile row even when quota is null',
      (tester) async {
        await tester.runAsync(() async {
          final api = FakeApi()
            ..threadsResult = [makeThread(_actorId, created: 't0')]
            ..quotaError = Exception('quota unavailable');
          final store = DashboardStore(api: api, stream: FakeStream());
          await store.init();
          await _pumpApp(
            tester,
            store,
            size: const Size(390, 844),
            onLogout: () {},
          );

          await _openMobileDrawer(tester);

          final drawer = find.byType(MobileNavDrawer);
          expect(find.byKey(const ValueKey('drawer-quota')), findsNothing);
          expect(find.byKey(const ValueKey('drawer-account')), findsOneWidget);
          expect(
            find.descendant(of: drawer, matching: find.text('Account')),
            findsOneWidget,
          );

          // Fallback avatar icon is used when profilePhotoUrl is null
          expect(
            find.descendant(
              of: drawer,
              matching: find.byIcon(Icons.person_outline),
            ),
            findsOneWidget,
          );

          await store.dispose();
        });
      },
    );

    testWidgets(
      'drawer hides Account profile row when auth is disabled (onLogout is null)',
      (tester) async {
        await tester.runAsync(() async {
          final (:store, :api) = await _createStore(quota: _quotaSnapshot());
          await _pumpApp(
            tester,
            store,
            size: const Size(390, 844),
            onLogout: null,
          );

          await _openMobileDrawer(tester);

          final drawer = find.byType(MobileNavDrawer);
          expect(find.byKey(const ValueKey('drawer-quota')), findsOneWidget);
          expect(find.byKey(const ValueKey('drawer-account')), findsNothing);
          expect(
            find.descendant(of: drawer, matching: find.text('Account')),
            findsNothing,
          );

          await store.dispose();
        });
      },
    );
  });

  group('Issue #516 review refinements: Touch targets, discoverability, cache signal', () {
    testWidgets(
      'mobile header controls preserve usable Material touch targets (>= 48x48) and discoverable label',
      (tester) async {
        await tester.runAsync(() async {
          final (:store, :api) = await _createStore();
          await _pumpApp(
            tester,
            store,
            size: const Size(390, 844),
            onLogout: () {},
          );
          await _navigateToActorsOnMobile(tester);

          final header = find.byType(MeshHeader);

          // 1. Mobile header omits ProfileMenu to avoid duplicating drawer Account row
          expect(
            find.descendant(of: header, matching: find.byType(ProfileMenu)),
            findsNothing,
          );

          // 2. Discoverable "Retired" label is visible on mobile
          final retiredLabel = find.descendant(
            of: header,
            matching: find.text('Retired'),
          );
          expect(retiredLabel, findsOneWidget);

          // 3. Tapping the "Retired" label itself toggles the retired state
          expect(store.showRetired.value, isFalse);
          await tester.tap(retiredLabel);
          await tester.pump(const Duration(milliseconds: 50));
          expect(store.showRetired.value, isTrue);

          // 4. Spawn button touch target is at least 48x48
          final spawnBtn = find.descendant(
            of: header,
            matching: find.byTooltip('Spawn actor'),
          );
          expect(spawnBtn, findsOneWidget);
          final spawnSize = tester.getSize(spawnBtn);
          expect(spawnSize.width, greaterThanOrEqualTo(48.0));
          expect(spawnSize.height, greaterThanOrEqualTo(48.0));

          // 5. Switch touch target is at least 48x48
          final switchFinder = find.descendant(
            of: header,
            matching: find.byType(Switch),
          );
          expect(switchFinder, findsOneWidget);
          final switchSize = tester.getSize(switchFinder);
          expect(switchSize.width, greaterThanOrEqualTo(48.0));
          expect(switchSize.height, greaterThanOrEqualTo(48.0));

          await store.dispose();
        });
      },
    );

    testWidgets(
      'cached hierarchy freshness signal displays when actorsStale is true and hides when synced',
      (tester) async {
        await tester.runAsync(() async {
          final now = DateTime.timestamp();
          final scope = DashboardStore.cacheScopeFor(Uri.base);
          final cache = FakeActorHierarchyCache(
            PersistedActorHierarchy.capture(
              scope: scope,
              threads: [makeThread(_actorId, created: 't0')],
              now: now,
            ),
          );

          final gate = Completer<ThreadsSnapshot>();
          final api = FakeApi()
            ..threadSnapshotGates.add(gate)
            ..threadsResult = [makeThread(_actorId, created: 't0')];
          final store = DashboardStore(
            api: api,
            stream: FakeStream(),
            actorHierarchyCache: cache,
          );

          // Restored from cache before fetch completes -> actorsStale is true
          expect(store.actorsStale.value, isTrue);

          // 1. Desktop: CachedHierarchyBadge is shown in ActorTree header
          await _pumpApp(tester, store, size: const Size(1200, 800));
          await tester.tap(find.text('Actors'));
          await tester.pump();
          await tester.pump(const Duration(milliseconds: 50));

          expect(find.text('Active Hierarchy'), findsNothing);
          expect(find.text('Active Hierarchy · cached'), findsNothing);
          expect(find.byType(CachedHierarchyBadge), findsOneWidget);
          expect(find.text('cached'), findsOneWidget);

          // 2. Mobile: CachedHierarchyBadge is shown in MeshHeader
          await _pumpApp(tester, store, size: const Size(390, 844));
          await _navigateToActorsOnMobile(tester);

          final header = find.byType(MeshHeader);
          expect(
            find.descendant(
              of: header,
              matching: find.byType(CachedHierarchyBadge),
            ),
            findsOneWidget,
          );
          expect(
            find.descendant(of: header, matching: find.text('cached')),
            findsOneWidget,
          );

          // 3. Complete authoritative sync -> actorsStale becomes false
          final booting = store.init();
          gate.complete(
            ThreadsSnapshot(
              halted: false,
              threads: [makeThread(_actorId, created: 't0')],
            ),
          );
          await booting;
          await pumpEventQueue();
          expect(store.actorsStale.value, isFalse);

          await tester.pump();
          await tester.pump(const Duration(milliseconds: 50));

          // Freshness badge disappears from mobile header
          expect(
            find.descendant(
              of: header,
              matching: find.byType(CachedHierarchyBadge),
            ),
            findsNothing,
          );

          await store.dispose();
        });
      },
    );

    testWidgets(
      'ultra-compact mobile (320px) retains full touch targets without overflow under halted state',
      (tester) async {
        await tester.runAsync(() async {
          final api = FakeApi()
            ..halted = true
            ..threadsResult = [makeThread(_actorId, created: 't0')];
          final store = DashboardStore(api: api, stream: FakeStream());
          await store.init();

          await tester.binding.setSurfaceSize(const Size(320, 568));
          addTearDown(() => tester.binding.setSurfaceSize(null));

          await tester.pumpWidget(
            MaterialApp(
              home: Scaffold(
                body: SizedBox(
                  width: 320,
                  child: MeshHeader(
                    store: store,
                    selected: DashboardView.actors,
                    onSelect: (_) {},
                    onMenuTap: () {},
                  ),
                ),
              ),
            ),
          );
          await tester.pump(const Duration(milliseconds: 50));

          final header = find.byType(MeshHeader);
          expect(tester.takeException(), isNull);

          final spawnBtn = find.descendant(
            of: header,
            matching: find.byTooltip('Spawn actor'),
          );
          expect(spawnBtn, findsOneWidget);
          final spawnSize = tester.getSize(spawnBtn);
          expect(spawnSize.width, greaterThanOrEqualTo(48.0));
          expect(spawnSize.height, greaterThanOrEqualTo(48.0));

          final switchFinder = find.descendant(
            of: header,
            matching: find.byType(Switch),
          );
          expect(switchFinder, findsOneWidget);
          final switchSize = tester.getSize(switchFinder);
          expect(switchSize.width, greaterThanOrEqualTo(48.0));
          expect(switchSize.height, greaterThanOrEqualTo(48.0));

          await store.dispose();
        });
      },
    );
  });
}
