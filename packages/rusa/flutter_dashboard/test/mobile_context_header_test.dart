import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rusa_dashboard/models.dart';
import 'package:rusa_dashboard/store.dart';
import 'package:rusa_dashboard/widgets/actor_tree.dart';
import 'package:rusa_dashboard/widgets/avatar.dart';
import 'package:rusa_dashboard/widgets/brand_mark.dart';
import 'package:rusa_dashboard/widgets/dashboard_body.dart';
import 'package:rusa_dashboard/widgets/detail_panel.dart';
import 'package:rusa_dashboard/widgets/header.dart';

import 'fakes.dart';

// #462: on a phone the app bar identifies the page — the Actors list shows
// hamburger + `Actors` with the Rusa name/branding in the drawer, and an actor
// detail shows back + avatar + handle with the run-state actions in an
// accessible overflow menu at the upper right. Desktop presentation is
// unchanged.
//
// Same convention as mobile_navigation_test.dart: the store does real async
// I/O and the dashboard runs repeating animations, so drive inside
// tester.runAsync and pump fixed durations rather than pumpAndSettle.

const _actorId = 'root';

Future<DashboardStore> _store({RunState runState = RunState.idle}) async {
  final api = FakeApi()
    ..threadsResult = [makeThread(_actorId, created: 't0', runState: runState)];
  final store = DashboardStore(api: api, stream: FakeStream());
  await store.init();
  return store;
}

Widget _app(DashboardStore store, {required Size size}) => MaterialApp(
  home: MediaQuery(
    data: MediaQueryData(size: size),
    child: Scaffold(body: DashboardBody(store: store)),
  ),
);

Future<void> _pump(
  WidgetTester tester,
  DashboardStore store, {
  required Size size,
}) async {
  await tester.binding.setSurfaceSize(size);
  addTearDown(() => tester.binding.setSurfaceSize(null));
  await tester.pumpWidget(_app(store, size: size));
  await tester.pump(const Duration(milliseconds: 50));
}

/// Opens the drawer, jumps to the Actors view, and waits out both animations.
Future<void> _goToActors(WidgetTester tester) async {
  await tester.tap(find.byIcon(Icons.menu));
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 400));
  await tester.tap(find.byKey(const ValueKey('drawer-nav-actors')));
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 400));
}

Future<void> _openActor(WidgetTester tester, DashboardStore store) async {
  store.clickActor(_actorId);
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 50));
}

Future<void> _openOverflow(WidgetTester tester) async {
  await tester.tap(find.byTooltip('Actor actions'));
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 300));
}

