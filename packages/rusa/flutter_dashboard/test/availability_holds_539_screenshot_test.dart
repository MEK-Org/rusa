// Screenshot harness for #539's availability holds on the header and quota
// rings, on synthetic fixtures: a provider-wide Codex hold an actor placed
// with the hold tools, and a chat `/halt` on the Fable model with an expiry.
// Their scopes differ, so the folded `halt` is null. The clear-all scenes add
// the global HALT brake and open the ✕'s confirmation (#1100). Run:
//
//   flutter test test/availability_holds_539_screenshot_test.dart
//
// It writes `screenshots/539_*_after.png`. The `before` images come from the
// same file run against staging with the `// after-only` lines and the
// `after-only:begin`/`:end` block removed and
// `--dart-define=SHOT_SUFFIX=before`: the same holds in force, which staging
// reported only as `halted`.
import 'dart:io';

import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rusa_dashboard/models.dart';
import 'package:rusa_dashboard/store.dart';
import 'package:rusa_dashboard/theme.dart';
import 'package:rusa_dashboard/widgets/header.dart';
import 'package:rusa_dashboard/widgets/mobile_nav_drawer.dart';

import 'fakes.dart';
import 'screenshot_support.dart';

final String _outDir = '${Directory.current.path}/screenshots';
const String _suffix = String.fromEnvironment(
  'SHOT_SUFFIX',
  defaultValue: 'after',
);

const _weekMs = 604800000;

String _iso(DateTime t) => t.toUtc().toIso8601String();

QuotaWindowDto _window(
  DateTime now, {
  required String id,
  required double used,
  required int windowMs,
  required Duration resetIn,
  List<String> modelIds = const [],
}) => QuotaWindowDto(
  id: id,
  label: id == 'weekly' ? 'Weekly' : 'Session',
  usedPercent: used,
  status: 'available',
  headline: id == 'weekly',
  windowMs: windowMs,
  resetAtIso: _iso(now.add(resetIn)),
  scrapedAt: _iso(now.subtract(const Duration(minutes: 4))),
  modelIds: modelIds,
);

QuotaSnapshotDto _quota(DateTime now) => QuotaSnapshotDto(
  generatedAt: _iso(now),
  providers: [
    ProviderQuotaDto(
      provider: 'claude',
      status: 'available',
      usedPercent: null,
      tier: null,
      message: null,
      windows: [
        _window(
          now,
          id: 'weekly',
          used: 38,
          windowMs: _weekMs,
          resetIn: const Duration(days: 4),
        ),
        _window(
          now,
          id: 'session',
          used: 22,
          windowMs: 18000000,
          resetIn: const Duration(hours: 3),
        ),
      ],
      modelWindows: [
        _window(
          now,
          id: 'weekly',
          used: 34,
          windowMs: _weekMs,
          resetIn: const Duration(days: 4),
          modelIds: const ['claude-fable-5-1'],
        ),
      ],
    ),
    ProviderQuotaDto(
      provider: 'codex',
      status: 'available',
      usedPercent: null,
      tier: null,
      message: null,
      windows: [
        _window(
          now,
          id: 'weekly',
          used: 47,
          windowMs: _weekMs,
          resetIn: const Duration(days: 2),
        ),
      ],
    ),
  ],
);

// after-only:begin
List<AvailabilityHoldDto> _holds(DateTime now) => [
  const AvailabilityHoldDto(
    provider: 'codex',
    origin: 'mesh',
    createdBy: 'root',
  ),
  AvailabilityHoldDto(
    provider: 'claude',
    model: 'claude-fable-5-1',
    origin: 'chat',
    expiry: _iso(now.add(const Duration(hours: 2))),
    createdBy: 'chat:operator',
  ),
];
// after-only:end

