import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rusa_dashboard/app.dart';
import 'package:rusa_dashboard/dashboard_url.dart';
import 'package:rusa_dashboard/session.dart';
import 'package:rusa_dashboard/store.dart';
import 'package:rusa_dashboard/widgets/chat_room.dart';
import 'package:rusa_dashboard/widgets/dashboard_body.dart';
import 'package:rusa_dashboard/widgets/mobile_nav_drawer.dart';
import 'package:rusa_dashboard/widgets/overview_tab.dart';
import 'package:rusa_dashboard/widgets/work_tab.dart';

import 'fakes.dart';

class _TestSession extends DashboardSession {
  _TestSession();

  @override
  DashboardSessionStatus status = DashboardSessionStatus.signedIn;

  @override
  bool get authenticationEnabled => true;

  @override
  String? get csrfToken => null;

  @override
  bool get isIdle => false;

  @override
  String? get profilePhotoUrl => null;

  @override
  String get operatorDisplayName => 'Operator';

  @override
  String? get browserTitle => null;

  @override
  String? get errorMessage => null;

  @override
  Future<void> requireAuthentication() async {}

  @override
  Future<void> signIn() async {}

  @override
  Future<void> signOut() async {}

  @override
  Future<void> visit() async {}

  @override
  void idleFromServer() {}

  @override
  Future<void> checkSession() async {}
}

Widget _testDashboardApp({
  required DashboardStore store,
  required DashboardSession session,
}) {
  return RusaDashboardApp(
    bootstrapSession: () => Future.value(session),
    pageBuilder: (_, _) => Scaffold(
      body: DashboardBody(
        store: store,
        understandingBuilder: (_) => const SizedBox(),
        reportsBuilder: (_) => const SizedBox(),
      ),
    ),
  );
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
          });

          tester.platformDispatcher.defaultRouteNameTestValue = '/overview';
          debugDashboardUrl = '/overview';

          final api = FakeApi()..chatRoomParticipants = ['root'];
          final store = DashboardStore(api: api, stream: FakeStream());
          await store.init();

          final session = _TestSession();

          // Render app with wide dimensions so top nav items are visible in header.
          tester.view.physicalSize = const Size(1200, 800);
          tester.view.devicePixelRatio = 1.0;
          addTearDown(() {
            tester.view.resetPhysicalSize();
            tester.view.resetDevicePixelRatio();
          });

          await tester.pumpWidget(
            _testDashboardApp(store: store, session: session),
          );
          await tester.pump();
          await tester.pump(const Duration(milliseconds: 50));

          // Initially on Overview
          expect(find.byType(OverviewTab), findsOneWidget);
          expect(find.byType(ChatRoomTab), findsNothing);

          // Clear initial nav calls during mount
          recordedNavCalls.clear();

          // Navigate from Overview (A) to Room
          final roomNavButton = find.widgetWithText(
            InkWell,
            'Room',
          );
          expect(roomNavButton, findsOneWidget);
          await tester.tap(roomNavButton);
          await tester.pump();
          await tester.pump(const Duration(milliseconds: 50));

          // Verify Room is now displayed
          expect(find.byType(ChatRoomTab), findsOneWidget);
          expect(find.byType(OverviewTab), findsNothing);

          // Verify that navigation enabled multi-entry history and pushed (replace: false)
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

          final multiEntryCalls = recordedNavCalls.where(
            (c) => c.method == 'selectMultiEntryHistory',
          );
          expect(
            multiEntryCalls,
            isNotEmpty,
            reason: 'Navigation must ensure selectMultiEntryHistory is called',
          );

          // Simulate browser / system back popping back to /overview
          final handled = await tester.binding.handlePushRoute('/overview');
          expect(handled, isTrue, reason: 'DashboardBody must handle push route for /overview');
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
          });

          tester.platformDispatcher.defaultRouteNameTestValue = '/overview';
          debugDashboardUrl = '/overview';

          final api = FakeApi()..chatRoomParticipants = ['root'];
          final store = DashboardStore(api: api, stream: FakeStream());
          await store.init();

          final session = _TestSession();

          tester.view.physicalSize = const Size(1200, 800);
          tester.view.devicePixelRatio = 1.0;
          addTearDown(() {
            tester.view.resetPhysicalSize();
            tester.view.resetDevicePixelRatio();
          });

          await tester.pumpWidget(
            _testDashboardApp(store: store, session: session),
          );
          await tester.pump();
          await tester.pump(const Duration(milliseconds: 50));

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
      'mobile drawer navigation to Room on phone viewport returns on back',
      (tester) async {
        await tester.runAsync(() async {
          addTearDown(() {
            tester.platformDispatcher.clearDefaultRouteNameTestValue();
          });

          tester.platformDispatcher.defaultRouteNameTestValue = '/overview';
          debugDashboardUrl = '/overview';

          final api = FakeApi()..chatRoomParticipants = ['root'];
          final store = DashboardStore(api: api, stream: FakeStream());
          await store.init();

          final session = _TestSession();

          // Phone viewport (< kNarrowBreakpoint = 720)
          tester.view.physicalSize = const Size(390, 844);
          tester.view.devicePixelRatio = 1.0;
          addTearDown(() {
            tester.view.resetPhysicalSize();
            tester.view.resetDevicePixelRatio();
          });

          await tester.pumpWidget(
            _testDashboardApp(store: store, session: session),
          );
          await tester.pump();
          await tester.pump(const Duration(milliseconds: 50));

          expect(find.byType(OverviewTab), findsOneWidget);

          // Open drawer via hamburger icon
          final hamburger = find.byIcon(Icons.menu);
          expect(hamburger, findsOneWidget);
          await tester.tap(hamburger);
          await tester.pump();
          await tester.pump(const Duration(milliseconds: 300));

          // Drawer is open; tap Chat Room tile
          expect(find.byType(MobileNavDrawer), findsOneWidget);
          await tester.tap(find.widgetWithText(ListTile, 'Room'));
          await tester.pump();
          await tester.pump(const Duration(milliseconds: 300));

          // Room view is active
          expect(find.byType(ChatRoomTab), findsOneWidget);

          // Android system back returns to Overview
          await tester.binding.handlePushRoute('/overview');
          await tester.pump();
          await tester.pump(const Duration(milliseconds: 50));

          expect(find.byType(OverviewTab), findsOneWidget);
          expect(find.byType(ChatRoomTab), findsNothing);

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
          });

          tester.platformDispatcher.defaultRouteNameTestValue = '/work';
          debugDashboardUrl = '/work';

          final api = FakeApi();
          final store = DashboardStore(api: api, stream: FakeStream());
          await store.init();

          final session = _TestSession();

          tester.view.physicalSize = const Size(1200, 800);
          tester.view.devicePixelRatio = 1.0;
          addTearDown(() {
            tester.view.resetPhysicalSize();
            tester.view.resetDevicePixelRatio();
          });

          await tester.pumpWidget(
            _testDashboardApp(store: store, session: session),
          );
          await tester.pump();
          await tester.pump(const Duration(milliseconds: 50));

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
  });
}
