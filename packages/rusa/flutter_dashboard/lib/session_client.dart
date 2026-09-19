import 'package:http/http.dart' as http;

abstract interface class SessionRequestState {
  bool get authenticationEnabled;
  String? get csrfToken;
  void requireAuthentication();
}

/// The cookie is browser-managed. Polling observes expiry but never renews it.
class SessionClient extends http.BaseClient {
  SessionClient([http.Client? inner, this._session]) : _inner = inner ?? http.Client();
  final http.Client _inner;
  final SessionRequestState? _session;

  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) async {
    if (!['GET', 'HEAD', 'OPTIONS'].contains(request.method) &&
        _needsCsrf(request.url)) {
      final bootstrap = await _inner.get(
        request.url.resolve('/api/auth/csrf'),
        headers: {'X-Rusa-CSRF-Bootstrap': '1'},
      );
      final token = _session?.csrfToken;
      if (bootstrap.statusCode != 200 || token == null) {
        throw http.ClientException('CSRF bootstrap unavailable', request.url);
      }
      request.headers['X-Rusa-CSRF'] = token;
    }
    final response = await _inner.send(request);
    if (response.statusCode == 401) _session?.requireAuthentication();
    return response;
  }

  bool _needsCsrf(Uri url) {
    if (!(_session?.authenticationEnabled ?? false)) return false;
    // Widget tests run with a file: base URI, while browser builds are always
    // http(s). The test transport is same-origin by construction.
    if (!Uri.base.isScheme('http') && !Uri.base.isScheme('https')) return true;
    return Uri.base.resolveUri(url).origin == Uri.base.origin;
  }

  @override
  void close() => _inner.close();
}
