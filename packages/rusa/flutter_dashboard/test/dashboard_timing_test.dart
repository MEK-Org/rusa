import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:rusa_dashboard/api.dart';
import 'package:rusa_dashboard/dashboard_timing.dart';

class _BodyGatedClient extends http.BaseClient {
  final body = StreamController<List<int>>();
  final timingRequest = Completer<http.BaseRequest>();

  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) async {
    if (request.url.path == '/api/dashboard/timing') {
      timingRequest.complete(request);
      return http.StreamedResponse(
        Stream<List<int>>.value(utf8.encode('{"accepted":true}')),
        202,
      );
    }
    return http.StreamedResponse(
      body.stream,
      200,
      headers: const {
        'X-Rusa-Request-Id': '123e4567-e89b-42d3-a456-426614174000',
      },
    );
  }

  @override
  void close() {
    unawaited(body.close());
  }
}

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
        await api.trackInteraction(
          DashboardInteraction.actorDetail,
          () => api.fetchCharter('actor-private-id'),
        ),
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
        api.trackInteraction(
          DashboardInteraction.actorDetail,
          () => api.fetchCharter('actor-private-id'),
        ),
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
        api.trackInteraction(
          DashboardInteraction.actorDetail,
          () => api.fetchCharter('actor-private-id'),
        ),
        throwsA(isA<DashboardApiException>()),
      );

      final envelope =
          jsonDecode((await timingRequest.future).body) as Map<String, dynamic>;
      expect(envelope['outcome'], 'failure');
      expect(envelope['requestIds'], isEmpty);
      expect(envelope.containsKey('requestTimings'), isFalse);
    },
  );

  test(
    'request timing ends after the response body, before later interaction work',
    () async {
      final client = _BodyGatedClient();
      final api = DashboardApi(
        base: Uri.parse('https://dashboard.example/'),
        client: client,
      );
      addTearDown(api.close);

      final interaction = api.trackInteraction(
        DashboardInteraction.initialLoad,
        () async {
          // This nested interaction scope must not replace the named outer interaction.
          await api.trackInteraction(
            DashboardInteraction.actorDetail,
            () => api.fetchCharter('private-actor-id'),
          );
          await Future<void>.delayed(const Duration(milliseconds: 20));
        },
      );
      await Future<void>.delayed(const Duration(milliseconds: 25));
      expect(client.timingRequest.isCompleted, isFalse);

      client.body.add(utf8.encode(jsonEncode({'charter': 'private charter'})));
      await client.body.close();
      await Future<void>.delayed(Duration.zero);
      // The body is complete, but the interaction's later work still keeps
      // the receipt from being emitted.
      expect(client.timingRequest.isCompleted, isFalse);

      await interaction;
      final request = await client.timingRequest.future;
      expect(request, isA<http.Request>());
      final body =
          jsonDecode((request as http.Request).body) as Map<String, dynamic>;
      final timing =
          (body['requestTimings'] as List<dynamic>).single
              as Map<String, dynamic>;
      expect(body['interaction'], 'initial_load');
      expect(timing['requestMs'] as int, greaterThanOrEqualTo(20));
      expect(
        body['durationMs'] as int,
        greaterThan(timing['requestMs'] as int),
      );
    },
  );

  test(
    'untracked background requests execute without emitting timing receipts',
    () async {
      var timingCalled = false;
      final api = DashboardApi(
        base: Uri.parse('https://dashboard.example/'),
        client: MockClient((request) async {
          if (request.url.path == '/api/dashboard/timing') {
            timingCalled = true;
            return http.Response('{"accepted":true}', 202);
          }
          expect(request.url.path, '/api/mesh/threads/charter');
          return http.Response(
            jsonEncode({'charter': 'background charter'}),
            200,
            headers: {'X-Rusa-Request-Id': requestId},
          );
        }),
      );
      addTearDown(api.close);

      expect(await api.fetchCharter('bg-actor'), 'background charter');
      await Future<void>.delayed(const Duration(milliseconds: 10));
      expect(timingCalled, isFalse);
    },
  );

  test(
    'late responses or stream chunks after context close do not modify receipt',
    () async {
      final bodyController = StreamController<List<int>>();
      final inner = MockClient.streaming((request, bodyStream) async {
        return http.StreamedResponse(
          bodyController.stream,
          200,
          headers: {'X-Rusa-Request-Id': requestId},
        );
      });
      final timingClient = DashboardTimingClient(inner);
      addTearDown(timingClient.close);
      addTearDown(bodyController.close);

      final timing = Completer<Map<String, dynamic>>();
      final reporter = DashboardTimingReporter(
        client: MockClient((request) async {
          timing.complete(jsonDecode(request.body) as Map<String, dynamic>);
          return http.Response('{"accepted":true}', 202);
        }),
        base: Uri.parse('https://dashboard.example/'),
      );

      http.StreamedResponse? response;
      await reporter.measure(DashboardInteraction.primaryNavigation, () async {
        response = await timingClient.send(
          http.Request('GET', Uri.parse('https://dashboard.example/api/test')),
        );
      });

      final receipt = await timing.future;
      expect(receipt['interaction'], 'primary_navigation');
      expect(receipt['requestIds'], [requestId]);
      expect(receipt.containsKey('requestTimings'), isFalse);

      bodyController.add(utf8.encode('chunk'));
      final closeFuture = bodyController.close();
      if (response != null) {
        await response!.stream.drain<void>();
      }
      await closeFuture;

      expect(receipt.containsKey('requestTimings'), isFalse);
    },
  );

  test(
    'detached asynchronous callback can start fresh interaction after prior closes',
    () async {
      final actorDetailDone = Completer<Map<String, dynamic>>();
      final timingRequests = <Map<String, dynamic>>[];
      final api = DashboardApi(
        base: Uri.parse('https://dashboard.example/'),
        client: MockClient((request) async {
          if (request.url.path == '/api/dashboard/timing') {
            final body = jsonDecode(request.body) as Map<String, dynamic>;
            timingRequests.add(body);
            if (body['interaction'] == 'actor_detail' && !actorDetailDone.isCompleted) {
              actorDetailDone.complete(body);
            }
            return http.Response('{"accepted":true}', 202);
          }
          return http.Response(
            jsonEncode({'charter': 'charter'}),
            200,
            headers: {'X-Rusa-Request-Id': requestId},
          );
        }),
      );
      addTearDown(api.close);

      Completer<void>? detachedDone;
      await api.trackInteraction(DashboardInteraction.primaryNavigation, () async {
        detachedDone = Completer<void>();
        Timer.run(() async {
          try {
            await api.trackInteraction(
              DashboardInteraction.actorDetail,
              () => api.fetchCharter('detached-actor'),
            );
            detachedDone!.complete();
          } catch (e, st) {
            detachedDone!.completeError(e, st);
          }
        });
      });

      await detachedDone!.future;
      await actorDetailDone.future.timeout(const Duration(seconds: 2));

      expect(timingRequests, hasLength(2));
      expect(timingRequests[0]['interaction'], 'primary_navigation');
      expect(timingRequests[1]['interaction'], 'actor_detail');
    },
  );
}
