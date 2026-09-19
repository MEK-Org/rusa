import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:rusa_dashboard/session.dart';

class _User implements SessionUser {
  _User(this.token, {this.photoUrl});

  final String token;

  @override
  final String? photoUrl;

  @override
  Future<String> getIdToken({bool forceRefresh = false}) async => token;
}

class _Auth implements SessionAuth {
  _Auth(this.currentUser);

  @override
  SessionUser? currentUser;
  final changes = StreamController<SessionUser?>.broadcast();
  int signOutCount = 0;

  @override
  Stream<SessionUser?> authStateChanges() => changes.stream;

  @override
  Future<SessionUser> signInWithGoogle() async {
    final user = _User('new-id-token', photoUrl: 'https://example.com/photo.png');
    currentUser = user;
    return user;
  }

  @override
  Future<void> signOut() async {
    signOutCount++;
    currentUser = null;
  }

  Future<void> close() => changes.close();
}

class _Client extends http.BaseClient {
  _Client(this._responses);

  final List<http.Response> _responses;
  final paths = <String>[];
  final requestBodies = <String>[];

  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) async {
    paths.add(request.url.path);
    if (request is http.Request) requestBodies.add(request.body);
    if (_responses.isEmpty) throw StateError('Unexpected request: ${request.url}');
    final response = _responses.removeAt(0);
    return http.StreamedResponse(
      Stream<List<int>>.value(utf8.encode(response.body)),
      response.statusCode,
      headers: response.headers,
    );
  }
}

void main() {
  test('restored Firebase user reaches the dashboard before background cookie validation', () async {
    final auth = _Auth(_User('restored-token', photoUrl: 'https://example.com/restored.png'));
    final client = _Client([http.Response('{}', 200)]);
    final session = FirebaseDashboardSession(auth, client: client, csrfToken: () => 'csrf');

    session.start();

    expect(session.status, DashboardSessionStatus.signedIn);
    expect(session.profilePhotoUrl, 'https://example.com/restored.png');
    await Future<void>.delayed(Duration.zero);
    expect(client.paths, ['/api/auth/session']);

    session.dispose();
    await auth.close();
  });

  test('a denied background cookie check clears dashboard state and Firebase auth', () async {
    final auth = _Auth(_User('restored-token'));
    var cleared = 0;
    final session = FirebaseDashboardSession(
      auth,
      client: _Client([http.Response('{}', 401)]),
      csrfToken: () => 'csrf',
      clearDashboardCaches: () => cleared++,
    );

    session.start();
    await Future<void>.delayed(Duration.zero);

    expect(session.status, DashboardSessionStatus.signedOut);
    expect(session.isIdle, isTrue);
    expect(auth.signOutCount, 1);
    expect(cleared, 1);

    session.dispose();
    await auth.close();
  });

  test('Google sign-in creates a server session with a CSRF-protected ID token', () async {
    final auth = _Auth(null);
    final client = _Client([
      http.Response('{}', 200),
      http.Response('{}', 200),
    ]);
    final session = FirebaseDashboardSession(auth, client: client, csrfToken: () => 'csrf-token');
    session.start();

    await session.signIn();

    expect(session.status, DashboardSessionStatus.signedIn);
    expect(client.paths, ['/api/auth/csrf', '/api/auth/session']);
    expect(client.requestBodies.last, '{"idToken":"new-id-token"}');

    session.dispose();
    await auth.close();
  });

  test('a visit renews the existing cookie and resumes an idle session', () async {
    final auth = _Auth(_User('restored-token'));
    final client = _Client([
      http.Response('{}', 200),
      http.Response('{}', 200),
      http.Response('{}', 200),
    ]);
    final session = FirebaseDashboardSession(
      auth,
      client: client,
      csrfToken: () => 'csrf-token',
      idleDuration: const Duration(milliseconds: 1),
    );
    session.start();
    await Future<void>.delayed(Duration.zero);
    await Future<void>.delayed(const Duration(milliseconds: 5));
    expect(session.isIdle, isTrue);

    await session.visit();

    expect(session.isIdle, isFalse);
    expect(client.paths, ['/api/auth/session', '/api/auth/csrf', '/api/auth/refresh']);
    expect(client.requestBodies.last, '{"idToken":"restored-token"}');

    session.dispose();
    await auth.close();
  });

  test('a server idle frame pauses streams until the next visit renews them', () async {
    final auth = _Auth(_User('restored-token'));
    final client = _Client([
      http.Response('{}', 200),
      http.Response('{}', 200),
      http.Response('{}', 200),
    ]);
    final session = FirebaseDashboardSession(
      auth,
      client: client,
      csrfToken: () => 'csrf-token',
    );
    session.start();
    await Future<void>.delayed(Duration.zero);

    session.idleFromServer();
    expect(session.isIdle, isTrue);

    await session.visit();

    expect(session.isIdle, isFalse);
    expect(client.paths, ['/api/auth/session', '/api/auth/csrf', '/api/auth/refresh']);

    session.dispose();
    await auth.close();
  });
}
