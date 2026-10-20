import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart' show MockClient;
import 'package:rusa_dashboard/api.dart';

void main() {
  test('posts a scoped hold recovery and reads its release receipt', () async {
    final client = MockClient((request) async {
      expect(request.method, 'POST');
      expect(request.url.path, '/api/mesh/availability-holds/clear');
      expect(request.headers['content-type'], 'application/json');
      expect(jsonDecode(request.body), {
        'provider': 'codex',
        'models': ['gpt-5.6', 'gpt-5.7'],
      });
      return http.Response(
        jsonEncode({
          'released': [
            {'provider': 'codex', 'model': 'gpt-5.6'},
            {'provider': 'codex', 'model': 'gpt-5.7'},
          ],
          'expired_removed': 1,
        }),
        200,
      );
    });
    final api = DashboardApi(
      client: client,
      base: Uri.parse('http://localhost:3000'),
    );

    final released = await api.clearAvailabilityHolds(
      provider: 'codex',
      models: ['gpt-5.6', 'gpt-5.7'],
    );

    expect(released, 2);
  });

  test('posts one clear-all and reads whether the brake and holds were released', () async {
    final client = MockClient((request) async {
      expect(request.method, 'POST');
      expect(request.url.path, '/api/mesh/halts/clear-all');
      expect(request.body, isEmpty);
      return http.Response(
        jsonEncode({
          'brake_released': true,
          'released': [
            {'provider': 'kimi', 'model': null, 'origin': 'chat'},
            {'provider': 'codex', 'model': 'gpt-5.6', 'origin': 'mesh'},
          ],
          'expired_removed': 0,
          'replayed': 1,
        }),
        200,
      );
    });
    final api = DashboardApi(
      client: client,
      base: Uri.parse('http://localhost:3000'),
    );

    final result = await api.clearAllHalts();

    expect(result.brakeReleased, isTrue);
    expect(result.released, 2);
  });

  test('surfaces a refused clear-all to the dashboard', () async {
    final api = DashboardApi(
      client: MockClient(
        (_) async => http.Response(jsonEncode({'error': 'unauthorized'}), 403),
      ),
      base: Uri.parse('http://localhost:3000'),
    );

    expect(api.clearAllHalts, throwsA(isA<DashboardApiException>()));
  });

  test('surfaces a refused hold recovery to the dashboard', () async {
    final api = DashboardApi(
      client: MockClient(
        (_) async => http.Response(jsonEncode({'error': 'unauthorized'}), 403),
      ),
      base: Uri.parse('http://localhost:3000'),
    );

    expect(
      () => api.clearAvailabilityHolds(provider: 'codex'),
      throwsA(isA<DashboardApiException>()),
    );
  });
}
