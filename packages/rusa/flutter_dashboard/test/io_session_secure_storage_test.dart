import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:rusa_dashboard/io_session.dart';
import 'package:rusa_dashboard/io_session_client.dart';
import 'package:rusa_dashboard/io_session_secure_storage.dart';
import 'package:rusa_dashboard/session.dart';

const _storageChannel = MethodChannel(
  'plugins.it_nomads.com/flutter_secure_storage',
);

class _RestoredUser implements SessionUser {
  @override
  String get uid => 'restored-user';

  @override
  String? get displayName => null;

  @override
  String? get email => null;

  @override
  String? get photoUrl => null;

  @override
  Future<String> getIdToken({bool forceRefresh = false}) async => 'token';
}

class _RestoredAuth implements SessionAuth {
  @override
  SessionUser? currentUser = _RestoredUser();

  @override
  Stream<SessionUser?> authStateChanges() => const Stream.empty();

  @override
  Future<SessionUser> signInWithGoogle() async => currentUser!;

  @override
  Future<void> signOut() async => currentUser = null;
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  final values = <String, String>{};

  setUp(() {
    values.clear();
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(_storageChannel, (call) async {
          final args = call.arguments as Map<Object?, Object?>;
          final key = args['key']! as String;
          switch (call.method) {
            case 'read':
              return values[key];
            case 'write':
              values[key] = args['value']! as String;
            case 'delete':
              values.remove(key);
          }
          return null;
        });
  });

  tearDown(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(_storageChannel, null);
  });

  test(
    'persists one origin through the secure-storage plugin and clears it',
    () async {
      final origin = Uri.parse('https://dashboard.example.test');
      final storage = SecureIoSessionCredentialStorage();
      final jar = IoSessionCookieJar(origin: origin, storage: storage);

      await jar.updateFromHeaders({
        'set-cookie':
            '__Host-rusa_session=session-1; Path=/; Secure, '
            '__Host-rusa_csrf=csrf-1; Path=/; Secure',
      });
      expect(values, hasLength(1));

      final restarted = IoSessionCookieJar(origin: origin, storage: storage);
      await restarted.restore();
      expect(restarted.sessionCookie, 'session-1');
      expect(restarted.csrfToken, 'csrf-1');

      final otherOrigin = IoSessionCookieJar(
        origin: Uri.parse('https://other.example.test'),
        storage: storage,
      );
      await otherOrigin.restore();
      expect(otherOrigin.buildCookieHeader(), isNull);

      await restarted.clear();
      final afterLogout = IoSessionCookieJar(origin: origin, storage: storage);
      await afterLogout.restore();
      expect(afterLogout.buildCookieHeader(), isNull);
    },
  );

  test(
    'restores a valid plugin cookie and clears it on logout and expiry',
    () async {
      final origin = Uri.parse('https://dashboard.example.test');
      final storage = SecureIoSessionCredentialStorage();

      Future<void> seed() async {
        final jar = IoSessionCookieJar(origin: origin, storage: storage);
        await jar.updateFromHeaders({
          'set-cookie':
              '__Host-rusa_session=session-1; Path=/; Secure, '
              '__Host-rusa_csrf=csrf-1; Path=/; Secure',
        });
      }

      final requests = <http.Request>[];
      var sessionStatus = 200;
      http.Client client() => MockClient((request) async {
        requests.add(request);
        if (request.url.path == '/api/auth/config') {
          return http.Response(
            '{"enabled":true,"firebase":{"apiKey":"key",'
            '"projectId":"project","authDomain":"domain"}}',
            200,
          );
        }
        if (request.url.path == '/api/auth/session') {
          return http.Response('{}', sessionStatus);
        }
        if (request.url.path == '/api/auth/csrf') {
          return http.Response('{}', 200);
        }
        if (request.url.path == '/api/auth/logout') {
          return http.Response('{}', 200);
        }
        throw StateError('unexpected ${request.url.path}');
      });

      await seed();
      final session = await bootstrapIoDashboardSession(
        baseUrl: origin,
        clientFactory: client,
        authFactory: (_) async => _RestoredAuth(),
        credentialStorage: storage,
      );
      await Future<void>.delayed(Duration.zero);
      final restoredCheck = requests.lastWhere(
        (request) => request.url.path == '/api/auth/session',
      );
      expect(restoredCheck.headers['Cookie'], contains('session-1'));

      await session.signOut();
      final afterLogout = IoSessionCookieJar(origin: origin, storage: storage);
      await afterLogout.restore();
      expect(afterLogout.buildCookieHeader(), isNull);

      requests.clear();
      sessionStatus = 401;
      await seed();
      await bootstrapIoDashboardSession(
        baseUrl: origin,
        clientFactory: client,
        authFactory: (_) async => _RestoredAuth(),
        credentialStorage: storage,
      );
      await Future<void>.delayed(Duration.zero);
      final afterExpiry = IoSessionCookieJar(origin: origin, storage: storage);
      await afterExpiry.restore();
      expect(afterExpiry.buildCookieHeader(), isNull);
    },
  );
}
