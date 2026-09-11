import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rusa_dashboard/models.dart';
import 'package:rusa_dashboard/store.dart';
import 'package:rusa_dashboard/widgets/actor_tree.dart';
import 'package:rusa_dashboard/widgets/brand_mark.dart';
import 'package:rusa_dashboard/widgets/dashboard_body.dart';
import 'package:rusa_dashboard/widgets/detail_panel.dart';
import 'package:rusa_dashboard/widgets/header.dart';
import 'package:rusa_dashboard/widgets/mobile_nav_drawer.dart';
import 'package:rusa_dashboard/widgets/overview_tab.dart';

import 'fakes.dart';

// #403: on a phone the top navigation moves into a drawer behind a hamburger
// that takes the mesh icon's slot, quota rides the bottom of that drawer, a
// detail view swaps the hamburger for a back arrow instead of spending a row
// of its own on one, and a truly short viewport lands on the actor hierarchy.
//
// Same convention as widget_test.dart: the store does real async I/O and the
// dashboard runs repeating animations, so drive inside tester.runAsync and pump
// fixed durations rather than pumpAndSettle.

const _actorId = 'root';

QuotaSnapshotDto _quotaSnapshot() => const QuotaSnapshotDto(
  generatedAt: '2026-07-09T00:00:00.000Z',
  providers: [
    ProviderQuotaDto(
      provider: 'claude',
      status: 'available',
      usedPercent: 3,
      tier: null,
      message: null,
      windows: [
        QuotaWindowDto(
          id: 'weekly',
          label: 'Weekly',
          usedPercent: 3,
          status: 'available',
          headline: true,
          windowMs: 604800000,
        ),
      ],
    ),
  ],
);

/// Every provider the drawer can stack, each with both concentric rings — the
/// tallest the bottom quota slot ever gets.
QuotaSnapshotDto _fullQuotaSnapshot() => QuotaSnapshotDto(
  generatedAt: '2026-07-09T00:00:00.000Z',
  providers: [
    for (final provider in kDefaultQuotaProviders.keys)
      ProviderQuotaDto(
        provider: provider,
        status: 'available',
        usedPercent: 50,
        tier: null,
        message: null,
        windows: const [
          QuotaWindowDto(
            id: 'weekly',
            label: 'Weekly',
            usedPercent: 50,
            status: 'available',
            headline: true,
            windowMs: 604800000,
          ),
          QuotaWindowDto(
            id: 'session',
            label: 'Session',
            usedPercent: 20,
            status: 'available',
            headline: false,
            windowMs: 18000000,
          ),
          QuotaWindowDto(
            id: 'five_hour',
            label: '5h',
            usedPercent: 20,
            status: 'available',
            headline: false,
            windowMs: 18000000,
          ),
        ],
      ),
  ],
);

Future<DashboardStore> _store({QuotaSnapshotDto? quota}) async {
  final api = FakeApi()
    ..threadsResult = [makeThread(_actorId, created: 't0')]
    ..quotaResult = quota;
  final store = DashboardStore(api: api, stream: FakeStream());
  await store.init();
  if (quota != null) await store.refreshQuota();
  return store;
}

Widget _app(
  DashboardStore store, {
  required Size size,
  double textScale = 1.0,
}) => MaterialApp(
  home: MediaQuery(
    data: MediaQueryData(size: size, textScaler: TextScaler.linear(textScale)),
    child: Scaffold(body: DashboardBody(store: store)),
  ),
);

/// Pumps [_app] at [size] and lets the first frames settle.
Future<void> _pump(
  WidgetTester tester,
  DashboardStore store, {
  required Size size,
  double textScale = 1.0,
}) async {
  await tester.binding.setSurfaceSize(size);
  addTearDown(() => tester.binding.setSurfaceSize(null));
  await tester.pumpWidget(_app(store, size: size, textScale: textScale));
  await tester.pump(const Duration(milliseconds: 50));
}

/// Taps the hamburger and waits out the drawer's open animation.
Future<void> _openDrawer(WidgetTester tester) async {
  await tester.tap(find.byIcon(Icons.menu));
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 400));
}

