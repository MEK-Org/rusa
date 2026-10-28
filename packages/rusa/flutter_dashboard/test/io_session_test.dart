import 'dart:async';
import 'dart:convert';

import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'package:rusa_dashboard/io_session.dart';
import 'package:rusa_dashboard/io_session_client.dart';
import 'package:rusa_dashboard/io_sse.dart';
import 'package:rusa_dashboard/models.dart';
import 'package:rusa_dashboard/platform_bootstrap_io.dart';
import 'package:rusa_dashboard/session.dart';

/// A client whose [close] actually kills it, like package:http's IOClient.
/// MockClient's close() is a no-op, so it cannot catch a reconnect that
/// reuses a closed shared client.
class _CloseEnforcingClient extends http.BaseClient {
  _CloseEnforcingClient(this._inner);

  final http.Client _inner;
  bool _closed = false;

  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) {
    if (_closed) {
      throw http.ClientException('Client is already closed.', request.url);
    }
    return _inner.send(request);
  }

  @override
  void close() {
    _closed = true;
    _inner.close();
  }
}

class _User implements SessionUser {
  _User(this.token);

  final String token;

  @override
  String get uid => 'uid-$token';

  @override
  String? get photoUrl => null;

  @override
  String? get displayName => null;

  @override
  String? get email => null;

  @override
  Future<String> getIdToken({bool forceRefresh = false}) async => token;
}

class _Auth implements SessionAuth {
  _Auth([this.currentUser]);

  @override
  SessionUser? currentUser;
  final changes = StreamController<SessionUser?>.broadcast();
  int signOutCount = 0;

  @override
  Stream<SessionUser?> authStateChanges() => changes.stream;

  @override
  Future<SessionUser> signInWithGoogle() async =>
      currentUser = _User('google-id-token');

  @override
  Future<void> signOut() async {
    signOutCount++;
    currentUser = null;
  }
}

/// A Firebase-mode session over [inner], already signed in when [auth] holds
/// a restored user.
IoFirebaseDashboardSession _firebaseSession(
  Uri baseUrl,
  http.Client inner, {
  _Auth? auth,
  IoSessionCookieJar? cookieJar,
}) {
  final jar = cookieJar ?? IoSessionCookieJar();
  return IoFirebaseDashboardSession(
    auth ?? _Auth(),
    client: IoSessionClient(inner: inner, baseUrl: baseUrl, cookieJar: jar),
    baseUrl: baseUrl,
    cookieJar: jar,
  )..start();
}

const _meshEventFrame =
    'event: mesh_event\n'
    'data: {"id":"evt-1","ts":"2026-10-26T12:00:00Z","actorId":"actor-1","kind":"status"}\n'
    '\n';

