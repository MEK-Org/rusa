import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:rusa_dashboard/api.dart';

void main() {
  const requestId = '123e4567-e89b-42d3-a456-426614174000';

  test(
    'actor detail reports a content-free successful timing envelope',
    () async {
      final timingRequest = Completer<http.Request>();
      final api = DashboardApi(
        base: Uri.parse('https://dashboard.example/'),
        client: MockClient((request) async {
          if (request.url.path == '/api/dashboard/timing') {
            timingRequest.complete(request);
            return http.Response('{"accepted":true}', 202);
          }
          expect(request.url.path, '/api/mesh/threads/charter');
          return http.Response(
            jsonEncode({'charter': 'private charter text'}),
            200,
            headers: {'X-Rusa-Request-Id': requestId},
          );
        }),
      );
      addTearDown(api.close);

      expect(
        await api.fetchCharter('actor-private-id'),
        'private charter text',
      );

      final envelope =
          jsonDecode((await timingRequest.future).body) as Map<String, dynamic>;
      expect(envelope['interaction'], 'actor_detail');
      expect(envelope['requestIds'], [requestId]);
      expect(envelope['requestTimings'], [
        {'requestId': requestId, 'requestMs': isA<int>()},
      ]);
      expect(envelope['outcome'], 'success');
      expect(envelope['durationMs'], isA<int>());
      expect(envelope['durationMs'] as int, greaterThanOrEqualTo(0));
      expect(envelope.containsKey('actorId'), isFalse);
      expect(jsonEncode(envelope), isNot(contains('actor-private-id')));
      expect(jsonEncode(envelope), isNot(contains('private charter text')));
    },
  );

  test(
    'actor detail reports failure without exposing the requested actor',
    () async {
      final timingRequest = Completer<http.Request>();
      final api = DashboardApi(
        base: Uri.parse('https://dashboard.example/'),
        client: MockClient((request) async {
          if (request.url.path == '/api/dashboard/timing') {
            timingRequest.complete(request);
            return http.Response('{"accepted":true}', 202);
          }
          return http.Response(
            'private server failure',
            500,
            headers: {'X-Rusa-Request-Id': requestId},
          );
        }),
      );
      addTearDown(api.close);

      await expectLater(
        api.fetchCharter('actor-private-id'),
        throwsA(isA<DashboardApiException>()),
      );

      final envelope =
          jsonDecode((await timingRequest.future).body) as Map<String, dynamic>;
      expect(envelope['interaction'], 'actor_detail');
      expect(envelope['requestIds'], [requestId]);
      expect(envelope['requestTimings'], [
        {'requestId': requestId, 'requestMs': isA<int>()},
      ]);
      expect(envelope['outcome'], 'failure');
      expect(jsonEncode(envelope), isNot(contains('actor-private-id')));
      expect(jsonEncode(envelope), isNot(contains('private server failure')));
    },
  );

  test(
    'a failed request without a response ID has no fabricated correlation',
    () async {
      final timingRequest = Completer<http.Request>();
      final api = DashboardApi(
        base: Uri.parse('https://dashboard.example/'),
        client: MockClient((request) async {
          if (request.url.path == '/api/dashboard/timing') {
            timingRequest.complete(request);
            return http.Response('{"accepted":true}', 202);
          }
          return http.Response('private server failure', 500);
        }),
      );
      addTearDown(api.close);

      await expectLater(
        api.fetchCharter('actor-private-id'),
        throwsA(isA<DashboardApiException>()),
      );

      final envelope =
          jsonDecode((await timingRequest.future).body) as Map<String, dynamic>;
      expect(envelope['outcome'], 'failure');
      expect(envelope['requestIds'], isEmpty);
      expect(envelope.containsKey('requestTimings'), isFalse);
    },
  );
}
