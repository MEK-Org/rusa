import 'package:http/http.dart' as http;

/// In-memory cookie jar for the dashboard session cookies on non-web hosts.
class IoSessionCookieJar {
  IoSessionCookieJar({String? initialSessionCookie, String? initialCsrfToken})
      : sessionCookie = initialSessionCookie,
        csrfToken = initialCsrfToken;

  String? sessionCookie;
  String? csrfToken;

  void updateFromHeaders(Map<String, String> headers) {
    // Both lower and mixed case header lookup
    final raw = headers['set-cookie'] ?? headers['Set-Cookie'];
    if (raw == null || raw.isEmpty) return;
    _parseSetCookie(raw);
  }

  void _parseSetCookie(String raw) {
    // Headers might contain multiple Set-Cookie directives separated by commas
    // or newlines. Matches look for __Host-rusa_session and __Host-rusa_csrf.
    for (final part in raw.split(RegExp(r',(?=\s*__Host-)|\n'))) {
      final trimmed = part.trim();
      if (trimmed.isEmpty) continue;
      final semiIndex = trimmed.indexOf(';');
      final cookiePair = semiIndex != -1 ? trimmed.substring(0, semiIndex).trim() : trimmed;
      if (cookiePair.startsWith('__Host-rusa_session=')) {
        final val = cookiePair.substring('__Host-rusa_session='.length);
        sessionCookie = val.isEmpty ? null : val;
      } else if (cookiePair.startsWith('__Host-rusa_csrf=')) {
        final val = cookiePair.substring('__Host-rusa_csrf='.length);
        csrfToken = val.isEmpty ? null : val;
      }
    }
  }

  String? buildCookieHeader() {
    final parts = <String>[];
    if (sessionCookie != null && sessionCookie!.isNotEmpty) {
      parts.add('__Host-rusa_session=$sessionCookie');
    }
    if (csrfToken != null && csrfToken!.isNotEmpty) {
      parts.add('__Host-rusa_csrf=$csrfToken');
    }
    return parts.isEmpty ? null : parts.join('; ');
  }

  void clear() {
    sessionCookie = null;
    csrfToken = null;
  }
}

/// An [http.Client] that persists dashboard session cookies and injects an Origin
/// header matching [baseUrl] on every request to [baseUrl]'s own origin.
/// Cross-origin requests pass through untouched: the session cookie and a
/// matching Origin are only meaningful (and only safe to attach) at home.
class IoSessionClient extends http.BaseClient {
  IoSessionClient({
    http.Client? inner,
    required this.baseUrl,
    IoSessionCookieJar? cookieJar,
  })  : _inner = inner ?? http.Client(),
        cookieJar = cookieJar ?? IoSessionCookieJar();

  final http.Client _inner;
  final Uri baseUrl;
  final IoSessionCookieJar cookieJar;

  String get origin =>
      '${baseUrl.scheme}://${baseUrl.host}${baseUrl.hasPort ? ':${baseUrl.port}' : ''}';

  bool _isSameOrigin(Uri url) =>
      url.scheme == baseUrl.scheme &&
      url.host == baseUrl.host &&
      url.port == baseUrl.port;

  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) async {
    final sameOrigin = _isSameOrigin(request.url);

    if (sameOrigin) {
      // Ensure Origin header is present for CSRF / same-origin checks.
      if (!request.headers.containsKey('Origin') &&
          !request.headers.containsKey('origin')) {
        request.headers['Origin'] = origin;
      }

      // Attach persisted cookies.
      final cookieHeader = cookieJar.buildCookieHeader();
      if (cookieHeader != null) {
        final existing = request.headers['Cookie'] ?? request.headers['cookie'];
        if (existing == null || existing.isEmpty) {
          request.headers['Cookie'] = cookieHeader;
        } else if (!existing.contains('__Host-rusa_')) {
          request.headers['Cookie'] = '$existing; $cookieHeader';
        }
      }
    }

    final response = await _inner.send(request);

    // Save any set cookies (home origin only — see _isSameOrigin).
    if (sameOrigin) {
      cookieJar.updateFromHeaders(response.headers);
    }

    return response;
  }

  @override
  void close() => _inner.close();
}
