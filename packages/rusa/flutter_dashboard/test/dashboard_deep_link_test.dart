import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rusa_dashboard/app.dart';
import 'package:rusa_dashboard/dashboard_url_core.dart';
import 'package:rusa_dashboard/dashboard_url_stub.dart';
import 'package:rusa_dashboard/session.dart';
import 'package:rusa_dashboard/store.dart';
import 'package:rusa_dashboard/widgets/dashboard_body.dart';
import 'package:rusa_dashboard/widgets/header.dart';

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

  group('dashboard URL core parsing and building', () {
    test('parses known views from URIs', () {
      expect(parseDashboardView(Uri.parse('/actors')), DashboardView.actors);
      expect(
        parseDashboardView(Uri.parse('/actors/sub')),
        DashboardView.actors,
      );
      expect(
        parseDashboardView(Uri.parse('/understanding')),
        DashboardView.understanding,
      );
      expect(parseDashboardView(Uri.parse('/reports')), DashboardView.reports);
      expect(parseDashboardView(Uri.parse('/work')), DashboardView.work);
      expect(
        parseDashboardView(Uri.parse('/work/ob-123')),
        DashboardView.work,
      );
      expect(parseDashboardView(Uri.parse('/overview')), DashboardView.overview);
      expect(parseDashboardView(Uri.parse('/')), isNull);
    });

    test('extracts and percent-decodes focused IDs', () {
      expect(
        parseFocusedObligationId(Uri.parse('/work/ob%2Dfocused')),
        'ob-focused',
      );
      expect(
        parseFocusedObligationId(Uri.parse('/?obligation=ob%2Dlegacy')),
        'ob-legacy',
      );
      expect(parseFocusedObligationId(Uri.parse('/overview')), isNull);

      expect(
        parseFocusedActorId(Uri.parse('/actors/actor%2D99')),
        'actor-99',
      );
      expect(parseFocusedActorId(Uri.parse('/work/ob-1')), isNull);
    });

    test('builds updated dashboard URIs', () {
      final base = Uri.parse('/work/ob-1?other=keep&obligation=drop');
      final updated = buildDashboardUri(
        base,
        DashboardView.actors,
        focusedActorId: 'actor-2',
      );
      expect(updated.path, '/actors/actor-2');
      expect(updated.queryParameters, {'other': 'keep'});
    });
  });

  group('deep link navigation and routing', () {
    testWidgets(
      'does not overwrite initial deep link to root during async bootstrap',
      (tester) async {
        addTearDown(() {
          tester.platformDispatcher.clearDefaultRouteNameTestValue();
        });

        tester.platformDispatcher.defaultRouteNameTestValue = '/work/ob-123';
        final sessionCompleter = Completer<DashboardSession>();

        await tester.pumpWidget(
          RusaDashboardApp(
            bootstrapSession: () => sessionCompleter.future,
            pageBuilder: (_, session) => const SizedBox(),
          ),
        );

        // During async session bootstrap, Flutter Navigator must not emit a route
        // update to "/" or throw a missing-route exception.
        final rootUpdates = recordedNavCalls.where(
          (c) =>
              c.method == 'routeInformationUpdated' &&
              c.arguments is Map &&
              (c.arguments as Map)['uri'] == '/',
        );
        expect(rootUpdates, isEmpty);
      },
    );

    for (final (path, expectedId, isWork) in [
      ('/work/ob-focused', 'ob-focused', true),
      ('/actors/actor-99', 'actor-99', false),
    ]) {
      testWidgets(
        'preserves $path deep link through cold authenticated load',
        (tester) async {
          await tester.runAsync(() async {
            addTearDown(() {
              tester.platformDispatcher.clearDefaultRouteNameTestValue();
            });

            tester.platformDispatcher.defaultRouteNameTestValue = path;
            debugDashboardUrl = path;

            final api = FakeApi();
            if (!isWork) {
              api.threadsResult = [makeThread(expectedId)];
            }
            final store = DashboardStore(api: api, stream: FakeStream());
            await store.init();

            final session = _TestSession(
              status: DashboardSessionStatus.signedIn,
            );

            await tester.pumpWidget(
              RusaDashboardApp(
                bootstrapSession: () => Future.value(session),
                pageBuilder: (_, _) => _testDashboardBody(store),
              ),
            );
            await tester.pump();
            await tester.pump(const Duration(milliseconds: 50));

            expect(find.byType(DashboardBody), findsOneWidget);
            if (isWork) {
              expect(store.focusedObligationId.value, expectedId);
            } else {
              expect(store.primary.value, expectedId);
            }
            expect(debugDashboardUrl, path);

            await store.dispose();
          });
        },
      );
    }

    for (final (path, expectedId, isWork) in [
      ('/work/ob-deferred', 'ob-deferred', true),
      ('/actors/actor-login', 'actor-login', false),
    ]) {
      testWidgets(
        'preserves $path destination through signed-out to signed-in transition',
        (tester) async {
          await tester.runAsync(() async {
            addTearDown(() {
              tester.platformDispatcher.clearDefaultRouteNameTestValue();
            });

            tester.platformDispatcher.defaultRouteNameTestValue = path;
            debugDashboardUrl = path;

            final api = FakeApi();
            if (!isWork) {
              api.threadsResult = [makeThread(expectedId)];
            }
            final store = DashboardStore(api: api, stream: FakeStream());
            await store.init();

            final session = _TestSession(
              status: DashboardSessionStatus.signedOut,
            );

            await tester.pumpWidget(
              RusaDashboardApp(
                bootstrapSession: () => Future.value(session),
                pageBuilder: (_, _) => _testDashboardBody(store),
              ),
            );
            await tester.pump();

            // While signed out, SignInPage is displayed and URL is preserved.
            expect(find.byType(SignInPage), findsOneWidget);
            expect(find.byType(DashboardBody), findsNothing);
            expect(debugDashboardUrl, path);

            // User signs in with Google.
            await tester.tap(
              find.widgetWithText(FilledButton, 'Sign in with Google'),
            );
            await tester.pump();
            await tester.pump(const Duration(milliseconds: 50));

            // After sign-in, DashboardBody mounts and retains the deep link.
            expect(find.byType(SignInPage), findsNothing);
            expect(find.byType(DashboardBody), findsOneWidget);
            if (isWork) {
              expect(store.focusedObligationId.value, expectedId);
            } else {
              expect(store.primary.value, expectedId);
            }
            expect(debugDashboardUrl, path);

            await store.dispose();
          });
        },
      );
    }

    testWidgets('operates normally in local/no-auth mode', (tester) async {
      await tester.runAsync(() async {
        addTearDown(() {
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
            bootstrapSession: () => Future.value(session),
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

    testWidgets(
      'renders auth startup error cleanly when bootstrapSession throws',
      (tester) async {
        await tester.pumpWidget(
          RusaDashboardApp(
            bootstrapSession: () =>
                Future.error(Exception('Failed to reach auth provider')),
            pageBuilder: (_, _) => const SizedBox(),
          ),
        );
        await tester.pump();

        expect(
          find.text('Unable to connect to Rusa. Please reload and try again.'),
          findsOneWidget,
        );
      },
    );
  });
}
