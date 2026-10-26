import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;

import 'io_session_client.dart';
import 'session.dart';
import 'session_client.dart';

/// Resolves the default server base URL on non-web platforms.
/// Defaults to http://localhost:3000; from an Android emulator or a
/// USB-connected device, `adb reverse tcp:3000 tcp:3000` forwards the
/// workstation's server to the device loopback. Override with
/// `--dart-define=RUSA_SERVER_URL=...` (e.g. http://10.0.2.2:3000 for the
/// emulator NAT alias, or a LAN host).
Uri resolveIoServerBaseUrl() {
  const fromEnv = String.fromEnvironment('RUSA_SERVER_URL');
  if (fromEnv.isNotEmpty) {
    return Uri.parse(fromEnv);
  }
  return Uri.parse('http://localhost:3000');
}

/// A [DashboardSession] for IO (Android / VM) environments.
class IoDashboardSession extends DashboardSession {
  IoDashboardSession({
    required this.client,
    required this.baseUrl,
    required this.cookieJar,
    this.authEnabled = false,
  }) : _status = authEnabled
            ? DashboardSessionStatus.signedOut
            : DashboardSessionStatus.local;

  final IoSessionClient client;
  final Uri baseUrl;
  final IoSessionCookieJar cookieJar;
  final bool authEnabled;

  bool _isIdle = false;
  String? _errorMessage;
  DashboardSessionStatus _status;

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
    if (!authEnabled) return;
    // Native authentication / token exchange against /api/auth/session is not yet
    // implemented on this platform build. Keep the session signedOut, report the error,
    // and throw so SignInPage shows that explanation rather than mounting a credential-less dashboard.
    setError(DashboardSignInUnsupportedError.message);
    throw const DashboardSignInUnsupportedError();
  }

  @override
  Future<void> signOut() async {
    try {
      // Route the logout POST through SessionClient so it bootstraps
      // /api/auth/csrf and carries X-Rusa-CSRF exactly like the web
      // dashboard's authenticated writes (a bare post is rejected 403).
      await SessionClient(client, this).post(
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
///
/// Mirrors the web bootstrap: transport errors propagate raw and a non-200
/// answer or malformed config throws [StateError], so the app renders its
/// startup error with a retry either way — it never silently degrades to a
/// local session. [clientFactory] is a test seam for injecting a mock
/// transport.
Future<DashboardSession> bootstrapIoDashboardSession({
  Uri? baseUrl,
  http.Client Function()? clientFactory,
}) async {
  final resolvedBaseUrl = baseUrl ?? resolveIoServerBaseUrl();
  final cookieJar = IoSessionCookieJar();
  final client = IoSessionClient(
    baseUrl: resolvedBaseUrl,
    cookieJar: cookieJar,
    inner: clientFactory?.call(),
  );

  final response = await client.get(
    resolvedBaseUrl.resolve('/api/auth/config'),
    headers: {'Accept': 'application/json'},
  );
  if (response.statusCode != 200) {
    throw StateError('Dashboard authentication configuration is unavailable');
  }
  final config = jsonDecode(response.body);
  if (config is! Map<String, dynamic>) {
    throw StateError('Dashboard authentication configuration is unavailable');
  }
  if (config['enabled'] == false) {
    return IoDashboardSession(
      client: client,
      baseUrl: resolvedBaseUrl,
      cookieJar: cookieJar,
      authEnabled: false,
    );
  }
  if (config['enabled'] == true) {
    final session = IoDashboardSession(
      client: client,
      baseUrl: resolvedBaseUrl,
      cookieJar: cookieJar,
      authEnabled: true,
    );
    await session.checkSession();
    return session;
  }
  throw StateError('Dashboard authentication configuration is unavailable');
}
