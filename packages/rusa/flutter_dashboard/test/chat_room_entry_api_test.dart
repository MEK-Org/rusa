import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart' show MockClient;
import 'package:rusa_dashboard/api.dart';
import 'package:rusa_dashboard/session_client.dart';

class _AuthenticatedSession implements SessionRequestState {
  @override
  bool get authenticationEnabled => true;

  @override
  String? get csrfToken => 'csrf-token';

  @override
  Future<void> requireAuthentication() async {}
}

void main() {
  test(
    'posts one authenticated Room entry through the CSRF boundary',
    () async {
      final paths = <String>[];
      final client = MockClient((request) async {
        paths.add(request.url.path);
        if (request.url.path == '/api/auth/csrf') {
          expect(request.method, 'GET');
          expect(request.headers['x-rusa-csrf-bootstrap'], '1');
          return http.Response(jsonEncode({'token': 'csrf-token'}), 200);
        }
        expect(request.method, 'POST');
        expect(request.url.path, '/api/mesh/chat-room/entry');
        expect(request.headers['x-rusa-csrf'], 'csrf-token');
        expect(request.body, isEmpty);
        return http.Response(jsonEncode({'status': 'entered'}), 200);
      });
      final api = DashboardApi(
        client: client,
        base: Uri.parse('http://localhost:3000'),
        session: _AuthenticatedSession(),
      );

      await api.enterChatRoom();

      expect(paths, ['/api/auth/csrf', '/api/mesh/chat-room/entry']);
    },
  );
}