void main() {
  testWidgets('a phone header carries a hamburger where the mesh icon sits, '
      'and the destinations move into its drawer', (tester) async {
    await tester.runAsync(() async {
      final store = await _store();
      await _pump(tester, store, size: const Size(390, 844));

      // The brand mark and the inline nav both give way to one leading action.
      expect(find.byIcon(Icons.menu), findsOneWidget);
      expect(find.byType(BrandMark), findsNothing);
      expect(find.text('Overview'), findsNothing);
      expect(find.text('IU'), findsNothing);
      expect(find.byType(MobileNavDrawer), findsNothing);

      await _openDrawer(tester);

      expect(find.byType(MobileNavDrawer), findsOneWidget);
      for (final label in ['Overview', 'Actors', 'Work', 'IU']) {
        expect(find.text(label), findsOneWidget);
      }
      // The brand mark keeps its place in the drawer it made room for.
      expect(find.byType(BrandMark), findsOneWidget);

      await store.dispose();
    });
  });

  testWidgets('a drawer destination switches the view and closes the drawer', (
    tester,
  ) async {
    await tester.runAsync(() async {
      final store = await _store();
      await _pump(tester, store, size: const Size(390, 844));
      expect(find.byType(OverviewTab), findsOneWidget);

      await _openDrawer(tester);
      await tester.tap(find.byKey(const ValueKey('drawer-nav-actors')));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 400));

      expect(find.byType(ActorTree), findsOneWidget);
      expect(find.byType(OverviewTab), findsNothing);
      // Drawer closed behind the choice, so the chosen view is what you see.
      expect(find.byKey(const ValueKey('drawer-nav-actors')), findsNothing);

      await store.dispose();
    });
  });

  testWidgets(
    'quota sits at the bottom of the drawer, below every destination',
    (tester) async {
      await tester.runAsync(() async {
        final store = await _store(quota: _quotaSnapshot());
        await _pump(tester, store, size: const Size(390, 844));

        // No quota in the phone header — it moved into the drawer.
        expect(find.text('Claude'), findsNothing);

        await _openDrawer(tester);

        expect(find.byKey(const ValueKey('drawer-quota')), findsOneWidget);
        final quotaTop = tester.getTopLeft(find.text('Claude')).dy;
        for (final view in ['overview', 'actors', 'work', 'understanding']) {
          expect(
            tester.getBottomLeft(find.byKey(ValueKey('drawer-nav-$view'))).dy,
            lessThan(quotaTop),
          );
        }

        await store.dispose();
      });
    },
  );

  testWidgets('a phone detail view swaps the hamburger for a back arrow and '
      'spends no extra row on it', (tester) async {
    await tester.runAsync(() async {
      final store = await _store();
      await _pump(tester, store, size: const Size(390, 844));

      await _openDrawer(tester);
      await tester.tap(find.byKey(const ValueKey('drawer-nav-actors')));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 400));

      store.clickActor(_actorId);
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 50));

      expect(find.byType(DetailPanel), findsOneWidget);
      expect(find.byIcon(Icons.arrow_back), findsOneWidget);
      expect(find.byIcon(Icons.menu), findsNothing);
      // The back arrow rides the header's own row: the detail starts where the
      // header ends, with no back bar wedged between them.
      final headerBottom = tester.getBottomLeft(find.byType(MeshHeader)).dy;
      expect(
        tester.getTopLeft(find.byType(DetailPanel)).dy,
        closeTo(headerBottom, 1),
      );
      expect(
        tester.getTopLeft(find.byIcon(Icons.arrow_back)).dy,
        lessThan(headerBottom),
      );

      await tester.tap(find.byIcon(Icons.arrow_back));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 50));

      // Back returns to the full-width list, hamburger and all.
      expect(find.byType(ActorTree), findsOneWidget);
      expect(find.byType(DetailPanel), findsNothing);
      expect(find.byIcon(Icons.menu), findsOneWidget);

      await store.dispose();
    });
  });

  testWidgets('a truly short viewport lands on the actor hierarchy', (
    tester,
  ) async {
    await tester.runAsync(() async {
      final store = await _store();
      // The full-screen walkie-talkie geometry: too short for the overview.
      await _pump(tester, store, size: const Size(640, 420));

      expect(find.byType(ActorTree), findsOneWidget);
      expect(find.byType(OverviewTab), findsNothing);

      await store.dispose();
    });
  });

  testWidgets('a tall phone still lands on the overview', (tester) async {
    await tester.runAsync(() async {
      final store = await _store();
      await _pump(tester, store, size: const Size(390, 844));

      expect(find.byType(OverviewTab), findsOneWidget);
      expect(find.byType(ActorTree), findsNothing);

      await store.dispose();
    });
  });

  testWidgets('the drawer fits a short, large-text viewport without overflow, '
      'quota still below every destination', (tester) async {
    await tester.runAsync(() async {
      // A landscape phone at accessibility text scale: the brand row, four
      // destinations and four providers' rings want more height than there is.
      final store = await _store(quota: _fullQuotaSnapshot());
      await _pump(tester, store, size: const Size(640, 300), textScale: 2.0);

      await _openDrawer(tester);

      expect(tester.takeException(), isNull);
      // The bottom slot is below the fold at this height, so it is reached by
      // scrolling the drawer rather than by overflowing it.
      await tester.drag(find.byType(MobileNavDrawer), const Offset(0, -400));
      await tester.pump();
      expect(tester.takeException(), isNull);
      expect(find.byKey(const ValueKey('drawer-quota')), findsOneWidget);
      final quotaTop = tester.getTopLeft(find.text('Claude')).dy;
      for (final view in ['overview', 'actors', 'work', 'understanding']) {
        expect(
          tester.getBottomLeft(find.byKey(ValueKey('drawer-nav-$view'))).dy,
          lessThan(quotaTop),
        );
      }

      await store.dispose();
    });
  });

  testWidgets('the phone leading action is a full-size touch target', (
    tester,
  ) async {
    await tester.runAsync(() async {
      final store = await _store();
      await _pump(tester, store, size: const Size(390, 844));

      expect(
        tester
            .getSize(
              find.ancestor(
                of: find.byIcon(Icons.menu),
                matching: find.byType(IconButton),
              ),
            )
            .shortestSide,
        greaterThanOrEqualTo(kMinInteractiveDimension),
      );

      await store.dispose();
    });
  });

  testWidgets('the desktop header keeps its brand mark, inline nav and quota', (
    tester,
  ) async {
    await tester.runAsync(() async {
      final store = await _store(quota: _quotaSnapshot());
      await _pump(tester, store, size: const Size(1360, 840));

      expect(find.byType(BrandMark), findsOneWidget);
      expect(find.byIcon(Icons.menu), findsNothing);
      expect(find.byType(Drawer), findsNothing);
      for (final label in ['Overview', 'Actors', 'Work', 'IU']) {
        expect(find.text(label), findsOneWidget);
      }
      expect(find.text('Claude'), findsOneWidget);

      await store.dispose();
    });
  });

  testWidgets('the desktop detail keeps its side-by-side layout, with no back '
      'affordance in the header', (tester) async {
    await tester.runAsync(() async {
      final store = await _store();
      await _pump(tester, store, size: const Size(1360, 840));
      await tester.tap(find.text('Actors'));
      await tester.pump();

      store.clickActor(_actorId);
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 50));

      // Tree and detail side by side, as before.
      expect(find.byType(ActorTree), findsOneWidget);
      expect(find.byType(DetailPanel), findsOneWidget);
      expect(find.byIcon(Icons.arrow_back), findsNothing);
      expect(find.byType(BrandMark), findsOneWidget);

      await store.dispose();
    });
  });

  group('landingViewFor', () {
    test('an unaddressed load on a truly short viewport lands on actors', () {
      expect(
        landingViewFor(urlNamedView: null, height: 420),
        DashboardView.actors,
      );
    });

    test('an unaddressed load with room lands on the overview', () {
      expect(
        landingViewFor(urlNamedView: null, height: 844),
        DashboardView.overview,
      );
    });

    test('an address that names a view wins at any height', () {
      // The branch the widget tests cannot reach: off the browser the URL
      // reader always returns null.
      for (final height in [420.0, 844.0]) {
        expect(
          landingViewFor(urlNamedView: DashboardView.work, height: height),
          DashboardView.work,
        );
      }
    });
  });
}
