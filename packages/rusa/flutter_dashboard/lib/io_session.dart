import 'dart:convert';

import 'package:http/http.dart' as http;

import 'io_firebase_auth.dart';
import 'io_session_client.dart';
import 'session.dart';

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

/// The device transport a dashboard session carries: the configured server
/// and the cookie-holding client every dashboard request must share.
abstract interface class IoSessionTransport {
  IoSessionClient get client;
  Uri get baseUrl;
  IoSessionCookieJar get cookieJar;
}

/// Unauthenticated local mode on IO (Android / VM), as [LocalDashboardSession]
/// is on web, plus the device transport.
class IoDashboardSession extends LocalDashboardSession
    implements IoSessionTransport {
  IoDashboardSession({
    required this.client,
    required this.baseUrl,
    required this.cookieJar,
  });

  @override
  final IoSessionClient client;
  @override
  final Uri baseUrl;
  @override
  final IoSessionCookieJar cookieJar;
}

/// Authenticated mode on IO. The sign-in, session-retention, renewal, idle and
/// logout policy is the web dashboard's [FirebaseDashboardSession]; only the
/// Google credential source and the cookie transport are device-specific.
class IoFirebaseDashboardSession extends FirebaseDashboardSession
    implements IoSessionTransport {
  IoFirebaseDashboardSession(
    super.auth, {
    required this.client,
    required this.baseUrl,
    required this.cookieJar,
    super.idleDuration,
  }) : super(
         client: client,
         baseUrl: baseUrl,
         csrfToken: () => cookieJar.csrfToken,
         // A browser drops an expired session cookie; the device jar is the
         // only dashboard state IO keeps, so expiry and logout clear it.
         clearDashboardCaches: cookieJar.clear,
       );

  @override
  final IoSessionClient client;
  @override
  final Uri baseUrl;
  @override
  final IoSessionCookieJar cookieJar;
}

/// Creates the native Firebase credential source from the server's public
/// Firebase client configuration (see `io_firebase_auth.dart`).
typedef IoSessionAuthFactory =
    Future<SessionAuth> Function(Map<String, dynamic> firebase);

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
  IoSessionAuthFactory authFactory = initializeNativeFirebaseAuth,
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
    );
  }
  final firebase = config['firebase'];
  if (config['enabled'] != true || firebase is! Map<String, dynamic>) {
    throw StateError('Dashboard authentication configuration is unavailable');
  }
  final session = IoFirebaseDashboardSession(
    await authFactory(firebase),
    client: client,
    baseUrl: resolvedBaseUrl,
    cookieJar: cookieJar,
  );
  session.start();
  return session;
}
