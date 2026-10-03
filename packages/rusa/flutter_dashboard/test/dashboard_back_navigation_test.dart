import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rusa_dashboard/app.dart';
import 'package:rusa_dashboard/dashboard_url.dart';
import 'package:rusa_dashboard/session.dart';
import 'package:rusa_dashboard/store.dart';
import 'package:rusa_dashboard/widgets/chat_room.dart';
import 'package:rusa_dashboard/widgets/dashboard_body.dart';
import 'package:rusa_dashboard/widgets/overview_tab.dart';
import 'package:rusa_dashboard/widgets/work_tab.dart';

import 'fakes.dart';

final _navCalls = <MethodCall>[];

/// Session renewals requested through `DashboardBody.onNavigation`, which
/// `main.dart` wires to `DashboardSession.visit`.
var _visits = 0;

/// The `routeInformationUpdated` calls recorded since the last clear, as
/// `(uri, replace)` pairs.
List<(String, bool)> _urlWrites() => [
  for (final c in _navCalls)
    if (c.method == 'routeInformationUpdated')
      (
        (c.arguments as Map)['uri'] as String,
        (c.arguments as Map)['replace'] as bool,
      ),
];

/// Mounts the real [RusaDashboardApp] (and so its Router) at [initialUrl],
/// runs [body], and tears the store and test-view overrides down afterwards.
Future<void> _withDashboard(
  WidgetTester tester, {
  required String initialUrl,
  FakeApi? api,
  required Future<void> Function(DashboardStore store) body,
}) async {
  await tester.runAsync(() async {
    addTearDown(() {
      tester.platformDispatcher.clearDefaultRouteNameTestValue();
      tester.view.resetPhysicalSize();
      tester.view.resetDevicePixelRatio();
    });
    final store = DashboardStore(
      api: api ?? (FakeApi()..chatRoomParticipants = ['root']),
      stream: FakeStream(),
    );
    await store.init();

    tester.platformDispatcher.defaultRouteNameTestValue = initialUrl;
    debugDashboardUrl = initialUrl;
    tester.view.physicalSize = const Size(1200, 800);
    tester.view.devicePixelRatio = 1.0;
    await tester.pumpWidget(
      RusaDashboardApp(
        bootstrapSession: () => Future.value(LocalDashboardSession()),
        pageBuilder: (_, _) => Scaffold(
          body: DashboardBody(
            store: store,
            onNavigation: () async => _visits++,
            understandingBuilder: (_) => const SizedBox(),
            reportsBuilder: (_) => const SizedBox(),
          ),
        ),
      ),
    );
    await _settle(tester);

    await body(store);
    await store.dispose();
  });
}

Future<void> _settle(WidgetTester tester) async {
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 50));
}

Future<void> _tapNav(WidgetTester tester, String label) async {
  await tester.tap(find.widgetWithText(InkWell, label));
  await _settle(tester);
}

