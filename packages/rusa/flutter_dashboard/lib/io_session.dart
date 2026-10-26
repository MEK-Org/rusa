import 'dart:async';
import 'dart:convert';

import 'io_session_client.dart';
import 'session.dart';

/// Resolves the default server base URL on non-web platforms.
/// Defaults to http://10.0.2.2:3000 on Android (loopback alias for the host workstation)
/// or can be configured via `--dart-define=RUSA_SERVER_URL=...`.
Uri resolveIoServerBaseUrl() {
  const fromEnv = String.fromEnvironment('RUSA_SERVER_URL');
  if (fromEnv.isNotEmpty) {
    return Uri.parse(fromEnv);
  }
  // Standard Android emulator loopback alias to host
  return Uri.parse('http://10.0.2.2:3000');
}

/// A [DashboardSession] for IO (Android / VM) environments.
class IoDashboardSession extends DashboardSession {
  IoDashboardSession({
    required this.client,
    required this.baseUrl,
    required this.cookieJar,
    this.authEnabled = false,
  });

  final IoSessionClient client;
  final Uri baseUrl;
  final IoSessionCookieJar cookieJar;
  final bool authEnabled;

  bool _isIdle = false;
  String? _errorMessage;
  DashboardSessionStatus _status = DashboardSessionStatus.local;

  @override
  bool get authenticationEnabled => authEnabled;

  @override
  String? get csrfToken => cookieJar.csrfToken;

  @override
  bool get isIdle => _isIdle;

  @override
  String? get profilePhotoUrl => null;

  @override
  String get operatorDisplayName => 'Operator';

  @override
  String? get browserTitle => null;

  @override
  String? get errorMessage => _errorMessage;

  @override
  DashboardSessionStatus get status => authEnabled ? _status : DashboardSessionStatus.local;

  void setStatus(DashboardSessionStatus status) {
    if (_status != status) {
      _status = status;
      notifyListeners();
    }
  }

  void setError(String? error) {
    if (_errorMessage != error) {
      _errorMessage = error;
      notifyListeners();
    }
  }

  @override
  Future<void> requireAuthentication() async {
    if (!authEnabled) return;
    setStatus(DashboardSessionStatus.signedOut);
  }

  @override
  Future<void> signIn() async {
    // In local or sideloaded APK mode, sign-in is typically initialized via Google auth or
    // session token exchange if auth is enabled.
    setStatus(DashboardSessionStatus.signedIn);
  }

  @override
  Future<void> signOut() async {
    try {
      await client.post(
        baseUrl.resolve('/api/auth/logout'),
        headers: {'Accept': 'application/json'},
      );
    } catch (_) {
      // Best-effort logout
    } finally {
      cookieJar.clear();
      setStatus(DashboardSessionStatus.signedOut);
    }
  }

  @override
  Future<void> visit() async {
    if (_isIdle) {
      _isIdle = false;
      notifyListeners();
    }
  }

  @override
  void idleFromServer() {
    if (!_isIdle) {
      _isIdle = true;
      notifyListeners();
    }
  }

  @override
  Future<void> checkSession() async {
    if (!authEnabled) return;
    try {
      final res = await client.get(
        baseUrl.resolve('/api/auth/session'),
        headers: {'Accept': 'application/json'},
      );
      if (res.statusCode == 401) {
        await requireAuthentication();
      } else if (res.statusCode == 200) {
        setStatus(DashboardSessionStatus.signedIn);
      }
    } catch (_) {}
  }
}

/// Bootstraps an IO session against the configured server.
Future<DashboardSession> bootstrapIoDashboardSession([Uri? overrideBaseUrl]) async {
  final baseUrl = overrideBaseUrl ?? resolveIoServerBaseUrl();
  final cookieJar = IoSessionCookieJar();
  final client = IoSessionClient(baseUrl: baseUrl, cookieJar: cookieJar);

  try {
    final response = await client.get(
      baseUrl.resolve('/api/auth/config'),
      headers: {'Accept': 'application/json'},
    );
    if (response.statusCode == 200) {
      final config = jsonDecode(response.body);
      if (config is Map<String, dynamic> && config['enabled'] == true) {
        final session = IoDashboardSession(
          client: client,
          baseUrl: baseUrl,
          cookieJar: cookieJar,
          authEnabled: true,
        );
        await session.checkSession();
        return session;
      }
    }
  } catch (_) {
    // If the server cannot be reached during cold bootstrap, default to local session.
  }

  return IoDashboardSession(
    client: client,
    baseUrl: baseUrl,
    cookieJar: cookieJar,
    authEnabled: false,
  );
}