void main() {
  group('phone Actors page', () {
    testWidgets('the app bar shows hamburger + Actors, brand in the drawer', (
      tester,
    ) async {
      await tester.runAsync(() async {
        final store = await _store();
        await _pump(tester, store, size: const Size(390, 844));
        await _goToActors(tester);

        // The page name takes the wordmark's slot; the brand moved into the
        // drawer (where the hamburger took its place).
        expect(find.byIcon(Icons.menu), findsOneWidget);
        expect(
          find.descendant(
            of: find.byType(MeshHeader),
            matching: find.text('Actors'),
          ),
          findsOneWidget,
        );
        expect(
          find.descendant(
            of: find.byType(MeshHeader),
            matching: find.text('RUSA'),
          ),
          findsNothing,
        );
        // No actor open → no actor actions overflow.
        expect(find.byIcon(Icons.more_vert), findsNothing);

        await tester.tap(find.byIcon(Icons.menu));
        await tester.pump();
        await tester.pump(const Duration(milliseconds: 400));
        expect(find.byType(BrandMark), findsOneWidget);
        expect(find.text('RUSA'), findsOneWidget);

        await store.dispose();
      });
    });

    testWidgets('the phone landing view names the overview too', (
      tester,
    ) async {
      await tester.runAsync(() async {
        final store = await _store();
        await _pump(tester, store, size: const Size(390, 844));

        expect(
          find.descendant(
            of: find.byType(MeshHeader),
            matching: find.text('Overview'),
          ),
          findsOneWidget,
        );

        await store.dispose();
      });
    });
  });

  group('phone actor detail', () {
    testWidgets('the app bar shows back + avatar + handle', (tester) async {
      await tester.runAsync(() async {
        final store = await _store();
        await _pump(tester, store, size: const Size(390, 844));
        await _goToActors(tester);
        await _openActor(tester, store);

        expect(find.byIcon(Icons.arrow_back), findsOneWidget);
        expect(find.byIcon(Icons.menu), findsNothing);
        expect(
          find.descendant(
            of: find.byType(MeshHeader),
            matching: find.byType(ActorAvatar),
          ),
          findsOneWidget,
        );
        expect(
          find.descendant(
            of: find.byType(MeshHeader),
            matching: find.text('$_actorId-handle'),
          ),
          findsOneWidget,
        );
        // The page name gives way to the actor identity.
        expect(
          find.descendant(
            of: find.byType(MeshHeader),
            matching: find.text('Actors'),
          ),
          findsNothing,
        );

        await store.dispose();
      });
    });

    testWidgets(
      'the header owns each actor status while the phone body omits identity',
      (tester) async {
        await tester.runAsync(() async {
          const cases = [
            (label: 'IDLE', status: 'active', runState: RunState.idle),
            (label: 'RUNNING', status: 'active', runState: RunState.running),
            (label: 'QUEUED', status: 'active', runState: RunState.queued),
            (label: 'RETIRED', status: 'retired', runState: RunState.idle),
          ];

          for (final testCase in cases) {
            final api = FakeApi()
              ..threadsResult = [
                makeThread(
                  _actorId,
                  created: 't0',
                  status: testCase.status,
                  runState: testCase.runState,
                ),
              ];
            final store = DashboardStore(api: api, stream: FakeStream());
            await store.init();

            await _pump(tester, store, size: const Size(390, 844));
            await _goToActors(tester);
            await _openActor(tester, store);

            expect(
              find.descendant(
                of: find.byType(MeshHeader),
                matching: find.text(testCase.label),
              ),
              findsOneWidget,
            );
            expect(
              find.descendant(
                of: find.byType(DetailPanel),
                matching: find.text(testCase.label),
              ),
              findsNothing,
            );
            expect(
              find.descendant(
                of: find.byType(DetailPanel),
                matching: find.text('$_actorId-handle'),
              ),
              findsNothing,
            );
            expect(
              find.descendant(
                of: find.byType(DetailPanel),
                matching: find.text(_actorId),
              ),
              findsNothing,
            );
            expect(
              find.descendant(
                of: find.byType(DetailPanel),
                matching: find.byType(ActorAvatar),
              ),
              findsNothing,
            );

            await store.dispose();
          }
        });
      },
    );

    testWidgets(
      'the header chip tracks live run-state deltas while the detail stays open',
      (tester) async {
        await tester.runAsync(() async {
          final api = FakeApi()
            ..runtimeCursor = const RuntimeCursor(
              streamId: 'stream-a',
              revision: 0,
            )
            ..threadsResult = [
              makeThread(_actorId, created: 't0', runState: RunState.idle),
            ];
          final stream = FakeStream();
          final store = DashboardStore(api: api, stream: stream);
          await store.init();
          await _pump(tester, store, size: const Size(390, 844));
          await _goToActors(tester);
          await _openActor(tester, store);

          Finder headerChip(String label) => find.descendant(
            of: find.byType(MeshHeader),
            matching: find.text(label),
          );

          expect(headerChip('IDLE'), findsOneWidget);

          // The authoritative stream moves the actor through each live run
          // state; with no navigation or other interaction, the relocated
          // header chip must follow each delta. A queued delta also makes the
          // store re-fetch the thread snapshot for pacing, so the fake server
          // is kept in agreement with the delta it just emitted — otherwise
          // the stale seed would legitimately win the chip back.
          const transitions = [
            (revision: 1, runState: RunState.running, label: 'RUNNING'),
            (revision: 2, runState: RunState.queued, label: 'QUEUED'),
            (revision: 3, runState: RunState.idle, label: 'IDLE'),
          ];
          for (final step in transitions) {
            api
              ..threadsResult = [
                makeThread(_actorId, created: 't0', runState: step.runState),
              ]
              ..runtimeCursor = RuntimeCursor(
                streamId: 'stream-a',
                revision: step.revision,
              );
            stream.runtimeStatesCtrl.add(
              ActorRuntimeStateDelta(
                streamId: 'stream-a',
                revision: step.revision,
                actorId: _actorId,
                runState: step.runState,
              ),
            );
            await tester.pump(const Duration(milliseconds: 50));
            await tester.pump(const Duration(milliseconds: 50));

            expect(headerChip(step.label), findsOneWidget);
            for (final other in ['IDLE', 'RUNNING', 'QUEUED', 'RETIRED']) {
              if (other == step.label) continue;
              expect(headerChip(other), findsNothing);
            }
            // The phone body still owns no copy of the chip.
            expect(
              find.descendant(
                of: find.byType(DetailPanel),
                matching: find.text(step.label),
              ),
              findsNothing,
            );
          }

          await store.dispose();
        });
      },
    );

    testWidgets(
      'a very long actor handle bounds and ellipsizes without overflowing the header row',
      (tester) async {
        await tester.runAsync(() async {
          const longId =
              'worker-b4f33453-a67e-424f-90e7-a3edbe63f4f6-long-actor-name';
          final api = FakeApi()
            ..threadsResult = [
              makeThread(longId, created: 't0', runState: RunState.idle),
            ];
          final store = DashboardStore(api: api, stream: FakeStream());
          await store.init();

          await _pump(tester, store, size: const Size(390, 844));
          await _goToActors(tester);
          store.clickActor(longId);
          await tester.pump();
          await tester.pump(const Duration(milliseconds: 50));

          expect(tester.takeException(), isNull);

          final handleFinder = find.descendant(
            of: find.byType(MeshHeader),
            matching: find.text('$longId-handle'),
          );
          expect(handleFinder, findsOneWidget);
          final textWidget = tester.widget<Text>(handleFinder);
          expect(textWidget.overflow, TextOverflow.ellipsis);
          expect(textWidget.maxLines, 1);

          await store.dispose();
        });
      },
    );

    testWidgets('run-state actions live in an accessible overflow menu', (
      tester,
    ) async {
      await tester.runAsync(() async {
        final store = await _store();
        final api = store.api as FakeApi;
        await _pump(tester, store, size: const Size(390, 844));
        await _goToActors(tester);
        await _openActor(tester, store);

        // The button carries a tooltip (its assistive-technology name)…
        expect(find.byTooltip('Actor actions'), findsOneWidget);
        // …and the inline action left the detail body for the menu.
        expect(find.byTooltip('Run now'), findsNothing);

        await _openOverflow(tester);
        // Labelled menu rows — readable by text, hence by screen readers.
        expect(find.text('Run now'), findsOneWidget);
        expect(find.text('Interrupt'), findsNothing);
        expect(find.text('Cancel queued run'), findsNothing);

        await tester.tap(find.text('Run now'));
        await tester.pump();
        await tester.pump(const Duration(milliseconds: 50));
        expect(api.runNowCalls, [_actorId]);

        await store.dispose();
      });
    });

    testWidgets('a queued actor gets Run now and Cancel queued run', (
      tester,
    ) async {
      await tester.runAsync(() async {
        final store = await _store(runState: RunState.queued);
        final api = store.api as FakeApi;
        await _pump(tester, store, size: const Size(390, 844));
        await _goToActors(tester);
        await _openActor(tester, store);

        await _openOverflow(tester);
        expect(find.text('Run now'), findsOneWidget);
        expect(find.text('Cancel queued run'), findsOneWidget);

        await tester.tap(find.text('Cancel queued run'));
        await tester.pump();
        await tester.pump(const Duration(milliseconds: 50));
        expect(api.interruptCalls, [_actorId]);

        await store.dispose();
      });
    });

    testWidgets('a running actor gets Interrupt', (tester) async {
      await tester.runAsync(() async {
        final store = await _store(runState: RunState.running);
        final api = store.api as FakeApi;
        await _pump(tester, store, size: const Size(390, 844));
        await _goToActors(tester);
        await _openActor(tester, store);

        await _openOverflow(tester);
        expect(find.text('Interrupt'), findsOneWidget);
        expect(find.text('Run now'), findsNothing);

        await tester.tap(find.text('Interrupt'));
        await tester.pump();
        await tester.pump(const Duration(milliseconds: 50));
        expect(api.interruptCalls, [_actorId]);

        await store.dispose();
      });
    });

    testWidgets(
      'the overflow tracks run-state changes after the detail is open',
      (tester) async {
        await tester.runAsync(() async {
          final api = FakeApi()
            ..runtimeCursor = const RuntimeCursor(
              streamId: 'stream-a',
              revision: 0,
            )
            ..threadsResult = [
              makeThread(_actorId, created: 't0', runState: RunState.idle),
            ];
          final stream = FakeStream();
          final store = DashboardStore(api: api, stream: stream);
          await store.init();
          await _pump(tester, store, size: const Size(390, 844));
          await _goToActors(tester);
          await _openActor(tester, store);

          // Initial pump: idle actor → Run now only.
          await _openOverflow(tester);
          expect(find.text('Run now'), findsOneWidget);
          expect(find.text('Interrupt'), findsNothing);
          // Dismiss the menu by tapping the detail body beneath it.
          await tester.tapAt(const Offset(195, 700));
          await tester.pump(const Duration(milliseconds: 300));

          // The authoritative stream transitions the actor to running — with no
          // other interaction, the open overflow must follow.
          stream.runtimeStatesCtrl.add(
            const ActorRuntimeStateDelta(
              streamId: 'stream-a',
              revision: 1,
              actorId: _actorId,
              runState: RunState.running,
            ),
          );
          await tester.pump(const Duration(milliseconds: 50));
          await tester.pump(const Duration(milliseconds: 50));

          // Identity stays; the actions swap to the running set.
          expect(
            find.descendant(
              of: find.byType(MeshHeader),
              matching: find.text('$_actorId-handle'),
            ),
            findsOneWidget,
          );
          await _openOverflow(tester);
          expect(find.text('Interrupt'), findsOneWidget);
          expect(find.text('Run now'), findsNothing);
          await tester.tapAt(const Offset(195, 700));
          await tester.pump(const Duration(milliseconds: 300));

          // And back to idle.
          stream.runtimeStatesCtrl.add(
            const ActorRuntimeStateDelta(
              streamId: 'stream-a',
              revision: 2,
              actorId: _actorId,
              runState: RunState.idle,
            ),
          );
          await tester.pump(const Duration(milliseconds: 50));
          await tester.pump(const Duration(milliseconds: 50));

          await _openOverflow(tester);
          expect(find.text('Run now'), findsOneWidget);
          expect(find.text('Interrupt'), findsNothing);

          await store.dispose();
        });
      },
    );

    testWidgets('a retired actor offers no overflow actions', (tester) async {
      await tester.runAsync(() async {
        final api = FakeApi()
          ..threadsResult = [
            makeThread(
              _actorId,
              created: 't0',
              status: 'retired',
              runState: RunState.idle,
            ),
          ];
        final store = DashboardStore(api: api, stream: FakeStream());
        await store.init();
        await _pump(tester, store, size: const Size(390, 844));
        await _goToActors(tester);
        await _openActor(tester, store);

        expect(find.byTooltip('Actor actions'), findsNothing);
        expect(find.byIcon(Icons.more_vert), findsNothing);

        await store.dispose();
      });
    });

    testWidgets('back returns to the full-width list with the Actors title', (
      tester,
    ) async {
      await tester.runAsync(() async {
        final store = await _store();
        await _pump(tester, store, size: const Size(390, 844));
        await _goToActors(tester);
        await _openActor(tester, store);

        expect(find.byTooltip('Back'), findsOneWidget);
        await tester.tap(find.byIcon(Icons.arrow_back));
        await tester.pump();
        await tester.pump(const Duration(milliseconds: 50));

        expect(find.byType(DetailPanel), findsNothing);
        expect(find.byType(ActorTree), findsOneWidget);
        expect(find.byIcon(Icons.menu), findsOneWidget);
        expect(
          find.descendant(
            of: find.byType(MeshHeader),
            matching: find.text('Actors'),
          ),
          findsOneWidget,
        );

        await store.dispose();
      });
    });
  });

  group('desktop breakpoint', () {
    testWidgets('the header keeps the brand and gains no page title or '
        'overflow', (tester) async {
      await tester.runAsync(() async {
        final store = await _store();
        await _pump(tester, store, size: const Size(1360, 840));
        await tester.tap(find.text('Actors'));
        await tester.pump();
        await _openActor(tester, store);

        expect(find.byType(BrandMark), findsOneWidget);
        expect(find.byIcon(Icons.menu), findsNothing);
        expect(find.byIcon(Icons.more_vert), findsNothing);
        expect(find.byIcon(Icons.arrow_back), findsNothing);
        // Identity stays in the detail panel, actions stay inline there.
        expect(find.byType(DetailPanel), findsOneWidget);
        expect(
          find.descendant(
            of: find.byType(DetailPanel),
            matching: find.byTooltip('Run now'),
          ),
          findsOneWidget,
        );

        await store.dispose();
      });
    });

    testWidgets('the desktop detail keeps its inline actions for each run '
        'state', (tester) async {
      await tester.runAsync(() async {
        final store = await _store(runState: RunState.queued);
        await _pump(tester, store, size: const Size(1360, 840));
        await tester.tap(find.text('Actors'));
        await tester.pump();
        await _openActor(tester, store);

        expect(
          find.descendant(
            of: find.byType(DetailPanel),
            matching: find.byTooltip('Run now'),
          ),
          findsOneWidget,
        );
        expect(
          find.descendant(
            of: find.byType(DetailPanel),
            matching: find.byTooltip('Cancel queued run'),
          ),
          findsOneWidget,
        );
        expect(find.byTooltip('Actor actions'), findsNothing);

        await store.dispose();
      });
    });

    testWidgets('desktop retains the detail body identity and status chip', (
      tester,
    ) async {
      await tester.runAsync(() async {
        final store = await _store();
        await _pump(tester, store, size: const Size(1360, 840));
        await tester.tap(find.text('Actors'));
        await tester.pump();
        await _openActor(tester, store);

        expect(
          find.descendant(
            of: find.byType(DetailPanel),
            matching: find.byType(ActorAvatar),
          ),
          findsOneWidget,
        );
        expect(
          find.descendant(
            of: find.byType(DetailPanel),
            matching: find.text('$_actorId-handle'),
          ),
          findsOneWidget,
        );
        expect(
          find.descendant(
            of: find.byType(DetailPanel),
            matching: find.text(_actorId),
          ),
          findsOneWidget,
        );
        expect(
          find.descendant(
            of: find.byType(DetailPanel),
            matching: find.text('IDLE'),
          ),
          findsOneWidget,
        );
        expect(
          find.descendant(
            of: find.byType(MeshHeader),
            matching: find.text('IDLE'),
          ),
          findsNothing,
        );

        await store.dispose();
      });
    });
  });
}