/// Simulates the browser restoring [url] (back/forward popstate): the address
/// bar changes first, then the engine pushes the route to the framework.
Future<void> _popTo(WidgetTester tester, String url) async {
  debugDashboardUrl = url;
  final handled = await tester.binding.handlePushRoute(url);
  expect(handled, isTrue, reason: 'the Router must accept the platform push');
  await _settle(tester);
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    debugDashboardUrl = null;
    _navCalls.clear();
    _visits = 0;
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(SystemChannels.navigation, (call) async {
          _navCalls.add(call);
          return null;
        });
  });

  tearDown(() {
    debugDashboardUrl = null;
    _navCalls.clear();
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(SystemChannels.navigation, null);
  });

  group('browser/system back navigation', () {
    testWidgets(
      'startup preserves multi-entry mode without selecting single-entry history',
      (tester) async {
        await _withDashboard(
          tester,
          initialUrl: '/overview',
          body: (_) async {
            final methods = _navCalls.map((c) => c.method);
            expect(
              methods,
              isNot(contains('selectSingleEntryHistory')),
              reason:
                  'Startup must never select single-entry history or downgrade web engine history mode',
            );
            expect(
              methods,
              contains('selectMultiEntryHistory'),
              reason: 'Engine must be placed in multi-entry history mode',
            );
          },
        );
      },
    );

    testWidgets(
      'navigating A -> Room pushes history with multi-entry mode, and system back returns to A',
      (tester) async {
        await _withDashboard(
          tester,
          initialUrl: '/overview',
          body: (_) async {
            expect(find.byType(OverviewTab), findsOneWidget);
            expect(find.byType(ChatRoomTab), findsNothing);
            expect(
              _visits,
              0,
              reason: 'Loading the addressed view is no visit',
            );
            _navCalls.clear();

            await _tapNav(tester, 'Room');
            expect(_visits, 1, reason: 'The Room tap renews the session');
            expect(find.byType(ChatRoomTab), findsOneWidget);
            expect(find.byType(OverviewTab), findsNothing);
            expect(
              _urlWrites(),
              contains(('/chat-room', false)),
              reason:
                  'Navigation to Room must push history entry with replace: false',
            );

            await _popTo(tester, '/overview');
            expect(
              find.byType(OverviewTab),
              findsOneWidget,
              reason:
                  'System back after Room must return to prior in-app location A (Overview)',
            );
            expect(find.byType(ChatRoomTab), findsNothing);
            expect(_visits, 2, reason: 'Browser back renews the session too');
          },
        );
      },
    );

    testWidgets(
      'the Router never writes the address, so in-app navigation has one URL writer',
      (tester) async {
        await _withDashboard(
          tester,
          initialUrl: '/overview',
          body: (_) async {
            final router = Router.of(
              tester.element(find.byType(DashboardBody)),
            );
            expect(
              router.routerDelegate.currentConfiguration,
              isNull,
              reason:
                  'A non-null configuration opts the Router into reporting, '
                  'and its copy goes stale after every in-app view change',
            );

            _navCalls.clear();
            await _tapNav(tester, 'Room');
            await _popTo(tester, '/overview');
            await _popTo(tester, '/chat-room');
            // Extra frames give any post-frame Router report a chance to run.
            await _settle(tester);

            expect(
              _urlWrites(),
              [('/chat-room', false)],
              reason:
                  'The Room tap is the only write; restoring views on '
                  'popstate must not write, and the Router must not re-report',
            );
          },
        );
      },
    );

    testWidgets(
      'platform popRoute closes an open dialog without changing the view',
      (tester) async {
        await _withDashboard(
          tester,
          initialUrl: '/overview',
          body: (_) async {
            showDialog<void>(
              context: tester.element(find.byType(DashboardBody)),
              builder: (_) => const AlertDialog(content: Text('probe dialog')),
            );
            await _settle(tester);
            expect(find.text('probe dialog'), findsOneWidget);

            _navCalls.clear();
            final handled = await tester.binding.handlePopRoute();
            await _settle(tester);
            // Let the dialog's exit transition finish.
            await tester.pump(const Duration(milliseconds: 300));

            expect(
              handled,
              isTrue,
              reason: 'The Router must dispatch popRoute to its Navigator',
            );
            expect(find.text('probe dialog'), findsNothing);
            expect(find.byType(OverviewTab), findsOneWidget);
            expect(_urlWrites(), isEmpty);
          },
        );
      },
    );

    testWidgets(
      'successive navigation Overview -> Work -> Room steps back through each location',
      (tester) async {
        await _withDashboard(
          tester,
          initialUrl: '/overview',
          body: (_) async {
            expect(find.byType(OverviewTab), findsOneWidget);

            await _tapNav(tester, 'Work');
            expect(find.byType(WorkTab), findsOneWidget);
            await _tapNav(tester, 'Room');
            expect(find.byType(ChatRoomTab), findsOneWidget);

            await _popTo(tester, '/work');
            expect(find.byType(WorkTab), findsOneWidget);
            expect(find.byType(ChatRoomTab), findsNothing);

            await _popTo(tester, '/overview');
            expect(find.byType(OverviewTab), findsOneWidget);
            expect(find.byType(WorkTab), findsNothing);
          },
        );
      },
    );

    testWidgets(
      'restoring URL without obligation focus clears focused obligation in store, UI pane, and URL',
      (tester) async {
        await _withDashboard(
          tester,
          initialUrl: '/work',
          api: FakeApi()
            ..chatRoomParticipants = ['root']
            ..obligationsResult = [makeObligation('ob-q', title: 'Task Q')],
          body: (store) async {
            expect(find.byType(WorkTab), findsOneWidget);
            expect(
              find.text('Select an obligation from the tree.'),
              findsOneWidget,
            );

            _navCalls.clear();
            store.setFocusedObligationId('ob-q');
            await _settle(tester);
            expect(store.focusedObligationId.valueOrNull, 'ob-q');
            expect(find.text('Task Q'), findsWidgets);
            expect(
              find.text('Select an obligation from the tree.'),
              findsNothing,
            );
            expect(
              _urlWrites().last,
              ('/work/ob-q', true),
              reason: 'In-view focus updates rewrite the address in place',
            );

            await _tapNav(tester, 'Room');
            expect(find.byType(ChatRoomTab), findsOneWidget);
            expect(_urlWrites().last, ('/chat-room', false));

            await _popTo(tester, '/work/ob-q');
            expect(find.byType(WorkTab), findsOneWidget);
            expect(store.focusedObligationId.valueOrNull, 'ob-q');
            expect(find.text('Task Q'), findsWidgets);
            expect(
              find.text('Select an obligation from the tree.'),
              findsNothing,
            );

            _navCalls.clear();
            await _popTo(tester, '/work');
            expect(find.byType(WorkTab), findsOneWidget);
            expect(
              store.focusedObligationId.valueOrNull,
              isNull,
              reason:
                  'Popping to bare /work must clear focused obligation in store',
            );
            expect(
              find.text('Select an obligation from the tree.'),
              findsOneWidget,
              reason:
                  'Detail pane must be cleared back to empty selection state',
            );
            expect(
              _urlWrites(),
              everyElement(('/work', true)),
              reason:
                  'Clearing the focus re-states bare /work in place, never '
                  'pushing or writing a stale focused address',
            );
          },
        );
      },
    );

    testWidgets(
      'direct deep link to /chat-room lands on Room without fabricating Overview',
      (tester) async {
        await _withDashboard(
          tester,
          initialUrl: '/chat-room',
          body: (_) async {
            expect(find.byType(ChatRoomTab), findsOneWidget);
            expect(find.byType(OverviewTab), findsNothing);
            expect(
              _urlWrites().map((w) => w.$1),
              everyElement('/chat-room'),
              reason: 'Startup must not rewrite the deep link to another view',
            );
          },
        );
      },
    );
  });
}
