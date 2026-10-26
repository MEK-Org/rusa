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
    test('injects origin and passes cookies', () async {
      final baseUrl = Uri.parse('http://10.0.2.2:3000');
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
      expect(captured?.headers['Origin'], 'http://10.0.2.2:3000');
      expect(
        captured?.headers['Cookie'],
        '__Host-rusa_session=sess123; __Host-rusa_csrf=csrf456',
      );
      expect(jar.csrfToken, 'new_csrf_789');
    });
  });

  group('IoDashboardSession', () {
    test('local mode bootstrap and properties', () async {
      final baseUrl = Uri.parse('http://10.0.2.2:3000');
      final mock = MockClient((req) async {
        if (req.url.path == '/api/auth/config') {
          return http.Response(jsonEncode({'enabled': false}), 200);
        }
        return http.Response('Not found', 404);
      });

      final jar = IoSessionCookieJar();
      final client = IoSessionClient(inner: mock, baseUrl: baseUrl, cookieJar: jar);
      final session = IoDashboardSession(
        client: client,
        baseUrl: baseUrl,
        cookieJar: jar,
        authEnabled: false,
      );

      expect(session.authenticationEnabled, isFalse);
      expect(session.status, DashboardSessionStatus.local);
      expect(session.operatorDisplayName, 'Operator');
    });

    test('authenticated mode sign out clears cookies', () async {
      final baseUrl = Uri.parse('http://10.0.2.2:3000');
      final jar = IoSessionCookieJar(
        initialSessionCookie: 'session_xyz',
        initialCsrfToken: 'csrf_xyz',
      );

      var loggedOut = false;
      final mock = MockClient((req) async {
        if (req.url.path == '/api/auth/logout') {
          loggedOut = true;
          return http.Response(jsonEncode({'ok': true}), 200);
        }
        return http.Response('Not found', 404);
      });

      final client = IoSessionClient(inner: mock, baseUrl: baseUrl, cookieJar: jar);
      final session = IoDashboardSession(
        client: client,
        baseUrl: baseUrl,
        cookieJar: jar,
        authEnabled: true,
      );

      await session.signOut();
      expect(loggedOut, isTrue);
      expect(jar.sessionCookie, isNull);
      expect(jar.csrfToken, isNull);
      expect(session.status, DashboardSessionStatus.signedOut);
    });
  });

  group('IoEventSourceStream', () {
    test('parses SSE frames and ignores comments', () async {
      final baseUrl = Uri.parse('http://10.0.2.2:3000');
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
        client: mock,
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
  });
}
