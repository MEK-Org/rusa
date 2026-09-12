import 'package:http/http.dart' as http;
import 'session_events_stub.dart'
    if (dart.library.js_interop) 'session_events_web.dart';

/// The cookie is browser-managed. Polling observes expiry but never renews it.
class SessionClient extends http.BaseClient {
  SessionClient([http.Client? inner]) : _inner = inner ?? http.Client();
  final http.Client _inner;

  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) async {
    if (!['GET', 'HEAD', 'OPTIONS'].contains(request.method) &&
        needsCsrf(request.url)) {
      final bootstrap = await _inner.get(
        request.url.resolve('/api/auth/csrf'),
        headers: {'X-Rusa-CSRF-Bootstrap': '1'},
      );
      final token = csrfToken;
      if (bootstrap.statusCode != 200 || token == null) {
        throw http.ClientException('CSRF bootstrap unavailable', request.url);
      }
      request.headers['X-Rusa-CSRF'] = token;
    }
    final response = await _inner.send(request);
    if (response.statusCode == 401) requireAuthentication();
    return response;
  }

  @override
  void close() => _inner.close();
}