void main() {
  setUpAll(loadFonts);

  final now = DateTime.now();

  Future<void> scene(
    WidgetTester tester, {
    required String name,
    required Size size,
    bool drawer = false,
    bool brake = false,
    Future<void> Function()? reveal,
  }) async {
    final api = FakeApi()
      ..halted = true
      ..threadsResult = [
        makeThread('root', created: 't0').copyWith(handle: 'steward'),
      ]
      ..quotaResult = _quota(now);
    if (brake) api.halt = const HaltStatusDto(scope: 'global');
    api.availabilityHolds = _holds(now); // after-only
    if (brake) api.haltBrake = const HaltStatusDto(scope: 'global'); // after-only
    final store = DashboardStore(api: api, stream: FakeStream());
    await tester.runAsync(() async {
      await store.init();
      await store.refreshQuota();
    });

    await tester.binding.setSurfaceSize(size);
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final phone = size.width < 600;
    final scaffold = GlobalKey<ScaffoldState>();
    final key = GlobalKey();
    await tester.pumpWidget(
      RepaintBoundary(
        key: key,
        child: MaterialApp(
          debugShowCheckedModeBanner: false,
          theme: buildMeshTheme(),
          home: Scaffold(
            key: scaffold,
            backgroundColor: MeshColors.bgPrimary,
            drawer: drawer
                ? MobileNavDrawer(
                    store: store,
                    selected: DashboardView.overview,
                    onSelect: (_) {},
                  )
                : null,
            body: Align(
              alignment: Alignment.topCenter,
              child: MeshHeader(
                store: store,
                selected: DashboardView.overview,
                onSelect: (_) {},
                onMenuTap: phone ? () {} : null,
              ),
            ),
          ),
        ),
      ),
    );
    await tester.pump(const Duration(milliseconds: 250));
    if (drawer) {
      scaffold.currentState!.openDrawer();
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 400));
    }
    await reveal?.call();
    await tester.pump(const Duration(seconds: 1));
    expect(tester.takeException(), isNull);
    await tester.runAsync(
      () => captureBoundary(key, '$_outDir/539_${name}_$_suffix.png'),
    );
    await tester.runAsync(store.dispose);
  }

  Future<void> hover(WidgetTester tester, Finder target) async {
    final mouse = await tester.createGesture(kind: PointerDeviceKind.mouse);
    await mouse.addPointer(location: Offset.zero);
    addTearDown(mouse.removePointer);
    await mouse.moveTo(tester.getCenter(target));
    await tester.pump();
  }

  testWidgets('wide: hover on the halted badge', (tester) async {
    await scene(
      tester,
      name: 'badge_hover_wide',
      size: const Size(1400, 240),
      reveal: () => hover(tester, find.text('Halted')),
    );
  });

  testWidgets('wide: hover on the held Fable ring', (tester) async {
    await scene(
      tester,
      name: 'fable_ring_hover_wide',
      size: const Size(1400, 300),
      reveal: () => hover(tester, find.text('Fable')),
    );
  });

  testWidgets('phone: long-press on the halted badge', (tester) async {
    await scene(
      tester,
      name: 'badge_longpress_phone',
      size: const Size(390, 300),
      reveal: () async {
        await tester.longPress(find.byIcon(Icons.pause_circle_filled).first);
        await tester.pump();
      },
    );
  });

  Future<void> openClearAll(WidgetTester tester) async {
    await tester.tap(find.byKey(const ValueKey('halt-clear-all'))); // after-only
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
  }

  testWidgets('wide: the clear-all confirmation', (tester) async {
    await scene(
      tester,
      name: 'clear_all_confirm_wide',
      size: const Size(1400, 600),
      brake: true,
      reveal: () => openClearAll(tester),
    );
  });

  testWidgets('phone: the clear-all confirmation', (tester) async {
    await scene(
      tester,
      name: 'clear_all_confirm_phone',
      size: const Size(390, 700),
      brake: true,
      reveal: () => openClearAll(tester),
    );
  });

  testWidgets('phone: the drawer rings', (tester) async {
    await scene(
      tester,
      name: 'drawer_rings_phone',
      size: const Size(390, 700),
      drawer: true,
    );
  });
}
