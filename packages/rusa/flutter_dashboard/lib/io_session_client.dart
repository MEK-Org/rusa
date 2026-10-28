import 'package:http/http.dart' as http;

/// The session credentials tied to one configured dashboard origin.
class IoSessionCredentials {
  const IoSessionCredentials({
    required this.sessionCookie,
    required this.csrfToken,
  });

  final String? sessionCookie;
  final String? csrfToken;
}

/// Persistent storage for the device-only cookie jar. Implementations must
/// scope keys to [origin] and encrypt their values at rest.
abstract interface class IoSessionCredentialStorage {
  Future<IoSessionCredentials?> read(Uri origin);

  Future<void> write(Uri origin, IoSessionCredentials credentials);

  Future<void> delete(Uri origin);
}

/// In-memory cookie jar for the dashboard session cookies on non-web hosts.
class IoSessionCookieJar {
  IoSessionCookieJar({
    String? initialSessionCookie,
    String? initialCsrfToken,
    this.origin,
    this.storage,
  }) : sessionCookie = initialSessionCookie,
       csrfToken = initialCsrfToken;

  String? sessionCookie;
  String? csrfToken;
  final Uri? origin;
  final IoSessionCredentialStorage? storage;

  /// Hydrates an authenticated session before Firebase's restored-user check.
  /// A record for another origin is never read through this jar.
  Future<void> restore() async {
    final origin = this.origin;
    final storage = this.storage;
    if (origin == null || storage == null) return;
    final stored = await storage.read(origin);
    if (stored == null) return;
    sessionCookie = stored.sessionCookie;
    csrfToken = stored.csrfToken;
  }

  Future<void> updateFromHeaders(Map<String, String> headers) async {
    // Both lower and mixed case header lookup
    final raw = headers['set-cookie'] ?? headers['Set-Cookie'];
    if (raw == null || raw.isEmpty) return;
    _parseSetCookie(raw);
    await _persist();
  }

  void _parseSetCookie(String raw) {
    // Headers might contain multiple Set-Cookie directives separated by commas
    // or newlines. Matches look for __Host-rusa_session and __Host-rusa_csrf.
    for (final part in raw.split(RegExp(r',(?=\s*__Host-)|\n'))) {
      final trimmed = part.trim();
      if (trimmed.isEmpty) continue;
      final semiIndex = trimmed.indexOf(';');
      final cookiePair = semiIndex != -1
          ? trimmed.substring(0, semiIndex).trim()
          : trimmed;
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

  Future<void> clear() async {
    sessionCookie = null;
    csrfToken = null;
    final origin = this.origin;
    final storage = this.storage;
    if (origin != null && storage != null) await storage.delete(origin);
  }

  Future<void> _persist() async {
    final origin = this.origin;
    final storage = this.storage;
    if (origin == null || storage == null) return;
    if (sessionCookie == null && csrfToken == null) {
      await storage.delete(origin);
      return;
    }
    await storage.write(
      origin,
      IoSessionCredentials(sessionCookie: sessionCookie, csrfToken: csrfToken),
    );
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
  }) : _inner = inner ?? http.Client(),
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

  /// Headers for a framework-owned same-origin fetch, such as [Image.network].
  /// Those fetches cannot use this [http.Client], so callers need this narrow
  /// projection of the current jar rather than a second, divergent transport.
  /// Never return credentials for a different origin.
  Map<String, String> headersFor(Uri url) {
    if (!_isSameOrigin(url)) return const {};
    final headers = <String, String>{'Origin': origin};
    final cookieHeader = cookieJar.buildCookieHeader();
    if (cookieHeader != null) headers['Cookie'] = cookieHeader;
    return headers;
  }

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
      await cookieJar.updateFromHeaders(response.headers);
    }

    return response;
  }

  @override
  void close() => _inner.close();
}

/// A non-owning view of a client owned by a longer-lived dashboard session.
/// A page-scoped [DashboardApi] may close its wrappers without invalidating the
/// session's sign-in, refresh, logout, or the next page it builds.
class NonClosingHttpClient extends http.BaseClient {
  NonClosingHttpClient(this._inner);

  final http.Client _inner;

  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) =>
      _inner.send(request);

  @override
  void close() {}
}
