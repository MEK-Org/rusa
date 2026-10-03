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

Widget _testDashboardApp({required DashboardStore store}) {
  return RusaDashboardApp(
    bootstrapSession: () => Future.value(LocalDashboardSession()),
    pageBuilder: (_, _) => Scaffold(
      body: DashboardBody(
        store: store,
        understandingBuilder: (_) => const SizedBox(),
        reportsBuilder: (_) => const SizedBox(),
      ),
    ),
  );
}

Future<void> _pumpDashboard(
  WidgetTester tester, {
  required DashboardStore store,
  String initialUrl = '/overview',
  Size size = const Size(1200, 800),
}) async {
  tester.platformDispatcher.defaultRouteNameTestValue = initialUrl;
  debugDashboardUrl = initialUrl;
  tester.view.physicalSize = size;
  tester.view.devicePixelRatio = 1.0;

  await tester.pumpWidget(_testDashboardApp(store: store));
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 50));
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  final recordedNavCalls = <MethodCall>[];

  setUp(() {
    debugDashboardUrl = null;
    recordedNavCalls.clear();
    final messenger =
        TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
    messenger.setMockMethodCallHandler(SystemChannels.navigation, (call) async {
      recordedNavCalls.add(call);
      return null;
    });
  });

  tearDown(() {
    debugDashboardUrl = null;
    recordedNavCalls.clear();
    final messenger =
        TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
    messenger.setMockMethodCallHandler(SystemChannels.navigation, null);
  });

  group('browser/system back navigation', () {
    testWidgets(
      'navigating A -> Room pushes history with multi-entry mode, and system back returns to A',
      (tester) async {
        await tester.runAsync(() async {
          addTearDown(() {
            tester.platformDispatcher.clearDefaultRouteNameTestValue();
            tester.view.resetPhysicalSize();
            tester.view.resetDevicePixelRatio();
          });

          final api = FakeApi()..chatRoomParticipants = ['root'];
          final store = DashboardStore(api: api, stream: FakeStream());
          await store.init();

          await _pumpDashboard(tester, store: store, initialUrl: '/overview');

          // Initially on Overview
          expect(find.byType(OverviewTab), findsOneWidget);
          expect(find.byType(ChatRoomTab), findsNothing);

          recordedNavCalls.clear();

          // Navigate from Overview (A) to Room
          final roomNavButton = find.widgetWithText(InkWell, 'Room');
          expect(roomNavButton, findsOneWidget);
          await tester.tap(roomNavButton);
          await tester.pump();
          await tester.pump(const Duration(milliseconds: 50));

          // Verify Room is now displayed
          expect(find.byType(ChatRoomTab), findsOneWidget);
          expect(find.byType(OverviewTab), findsNothing);

          // Verify that navigation pushed history (replace: false)
          final pushUpdates = recordedNavCalls.where(
            (c) =>
                c.method == 'routeInformationUpdated' &&
                c.arguments is Map &&
                (c.arguments as Map)['uri'] == '/chat-room' &&
                (c.arguments as Map)['replace'] == false,
          );
          expect(
            pushUpdates,
            isNotEmpty,
            reason: 'Navigation to Room must push history entry with replace: false',
          );

          // Simulate browser / system back popping back to /overview
          final handled = await tester.binding.handlePushRoute('/overview');
          expect(handled, isTrue, reason: 'DashboardRouteScope must handle push route');
          await tester.pump();
          await tester.pump(const Duration(milliseconds: 50));

          // Acceptance criterion: system back returns to prior location A (Overview)
          expect(
            find.byType(OverviewTab),
            findsOneWidget,
            reason: 'System back after Room must return to prior in-app location A (Overview)',
          );
          expect(find.byType(ChatRoomTab), findsNothing);

          await store.dispose();
        });
      },
    );

    testWidgets(
      'successive navigation Overview -> Work -> Room steps back through each location',
      (tester) async {
        await tester.runAsync(() async {
          addTearDown(() {
            tester.platformDispatcher.clearDefaultRouteNameTestValue();
            tester.view.resetPhysicalSize();
            tester.view.resetDevicePixelRatio();
          });

          final api = FakeApi()..chatRoomParticipants = ['root'];
          final store = DashboardStore(api: api, stream: FakeStream());
          await store.init();

          await _pumpDashboard(tester, store: store, initialUrl: '/overview');

          expect(find.byType(OverviewTab), findsOneWidget);

          // 1. Navigate to Work
          await tester.tap(find.widgetWithText(InkWell, 'Work'));
          await tester.pump();
          await tester.pump(const Duration(milliseconds: 50));
          expect(find.byType(WorkTab), findsOneWidget);

          // 2. Navigate to Room
          await tester.tap(find.widgetWithText(InkWell, 'Room'));
          await tester.pump();
          await tester.pump(const Duration(milliseconds: 50));
          expect(find.byType(ChatRoomTab), findsOneWidget);

          // 3. First back -> returns to Work
          await tester.binding.handlePushRoute('/work');
          await tester.pump();
          await tester.pump(const Duration(milliseconds: 50));
          expect(find.byType(WorkTab), findsOneWidget);
          expect(find.byType(ChatRoomTab), findsNothing);

          // 4. Second back -> returns to Overview
          await tester.binding.handlePushRoute('/overview');
          await tester.pump();
          await tester.pump(const Duration(milliseconds: 50));
          expect(find.byType(OverviewTab), findsOneWidget);
          expect(find.byType(WorkTab), findsNothing);

          await store.dispose();
        });
      },
    );

    testWidgets(
      'restoring URL without obligation focus clears focused obligation in store and UI',
      (tester) async {
        await tester.runAsync(() async {
          addTearDown(() {
            tester.platformDispatcher.clearDefaultRouteNameTestValue();
            tester.view.resetPhysicalSize();
            tester.view.resetDevicePixelRatio();
          });

          final api = FakeApi()..chatRoomParticipants = ['root'];
          final store = DashboardStore(api: api, stream: FakeStream());
          await store.init();

          await _pumpDashboard(tester, store: store, initialUrl: '/work');
          expect(find.byType(WorkTab), findsOneWidget);

          // Focus obligation Q (simulating in-view focus selection)
          store.setFocusedObligationId('ob-q');
          await tester.pump();
          await tester.pump(const Duration(milliseconds: 50));
          expect(store.focusedObligationId.valueOrNull, 'ob-q');

          // Navigate to Room
          await tester.tap(find.widgetWithText(InkWell, 'Room'));
          await tester.pump();
          await tester.pump(const Duration(milliseconds: 50));
          expect(find.byType(ChatRoomTab), findsOneWidget);

          // Back to /work/ob-q restores WorkTab with obligation focused
          await tester.binding.handlePushRoute('/work/ob-q');
          await tester.pump();
          await tester.pump(const Duration(milliseconds: 50));
          expect(find.byType(WorkTab), findsOneWidget);
          expect(store.focusedObligationId.valueOrNull, 'ob-q');

          // Back to original bare /work clears focused obligation in store
          await tester.binding.handlePushRoute('/work');
          await tester.pump();
          await tester.pump(const Duration(milliseconds: 50));
          expect(find.byType(WorkTab), findsOneWidget);
          expect(
            store.focusedObligationId.valueOrNull,
            isNull,
            reason: 'Popping to bare /work must clear focused obligation in store',
          );

          await store.dispose();
        });
      },
    );

    testWidgets(
      'focus updates within tab update URL in place with replace: true',
      (tester) async {
        await tester.runAsync(() async {
          addTearDown(() {
            tester.platformDispatcher.clearDefaultRouteNameTestValue();
            tester.view.resetPhysicalSize();
            tester.view.resetDevicePixelRatio();
          });

          final api = FakeApi();
          final store = DashboardStore(api: api, stream: FakeStream());
          await store.init();

          await _pumpDashboard(tester, store: store, initialUrl: '/work');

          recordedNavCalls.clear();

          // Change obligation focus within Work tab
          store.setFocusedObligationId('ob-focused-1');
          await tester.pump();
          await tester.pump(const Duration(milliseconds: 50));

          // Focus change must use replace: true (does not push history)
          final focusCalls = recordedNavCalls.where(
            (c) =>
                c.method == 'routeInformationUpdated' &&
                c.arguments is Map &&
                (c.arguments as Map)['uri'] == '/work/ob-focused-1',
          );
          expect(focusCalls, isNotEmpty);
          expect(
            (focusCalls.last.arguments as Map)['replace'],
            isTrue,
            reason: 'In-view focus updates must use replace: true',
          );

          await store.dispose();
        });
      },
    );

    testWidgets(
      'direct deep link to /chat-room lands on Room without fabricating Overview',
      (tester) async {
        await tester.runAsync(() async {
          addTearDown(() {
            tester.platformDispatcher.clearDefaultRouteNameTestValue();
            tester.view.resetPhysicalSize();
            tester.view.resetDevicePixelRatio();
          });

          final api = FakeApi()..chatRoomParticipants = ['root'];
          final store = DashboardStore(api: api, stream: FakeStream());
          await store.init();

          await _pumpDashboard(tester, store: store, initialUrl: '/chat-room');

          // Direct deep link displays ChatRoomTab
          expect(find.byType(ChatRoomTab), findsOneWidget);
          expect(find.byType(OverviewTab), findsNothing);

          await store.dispose();
        });
      },
    );
  });
}
