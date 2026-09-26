// Screenshot harness (ISSUE_NUM item 1).
//
// A repeatable, headless way to render the real dashboard widgets to PNG with
// seeded fake actors — no live mesh, no API, no network. Run it with:
//
//   flutter test test/screenshots_test.dart
//
// and it writes PNGs under `flutter_dashboard/screenshots/`, which are committed
// and embedded in PRs so visual changes get before/after images. It is also the
// validation for the visual items (enlarged detail avatar, true-circle avatars,
// charter-in-its-own-tab, coalesced run rows).
//
// Rendering notes:
//  • Real fonts (Roboto + Material Icons) are loaded from the Flutter SDK cache
//    so text/icons are legible instead of the test renderer's placeholder boxes.
//  • Avatars are `Image.network`; an HttpOverrides shim serves a per-actor
//    portrait PNG (a non-square gradient) so the circular clip / BoxFit.cover
//    fill is demonstrated with real pixels.
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rusa_dashboard/models.dart';
import 'package:rusa_dashboard/store.dart';
import 'package:rusa_dashboard/theme.dart';
import 'package:rusa_dashboard/widgets/actor_tree.dart';
import 'package:rusa_dashboard/widgets/avatar.dart';
import 'package:rusa_dashboard/widgets/dashboard_body.dart';
import 'package:rusa_dashboard/widgets/detail_panel.dart';
import 'package:rusa_dashboard/widgets/inbox_tab.dart';
import 'package:rusa_dashboard/widgets/mobile_nav_drawer.dart';
import 'package:rusa_dashboard/widgets/overview_tab.dart';
import 'package:rusa_dashboard/widgets/quota_history_chart.dart';

import 'fakes.dart';
import 'screenshot_support.dart';

final String _outDir = '${Directory.current.path}/screenshots';

