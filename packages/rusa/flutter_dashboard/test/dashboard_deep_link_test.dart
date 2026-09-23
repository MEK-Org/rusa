import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rusa_dashboard/app.dart';
import 'package:rusa_dashboard/dashboard_url_stub.dart';
import 'package:rusa_dashboard/session.dart';
import 'package:rusa_dashboard/store.dart';
import 'package:rusa_dashboard/widgets/dashboard_body.dart';

import 'fakes.dart';

class _TestSession extends DashboardSession {
  _TestSession({this.status = DashboardSessionStatus.signedIn});

  @override
  DashboardSessionStatus status;

  @override
  bool get authenticationEnabled => true;

  @override
  String? get csrfToken => null;

  @override
  bool get isIdle => false;

  @override
  String? get profilePhotoUrl => null;

  @override
  String? get browserTitle => null;

  @override
  String? get errorMessage => null;

  @override
  Future<void> requireAuthentication() async {}

  @override
  Future<void> signIn() async {
    status = DashboardSessionStatus.signedIn;
    notifyListeners();
  }

  @override
  Future<void> signOut() async {
    status = DashboardSessionStatus.signedOut;
    notifyListeners();
  }

  @override
  Future<void> visit() async {}

  @override
  void idleFromServer() {}

  @override
  Future<void> checkSession() async {}
}

