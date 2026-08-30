import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rusa_dashboard/api.dart';
import 'package:rusa_dashboard/models.dart';
import 'package:rusa_dashboard/store.dart';
import 'package:rusa_dashboard/theme.dart';
import 'package:rusa_dashboard/widgets/actor_tree.dart';
import 'package:rusa_dashboard/widgets/avatar.dart';
import 'package:rusa_dashboard/widgets/detail_panel.dart';
import 'package:rusa_dashboard/widgets/header.dart';

import 'fakes.dart';

// The store does real async I/O (Futures + broadcast streams) and the dashboard
// has always-running animations (status pulse, cursor). So we drive each test
// inside tester.runAsync (real async zone) and pump fixed durations rather than
// pumpAndSettle (which would never settle against the repeating animations).

Widget _harness(DashboardStore store) => MaterialApp(
  home: Scaffold(
    body: Row(
      children: [
        ActorTree(store: store),
        Expanded(child: DetailPanel(store: store)),
      ],
    ),
  ),
);

// resetAtIso is null throughout this fixture, so `quotaScheduleColor` always
// takes its "can't resolve a schedule position" fallback path — the ring
// colors below are deterministic (quota-only thresholds), independent of the
// wall clock the widget test happens to run at. Schedule-aware coloring with
// a resolvable `resetAtIso` is covered directly (no widget pump needed) by the
// `quotaScheduleColor` group further down.
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
          id: 'session',
          label: 'Session',
          usedPercent: 32,
          status: 'available',
          headline: false,
          windowMs: 18000000,
        ),
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
    ProviderQuotaDto(
      provider: 'codex',
      status: 'available',
      usedPercent: 41,
      tier: null,
      message: null,
      windows: [
        QuotaWindowDto(
          id: 'five_hour',
          label: '5h',
          usedPercent: 12,
          status: 'available',
          headline: false,
          windowMs: 18000000,
        ),
        QuotaWindowDto(
          id: 'weekly',
          label: 'Weekly',
          usedPercent: 90,
          status: 'available',
          headline: true,
          windowMs: 604800000,
        ),
      ],
    ),
    ProviderQuotaDto(
      provider: 'agy',
      status: 'available',
      usedPercent: 65,
      tier: null,
      message: null,
      windows: [
        QuotaWindowDto(
          id: 'weekly',
          label: 'Weekly',
          usedPercent: 50,
          status: 'available',
          headline: true,
          windowMs: 604800000,
        ),
        QuotaWindowDto(
          id: 'five_hour',
          label: '5h',
          usedPercent: 8,
          status: 'available',
          headline: false,
          windowMs: 18000000,
        ),
      ],
    ),
  ],
);

class _EventsLogFakeApi extends FakeApi {
  _EventsLogFakeApi() {
    threadsResult = [
      makeThread('root', created: 't0'),
      makeThread('a', parent: 'root', created: 't1'),
      makeThread('b', parent: 'root', created: 't2'),
    ];
  }

  @override
  Future<EventPage> fetchEvents({
    List<String>? actors,
    String? since,
    List<String>? kinds,
    int? before,
    int limit = 50,
    bool conversation = false,
    String? order,
  }) async {
    return EventPage(
      events: [
        makeEvent(
          'e1',
          'message_sent',
          actor: 'a',
          detail: 'a6bf1ca9-43eb-466d-a06d-3a08e4f09605',
          body: 'Please check the dashboard event log.',
          payload: '{"messageId": "m1", "to": "b"}',
        ),
        makeEvent(
          'e2',
          'message_received',
          actor: 'a',
          detail: 'd1411b1f-ec2e-498a-b140-cafc2049ba22',
          body: 'I will check it now.',
          payload: '{"messageId": "m2", "from": "b"}',
        ),
        makeEvent(
          'e3',
          'actor_spawned',
          actor: 'a',
          payload: '{"parentId": "b"}',
        ),
        makeEvent(
          'e4',
          'handle_granted',
          actor: 'a',
          payload: '{"handleId": "b"}',
        ),
      ],
      nextCursor: null,
    );
  }
}

