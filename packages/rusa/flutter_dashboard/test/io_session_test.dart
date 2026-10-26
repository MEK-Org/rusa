import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'package:rusa_dashboard/io_session.dart';
import 'package:rusa_dashboard/io_session_client.dart';
import 'package:rusa_dashboard/io_sse.dart';
import 'package:rusa_dashboard/models.dart';
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
        authEnabled: false,
      );

      expect(session.authenticationEnabled, isFalse);
      expect(session.status, DashboardSessionStatus.local);
      expect(session.operatorDisplayName, 'Operator');
    });

    test('authenticated mode starts signedOut, not local', () {
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
        authEnabled: true,
      );

      expect(session.status, DashboardSessionStatus.signedOut);
    });

    test('authenticated mode sign out bootstraps CSRF and clears cookies',
        () async {
      final baseUrl = Uri.parse('http://localhost:3000');
      final jar = IoSessionCookieJar(
        initialSessionCookie: 'session_xyz',
        initialCsrfToken: 'csrf_xyz',
      );

      String? csrfHeader;
      final mock = MockClient((req) async {
        if (req.url.path == '/api/auth/csrf') {
          return http.Response(
            jsonEncode({'ok': true}),
            200,
            headers: {
              'set-cookie': '__Host-rusa_csrf=fresh_csrf; Path=/; Secure',
            },
          );
        }
        if (req.url.path == '/api/auth/logout') {
          csrfHeader = req.headers['X-Rusa-CSRF'] ?? req.headers['x-rusa-csrf'];
          return http.Response(jsonEncode({'ok': true}), 200);
        }
        return http.Response('Not found', 404);
      });

      final client = IoSessionClient(
        inner: mock,
        baseUrl: baseUrl,
        cookieJar: jar,
      );
      final session = IoDashboardSession(
        client: client,
        baseUrl: baseUrl,
        cookieJar: jar,
        authEnabled: true,
      );

      await session.signOut();
      expect(csrfHeader, 'fresh_csrf');
      expect(jar.sessionCookie, isNull);
      expect(jar.csrfToken, isNull);
      expect(session.status, DashboardSessionStatus.signedOut);
    });

    test('signIn throws and stays signedOut when auth is enabled', () async {
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
        authEnabled: true,
      );

      expect(session.status, DashboardSessionStatus.signedOut);
      await expectLater(
        () => session.signIn(),
        throwsA(isA<StateError>()),
      );
      expect(session.status, DashboardSessionStatus.signedOut);
      expect(
        session.errorMessage,
        'Google sign-in is not supported on this device build.',
      );
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

    test('returns a signedOut session when auth is enabled without a cookie',
        () async {
      final mock = MockClient((req) async {
        if (req.url.path == '/api/auth/config') {
          return http.Response(jsonEncode({'enabled': true}), 200);
        }
        if (req.url.path == '/api/auth/session') {
          return http.Response('unauthorized', 401);
        }
        return http.Response('Not found', 404);
      });

      final session = await bootstrapIoDashboardSession(
        baseUrl: Uri.parse('http://localhost:3000'),
        clientFactory: () => mock,
      );

      expect(session.authenticationEnabled, isTrue);
      expect(session.status, DashboardSessionStatus.signedOut);
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

    test('throws StateError when auth config has missing or non-boolean enabled',
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
    });
  });

  group('IoEventSourceStream', () {
    IoDashboardSession makeSession(Uri baseUrl) => IoDashboardSession(
          client: IoSessionClient(
            inner: MockClient(
              (req) async => http.Response('Not found', 404),
            ),
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

      final ssePayload = ': connected\n\n'
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

    test('survives a second connect (actor switch) with close-enforcing clients',
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
    });

    test('reconnects with a fresh client after the server drops the stream',
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
    });

    test('session_idle frame closes the stream and visit() reopens it',
        () async {
      final baseUrl = Uri.parse('http://localhost:3000');
      final controllers = <StreamController<List<int>>>[];

      final session = makeSession(baseUrl);
      final stream = IoEventSourceStream(
        session: session,
        baseUrl: baseUrl,
        clientFactory: connectionFactory(controllers),
      );

      stream.connect(['actor-a']);
      await Future<void>.delayed(const Duration(milliseconds: 10));
      expect(controllers.length, 1);

      controllers.first.add(
        utf8.encode('event: session_idle\ndata: {}\n\n'),
      );
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
    });

    test('auth_required frame prompts re-authentication without reconnecting',
        () async {
      final baseUrl = Uri.parse('http://localhost:3000');
      final controllers = <StreamController<List<int>>>[];

      final jar = IoSessionCookieJar();
      final session = IoDashboardSession(
        client: IoSessionClient(
          inner: MockClient((req) async => http.Response('Not found', 404)),
          baseUrl: baseUrl,
          cookieJar: jar,
        ),
        baseUrl: baseUrl,
        cookieJar: jar,
        authEnabled: true,
      );
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
    });

    test('401 response prompts re-authentication without reconnecting',
        () async {
      final baseUrl = Uri.parse('http://localhost:3000');
      var connections = 0;

      final jar = IoSessionCookieJar();
      final session = IoDashboardSession(
        client: IoSessionClient(
          inner: MockClient((req) async => http.Response('Not found', 404)),
          baseUrl: baseUrl,
          cookieJar: jar,
        ),
        baseUrl: baseUrl,
        cookieJar: jar,
        authEnabled: true,
      );
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
    });
  });
}