Widget _testDashboardBody(DashboardStore store) => Scaffold(
  body: DashboardBody(
    store: store,
    understandingBuilder: (_) => const SizedBox(),
    reportsBuilder: (_) => const SizedBox(),
  ),
);

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    debugDashboardUrl = null;
  });

  tearDown(() {
    debugDashboardUrl = null;
  });

  testWidgets(
    'does not overwrite initial deep link to root during async bootstrap',
    (tester) async {
      final calls = <MethodCall>[];
      final messenger =
          TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
      messenger.setMockMethodCallHandler(SystemChannels.navigation, (
        call,
      ) async {
        calls.add(call);
        return null;
      });
      addTearDown(() {
        messenger.setMockMethodCallHandler(SystemChannels.navigation, null);
        tester.platformDispatcher.clearDefaultRouteNameTestValue();
      });

      tester.platformDispatcher.defaultRouteNameTestValue = '/work/ob-123';
      final sessionCompleter = Completer<DashboardSession>();

      await tester.pumpWidget(
        RusaDashboardApp(
          session: sessionCompleter.future,
          initialRoute: '/work/ob-123',
        ),
      );

      // During async session bootstrap, Flutter Navigator must not emit a route
      // update to "/" or throw a missing-route exception.
      final rootUpdates = calls.where(
        (c) =>
            c.method == 'routeInformationUpdated' &&
            c.arguments is Map &&
            (c.arguments as Map)['uri'] == '/',
      );
      expect(rootUpdates, isEmpty);
    },
  );

  testWidgets(
    'preserves /work/<id> deep link through cold authenticated load',
    (tester) async {
      await tester.runAsync(() async {
        final calls = <MethodCall>[];
        final messenger =
            TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
        messenger.setMockMethodCallHandler(SystemChannels.navigation, (
          call,
        ) async {
          calls.add(call);
          return null;
        });
        addTearDown(() {
          messenger.setMockMethodCallHandler(SystemChannels.navigation, null);
          tester.platformDispatcher.clearDefaultRouteNameTestValue();
        });

        tester.platformDispatcher.defaultRouteNameTestValue =
            '/work/ob-focused';
        debugDashboardUrl = '/work/ob-focused';

        final api = FakeApi();
        final store = DashboardStore(api: api, stream: FakeStream());
        await store.init();

        final session = _TestSession(status: DashboardSessionStatus.signedIn);

        await tester.pumpWidget(
          RusaDashboardApp(
            session: Future.value(session),
            initialRoute: '/work/ob-focused',
            pageBuilder: (_, _) => _testDashboardBody(store),
          ),
        );
        await tester.pump();
        await tester.pump(const Duration(milliseconds: 50));

        expect(find.byType(DashboardBody), findsOneWidget);
        expect(store.focusedObligationId.value, 'ob-focused');
        expect(debugDashboardUrl, '/work/ob-focused');

        await store.dispose();
      });
    },
  );

  testWidgets(
    'preserves /actors/<id> deep link through cold authenticated load',
    (tester) async {
      await tester.runAsync(() async {
        final calls = <MethodCall>[];
        final messenger =
            TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
        messenger.setMockMethodCallHandler(SystemChannels.navigation, (
          call,
        ) async {
          calls.add(call);
          return null;
        });
        addTearDown(() {
          messenger.setMockMethodCallHandler(SystemChannels.navigation, null);
          tester.platformDispatcher.clearDefaultRouteNameTestValue();
        });

        tester.platformDispatcher.defaultRouteNameTestValue =
            '/actors/actor-99';
        debugDashboardUrl = '/actors/actor-99';

        final api = FakeApi()..threadsResult = [makeThread('actor-99')];
        final store = DashboardStore(api: api, stream: FakeStream());
        await store.init();

        final session = _TestSession(status: DashboardSessionStatus.signedIn);

        await tester.pumpWidget(
          RusaDashboardApp(
            session: Future.value(session),
            initialRoute: '/actors/actor-99',
            pageBuilder: (_, _) => _testDashboardBody(store),
          ),
        );
        await tester.pump();
        await tester.pump(const Duration(milliseconds: 50));

        expect(find.byType(DashboardBody), findsOneWidget);
        expect(store.primary.value, 'actor-99');
        expect(debugDashboardUrl, '/actors/actor-99');

        await store.dispose();
      });
    },
  );

  testWidgets(
    'preserves /work/<id> destination through signed-out to signed-in transition',
    (tester) async {
      await tester.runAsync(() async {
        final calls = <MethodCall>[];
        final messenger =
            TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
        messenger.setMockMethodCallHandler(SystemChannels.navigation, (
          call,
        ) async {
          calls.add(call);
          return null;
        });
        addTearDown(() {
          messenger.setMockMethodCallHandler(SystemChannels.navigation, null);
          tester.platformDispatcher.clearDefaultRouteNameTestValue();
        });

        tester.platformDispatcher.defaultRouteNameTestValue =
            '/work/ob-deferred';
        debugDashboardUrl = '/work/ob-deferred';

        final api = FakeApi();
        final store = DashboardStore(api: api, stream: FakeStream());
        await store.init();

        final session = _TestSession(status: DashboardSessionStatus.signedOut);

        await tester.pumpWidget(
          RusaDashboardApp(
            session: Future.value(session),
            initialRoute: '/work/ob-deferred',
            pageBuilder: (_, _) => _testDashboardBody(store),
          ),
        );
        await tester.pump();

        // While signed out, SignInPage is displayed and URL is preserved.
        expect(find.byType(SignInPage), findsOneWidget);
        expect(find.byType(DashboardBody), findsNothing);
        expect(debugDashboardUrl, '/work/ob-deferred');

        // User signs in with Google.
        await tester.tap(
          find.widgetWithText(FilledButton, 'Sign in with Google'),
        );
        await tester.pump();
        await tester.pump(const Duration(milliseconds: 50));

        // After sign-in, DashboardBody mounts and retains the deep link.
        expect(find.byType(SignInPage), findsNothing);
        expect(find.byType(DashboardBody), findsOneWidget);
        expect(store.focusedObligationId.value, 'ob-deferred');
        expect(debugDashboardUrl, '/work/ob-deferred');

        await store.dispose();
      });
    },
  );

  testWidgets(
    'preserves /actors/<id> destination through signed-out to signed-in transition',
    (tester) async {
      await tester.runAsync(() async {
        final calls = <MethodCall>[];
        final messenger =
            TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
        messenger.setMockMethodCallHandler(SystemChannels.navigation, (
          call,
        ) async {
          calls.add(call);
          return null;
        });
        addTearDown(() {
          messenger.setMockMethodCallHandler(SystemChannels.navigation, null);
          tester.platformDispatcher.clearDefaultRouteNameTestValue();
        });

        tester.platformDispatcher.defaultRouteNameTestValue =
            '/actors/actor-login';
        debugDashboardUrl = '/actors/actor-login';

        final api = FakeApi()..threadsResult = [makeThread('actor-login')];
        final store = DashboardStore(api: api, stream: FakeStream());
        await store.init();

        final session = _TestSession(status: DashboardSessionStatus.signedOut);

        await tester.pumpWidget(
          RusaDashboardApp(
            session: Future.value(session),
            initialRoute: '/actors/actor-login',
            pageBuilder: (_, _) => _testDashboardBody(store),
          ),
        );
        await tester.pump();

        expect(find.byType(SignInPage), findsOneWidget);
        expect(find.byType(DashboardBody), findsNothing);
        expect(debugDashboardUrl, '/actors/actor-login');

        // User signs in.
        await tester.tap(
          find.widgetWithText(FilledButton, 'Sign in with Google'),
        );
        await tester.pump();
        await tester.pump(const Duration(milliseconds: 50));

        expect(find.byType(SignInPage), findsNothing);
        expect(find.byType(DashboardBody), findsOneWidget);
        expect(store.primary.value, 'actor-login');
        expect(debugDashboardUrl, '/actors/actor-login');

        await store.dispose();
      });
    },
  );

  testWidgets('operates normally in local/no-auth mode', (tester) async {
    await tester.runAsync(() async {
      final calls = <MethodCall>[];
      final messenger =
          TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
      messenger.setMockMethodCallHandler(SystemChannels.navigation, (
        call,
      ) async {
        calls.add(call);
        return null;
      });
      addTearDown(() {
        messenger.setMockMethodCallHandler(SystemChannels.navigation, null);
        tester.platformDispatcher.clearDefaultRouteNameTestValue();
      });

      tester.platformDispatcher.defaultRouteNameTestValue = '/work/ob-local';
      debugDashboardUrl = '/work/ob-local';

      final api = FakeApi();
      final store = DashboardStore(api: api, stream: FakeStream());
      await store.init();

      final session = LocalDashboardSession();

      await tester.pumpWidget(
        RusaDashboardApp(
          session: Future.value(session),
          initialRoute: '/work/ob-local',
          pageBuilder: (_, _) => _testDashboardBody(store),
        ),
      );
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 50));

      expect(find.byType(DashboardBody), findsOneWidget);
      expect(store.focusedObligationId.value, 'ob-local');
      expect(debugDashboardUrl, '/work/ob-local');

      await store.dispose();
    });
  });
}