void main() {
  testWidgets('spawns a root child from the hierarchy control', (tester) async {
    await tester.runAsync(() async {
      final api = FakeApi()
        ..threadsResult = [makeThread('root', created: 't0')];
      final store = DashboardStore(api: api, stream: FakeStream());
      await store.init();
      await tester.pumpWidget(_harness(store));

      await tester.tap(find.byTooltip('Spawn actor'));
      await tester.pump(const Duration(milliseconds: 100));
      expect(find.text('Spawn actor'), findsOneWidget);

      await tester.enterText(
        find.widgetWithText(TextFormField, 'Title'),
        'Context evaluator',
      );
      await tester.enterText(
        find.widgetWithText(TextFormField, 'Charter'),
        'Evaluate portable context continuity',
      );
      await tester.enterText(
        find.widgetWithText(TextFormField, 'Model'),
        'gemini-3.5-flash-medium',
      );
      await tester.enterText(
        find.widgetWithText(TextFormField, 'Maximum runs'),
        '3',
      );
      await tester.tap(find.widgetWithText(FilledButton, 'Spawn'));
      await tester.pump(const Duration(milliseconds: 100));

      expect(api.rootSpawnCalls.single, (
        charter: 'Evaluate portable context continuity',
        title: 'Context evaluator',
        provider: 'agy',
        model: 'gemini-3.5-flash-medium',
        maxRuns: 3,
      ));
      expect(store.primary.value, 'spawned-child');
      await store.dispose();
    });
  });

  testWidgets('renders the actor tree with handles and selects on tap', (
    tester,
  ) async {
    await tester.runAsync(() async {
      final api = FakeApi()
        ..threadsResult = [
          makeThread('root', created: 't0'),
          makeThread('a', parent: 'root', created: 't1'),
        ];
      final store = DashboardStore(api: api, stream: FakeStream());
      await store.init();

      await tester.pumpWidget(_harness(store));
      await tester.pump(const Duration(milliseconds: 50));

      // Tree shows handles (not raw UUIDs).
      expect(find.text('root-handle'), findsOneWidget);
      expect(find.text('a-handle'), findsOneWidget);
      // Nothing selected yet → detail prompts for a selection.
      expect(find.text('Select an actor from the tree.'), findsOneWidget);

      // Click an actor → primary; detail header shows handle, UUID, and tabs.
      await tester.tap(find.text('a-handle'));
      await tester.pump(const Duration(milliseconds: 50));

      expect(store.selection.value, {'a'});
      expect(find.text('a'), findsWidgets); // UUID in the detail header
      expect(find.text('Chat'), findsOneWidget);
      expect(find.text('Events Log'), findsOneWidget);
      expect(find.text('Live Output'), findsOneWidget);
      expect(find.byType(TextField), findsOneWidget);

      await store.dispose();
    });
  });

  testWidgets(
    'renders state-driven action buttons: Run Now and Cancel for queued actors, and Interrupt (stop) for running actors',
    (tester) async {
      await tester.runAsync(() async {
        final api = FakeApi()
          ..threadsResult = [
            makeThread('root', created: 't0', runState: RunState.idle),
            makeThread('queued-actor', parent: 'root', created: 't1', runState: RunState.queued),
            makeThread('running-actor', parent: 'root', created: 't2', runState: RunState.running),
          ];
        final store = DashboardStore(api: api, stream: FakeStream());
        await store.init();

        await tester.pumpWidget(_harness(store));
        await tester.pump(const Duration(milliseconds: 50));

        // Queued actor shows "Run now" and "Cancel queued run" buttons
        expect(find.byTooltip('Run now'), findsOneWidget);
        expect(find.byTooltip('Cancel queued run'), findsOneWidget);
        expect(find.byIcon(Icons.fast_forward_rounded), findsOneWidget);

        // Running actor shows "Interrupt" button (with stop icon)
        expect(find.byTooltip('Interrupt'), findsOneWidget);
        expect(find.byIcon(Icons.stop_rounded), findsNWidgets(2));

        // Tap Run Now button on queued actor
        await tester.tap(find.byTooltip('Run now'));
        await tester.pump(const Duration(milliseconds: 50));
        expect(api.runNowCalls, ['queued-actor']);

        // Tap Cancel queued run button on queued actor
        await tester.tap(find.byTooltip('Cancel queued run'));
        await tester.pump(const Duration(milliseconds: 50));
        expect(api.interruptCalls, [(actorId: 'queued-actor', by: 'human:operator')]);

        // Tap Interrupt button on running actor
        await tester.tap(find.byTooltip('Interrupt'));
        await tester.pump(const Duration(milliseconds: 50));
        expect(api.interruptCalls, [
          (actorId: 'queued-actor', by: 'human:operator'),
          (actorId: 'running-actor', by: 'human:operator'),
        ]);

        await store.dispose();
      });
    },
  );

  testWidgets(
    'ActorTree and DetailPanel reactively synchronize on SSE lifecycle events ',
    (tester) async {
      await tester.runAsync(() async {
        final api = FakeApi()
          ..threadsResult = [
            makeThread('root', created: 't0', runState: RunState.idle),
            makeThread('a', parent: 'root', created: 't1', runState: RunState.idle),
          ];
        final stream = FakeStream();
        final store = DashboardStore(api: api, stream: stream);
        await store.init();

        // Select 'a'
        store.clickActor('a');

        await tester.pumpWidget(_harness(store));
        await tester.pump(const Duration(milliseconds: 50));

        // In detail panel: 'a' is idle -> shows 'Run now' in detail panel header
        expect(find.byTooltip('Run now'), findsOneWidget);
        expect(find.byTooltip('Interrupt'), findsNothing);

        // SSE: 'a' transitions to running (run_start)
        stream.meshCtrl.add(makeEvent('e1', 'run_start', actor: 'a'));
        await tester.pump(const Duration(milliseconds: 50));
        await tester.pump(const Duration(milliseconds: 50));

        // Detail panel and tree row reactively show 'Interrupt'
        expect(find.byTooltip('Interrupt'), findsNWidgets(2));
        expect(find.byTooltip('Run now'), findsNothing);

        // SSE: 'a' transitions to queued (run_queued)
        stream.meshCtrl.add(makeEvent('e2', 'run_queued', actor: 'a'));
        await tester.pump(const Duration(milliseconds: 50));
        await tester.pump(const Duration(milliseconds: 50));

        // Detail panel and tree row reactively show 'Run now' and 'Cancel queued run'
        expect(find.byTooltip('Run now'), findsNWidgets(2));
        expect(find.byTooltip('Cancel queued run'), findsNWidgets(2));
        expect(find.byTooltip('Interrupt'), findsNothing);

        // SSE: 'a' transitions to idle (run_end)
        stream.meshCtrl.add(makeEvent('e3', 'run_end', actor: 'a'));
        await tester.pump(const Duration(milliseconds: 50));
        await tester.pump(const Duration(milliseconds: 50));

        // Detail panel reactively shows 'Run now' in header
        expect(find.byTooltip('Run now'), findsOneWidget);
        expect(find.byTooltip('Cancel queued run'), findsNothing);
        expect(find.byTooltip('Interrupt'), findsNothing);

        await store.dispose();
      });
    },
  );

  testWidgets(
    'renders message_sent and message_received with counterparty handles',
    (tester) async {
      await tester.runAsync(() async {
        final api = _EventsLogFakeApi();
        final store = DashboardStore(api: api, stream: FakeStream());
        await store.init();

        await tester.pumpWidget(_harness(store));
        await tester.pump(const Duration(milliseconds: 50));

        // Click actor 'a' to load its events
        await tester.tap(find.text('a-handle'));
        await tester.pump(const Duration(milliseconds: 50));

        // Switch to the Events Log tab
        await tester.tap(find.byIcon(Icons.terminal));
        for (int i = 0; i < 10; i++) {
          await tester.pump(const Duration(milliseconds: 100));
        }

        // Assert that counterparty b's handle is displayed correctly for both events
        expect(find.text('to b-handle'), findsOneWidget);
        expect(find.text('from b-handle'), findsOneWidget);
        expect(find.text('→ b-handle'), findsNWidgets(2));
        expect(find.text('to unknown'), findsNothing);
        expect(find.text('Please check the dashboard event log.'), findsOneWidget);
        expect(find.text('I will check it now.'), findsOneWidget);
        expect(find.text('a6bf1ca9-43eb-466d-a06d-3a08e4f09605'), findsNothing);
        expect(find.text('d1411b1f-ec2e-498a-b140-cafc2049ba22'), findsNothing);

        // Assert that the selection actor 'a' (the sender/recipient of these events) is NOT
        // incorrectly shown as the target or sender (direction check)
        expect(find.text('to a-handle'), findsNothing);
        expect(find.text('from a-handle'), findsNothing);

        await store.dispose();
      });
    },
  );

  testWidgets('renders a single model with no divergence surface', (
    tester,
  ) async {
    await tester.runAsync(() async {
      final api = FakeApi()
        ..threadsResult = [
          makeThread('root', created: 't0'),
          makeThread('a', parent: 'root', created: 't1', model: 'gpt-5-codex'),
        ];
      final store = DashboardStore(api: api, stream: FakeStream());
      await store.init();

      await tester.pumpWidget(_harness(store));
      await tester.pump(const Duration(milliseconds: 50));

      expect(find.text('gpt-5-codex'), findsOneWidget);
      // The tree's compact divergence chip is gone, not merely unlit.
      expect(find.text('DIFF'), findsNothing);

      await tester.tap(find.text('a-handle'));
      await tester.pump(const Duration(milliseconds: 50));

      expect(find.text('MODEL DIVERGED'), findsNothing);

      await tester.ensureVisible(find.text('Info'));
      await tester.tap(find.text('Info'));
      // Pump several frames to complete the swipe animation without pumpAndSettle
      for (int i = 0; i < 10; i++) {
        await tester.pump(const Duration(milliseconds: 100));
      }

      // One model row, and no second value to compare it against.
      expect(
        find.textContaining('Model: ', findRichText: true),
        findsOneWidget,
      );
      expect(
        find.textContaining('Requested: ', findRichText: true),
        findsNothing,
      );
      expect(
        find.textContaining('gpt-5-codex', findRichText: true),
        findsWidgets,
      );

      await store.dispose();
    });
  });

  testWidgets('Show Retired toggle reveals recently retired actors', (
    tester,
  ) async {
    await tester.runAsync(() async {
      final recent = DateTime.now()
          .toUtc()
          .subtract(const Duration(days: 1))
          .toIso8601String();
      final api = FakeApi()
        ..threadsResult = [
          makeThread('root', created: 't0'),
          makeThread(
            'gone',
            parent: 'root',
            status: 'retired',
            created: 't1',
            lastActiveAt: recent,
          ),
        ];
      final store = DashboardStore(api: api, stream: FakeStream());
      await store.init();

      await tester.pumpWidget(_harness(store));
      await tester.pump(const Duration(milliseconds: 50));

      expect(find.text('gone-handle'), findsNothing); // hidden by default

      await tester.tap(find.byType(Switch));
      await tester.pump(const Duration(milliseconds: 50));

      expect(find.text('gone-handle'), findsOneWidget);
      await store.dispose();
    });
  });

  testWidgets('Show Retired toggle still hides stale retired actors', (
    tester,
  ) async {
    await tester.runAsync(() async {
      final stale = DateTime.now()
          .toUtc()
          .subtract(const Duration(days: 8))
          .toIso8601String();
      final api = FakeApi()
        ..threadsResult = [
          makeThread('root', created: 't0'),
          makeThread(
            'old',
            parent: 'root',
            status: 'retired',
            created: 't1',
            lastActiveAt: stale,
          ),
        ];
      final store = DashboardStore(api: api, stream: FakeStream());
      await store.init();

      await tester.pumpWidget(_harness(store));
      await tester.pump(const Duration(milliseconds: 50));

      // Even with Show Retired enabled, an actor whose most recent mesh event
      // (here, its retirement) is more than a week old stays hidden.
      await tester.tap(find.byType(Switch));
      await tester.pump(const Duration(milliseconds: 50));

      expect(find.text('old-handle'), findsNothing);
      await store.dispose();
    });
  });

  testWidgets('collapse and expand chevrons toggle sub-actor visibility', (
    tester,
  ) async {
    await tester.runAsync(() async {
      final api = FakeApi()
        ..threadsResult = [
          makeThread('root', created: 't0'),
          makeThread('child', parent: 'root', created: 't1'),
        ];
      final store = DashboardStore(api: api, stream: FakeStream());
      await store.init();

      await tester.pumpWidget(_harness(store));
      await tester.pump(const Duration(milliseconds: 50));

      // Both are visible initially
      expect(find.text('root-handle'), findsOneWidget);
      expect(find.text('child-handle'), findsOneWidget);

      // Find the chevron icon. Since only 'root' has children, there's exactly one chevron (Icons.arrow_drop_down).
      final chevronFinder = find.byIcon(Icons.arrow_drop_down);
      expect(chevronFinder, findsOneWidget);

      // Tap the chevron to collapse
      await tester.tap(chevronFinder);
      await tester.pump(const Duration(milliseconds: 50));

      // 'child' should be hidden now, and root's chevron should point right
      expect(find.text('root-handle'), findsOneWidget);
      expect(find.text('child-handle'), findsNothing);
      expect(find.byIcon(Icons.arrow_right), findsOneWidget);
      expect(find.byIcon(Icons.arrow_drop_down), findsNothing);

      // Tap the chevron again to expand
      await tester.tap(find.byIcon(Icons.arrow_right));
      await tester.pump(const Duration(milliseconds: 50));

      // Both should be visible again
      expect(find.text('root-handle'), findsOneWidget);
      expect(find.text('child-handle'), findsOneWidget);
      expect(find.byIcon(Icons.arrow_drop_down), findsOneWidget);
      expect(find.byIcon(Icons.arrow_right), findsNothing);

      await store.dispose();
    });
  });

  testWidgets('header shows Halted when halted in the brand cluster', (
    tester,
  ) async {
    await tester.runAsync(() async {
      final api = FakeApi()
        ..halted = true
        ..threadsResult = [makeThread('root', created: 't0')];
      final store = DashboardStore(api: api, stream: FakeStream());
      await store.init();

      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: SizedBox(
              width: 1100,
              child: MeshHeader(
                store: store,
                selected: DashboardView.actors,
                onSelect: (_) {},
              ),
            ),
          ),
        ),
      );
      await tester.pump(const Duration(milliseconds: 50));

      expect(find.text('Halted'), findsOneWidget);
      expect(find.text('SYSTEM HALTED'), findsNothing);
      expect(find.text('Active'), findsNothing);
      expect(find.text('V1.4.0'), findsNothing);
      expect(
        tester.getTopLeft(find.text('Halted')).dx,
        lessThan(tester.getTopLeft(find.text('Actors')).dx),
      );
      await store.dispose();
    });
  });

  testWidgets('header shows the active pulse in the brand cluster', (
    tester,
  ) async {
    await tester.runAsync(() async {
      final api = FakeApi()
        ..threadsResult = [
          makeThread('root', created: 't0'),
        ]; // halted defaults false
      final store = DashboardStore(api: api, stream: FakeStream());
      await store.init();

      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: SizedBox(
              width: 1100,
              child: MeshHeader(
                store: store,
                selected: DashboardView.actors,
                onSelect: (_) {},
              ),
            ),
          ),
        ),
      );
      await tester.pump(const Duration(milliseconds: 50));

      expect(find.text('Active'), findsOneWidget);
      expect(find.text('Mesh System Active'), findsNothing);
      expect(find.text('SYSTEM HALTED'), findsNothing);
      expect(find.text('V1.4.0'), findsNothing);
      expect(
        tester.getTopLeft(find.text('Active')).dx,
        lessThan(tester.getTopLeft(find.text('Actors')).dx),
      );
      await store.dispose();
    });
  });

  testWidgets(
    'header renders per-provider remaining rings without visible percentages',
    (tester) async {
      await tester.runAsync(() async {
        final api = FakeApi()
          ..threadsResult = [makeThread('root', created: 't0')]
          ..quotaResult = _quotaSnapshot();
        final store = DashboardStore(api: api, stream: FakeStream());
        await store.init();
        await store.refreshQuota();

        await tester.pumpWidget(
          MaterialApp(
            home: Scaffold(
              body: SizedBox(width: 1100, child: MeshHeader(store: store)),
            ),
          ),
        );
        await tester.pump(const Duration(milliseconds: 50));

        expect(find.text('Claude'), findsOneWidget);
        expect(find.text('Codex'), findsOneWidget);
        expect(find.text('Agy'), findsOneWidget);
        expect(find.text('90%'), findsNothing);
        expect(find.text('50%'), findsNothing);
        expect(find.text('n/a'), findsNothing);
        expect(find.text('0%'), findsNothing);

        // Each provider now renders two concentric rings — weekly (outer),
        // then session/5h (inner) — in that order .
        final rings = tester
            .widgetList<CircularProgressIndicator>(
              find.byType(CircularProgressIndicator),
            )
            .toList();
        expect(rings, hasLength(6));
        expect(
          rings[0].value,
          0.97,
        ); // claude weekly: 3% used => 97% remaining.
        expect(
          rings[1].value,
          0.68,
        ); // claude session: 32% used => 68% remaining.
        expect(rings[2].value, 0.1); // codex weekly: 90% used => 10% remaining.
        expect(rings[3].value, 0.88); // codex 5h: 12% used => 88% remaining.
        expect(rings[4].value, 0.5); // agy weekly: 50% used => 50% remaining.
        expect(
          rings[5].value,
          0.92,
        ); // agy five_hour: 8% used => 92% remaining.

        // The tooltip reports both the weekly and the session percentage.
        final claudeTooltip = tester.widget<Tooltip>(
          find.byType(Tooltip).first,
        );
        expect(claudeTooltip.message, contains('Weekly: 97% remaining'));
        expect(claudeTooltip.message, contains('Session: 68% remaining'));

        // Geometry check standing in for a pixel screenshot: this sandbox's
        // Flutter SDK cache is read-only, so a headless-Chrome/CDP capture of
        // the real web build isn't available here. Assert directly that the
        // inner (session) ring is fully nested inside, and shares a center
        // with, the outer (weekly) ring — i.e. they render as concentric
        // circles rather than clipping or overlapping (the ISSUE_NUM/ISSUE_NUM class of
        // ring-clipping bug this repo has hit before).
        final outerRect = tester.getRect(
          find.byType(CircularProgressIndicator).at(0),
        );
        final innerRect = tester.getRect(
          find.byType(CircularProgressIndicator).at(1),
        );
        expect(outerRect.width, greaterThan(innerRect.width));
        expect(outerRect.height, greaterThan(innerRect.height));
        expect(outerRect.center, innerRect.center);
        expect(outerRect.contains(innerRect.topLeft), isTrue);
        expect(outerRect.contains(innerRect.bottomRight), isTrue);

        await store.dispose();
      });
    },
  );

  testWidgets(
    'provider tooltip shows the ground-truth scrape stamp as "as of HH:mm" '
    'and formats relative age across minutes, hours, and days (issue #9)',
    (tester) async {
      await tester.runAsync(() async {
        final now = DateTime.now().toUtc();
        final recentIso = now.subtract(const Duration(seconds: 30)).toIso8601String();
        final minutesAgoIso = now.subtract(const Duration(minutes: 5)).toIso8601String();
        final hoursAgoIso = now.subtract(const Duration(hours: 2)).toIso8601String();
        final daysAgoIso = now.subtract(const Duration(days: 2)).toIso8601String();

        final snapshot = QuotaSnapshotDto(
          generatedAt: now.toIso8601String(),
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
                  scrapedAt: recentIso,
                ),
              ],
            ),
            ProviderQuotaDto(
              provider: 'codex',
              status: 'available',
              usedPercent: 10,
              tier: null,
              message: null,
              windows: [
                QuotaWindowDto(
                  id: 'weekly',
                  label: 'Weekly',
                  usedPercent: 10,
                  status: 'available',
                  headline: true,
                  windowMs: 604800000,
                  scrapedAt: minutesAgoIso,
                ),
              ],
            ),
            ProviderQuotaDto(
              provider: 'agy',
              status: 'available',
              usedPercent: 20,
              tier: null,
              message: null,
              windows: [
                QuotaWindowDto(
                  id: 'weekly',
                  label: 'Weekly',
                  usedPercent: 20,
                  status: 'available',
                  headline: true,
                  windowMs: 604800000,
                  scrapedAt: hoursAgoIso,
                ),
              ],
            ),
            ProviderQuotaDto(
              provider: 'kimi',
              status: 'available',
              usedPercent: 15,
              tier: null,
              message: null,
              windows: [
                QuotaWindowDto(
                  id: 'weekly',
                  label: 'Weekly',
                  usedPercent: 15,
                  status: 'available',
                  headline: true,
                  windowMs: 604800000,
                  scrapedAt: daysAgoIso,
                ),
              ],
            ),
          ],
        );
        final api = FakeApi()
          ..threadsResult = [makeThread('root', created: 't0')]
          ..quotaResult = snapshot;
        final store = DashboardStore(api: api, stream: FakeStream());
        await store.init();
        await store.refreshQuota();

        await tester.pumpWidget(
          MaterialApp(
            home: Scaffold(
              body: SizedBox(width: 1100, child: MeshHeader(store: store)),
            ),
          ),
        );
        await tester.pump(const Duration(milliseconds: 50));

        final tooltips = tester.widgetList<Tooltip>(find.byType(Tooltip)).toList();
        // 4 providers in order: Claude, Codex, Agy, Kimi
        expect(tooltips, hasLength(4));

        // Claude: < 2m ago -> just "as of HH:mm"
        expect(tooltips[0].message, contains('as of '));
        expect(tooltips[0].message, isNot(contains('ago)')));

        // Codex: 5m ago -> "(5m ago)"
        expect(tooltips[1].message, contains('(5m ago)'));

        // Agy: 2h ago -> "(2h ago)"
        expect(tooltips[2].message, contains('(2h ago)'));

        // Kimi: 2d ago -> "(2d ago)"
        expect(tooltips[3].message, contains('(2d ago)'));

        await store.dispose();
      });
    },
  );


  testWidgets(
    'header renders empty inner ring and "window reset at" tooltip when window is past reset (issue #9)',
    (tester) async {
      await tester.runAsync(() async {
        final pastResetIso = DateTime.now()
            .toUtc()
            .subtract(const Duration(minutes: 32))
            .toIso8601String();
        final snapshot = QuotaSnapshotDto(
          generatedAt: '2026-07-09T00:00:00.000Z',
          providers: [
            ProviderQuotaDto(
              provider: 'codex',
              status: 'available',
              usedPercent: 47,
              tier: null,
              message: null,
              windows: [
                const QuotaWindowDto(
                  id: 'weekly',
                  label: 'Weekly',
                  usedPercent: 10,
                  status: 'available',
                  headline: true,
                  windowMs: 604800000,
                ),
                QuotaWindowDto(
                  id: 'five_hour',
                  label: '5h',
                  usedPercent: 47,
                  status: 'available',
                  headline: false,
                  resetAtIso: pastResetIso,
                  windowMs: 18000000,
                ),
              ],
            ),
          ],
        );
        final api = FakeApi()
          ..threadsResult = [makeThread('root', created: 't0')]
          ..quotaResult = snapshot;
        final store = DashboardStore(api: api, stream: FakeStream());
        await store.init();
        await store.refreshQuota();

        await tester.pumpWidget(
          MaterialApp(
            home: Scaffold(
              body: SizedBox(width: 1100, child: MeshHeader(store: store)),
            ),
          ),
        );
        await tester.pump(const Duration(milliseconds: 50));

        final rings = tester
            .widgetList<CircularProgressIndicator>(
              find.byType(CircularProgressIndicator),
            )
            .toList();
        expect(rings, hasLength(2));
        expect(rings[0].value, 0.9); // weekly: 10% used => 90% remaining
        expect(rings[1].value, 0.0); // 5h: past reset => 0.0 (empty ring)

        final codexTooltip = tester.widget<Tooltip>(
          find.byType(Tooltip).first,
        );
        expect(codexTooltip.message, contains('Weekly: 90% remaining'));
        expect(codexTooltip.message, contains('5h: window reset at '));
        expect(codexTooltip.message, contains('no fresh read since'));
        expect(codexTooltip.message, isNot(contains('5h: 53% remaining')));
        expect(codexTooltip.message, isNot(contains('5h: 47% quota remaining')));

        await store.dispose();
      });
    },
  );

  testWidgets(
    'quota provider config selects each provider primary window independently',
    (tester) async {
      await tester.runAsync(() async {
        final api = FakeApi()
          ..threadsResult = [makeThread('root', created: 't0')]
          ..quotaResult = _quotaSnapshot();
        final store = DashboardStore(api: api, stream: FakeStream());
        await store.init();
        await store.refreshQuota();

        await tester.pumpWidget(
          MaterialApp(
            home: Scaffold(
              body: SizedBox(
                width: 1100,
                child: MeshHeader(
                  store: store,
                  quotaProviders: const {
                    'claude': QuotaProviderConfig(primaryWindow: 'session'),
                    'codex': QuotaProviderConfig(primaryWindow: 'weekly'),
                    'agy': QuotaProviderConfig(primaryWindow: 'weekly'),
                  },
                ),
              ),
            ),
          ),
        );
        await tester.pump(const Duration(milliseconds: 50));

        final rings = tester
            .widgetList<CircularProgressIndicator>(
              find.byType(CircularProgressIndicator),
            )
            .toList();
        expect(rings, hasLength(3));
        expect(
          rings[0].value,
          0.68,
        ); // claude session, not the unknown weekly slot.
        expect(rings[1].value, 0.1);
        expect(rings[2].value, 0.5);
        expect(find.text('68%'), findsNothing);

        await store.dispose();
      });
    },
  );

  testWidgets(
    'quota 503 leaves the header quiet and does not set a dashboard error',
    (tester) async {
      await tester.runAsync(() async {
        final api = FakeApi()
          ..threadsResult = [makeThread('root', created: 't0')]
          ..quotaError = DashboardApiException(
            Uri.parse('/api/quota'),
            503,
            'unavailable',
          );
        final store = DashboardStore(api: api, stream: FakeStream());
        await store.init();
        await store.refreshQuota();

        await tester.pumpWidget(
          MaterialApp(
            home: Scaffold(
              body: SizedBox(width: 1100, child: MeshHeader(store: store)),
            ),
          ),
        );
        await tester.pump(const Duration(milliseconds: 50));

        expect(find.text('CLAUDE'), findsNothing);
        expect(store.error.valueOrNull, isNull);

        await store.dispose();
      });
    },
  );

  testWidgets('renders actor avatars with size 52 and shows the actor title', (
    tester,
  ) async {
    await tester.runAsync(() async {
      final api = FakeApi()
        ..threadsResult = [
          makeThread('root', created: 't0', title: 'Custom Root Title'),
        ];
      final store = DashboardStore(api: api, stream: FakeStream());
      await store.init();

      await tester.pumpWidget(_harness(store));
      await tester.pump(const Duration(milliseconds: 50));

      // The handle is shown.
      expect(find.text('root-handle'), findsOneWidget);
      // The custom title is shown.
      expect(find.text('Custom Root Title'), findsOneWidget);

      // The ActorAvatar widget has size 52.
      final avatarFinder = find.byType(ActorAvatar);
      expect(avatarFinder, findsOneWidget);
      final avatar = tester.widget<ActorAvatar>(avatarFinder);
      expect(avatar.size, 52);

      await store.dispose();
    });
  });

  group('quotaScheduleColor (ISSUE_NUM schedule-aware pace coloring)', () {
    // Fixed reference instant so every case is deterministic regardless of
    // the wall clock the test suite happens to run at.
    final now = DateTime.utc(2026, 1, 1, 0, 0, 0);
    const fiveHourMs = 5 * 60 * 60 * 1000;

    QuotaWindowDto window({
      double? usedPercent,
      String status = 'available',
      String? resetAtIso,
      int windowMs = fiveHourMs,
    }) => QuotaWindowDto(
      id: 'session',
      label: 'Session',
      usedPercent: usedPercent,
      status: status,
      resetAtIso: resetAtIso,
      headline: false,
      windowMs: windowMs,
    );

    test('unknown/null window reads grey (muted), never crashes', () {
      expect(quotaScheduleColor(null, now: now), MeshColors.textMuted);
      expect(
        quotaScheduleColor(
          window(usedPercent: null, status: 'unknown'),
          now: now,
        ),
        MeshColors.textMuted,
      );
    });

    test('window past its reset (resetAtIso < now) reads grey (muted)', () {
      final w = window(
        usedPercent: 53,
        resetAtIso: now
            .subtract(const Duration(minutes: 32))
            .toIso8601String(),
      );
      expect(quotaScheduleColor(w, now: now), MeshColors.textMuted);
    });

    test('burning slow (delta >= 15) reads green', () {
      // 20% used (80% quota remaining) with 50% time remaining => delta 30,
      // meaningfully ahead of schedule.
      final w = window(
        usedPercent: 20,
        resetAtIso: now
            .add(const Duration(hours: 2, minutes: 30))
            .toIso8601String(),
      );
      expect(quotaScheduleColor(w, now: now), MeshColors.statusActive);
    });

    test('on pace (delta within the +/-15 band) reads amber', () {
      // Half the window elapsed (timeRemainingPct ~50%) but only 40% quota
      // left => delta ~ -10, inside the neutral "on pace" band.
      final w = window(
        usedPercent: 60,
        resetAtIso: now
            .add(const Duration(hours: 2, minutes: 30))
            .toIso8601String(),
      );
      expect(quotaScheduleColor(w, now: now), MeshColors.statusIdle);
    });

    test('burning fast (delta <= -15) reads red', () {
      // Window just started (timeRemainingPct clamps to 100%) but quota is
      // nearly exhausted => delta ~ -95, well past the "on pace" band.
      final w = window(
        usedPercent: 95,
        resetAtIso: now.add(const Duration(days: 30)).toIso8601String(),
      );
      expect(quotaScheduleColor(w, now: now), MeshColors.statusHalted);
    });

    test('delta exactly on the burning-fast boundary (-15) reads red', () {
      final w = window(
        usedPercent: 65,
        resetAtIso: now
            .add(const Duration(hours: 2, minutes: 30))
            .toIso8601String(),
      );
      expect(quotaScheduleColor(w, now: now), MeshColors.statusHalted);
    });

    test('delta exactly on the burning-slow boundary (+15) reads green', () {
      final w = window(
        usedPercent: 35,
        resetAtIso: now
            .add(const Duration(hours: 2, minutes: 30))
            .toIso8601String(),
      );
      expect(quotaScheduleColor(w, now: now), MeshColors.statusActive);
    });

    test(
      'falls back to quota-only thresholds when resetAtIso cannot be parsed',
      () {
        // Unparseable reset text DateTime.tryParse rejects, and
        // the ring falls back to coloring by remaining quota alone.
        const unparsed = 'Jul 13, 2:59am (UTC)';
        expect(
          quotaScheduleColor(
            window(usedPercent: 10, resetAtIso: unparsed),
            now: now,
          ),
          MeshColors.statusActive, // 90% remaining
        );
        expect(
          quotaScheduleColor(
            window(usedPercent: 50, resetAtIso: unparsed),
            now: now,
          ),
          MeshColors.statusIdle, // 50% remaining
        );
        expect(
          quotaScheduleColor(
            window(usedPercent: 85, resetAtIso: unparsed),
            now: now,
          ),
          MeshColors.statusHalted, // 15% remaining
        );
      },
    );

    test('falls back to quota-only thresholds when resetAtIso is absent', () {
      expect(
        quotaScheduleColor(window(usedPercent: 10, resetAtIso: null), now: now),
        MeshColors.statusActive,
      );
    });
  });

  group('quotaWindowTooltip (ISSUE_NUM self-explaining pace tooltip)', () {
    // Fix the viewer's local wall-clock time, then serialize reset instants as
    // UTC below. This keeps the expected presentation deterministic in every
    // test-runner timezone while exercising the UTC -> local conversion.
    final now = DateTime(2026, 1, 1, 0, 0, 0);
    const fiveHourMs = 5 * 60 * 60 * 1000;

    QuotaWindowDto window({
      double? usedPercent,
      String status = 'available',
      String? resetAtIso,
      int windowMs = fiveHourMs,
    }) => QuotaWindowDto(
      id: 'session',
      label: 'Session',
      usedPercent: usedPercent,
      status: status,
      resetAtIso: resetAtIso,
      headline: false,
      windowMs: windowMs,
    );

    test('unknown/null window reads n/a, never crashes', () {
      expect(
        quotaWindowTooltip(null, fallbackLabel: 'Session', now: now),
        'Session: n/a',
      );
      expect(
        quotaWindowTooltip(
          window(usedPercent: null, status: 'unknown'),
          fallbackLabel: 'Session',
          now: now,
        ),
        'Session: n/a',
      );
    });

    test(
      'honestly reports a window past its reset without showing stale percentage',
      () {
        final w = window(
          usedPercent: 53,
          resetAtIso: now
              .subtract(const Duration(minutes: 32))
              .toUtc()
              .toIso8601String(),
        );
        expect(
          quotaWindowTooltip(w, fallbackLabel: 'Session', now: now),
          'Session: window reset at Wed 11:28 PM; no fresh read since',
        );
      },
    );

    test(
      'states quota remaining, time remaining, an on-pace verdict, the reset '
      'time, and a burn-rate projection',
      () {
        final w = window(
          usedPercent: 90,
          resetAtIso: now
              .add(const Duration(minutes: 1))
              .toUtc()
              .toIso8601String(),
        );
        expect(
          quotaWindowTooltip(w, fallbackLabel: 'Session', now: now),
          'Session: 10% quota remaining, 0% time remaining (on pace)\n'
          'resets Thu 12:01 AM\n'
          '~10% left at reset',
        );
      },
    );

    test(
      'states an on-pace verdict with an "empty before reset" projection',
      () {
        final w = window(
          usedPercent: 60,
          resetAtIso: now
              .add(const Duration(hours: 2, minutes: 30))
              .toUtc()
              .toIso8601String(),
        );
        expect(
          quotaWindowTooltip(w, fallbackLabel: 'Session', now: now),
          'Session: 40% quota remaining, 50% time remaining (on pace)\n'
          'resets Thu 2:30 AM\n'
          'at this rate: empty ~Thu (resets Thu)',
        );
      },
    );

    test('states a burning-fast verdict, falling back to a quota-only '
        'projection on a degenerate (window-exceeding) reset', () {
      final w = window(
        usedPercent: 95,
        resetAtIso: now.add(const Duration(days: 30)).toUtc().toIso8601String(),
      );
      expect(
        quotaWindowTooltip(w, fallbackLabel: 'Session', now: now),
        'Session: 5% quota remaining, 100% time remaining (burning fast)\n'
        'resets Sat 12:00 AM\n'
        '~5% left at reset',
      );
    });

    test('falls back to quota-only phrasing plus the raw reset text when '
        'resetAtIso cannot be parsed', () {
      const unparsed = 'Jul 13, 2:59am (UTC)';
      expect(
        quotaWindowTooltip(
          window(usedPercent: 3, resetAtIso: unparsed),
          fallbackLabel: 'Session',
          now: now,
        ),
        'Session: 97% remaining\nresets Jul 13, 2:59am (UTC)',
      );
    });
  });

  group('quotaThrottleTooltip', () {
    test('identifies the adaptive interval and bucket driving live pacing', () {
      expect(
        quotaThrottleTooltip(
          const QuotaThrottleDto(
            intervalSeconds: 73,
            expired: false,
            updatedAt: '2026-07-22T12:00:00.000Z',
            buckets: [
              QuotaThrottleBucketDto(
                key: 'claude:weekly',
                error: 20,
                percentLeft: 30,
                timeRemainingPct: 50,
              ),
            ],
          ),
        ),
        'Normal launch pacing: one start every 1.2m\n'
        'hottest bucket claude:weekly: 20.0 points over pace',
      );
    });

    test('renders only pacing line when not expired and no buckets driving pace', () {
      final tooltip = quotaThrottleTooltip(
        const QuotaThrottleDto(
          intervalSeconds: 73,
          expired: false,
          updatedAt: '2026-07-22T12:00:00.000Z',
          buckets: [],
        ),
      );
      expect(tooltip, 'Normal launch pacing: one start every 1.2m');
      expect(tooltip, isNot(contains('learning')));
      expect(tooltip, isNot(contains('expired')));
    });

    test('explains that previous quota window expired', () {
      expect(
        quotaThrottleTooltip(
          const QuotaThrottleDto(
            intervalSeconds: 73,
            expired: true,
            updatedAt: '2026-07-22T12:00:00.000Z',
            buckets: [],
          ),
        ),
        contains('previous quota window expired'),
      );
    });
  });

  group('kDefaultQuotaProviders', () {
    test('kimi surfaces the five_hour session window (inner ring), ISSUE_NUM', () {
      final kimi = kDefaultQuotaProviders['kimi'];
      expect(kimi, isNotNull);
      expect(kimi!.primaryWindow, 'weekly');
      // Regression for the weekly-only opt-out: kimi's DTO now carries both
      // windows, so the inner ring must be wired to five_hour like codex/agy.
      expect(kimi.sessionWindow, 'five_hour');
      expect(kimi.sessionWindow, kDefaultQuotaProviders['agy']!.sessionWindow);
    });
  });

  testWidgets('ActorTree supports drag-to-reorder for sibling actors', (tester) async {
    await tester.runAsync(() async {
      final api = FakeApi()
        ..threadsResult = [
          makeThread('root', created: 't0'),
          makeThread('child-1', parent: 'root', created: 't1'),
          makeThread('child-2', parent: 'root', created: 't2'),
        ];
      final cache = FakeTreePreferencesCache();
      final store = DashboardStore(
        api: api,
        stream: FakeStream(),
        treePreferencesCache: cache,
      );
      await store.init();

      await tester.pumpWidget(_harness(store));
      await tester.pump(const Duration(milliseconds: 50));

      // Verify Draggables and DragTargets exist for actors
      expect(find.byType(Draggable<ThreadDto>), findsNWidgets(3));
      expect(find.byType(DragTarget<ThreadDto>), findsNWidgets(3));

      // Find Draggable for child-2
      final child2Finder = find.widgetWithText(Draggable<ThreadDto>, 'child-2-handle');
      expect(child2Finder, findsOneWidget);

      // Find DragTarget for child-1
      final child1Target = find.widgetWithText(DragTarget<ThreadDto>, 'child-1-handle');
      expect(child1Target, findsOneWidget);

      // Drag child-2 onto child-1 (upper half -> before child-1)
      final firstLocation = tester.getCenter(child2Finder);
      final targetTopLocation = tester.getTopLeft(child1Target) + const Offset(20, 5);

      final gesture = await tester.startGesture(firstLocation);
      await tester.pump(const Duration(milliseconds: 50));
      await gesture.moveTo(targetTopLocation);
      await tester.pump(const Duration(milliseconds: 50));
      await gesture.up();
      await tester.pump(const Duration(milliseconds: 50));

      // Verify child-2 is now before child-1
      expect(store.flattenedVisible().map((t) => t.id), [
        'root',
        'child-2',
        'child-1',
      ]);
      expect(cache.storedActorOrder?['root'], ['child-2', 'child-1']);

      await store.dispose();
    });
  });

  testWidgets('ActorTree uses LongPressDraggable when touchTargets is true', (tester) async {
    await tester.runAsync(() async {
      final api = FakeApi()
        ..threadsResult = [
          makeThread('root', created: 't0'),
          makeThread('child-1', parent: 'root', created: 't1'),
        ];
      final cache = FakeTreePreferencesCache();
      final store = DashboardStore(
        api: api,
        stream: FakeStream(),
        treePreferencesCache: cache,
      );
      await store.init();

      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: ActorTree(store: store, touchTargets: true),
          ),
        ),
      );
      await tester.pump(const Duration(milliseconds: 50));

      expect(find.byType(LongPressDraggable<ThreadDto>), findsNWidgets(2));
      expect(find.byType(Draggable<ThreadDto>), findsNothing);

      await store.dispose();
    });
  });
}