void main() {
  group('IoSessionCookieJar', () {
    test('extracts and builds session and csrf cookies', () {
      final jar = IoSessionCookieJar();
      expect(jar.buildCookieHeader(), isNull);

      jar.updateFromHeaders({
        'set-cookie':
            '__Host-rusa_session=session_token_123; Path=/; Secure; HttpOnly, '
            '__Host-rusa_csrf=csrf_token_456; Path=/; Secure; SameSite=Strict',
      });

      expect(jar.sessionCookie, 'session_token_123');
      expect(jar.csrfToken, 'csrf_token_456');
      expect(
        jar.buildCookieHeader(),
        '__Host-rusa_session=session_token_123; __Host-rusa_csrf=csrf_token_456',
      );

      jar.clear();
      expect(jar.sessionCookie, isNull);
      expect(jar.csrfToken, isNull);
      expect(jar.buildCookieHeader(), isNull);
    });
  });

  group('IoSessionClient', () {
    test('injects origin and passes cookies at the base origin', () async {
      final baseUrl = Uri.parse('http://localhost:3000');
      final jar = IoSessionCookieJar(
        initialSessionCookie: 'sess123',
        initialCsrfToken: 'csrf456',
      );

      http.BaseRequest? captured;
      final mock = MockClient((req) async {
        captured = req;
        return http.Response(
          '{"ok":true}',
          200,
          headers: {
            'set-cookie': '__Host-rusa_csrf=new_csrf_789; Path=/; Secure',
          },
        );
      });

      final client = IoSessionClient(
        inner: mock,
        baseUrl: baseUrl,
        cookieJar: jar,
      );

      final res = await client.get(baseUrl.resolve('/api/test'));
      expect(res.statusCode, 200);
      expect(captured?.headers['Origin'], 'http://localhost:3000');
      expect(
        captured?.headers['Cookie'],
        '__Host-rusa_session=sess123; __Host-rusa_csrf=csrf456',
      );
      expect(jar.csrfToken, 'new_csrf_789');
    });

    test('attaches nothing to cross-origin requests', () async {
      final baseUrl = Uri.parse('http://localhost:3000');
      final jar = IoSessionCookieJar(
        initialSessionCookie: 'sess123',
        initialCsrfToken: 'csrf456',
      );

      http.BaseRequest? captured;
      final mock = MockClient((req) async {
        captured = req;
        return http.Response('{"ok":true}', 200);
      });

      final client = IoSessionClient(
        inner: mock,
        baseUrl: baseUrl,
        cookieJar: jar,
      );

      await client.get(Uri.parse('http://other.example/api/test'));
      expect(captured?.headers.containsKey('Origin'), isFalse);
      expect(captured?.headers.containsKey('Cookie'), isFalse);
    });

    test('projects current cookies only for same-origin framework fetches', () {
      final baseUrl = Uri.parse('https://dashboard.example.test');
      final client = IoSessionClient(
        inner: MockClient((_) async => http.Response('', 200)),
        baseUrl: baseUrl,
        cookieJar: IoSessionCookieJar(
          initialSessionCookie: 'sess123',
          initialCsrfToken: 'csrf456',
        ),
      );

      expect(
        client.headersFor(baseUrl.resolve('/api/mesh/avatar/worker.png')),
        {
          'Origin': 'https://dashboard.example.test',
          'Cookie': '__Host-rusa_session=sess123; __Host-rusa_csrf=csrf456',
        },
      );
      expect(
        client.headersFor(Uri.parse('https://other.example/avatar.png')),
        isEmpty,
      );
    });
  });

  group('IoDashboardSession', () {
    test('local mode properties', () {
      final baseUrl = Uri.parse('http://localhost:3000');
      final jar = IoSessionCookieJar();
      final session = IoDashboardSession(
        client: IoSessionClient(
          inner: MockClient((req) async => http.Response('Not found', 404)),
          baseUrl: baseUrl,
          cookieJar: jar,
        ),
        baseUrl: baseUrl,
        cookieJar: jar,
      );

      expect(session.authenticationEnabled, isFalse);
      expect(session.status, DashboardSessionStatus.local);
      expect(session.operatorDisplayName, 'Operator');
    });
  });

  group('IoFirebaseDashboardSession', () {
    final baseUrl = Uri.parse('https://dashboard.example.test');

    test(
      'page API disposal does not close the session before a later sign-in',
      () async {
        final auth = _Auth();
        final inner = _CloseEnforcingClient(
          MockClient((request) async {
            if (request.url.path == '/api/auth/csrf') {
              return http.Response(
                '{}',
                200,
                headers: {
                  'set-cookie': '__Host-rusa_csrf=csrf-1; Path=/; Secure',
                },
              );
            }
            return http.Response(
              '{}',
              200,
              headers: {
                'set-cookie': '__Host-rusa_session=session-1; Path=/; Secure',
              },
            );
          }),
        );
        final session = _firebaseSession(baseUrl, inner, auth: auth);
        final api = platformCreateDashboardApi(session);

        await session.signIn();
        await session.signOut();
        api.close(); // DashboardPage / DashboardStore disposal after sign-out.
        await session.signIn();

        expect(session.status, DashboardSessionStatus.signedIn);
        session.dispose();
      },
    );

    test('starts signedOut without a restored Firebase user', () {
      final session = _firebaseSession(
        baseUrl,
        MockClient((req) async => http.Response('Not found', 404)),
      );

      expect(session.authenticationEnabled, isTrue);
      expect(session.status, DashboardSessionStatus.signedOut);
    });

    test('signIn exchanges the Google ID token at the configured server and '
        'requires the retained cookie', () async {
      final requests = <http.Request>[];
      final session = _firebaseSession(
        baseUrl,
        MockClient((req) async {
          requests.add(req);
          switch (req.url.path) {
            case '/api/auth/csrf':
              return http.Response(
                '{"ok":true}',
                200,
                headers: {'set-cookie': '__Host-rusa_csrf=pre; Path=/'},
              );
            case '/api/auth/session' when req.method == 'POST':
              return http.Response(
                '{"authenticated":true}',
                200,
                headers: {
                  'set-cookie':
                      '__Host-rusa_session=sess; Path=/; HttpOnly, '
                      '__Host-rusa_csrf=bound; Path=/',
                },
              );
            case '/api/auth/session':
              return req.headers['Cookie']?.contains(
                        '__Host-rusa_session=sess',
                      ) ==
                      true
                  ? http.Response('{"authenticated":true}', 200)
                  : http.Response('unauthorized', 401);
          }
          return http.Response('Not found', 404);
        }),
      );

      await session.signIn();

      final exchange = requests.singleWhere(
        (r) => r.method == 'POST' && r.url.path == '/api/auth/session',
      );
      expect(exchange.url.origin, baseUrl.origin);
      expect(jsonDecode(exchange.body), {'idToken': 'google-id-token'});
      expect(exchange.headers['Origin'], baseUrl.origin);
      expect(exchange.headers['X-Rusa-CSRF'], 'pre');
      expect(requests.last.method, 'GET');
      expect(requests.last.url.path, '/api/auth/session');
      expect(session.status, DashboardSessionStatus.signedIn);
      expect(session.csrfToken, 'bound');
    });

    test('signIn fails and stays signedOut when the server refuses', () async {
      final auth = _Auth();
      final session = _firebaseSession(
        baseUrl,
        MockClient((req) async {
          if (req.url.path == '/api/auth/csrf') {
            return http.Response(
              '{"ok":true}',
              200,
              headers: {'set-cookie': '__Host-rusa_csrf=pre; Path=/'},
            );
          }
          return http.Response('unauthorized', 401);
        }),
        auth: auth,
      );

      await expectLater(session.signIn(), throwsA(isA<StateError>()));
      expect(session.status, DashboardSessionStatus.signedOut);
      expect(auth.signOutCount, 1);
    });

    test('signIn fails when the session cookie is not retained', () async {
      final auth = _Auth();
      final session = _firebaseSession(
        baseUrl,
        MockClient((req) async {
          if (req.url.path == '/api/auth/csrf') {
            return http.Response(
              '{"ok":true}',
              200,
              headers: {'set-cookie': '__Host-rusa_csrf=pre; Path=/'},
            );
          }
          if (req.method == 'POST') {
            return http.Response('{"authenticated":true}', 200);
          }
          return http.Response('unauthorized', 401);
        }),
        auth: auth,
      );

      await expectLater(session.signIn(), throwsA(isA<StateError>()));
      expect(session.status, DashboardSessionStatus.signedOut);
      expect(auth.signOutCount, 1);
    });

    test('sign out bootstraps CSRF and clears cookies', () async {
      final jar = IoSessionCookieJar(
        initialSessionCookie: 'session_xyz',
        initialCsrfToken: 'csrf_xyz',
      );
      String? csrfHeader;
      final session = _firebaseSession(
        baseUrl,
        MockClient((req) async {
          if (req.url.path == '/api/auth/csrf') {
            return http.Response(
              '{"ok":true}',
              200,
              headers: {'set-cookie': '__Host-rusa_csrf=fresh_csrf; Path=/'},
            );
          }
          if (req.url.path == '/api/auth/logout') {
            csrfHeader = req.headers['X-Rusa-CSRF'];
            return http.Response('{"ok":true}', 200);
          }
          return http.Response('{"authenticated":true}', 200);
        }),
        auth: _Auth(_User('restored')),
        cookieJar: jar,
      );
      expect(session.status, DashboardSessionStatus.signedIn);

      await session.signOut();

      expect(csrfHeader, 'fresh_csrf');
      expect(jar.sessionCookie, isNull);
      expect(jar.csrfToken, isNull);
      expect(session.status, DashboardSessionStatus.signedOut);
    });
  });

  group('bootstrapIoDashboardSession', () {
    test('returns a local session when auth is disabled', () async {
      final mock = MockClient((req) async {
        if (req.url.path == '/api/auth/config') {
          return http.Response(jsonEncode({'enabled': false}), 200);
        }
        return http.Response('Not found', 404);
      });

      final session = await bootstrapIoDashboardSession(
        baseUrl: Uri.parse('http://localhost:3000'),
        clientFactory: () => mock,
      );

      expect(session.authenticationEnabled, isFalse);
      expect(session.status, DashboardSessionStatus.local);
    });

    test(
      'initializes native auth from the served Firebase config when enabled',
      () async {
        Map<String, dynamic>? firebaseConfig;
        final mock = MockClient((req) async {
          if (req.url.path == '/api/auth/config') {
            return http.Response(
              jsonEncode({
                'enabled': true,
                'firebase': {'apiKey': 'key', 'projectId': 'project'},
              }),
              200,
            );
          }
          return http.Response('Not found', 404);
        });

        final session = await bootstrapIoDashboardSession(
          baseUrl: Uri.parse('http://localhost:3000'),
          clientFactory: () => mock,
          authFactory: (firebase) async {
            firebaseConfig = firebase;
            return _Auth();
          },
        );

        expect(firebaseConfig, {'apiKey': 'key', 'projectId': 'project'});
        expect(session, isA<IoFirebaseDashboardSession>());
        expect(session.authenticationEnabled, isTrue);
        expect(session.status, DashboardSessionStatus.signedOut);
      },
    );

    test(
      'a restored Firebase user without a retained server cookie signs out before mounting',
      () async {
        final auth = _Auth(_User('restored'));
        final requests = <http.Request>[];
        final mock = MockClient((req) async {
          requests.add(req);
          if (req.url.path == '/api/auth/config') {
            return http.Response(
              jsonEncode({'enabled': true, 'firebase': <String, dynamic>{}}),
              200,
            );
          }
          return http.Response('Not found', 404);
        });

        final session = await bootstrapIoDashboardSession(
          baseUrl: Uri.parse('http://localhost:3000'),
          clientFactory: () => mock,
          authFactory: (_) async => auth,
        );

        expect(session.status, DashboardSessionStatus.signedOut);
        expect(auth.signOutCount, 1);
        expect(requests.map((request) => request.url.path), [
          '/api/auth/config',
        ]);
      },
    );

    test('throws StateError when enabled auth has no Firebase config', () {
      final mock = MockClient((req) async {
        return http.Response(jsonEncode({'enabled': true}), 200);
      });

      expect(
        bootstrapIoDashboardSession(
          baseUrl: Uri.parse('http://localhost:3000'),
          clientFactory: () => mock,
          authFactory: (_) async => _Auth(),
        ),
        throwsA(isA<StateError>()),
      );
    });

    test('throws StateError when the server is unreachable', () {
      final mock = MockClient((req) async {
        throw http.ClientException('Connection refused', req.url);
      });

      // Transport errors propagate raw, exactly like the web bootstrap's
      // http.get; the app renders its startup error for any failure.
      expect(
        bootstrapIoDashboardSession(
          baseUrl: Uri.parse('http://localhost:3000'),
          clientFactory: () => mock,
        ),
        throwsA(isA<http.ClientException>()),
      );
    });

    test('throws StateError on a non-200 config response', () {
      final mock = MockClient((req) async {
        return http.Response('unavailable', 503);
      });

      expect(
        bootstrapIoDashboardSession(
          baseUrl: Uri.parse('http://localhost:3000'),
          clientFactory: () => mock,
        ),
        throwsA(isA<StateError>()),
      );
    });

    test(
      'throws StateError when auth config has missing or non-boolean enabled',
      () async {
        for (final invalidBody in [
          '{}',
          '{"enabled":"true"}',
          '{"enabled":null}',
          '{"enabled":1}',
        ]) {
          final mock = MockClient((req) async {
            if (req.url.path == '/api/auth/config') {
              return http.Response(invalidBody, 200);
            }
            return http.Response('Not found', 404);
          });

          expect(
            bootstrapIoDashboardSession(
              baseUrl: Uri.parse('http://localhost:3000'),
              clientFactory: () => mock,
            ),
            throwsA(isA<StateError>()),
          );
        }
      },
    );
  });

  group('IoEventSourceStream', () {
    IoDashboardSession makeSession(Uri baseUrl) => IoDashboardSession(
      client: IoSessionClient(
        inner: MockClient((req) async => http.Response('Not found', 404)),
        baseUrl: baseUrl,
      ),
      baseUrl: baseUrl,
      cookieJar: IoSessionCookieJar(),
    );

    /// A factory handing each connection a fresh close-enforcing client over
    /// a fresh SSE controller, recording every controller in [controllers].
    http.Client Function() connectionFactory(
      List<StreamController<List<int>>> controllers,
    ) {
      return () => _CloseEnforcingClient(
        MockClient.streaming((req, _) async {
          final controller = StreamController<List<int>>();
          controllers.add(controller);
          return http.StreamedResponse(
            controller.stream,
            200,
            headers: {'content-type': 'text/event-stream'},
          );
        }),
      );
    }

    test('parses SSE frames and ignores comments', () async {
      final baseUrl = Uri.parse('http://localhost:3000');
      final controller = StreamController<List<int>>();

      final mock = MockClient.streaming((req, _) async {
        return http.StreamedResponse(
          controller.stream,
          200,
          headers: {'content-type': 'text/event-stream'},
        );
      });

      final jar = IoSessionCookieJar();
      final sessionClient = IoSessionClient(
        inner: mock,
        baseUrl: baseUrl,
        cookieJar: jar,
      );
      final session = IoDashboardSession(
        client: sessionClient,
        baseUrl: baseUrl,
        cookieJar: jar,
      );

      final stream = IoEventSourceStream(
        session: session,
        baseUrl: baseUrl,
        clientFactory: () => mock,
      );

      final events = <MeshEvent>[];
      final outputs = <LiveOutputChunk>[];
      stream.meshEvents.listen(events.add);
      stream.liveOutput.listen(outputs.add);

      stream.connect(['test-actor']);
      await Future<void>.delayed(const Duration(milliseconds: 10));

      // Pump data into SSE stream
      final sampleMeshEvent = {
        'id': 'evt-1',
        'ts': '2026-10-26T12:00:00Z',
        'actorId': 'actor-1',
        'kind': 'status',
      };
      final sampleChunk = {
        'actorId': 'test-actor',
        'text': 'Hello from Android test\n',
      };

      final ssePayload =
          ': connected\n\n'
          ': heartbeat\n\n'
          'event: mesh_event\n'
          'data: ${jsonEncode(sampleMeshEvent)}\n\n'
          'event: live_output\n'
          'data: ${jsonEncode(sampleChunk)}\n\n';

      controller.add(utf8.encode(ssePayload));
      await Future<void>.delayed(const Duration(milliseconds: 50));

      expect(events.length, 1);
      expect(events.first.id, 'evt-1');
      expect(outputs.length, 1);
      expect(outputs.first.actorId, 'test-actor');
      expect(outputs.first.text, 'Hello from Android test\n');

      stream.dispose();
      await controller.close();
    });

    test(
      'survives a second connect (actor switch) with close-enforcing clients',
      () async {
        final baseUrl = Uri.parse('http://localhost:3000');
        final controllers = <StreamController<List<int>>>[];

        final stream = IoEventSourceStream(
          session: makeSession(baseUrl),
          baseUrl: baseUrl,
          clientFactory: connectionFactory(controllers),
        );

        final events = <MeshEvent>[];
        stream.meshEvents.listen(events.add);

        stream.connect(['actor-a']);
        await Future<void>.delayed(const Duration(milliseconds: 10));
        expect(controllers.length, 1);

        // Actor switch: connect() #1's client is closed. With the old shared
        // client this threw 'Client is already closed' here and on every send.
        stream.connect(['actor-b']);
        await Future<void>.delayed(const Duration(milliseconds: 10));
        expect(controllers.length, 2);

        controllers.last.add(utf8.encode(_meshEventFrame));
        await Future<void>.delayed(const Duration(milliseconds: 50));

        expect(events.length, 1);
        expect(events.first.id, 'evt-1');

        stream.dispose();
        for (final controller in controllers) {
          if (!controller.isClosed) await controller.close();
        }
      },
    );

    test(
      'reconnects with a fresh client after the server drops the stream',
      () async {
        final baseUrl = Uri.parse('http://localhost:3000');
        final controllers = <StreamController<List<int>>>[];

        final stream = IoEventSourceStream(
          session: makeSession(baseUrl),
          baseUrl: baseUrl,
          clientFactory: connectionFactory(controllers),
        );

        final events = <MeshEvent>[];
        stream.meshEvents.listen(events.add);

        stream.connect(['actor-a']);
        await Future<void>.delayed(const Duration(milliseconds: 10));
        expect(controllers.length, 1);

        await controllers.first.close();
        // The transport retries on a timer after a genuine drop.
        await Future<void>.delayed(const Duration(milliseconds: 2500));
        expect(controllers.length, 2);

        controllers.last.add(utf8.encode(_meshEventFrame));
        await Future<void>.delayed(const Duration(milliseconds: 50));
        expect(events.length, 1);

        stream.dispose();
        for (final controller in controllers) {
          if (!controller.isClosed) await controller.close();
        }
      },
    );

    test(
      'session_idle frame closes the stream and visit() reopens it',
      () async {
        final baseUrl = Uri.parse('http://localhost:3000');
        final controllers = <StreamController<List<int>>>[];

        // The server idles only authenticated streams; visit() renews.
        final session = _firebaseSession(
          baseUrl,
          MockClient((req) async => http.Response('{"ok":true}', 200)),
          auth: _Auth(_User('restored')),
          cookieJar: IoSessionCookieJar(initialCsrfToken: 'csrf'),
        );
        final stream = IoEventSourceStream(
          session: session,
          baseUrl: baseUrl,
          clientFactory: connectionFactory(controllers),
        );

        stream.connect(['actor-a']);
        await Future<void>.delayed(const Duration(milliseconds: 10));
        expect(controllers.length, 1);

        controllers.first.add(utf8.encode('event: session_idle\ndata: {}\n\n'));
        await Future<void>.delayed(const Duration(milliseconds: 50));
        expect(session.isIdle, isTrue);

        // An idle session must not blind-reconnect.
        await Future<void>.delayed(const Duration(milliseconds: 2500));
        expect(controllers.length, 1);

        await session.visit();
        await Future<void>.delayed(const Duration(milliseconds: 10));
        expect(controllers.length, 2);

        stream.dispose();
        for (final controller in controllers) {
          if (!controller.isClosed) await controller.close();
        }
      },
    );

    testWidgets('returning to the foreground renews an idled session and '
        'reopens its stream', (tester) async {
      await tester.runAsync(() async {
        final baseUrl = Uri.parse('http://localhost:3000');
        final controllers = <StreamController<List<int>>>[];
        final renewals = <String>[];
        final session = _firebaseSession(
          baseUrl,
          MockClient((req) async {
            if (req.url.path == '/api/auth/refresh') renewals.add(req.method);
            return http.Response('{"ok":true}', 200);
          }),
          auth: _Auth(_User('restored')),
          cookieJar: IoSessionCookieJar(initialCsrfToken: 'csrf'),
        );
        final disposeHooks = platformBrowserHooksBuilder!(session);
        final stream = IoEventSourceStream(
          session: session,
          baseUrl: baseUrl,
          clientFactory: connectionFactory(controllers),
        );

        stream.connect(['actor-a']);
        await Future<void>.delayed(const Duration(milliseconds: 10));
        controllers.first.add(utf8.encode('event: session_idle\ndata: {}\n\n'));
        await Future<void>.delayed(const Duration(milliseconds: 50));
        expect(session.isIdle, isTrue);
        expect(controllers.length, 1);

        // Background, then foreground the same screen with no navigation.
        for (final state in [
          AppLifecycleState.inactive,
          AppLifecycleState.hidden,
          AppLifecycleState.paused,
          AppLifecycleState.hidden,
          AppLifecycleState.inactive,
        ]) {
          tester.binding.handleAppLifecycleStateChanged(state);
        }
        expect(renewals, isEmpty);
        tester.binding.handleAppLifecycleStateChanged(
          AppLifecycleState.resumed,
        );
        await Future<void>.delayed(const Duration(milliseconds: 50));

        expect(renewals, ['POST']);
        expect(session.isIdle, isFalse);
        expect(controllers.length, 2);

        disposeHooks();
        stream.dispose();
        session.dispose();
        for (final controller in controllers) {
          if (!controller.isClosed) await controller.close();
        }
      });
    });

    test(
      'auth_required frame prompts re-authentication without reconnecting',
      () async {
        final baseUrl = Uri.parse('http://localhost:3000');
        final controllers = <StreamController<List<int>>>[];

        final session = _firebaseSession(
          baseUrl,
          MockClient((req) async => http.Response('{"ok":true}', 200)),
          auth: _Auth(_User('restored')),
        );
        expect(session.status, DashboardSessionStatus.signedIn);
        final stream = IoEventSourceStream(
          session: session,
          baseUrl: baseUrl,
          clientFactory: connectionFactory(controllers),
        );

        stream.connect([]);
        await Future<void>.delayed(const Duration(milliseconds: 10));
        expect(controllers.length, 1);

        controllers.first.add(
          utf8.encode('event: auth_required\ndata: {}\n\n'),
        );
        await Future<void>.delayed(const Duration(milliseconds: 50));
        expect(session.status, DashboardSessionStatus.signedOut);

        await Future<void>.delayed(const Duration(milliseconds: 2500));
        expect(controllers.length, 1);

        stream.dispose();
        for (final controller in controllers) {
          if (!controller.isClosed) await controller.close();
        }
      },
    );

    test(
      '401 response prompts re-authentication without reconnecting',
      () async {
        final baseUrl = Uri.parse('http://localhost:3000');
        var connections = 0;

        final session = _firebaseSession(
          baseUrl,
          MockClient((req) async => http.Response('{"ok":true}', 200)),
          auth: _Auth(_User('restored')),
        );
        expect(session.status, DashboardSessionStatus.signedIn);
        final stream = IoEventSourceStream(
          session: session,
          baseUrl: baseUrl,
          clientFactory: () => _CloseEnforcingClient(
            MockClient((req) async {
              connections++;
              return http.Response('unauthorized', 401);
            }),
          ),
        );

        stream.connect([]);
        await Future<void>.delayed(const Duration(milliseconds: 50));
        expect(connections, 1);
        expect(session.status, DashboardSessionStatus.signedOut);

        await Future<void>.delayed(const Duration(milliseconds: 2500));
        expect(connections, 1);

        stream.dispose();
      },
    );
  });
}
