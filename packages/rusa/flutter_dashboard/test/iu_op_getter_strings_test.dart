// Render-check for the externalized-string resolution path (ISSUE_NUM string-loading fix).
//
// This exercises the REAL externalized shape: an entry id that is NOT inline (the baseline case)
// must resolve via `loadString → GET /api/understanding/strings`. Validates resolution, request
// BATCHING (concurrent misses → one request, no N+1), the client cache (no refetch), and graceful
// degradation (a failed/!200 strings fetch → null, never a throw that blanks the whole view).
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart' show MockClient;
import 'package:rusa_dashboard/iu/op_getter_persistence.dart';

void main() {
  test(
    'loadString resolves an externalized id via the strings endpoint',
    () async {
      final requests = <Uri>[];
      final svc = OpGetterPersistenceService(
        baseUrl: 'http://localhost',
        client: _stringsClient(requests),
      );

      expect(await svc.loadString('e1'), 'body-e1');
      expect(requests, hasLength(1));
      expect(requests.single.path, '/api/understanding/strings');
      expect(requests.single.queryParameters['ids'], 'e1');
    },
  );

  test(
    'concurrent misses coalesce into ONE batched request (no N+1)',
    () async {
      final requests = <Uri>[];
      final svc = OpGetterPersistenceService(
        baseUrl: 'http://localhost',
        client: _stringsClient(requests),
      );

      final results = await Future.wait([
        svc.loadString('a'),
        svc.loadString('b'),
      ]);
      expect(results, ['body-a', 'body-b']);
      expect(requests, hasLength(1)); // a single coalesced fetch
      final ids = (requests.single.queryParameters['ids'] ?? '')
          .split(',')
          .toSet();
      expect(ids, {'a', 'b'});
    },
  );

  test(
    'resolved strings are cached — a second load makes no request',
    () async {
      final requests = <Uri>[];
      final svc = OpGetterPersistenceService(
        baseUrl: 'http://localhost',
        client: _stringsClient(requests),
      );

      expect(await svc.loadString('c'), 'body-c');
      requests.clear();
      expect(await svc.loadString('c'), 'body-c'); // from cache
      expect(requests, isEmpty);
    },
  );

  test('a failed strings fetch degrades to null (no throw)', () async {
    final svc = OpGetterPersistenceService(
      baseUrl: 'http://localhost',
      client: MockClient((_) async => http.Response('boom', 500)),
    );
    expect(await svc.loadString('x'), isNull);
  });

  test(
    'an id missing from v001_strings resolves to null (per-entry degrade)',
    () async {
      final svc = OpGetterPersistenceService(
        baseUrl: 'http://localhost',
        // Server omits unknown ids from the map (matches the real endpoint).
        client: MockClient(
          (_) async => http.Response(jsonEncode({'strings': {}}), 200),
        ),
      );
      expect(await svc.loadString('missing'), isNull);
    },
  );
}

/// A mock client that answers the strings endpoint with `body-<id>` for every requested id.
MockClient _stringsClient(List<Uri> requests) => MockClient((req) async {
  requests.add(req.url);
  if (req.url.path == '/api/understanding/strings') {
    final ids = (req.url.queryParameters['ids'] ?? '')
        .split(',')
        .where((s) => s.isNotEmpty);
    final strings = {for (final id in ids) id: 'body-$id'};
    return http.Response(jsonEncode({'strings': strings}), 200);
  }
  return http.Response('not found', 404);
});