void main() {
  setUpAll(() async {
    await loadFonts();
  });

  testWidgets(
    'renders overview queue and quota columns wide and stacked narrow',
    (tester) async {
      await tester.runAsync(() async {
        final api = FakeApi()
          ..obligationsResult = [
            makeObligation(
              'overview-ready',
              ownerId: 'human:operator',
              intent: 'Review deployment checklist',
            ),
          ]
          ..quotaHistoryResult = _overviewQuotaHistory();
        final store = DashboardStore(api: api, stream: FakeStream());
        await store.init();
        addTearDown(store.dispose);
        addTearDown(() => tester.binding.setSurfaceSize(null));

        final key = GlobalKey();
        await tester.binding.setSurfaceSize(const Size(1200, 900));
        await tester.pumpWidget(
          _app(store, key, dashboardKey: const ValueKey('wide-overview')),
        );
        await tester.pump();
        await tester.pump();

        expect(find.byType(OverviewTab), findsOneWidget);
        await captureBoundary(key, '$_outDir/overview_columns_wide.png');

        await tester.binding.setSurfaceSize(const Size(390, 844));
        await tester.pumpWidget(
          _app(store, key, dashboardKey: const ValueKey('narrow-overview')),
        );
        await tester.pump();
        await tester.pump();

        expect(find.byType(OverviewTab), findsOneWidget);
        expect(find.text('Review deployment checklist'), findsOneWidget);
        await captureBoundary(key, '$_outDir/overview_columns_narrow.png');
        expect(tester.takeException(), isNull);
      });
    },
  );

  testWidgets('renders the quota plots with a null-controller model series', (
    tester,
  ) async {
    await tester.runAsync(() async {
      await tester.binding.setSurfaceSize(const Size(900, 980));
      addTearDown(() => tester.binding.setSurfaceSize(null));

      final key = GlobalKey();
      await tester.pumpWidget(
        MaterialApp(
          debugShowCheckedModeBanner: false,
          theme: buildMeshTheme(),
          home: Scaffold(
            body: RepaintBoundary(
              key: key,
              child: ColoredBox(
                color: MeshColors.bgSecondary,
                child: Padding(
                  padding: const EdgeInsets.all(16),
                  child: QuotaHistoryChart(history: _overviewQuotaHistory()),
                ),
              ),
            ),
          ),
        ),
      );
      await tester.pump();

      expect(find.text('Quota Remaining'), findsOneWidget);
      await captureBoundary(key, '$_outDir/quota_history_remaining.png');
      expect(tester.takeException(), isNull);
    });
  });

  testWidgets(
    'renders the dashboard overview (tree + detail + coalesced events)',
    (tester) async {
      await tester.runAsync(() async {
        final ids = _seedIds();
        HttpOverrides.global = FakeImageHttpOverrides(await portraits(ids));
        addTearDown(() => HttpOverrides.global = null);

        final api = FakeApi()
          ..threadsResult = _seedThreads()
          ..eventPages = [EventPage(events: _seedEvents(), nextCursor: null)];
        final store = DashboardStore(api: api, stream: FakeStream());
        await store.init();
        // Select a worker so the detail panel shows the enlarged avatar + tabs.
        store.clickActor('11111111-1111-4111-8111-111111111111');

        await tester.binding.setSurfaceSize(const Size(1360, 840));
        addTearDown(() => tester.binding.setSurfaceSize(null));

        final key = GlobalKey();
        await tester.pumpWidget(_app(store, key));
        // Overview is the default landing view now; switch to Actors for the
        // master-detail + Info-tab captures below.
        await tester.tap(find.text('Actors'));
        await tester.pump();
        await settleImages(tester, portraitUrls(ids));
        // Guard against a silently-missed nav tap (mirrors the mobile guard
        // below, ISSUE_NUM review) before capturing the master-detail shots.
        expect(find.byType(OverviewTab), findsNothing);
        expect(find.byType(ActorTree), findsOneWidget);

        await captureBoundary(key, '$_outDir/dashboard_overview.png');

        // Second shot: the Info tab selected, showing the charter lives in its
        // own tab alongside the work-state detail.
        await tester.ensureVisible(find.text('Info'));
        await tester.tap(find.text('Info'));
        for (var i = 0; i < 10; i++) {
          await tester.pump(const Duration(milliseconds: 50));
        }
        expect(find.text('Charter'), findsOneWidget);
        await captureBoundary(key, '$_outDir/detail_info_tab.png');

        await store.dispose();
      });
    },
  );

  testWidgets(
    "renders an actor's inbox page (signals + obligations, two columns)",
    (tester) async {
      await tester.runAsync(() async {
        final ids = _seedIds();
        HttpOverrides.global = FakeImageHttpOverrides(await portraits(ids));
        addTearDown(() => HttpOverrides.global = null);

        const worker = '11111111-1111-4111-8111-111111111111';
        final api = FakeApi()
          ..threadsResult = _seedThreads()
          ..eventPages = [EventPage(events: _seedEvents(), nextCursor: null)]
          ..inboxResultsByStatus['unhandled'] = {
            'entries': _seedInboxUnhandled(),
          }
          ..inboxResultsByStatus['handled'] = {'entries': _seedInboxHandled()}
          ..obligationsResult = _seedInboxObligations(worker);
        final store = DashboardStore(api: api, stream: FakeStream());
        await store.init();
        store.clickActor(worker);

        // Tall enough that both columns fit without scrolling, so the shot
        // shows every seeded row rather than a cropped list.
        await tester.binding.setSurfaceSize(const Size(1360, 1220));
        addTearDown(() => tester.binding.setSurfaceSize(null));

        final key = GlobalKey();
        await tester.pumpWidget(_app(store, key));
        await tester.tap(find.text('Actors'));
        await tester.pump();
        await settleImages(tester, portraitUrls(ids));
        expect(find.byType(ActorTree), findsOneWidget);

        await tester.ensureVisible(find.text('Inbox'));
        await tester.tap(find.text('Inbox'));
        // Let the tab animate in and the inbox FutureBuilder resolve.
        for (var i = 0; i < 10; i++) {
          await tester.pump(const Duration(milliseconds: 50));
        }
        expect(find.byType(InboxTab), findsOneWidget);
        expect(find.text('Outstanding inbox signals'), findsOneWidget);
        expect(find.text('Recently resolved signals'), findsOneWidget);
        expect(find.text('Ready Obligations'), findsOneWidget);
        expect(find.text('Waiting Obligations'), findsOneWidget);
        await captureBoundary(key, '$_outDir/actor_inbox.png');
        expect(tester.takeException(), isNull);

        await store.dispose();
      });
    },
  );

  testWidgets('renders the mobile (~390px) master-detail list + detail ', (
    tester,
  ) async {
    await tester.runAsync(() async {
      final ids = _seedIds();
      HttpOverrides.global = FakeImageHttpOverrides(await portraits(ids));
      addTearDown(() => HttpOverrides.global = null);

      final api = FakeApi()
        ..threadsResult = _seedThreads()
        ..eventPages = [EventPage(events: _seedEvents(), nextCursor: null)]
        ..quotaResult = _seedQuota();
      final store = DashboardStore(api: api, stream: FakeStream());
      await store.init();
      // Quota rides the bottom of the phone drawer, so seed a reading for it.
      await store.refreshQuota();

      // A typical tall phone viewport (~390 logical px wide → narrow layout).
      await tester.binding.setSurfaceSize(const Size(390, 844));
      addTearDown(() => tester.binding.setSurfaceSize(null));

      final key = GlobalKey();
      await tester.pumpWidget(_mobileApp(store, key));
      // Overview is the default landing view at this height; switch to
      // Actors for the master-detail navigation captures below. On a phone
      // the destinations live in the drawer behind the header's hamburger.
      await tester.tap(find.byIcon(Icons.menu));
      // Let the drawer animation finish so the shot is the settled panel.
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 400));

      // 1) The open navigation drawer: destinations up top, quota pinned to
      // the bottom.
      expect(find.byType(MobileNavDrawer), findsOneWidget);
      await captureBoundary(key, '$_outDir/mobile_drawer.png');

      await tester.tap(find.byKey(const ValueKey('drawer-nav-actors')));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 400));
      await settleImages(tester, portraitUrls(ids));

      // 2) The full-width actor list (no actor selected → master view).
      // Assert the actor tree actually rendered — not still Overview — so
      // a missed nav tap fails loudly instead of silently capturing the
      // wrong screen.
      expect(find.byType(OverviewTab), findsNothing);
      expect(find.byType(ActorTree), findsOneWidget);
      await captureBoundary(key, '$_outDir/mobile_list.png');

      // 3) Tap an actor → full-width detail view, its way back the header's
      // top-left arrow rather than a row of its own.
      store.clickActor('11111111-1111-4111-8111-111111111111');
      await settleImages(tester, portraitUrls(ids));
      // Assert the actor detail panel — identified by the selected actor's
      // handle in its header — is what's rendered before capturing.
      expect(find.byType(DetailPanel), findsOneWidget);
      expect(find.text('cloudy-porpoise'), findsWidgets);
      await captureBoundary(key, '$_outDir/mobile_detail.png');

      await store.dispose();
    });
  });

  testWidgets('renders the avatar circle/size strip (26 / 52 / 91 px)', (
    tester,
  ) async {
    await tester.runAsync(() async {
      const id = '11111111-1111-4111-8111-111111111111';
      HttpOverrides.global = FakeImageHttpOverrides(await portraits([id]));
      addTearDown(() => HttpOverrides.global = null);

      await tester.binding.setSurfaceSize(const Size(560, 260));
      addTearDown(() => tester.binding.setSurfaceSize(null));

      final key = GlobalKey();
      await tester.pumpWidget(
        MaterialApp(
          debugShowCheckedModeBanner: false,
          theme: buildMeshTheme(),
          home: Scaffold(
            backgroundColor: MeshColors.bgPrimary,
            body: RepaintBoundary(
              key: key,
              child: Center(
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.end,
                  children: const [
                    _LabeledAvatar(id: id, size: 26, label: 'tree · 26px'),
                    SizedBox(width: 40),
                    _LabeledAvatar(
                      id: id,
                      size: 52,
                      label: 'old detail · 52px',
                    ),
                    SizedBox(width: 40),
                    _LabeledAvatar(
                      id: id,
                      size: 91,
                      label: 'new detail · 91px',
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      );
      await settleImages(tester, portraitUrls([id]));
      await captureBoundary(key, '$_outDir/avatar_circles.png');
    });
  });
}

// ── App composition ──────────────────────────────────────────────────────────

Widget _app(DashboardStore store, Key boundaryKey, {Key? dashboardKey}) =>
    MaterialApp(
      debugShowCheckedModeBanner: false,
      theme: buildMeshTheme(),
      home: Scaffold(
        backgroundColor: MeshColors.bgPrimary,
        // Render the real responsive body (wide → side-by-side at this surface
        // size) so the desktop shot matches the app, including the dark detail
        // background that DashboardBody paints itself.
        body: RepaintBoundary(
          key: boundaryKey,
          child: DashboardBody(key: dashboardKey, store: store),
        ),
      ),
    );

/// The real responsive body ([DashboardBody]) at a phone width, so the mobile
/// shots are the actual reflowed layout (full-width list → tap → detail).
Widget _mobileApp(DashboardStore store, Key boundaryKey) => MaterialApp(
  debugShowCheckedModeBanner: false,
  theme: buildMeshTheme(),
  home: Scaffold(
    backgroundColor: MeshColors.bgPrimary,
    body: RepaintBoundary(
      key: boundaryKey,
      child: DashboardBody(store: store),
    ),
  ),
);

class _LabeledAvatar extends StatelessWidget {
  const _LabeledAvatar({
    required this.id,
    required this.size,
    required this.label,
  });
  final String id;
  final double size;
  final String label;

  @override
  Widget build(BuildContext context) => Column(
    mainAxisSize: MainAxisSize.min,
    children: [
      ActorAvatar(id: id, size: size),
      const SizedBox(height: 10),
      Text(
        label,
        style: const TextStyle(color: MeshColors.textSecondary, fontSize: 12),
      ),
    ],
  );
}

// ── Seed data ────────────────────────────────────────────────────────────────

/// Two providers mid-week, so the drawer's bottom slot shows real rings.
/// `resetAtIso` is left null so the ring colors come from the wall-clock-free
/// quota-only fallback and the shot is reproducible.
QuotaSnapshotDto _seedQuota() => const QuotaSnapshotDto(
  generatedAt: '2026-06-26T09:00:00Z',
  providers: [
    ProviderQuotaDto(
      provider: 'claude',
      status: 'available',
      usedPercent: 38,
      tier: null,
      message: null,
      windows: [
        QuotaWindowDto(
          id: 'weekly',
          label: 'Weekly',
          usedPercent: 38,
          status: 'available',
          headline: true,
          windowMs: 604800000,
        ),
        QuotaWindowDto(
          id: 'session',
          label: 'Session',
          usedPercent: 12,
          status: 'available',
          headline: false,
          windowMs: 18000000,
        ),
      ],
    ),
    ProviderQuotaDto(
      provider: 'codex',
      status: 'available',
      usedPercent: 71,
      tier: null,
      message: null,
      windows: [
        QuotaWindowDto(
          id: 'weekly',
          label: 'Weekly',
          usedPercent: 71,
          status: 'available',
          headline: true,
          windowMs: 604800000,
        ),
        QuotaWindowDto(
          id: 'five_hour',
          label: '5h',
          usedPercent: 44,
          status: 'available',
          headline: false,
          windowMs: 18000000,
        ),
      ],
    ),
  ],
);

QuotaHistoryDto _overviewQuotaHistory() => QuotaHistoryDto(
  generatedAt: '2026-06-26T09:00:00Z',
  historySince: '2026-06-12T09:00:00Z',
  history: [
    const QuotaHistorySeriesDto(
      provider: 'codex',
      windowId: 'weekly',
      label: 'Weekly',
      points: [
        QuotaHistoryPointDto(
          observedAt: '2026-06-23T09:00:00Z',
          remainingPercent: 80,
          intervalSeconds: 30,
        ),
        QuotaHistoryPointDto(
          observedAt: '2026-06-25T09:00:00Z',
          remainingPercent: 60,
          intervalSeconds: 45,
        ),
        QuotaHistoryPointDto(
          observedAt: '2026-06-26T09:00:00Z',
          remainingPercent: 52,
          intervalSeconds: 60,
        ),
      ],
    ),
    // Model history with no controller decision (#706): it draws only on the
    // remaining plot, across a reset and a day with no readings.
    QuotaHistorySeriesDto(
      provider: 'claude',
      windowId: 'weekly',
      scope: 'model',
      modelIds: const ['claude-fable'],
      label: 'Fable',
      points: _fableHistoryPoints(),
    ),
  ],
);

/// Half-hourly Fable readings from Jun 13, as the API sends them after
/// thinning: weekly drawdown, a reset on Jun 19 and Jun 26, and no readings
/// through Jun 21.
List<QuotaHistoryPointDto> _fableHistoryPoints() {
  final points = <QuotaHistoryPointDto>[];
  final resets = [
    DateTime.utc(2026, 6, 19),
    DateTime.utc(2026, 6, 26),
    DateTime.utc(2026, 7, 3),
  ];
  for (
    var at = DateTime.utc(2026, 6, 13);
    !at.isAfter(DateTime.utc(2026, 6, 26, 9));
    at = at.add(const Duration(minutes: 30))
  ) {
    if (at.isAfter(DateTime.utc(2026, 6, 21)) &&
        at.isBefore(DateTime.utc(2026, 6, 22))) {
      continue;
    }
    final resetAt = resets.firstWhere((reset) => reset.isAfter(at));
    final left = resetAt.difference(at).inMinutes / (7 * 24 * 60);
    points.add(
      QuotaHistoryPointDto(
        observedAt: at.toIso8601String(),
        remainingPercent: (100 * left * 0.9 + 8).clamp(0, 100).toDouble(),
        resetAtIso: resetAt.toIso8601String(),
      ),
    );
  }
  return points;
}

List<String> _seedIds() => const [
  'root',
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  '33333333-3333-4333-8333-333333333333',
  '44444444-4444-4444-8444-444444444444',
];

List<ThreadDto> _seedThreads() => [
  _thread(
    'root',
    null,
    'active',
    RunState.running,
    '2026-06-26T09:00:00Z',
    handle: 'silicon-familiar',
    charter: 'the root actor',
    provider: 'anthropic',
    model: 'claude-opus-4-8',
  ),
  _thread(
    '11111111-1111-4111-8111-111111111111',
    'root',
    'active',
    RunState.running,
    '2026-06-26T09:01:00Z',
    handle: 'cloudy-porpoise',
    charter:
        'dashboard-refinements implementer: enlarge the detail avatar, fix the circular clip, coalesce run rows.',
    provider: 'anthropic',
    model: 'claude-opus-4-8',
  ),
  _thread(
    '22222222-2222-4222-8222-222222222222',
    'root',
    'active',
    RunState.idle,
    '2026-06-26T09:02:00Z',
    handle: 'burning-paca',
    charter: 'mesh-architecture elder',
    provider: 'anthropic',
    model: 'claude-opus-4-8',
  ),
  _thread(
    '33333333-3333-4333-8333-333333333333',
    '11111111-1111-4111-8111-111111111111',
    'active',
    RunState.idle,
    '2026-06-26T09:03:00Z',
    handle: 'kinetic-deer',
    charter: 'screenshot sub-worker',
    provider: 'google',
    model: 'gemini-2.5-pro',
  ),
  _thread(
    '44444444-4444-4444-8444-444444444444',
    'root',
    'retired',
    RunState.idle,
    '2026-06-26T09:04:00Z',
    handle: 'misty-otter',
    charter: 'retired reviewer',
  ),
];

ThreadDto _thread(
  String id,
  String? parent,
  String status,
  RunState run,
  String created, {
  required String handle,
  required String charter,
  String? provider,
  String? model,
}) => ThreadDto(
  id: id,
  handle: handle,
  parentId: parent,
  status: status,
  provider: provider,
  model: model,
  charterPreview: charter,
  title: charter,
  createdAt: created,
  runState: run,
);

/// Two outstanding signals for the selected worker: a GitHub review comment
/// on a PR it owns, and a Google Chat message. Shaped like the dashboard's
/// `/api/mesh/inbox` rows, including the resolved `reference` the server
/// attaches for GitHub sources.
List<Map<String, dynamic>> _seedInboxUnhandled() => [
  {
    'id': 'inbox-1',
    'source': 'github:example-org/widgets/pulls/42',
    'deliveredAt': '2026-06-26T08:52:00Z',
    'handledAt': null,
    'payload': {'type': 'pull_request_review_comment.created'},
    'reference': {
      'ref': 'github:example-org/widgets/pulls/42',
      'scheme': 'github',
      'title': 'Retry the sync worker with backoff',
      'url': 'https://github.com/example-org/widgets/pull/42',
      'author': 'reviewer',
      'entity': {
        'type': 'github_comment',
        'body':
            'A fixed 5s sleep will still pile up under load. Could this back '
            'off exponentially and cap at a minute?',
      },
    },
  },
  {
    'id': 'inbox-2',
    'source': 'gchat:spaces/AAAAexample',
    'deliveredAt': '2026-06-26T08:40:00Z',
    'handledAt': null,
    // A chat event routes by space, so it carries no per-message reference
    // and the card shows the raw payload.
    'payload': {
      'type': 'gchat.message',
      'messageName': 'spaces/AAAAexample/messages/BBBBexample',
      'spaceName': 'spaces/AAAAexample',
      'senderName': 'users/000000000000',
      'priority': 'responsive',
    },
  },
];

/// Two recently resolved signals, each with the note the actor left when it
/// marked the entry handled.
List<Map<String, dynamic>> _seedInboxHandled() => [
  {
    'id': 'inbox-3',
    'source': 'github:example-org/widgets/issues/17',
    'deliveredAt': '2026-06-25T16:10:00Z',
    'handledAt': '2026-06-25T16:31:00Z',
    'handledNote':
        'Reproduced the drop with a full queue, replied on the issue with the '
        'steps, and opened the retry PR.',
    'payload': {'type': 'issue_comment.created'},
    'reference': {
      'ref': 'github:example-org/widgets/issues/17',
      'scheme': 'github',
      'title': 'Sync worker drops events when the queue is full',
      'url': 'https://github.com/example-org/widgets/issues/17',
      'entity': {
        'type': 'github_issue',
        'title': 'Sync worker drops events when the queue is full',
        'description':
            'Under sustained load the worker silently discards events once '
            'its queue hits the cap.',
      },
    },
  },
  {
    'id': 'inbox-4',
    'source': 'operator:dashboard',
    'deliveredAt': '2026-06-25T09:00:00Z',
    'handledAt': '2026-06-25T09:02:00Z',
    'handledNote': 'Ran once by hand; nothing new was waiting in the queue.',
    'payload': {'type': 'operator.run_now', 'priority': 'responsive'},
  },
];

const _subWorker = '33333333-3333-4333-8333-333333333333';

/// The selected worker's obligations: two ready, two waiting on children
/// (one child is the worker's own ready row, the others belong to a
/// sub-worker and to the operator, so they surface only as blockers).
List<ObligationDto> _seedInboxObligations(String owner) => [
  makeObligation(
    'ob-release',
    ownerId: owner,
    status: 'waiting',
    title: 'Ship the 0.4 release',
    intent:
        'Cut the tag once the retry fix has landed and a fresh install '
        'upgrades cleanly.',
  ),
  makeObligation(
    'ob-retry-pr',
    ownerId: owner,
    parentId: 'ob-release',
    title: 'Land the sync-worker retry PR',
    intent: 'Land the sync-worker retry PR',
    externalRef: 'github:example-org/widgets/pulls/42',
  ),
  makeObligation(
    'ob-upgrade-check',
    ownerId: _subWorker,
    parentId: 'ob-release',
    title: 'Verify the upgrade path on a fresh install',
    intent: 'Verify the upgrade path on a fresh install',
  ),
  makeObligation(
    'ob-release-notes',
    ownerId: owner,
    title: 'Write the 0.4 release notes',
    intent: 'Highlights, the config rename, and the upgrade note.',
    checkpoint:
        'Highlights drafted. Still need the upgrade note for the config '
        'rename.',
    checkpointAt: '2026-06-26T08:15:00Z',
  ),
  makeObligation(
    'ob-poller',
    ownerId: owner,
    status: 'waiting',
    title: 'Retire the legacy poller',
    intent: 'Remove the polling fallback once nothing depends on it.',
  ),
  makeObligation(
    'ob-poller-check',
    ownerId: 'human:operator',
    parentId: 'ob-poller',
    title: 'Confirm no instance still depends on polling',
    intent: 'Confirm no instance still depends on polling',
  ),
];

/// Newest-first events for the selected worker, including a run that both
/// yielded and ended (coalesced into one row) plus a standalone run_end.
List<MeshEvent> _seedEvents() {
  const actor = '11111111-1111-4111-8111-111111111111';
  return [
    makeEvent('e8', 'run_end', actor: actor, detail: 'exit 0'),
    _ev(
      'e7',
      'run_yielded',
      actor,
      detail: 'complete',
      body: 'PR opened with screenshots; ready for review.',
    ),
    makeEvent('e6', 'run_queued', actor: actor, detail: 'message from root'),
    makeEvent(
      'e5',
      'run_end',
      actor: actor,
      detail: 'exit 0',
    ), // auto-continued → standalone
    makeEvent(
      'e4',
      'run_continued',
      actor: actor,
      detail: 'auto-continuation 1/8',
    ),
    makeEvent(
      'e3',
      'message_sent',
      actor: actor,
      peer: 'root',
      detail: 'progress update',
    ),
    makeEvent('e2', 'run_queued', actor: actor, detail: 'spawned'),
    makeEvent('e1', 'actor_spawned', actor: actor, peer: 'root'),
  ];
}

MeshEvent _ev(
  String id,
  String kind,
  String actor, {
  String? detail,
  String? body,
}) => MeshEvent(
  id: id,
  ts: '2026-01-01T00:00:00Z',
  kind: kind,
  actorId: actor,
  detail: detail,
  body: body,
  success: null,
);
