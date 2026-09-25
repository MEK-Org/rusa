import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:rusa_dashboard/api.dart';
import 'package:rusa_dashboard/session.dart';

class _User implements SessionUser {
  _User(this.token, {String? uid, this.photoUrl, this.displayName, this.email})
    : uid = uid ?? token;

  final String token;

  @override
  final String uid;

  @override
  final String? photoUrl;

  @override
  final String? displayName;

  @override
  final String? email;

  @override
  Future<String> getIdToken({bool forceRefresh = false}) async => token;
}

class _Auth implements SessionAuth {
  _Auth(this.currentUser);

  @override
  SessionUser? currentUser;
  final changes = StreamController<SessionUser?>.broadcast();
  int signOutCount = 0;
  Completer<SessionUser>? signInCompleter;

  @override
  Stream<SessionUser?> authStateChanges() => changes.stream;

  @override
  Future<SessionUser> signInWithGoogle() async {
    final pending = signInCompleter;
    if (pending != null) return pending.future;
    final user = _User(
      'new-id-token',
      photoUrl: 'https://example.com/photo.png',
    );
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
    if (_responses.isEmpty) {
      throw StateError('Unexpected request: ${request.url}');
    }
    final response = _responses.removeAt(0);
    return http.StreamedResponse(
      Stream<List<int>>.value(utf8.encode(response.body)),
      response.statusCode,
      headers: response.headers,
    );
  }
}

void main() {
  test(
    'restored Firebase user reaches the dashboard before background cookie validation',
    () async {
      final auth = _Auth(
        _User('restored-token', photoUrl: 'https://example.com/restored.png'),
      );
      final client = _Client([http.Response('{}', 200)]);
      final session = FirebaseDashboardSession(
        auth,
        client: client,
        csrfToken: () => 'csrf',
      );

      session.start();

      expect(session.status, DashboardSessionStatus.signedIn);
      expect(session.profilePhotoUrl, 'https://example.com/restored.png');
      await Future<void>.delayed(Duration.zero);
      expect(client.paths, ['/api/auth/session']);

      session.dispose();
      await auth.close();
    },
  );

  test(
    'a denied background cookie check clears dashboard state and Firebase auth',
    () async {
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
    },
  );

  test(
    'Google sign-in creates a server session with a CSRF-protected ID token',
    () async {
      final auth = _Auth(null);
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

      await session.signIn();

      expect(session.status, DashboardSessionStatus.signedIn);
      expect(client.paths, [
        '/api/auth/csrf',
        '/api/auth/session',
        '/api/auth/session',
      ]);
      expect(client.requestBodies[1], '{"idToken":"new-id-token"}');

      session.dispose();
      await auth.close();
    },
  );

  test(
    'a visit renews the existing cookie and resumes an idle session',
    () async {
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
      expect(client.paths, [
        '/api/auth/session',
        '/api/auth/csrf',
        '/api/auth/refresh',
      ]);
      expect(client.requestBodies.last, '{"idToken":"restored-token"}');

      session.dispose();
      await auth.close();
    },
  );

  test(
    'a server idle frame pauses streams until the next visit renews them',
    () async {
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
      expect(client.paths, [
        '/api/auth/session',
        '/api/auth/csrf',
        '/api/auth/refresh',
      ]);

      session.dispose();
      await auth.close();
    },
  );

  test(
    'a cross-tab Firebase sign-out clears caches and returns to sign-in',
    () async {
      final auth = _Auth(_User('restored-token'));
      var cleared = 0;
      final session = FirebaseDashboardSession(
        auth,
        client: _Client([http.Response('{}', 200)]),
        clearDashboardCaches: () => cleared++,
      );
      session.start();
      await Future<void>.delayed(Duration.zero);

      auth.changes.add(null);
      await Future<void>.delayed(Duration.zero);

      expect(session.status, DashboardSessionStatus.signedOut);
      expect(session.isIdle, isTrue);
      expect(cleared, 1);
      expect(auth.signOutCount, 1);

      session.dispose();
      await auth.close();
    },
  );

  test(
    'a 401 from an arbitrary dashboard API request expires the session',
    () async {
      final auth = _Auth(_User('restored-token'));
      var cleared = 0;
      final client = _Client([
        http.Response('{}', 200),
        http.Response('{}', 401),
      ]);
      final session = FirebaseDashboardSession(
        auth,
        client: client,
        clearDashboardCaches: () => cleared++,
      );
      session.start();
      await Future<void>.delayed(Duration.zero);

      await expectLater(
        DashboardApi(client: client, session: session).fetchThreads(),
        throwsA(isA<DashboardApiException>()),
      );
      await Future<void>.delayed(Duration.zero);

      expect(session.status, DashboardSessionStatus.signedOut);
      expect(cleared, 1);
      expect(auth.signOutCount, 1);

      session.dispose();
      await auth.close();
    },
  );

  test('sign-out posts logout before expiring the local session', () async {
    final auth = _Auth(_User('restored-token'));
    var cleared = 0;
    final session = FirebaseDashboardSession(
      auth,
      client: _Client([
        http.Response('{}', 200),
        http.Response('{}', 200),
        http.Response('{}', 200),
      ]),
      csrfToken: () => 'csrf-token',
      clearDashboardCaches: () => cleared++,
    );
    session.start();
    await Future<void>.delayed(Duration.zero);

    await session.signOut();

    expect(session.status, DashboardSessionStatus.signedOut);
    expect(session.isIdle, isTrue);
    expect(auth.signOutCount, 1);
    expect(cleared, 1);

    session.dispose();
    await auth.close();
  });

  test(
    'a failed logout stays signed in and exposes a retryable error',
    () async {
      final auth = _Auth(_User('restored-token'));
      final session = FirebaseDashboardSession(
        auth,
        client: _Client([
          http.Response('{}', 200),
          http.Response('{}', 200),
          http.Response('{}', 500),
        ]),
        csrfToken: () => 'csrf-token',
      );
      session.start();
      await Future<void>.delayed(Duration.zero);

      await session.signOut();

      expect(session.status, DashboardSessionStatus.signedIn);
      expect(session.errorMessage, 'Unable to log out. Please try again.');
      expect(auth.signOutCount, 0);

      session.dispose();
      await auth.close();
    },
  );

  test(
    'a denied sign-in clears Firebase auth and leaves the session signed out',
    () async {
      final auth = _Auth(null);
      final session = FirebaseDashboardSession(
        auth,
        client: _Client([http.Response('{}', 200), http.Response('{}', 403)]),
        csrfToken: () => 'csrf-token',
      );
      session.start();

      await expectLater(session.signIn(), throwsA(isA<StateError>()));

      expect(session.status, DashboardSessionStatus.signedOut);
      expect(auth.signOutCount, 1);

      session.dispose();
      await auth.close();
    },
  );

  test('an account-link conflict gives the dashboard a safe actionable error', () async {
    final auth = _Auth(null);
    final session = FirebaseDashboardSession(
      auth,
      client: _Client([http.Response('{}', 200), http.Response('{}', 409)]),
      csrfToken: () => 'csrf-token',
    );
    session.start();

    await expectLater(
      session.signIn(),
      throwsA(isA<DashboardAccountSetupError>()),
    );
    expect(DashboardAccountSetupError.message, contains('administrator'));
    expect(auth.signOutCount, 1);
    expect(session.status, DashboardSessionStatus.signedOut);

    session.dispose();
    await auth.close();
  });

  test(
    'sign-in fails closed when the browser did not retain the server cookie',
    () async {
      final auth = _Auth(null);
      final session = FirebaseDashboardSession(
        auth,
        client: _Client([
          http.Response('{}', 200),
          http.Response('{}', 200),
          http.Response('{}', 401),
        ]),
        csrfToken: () => 'csrf-token',
      );
      session.start();

      await expectLater(session.signIn(), throwsA(isA<StateError>()));

      expect(session.status, DashboardSessionStatus.signedOut);
      expect(auth.signOutCount, 1);

      session.dispose();
      await auth.close();
    },
  );

  test(
    'an auth-state event during sign-in does not mark the dashboard ready early',
    () async {
      final auth = _Auth(null);
      final pendingSignIn = Completer<SessionUser>();
      auth.signInCompleter = pendingSignIn;
      final session = FirebaseDashboardSession(
        auth,
        client: _Client([
          http.Response('{}', 200),
          http.Response('{}', 200),
          http.Response('{}', 200),
        ]),
        csrfToken: () => 'csrf-token',
      );
      session.start();

      final signingIn = session.signIn();
      auth.changes.add(_User('auth-state-token'));
      await Future<void>.delayed(Duration.zero);
      expect(session.status, DashboardSessionStatus.signedOut);

      pendingSignIn.complete(_User('new-id-token'));
      await signingIn;

      expect(session.status, DashboardSessionStatus.signedIn);

      session.dispose();
      await auth.close();
    },
  );

  test(
    'an authenticated manifest title becomes the browser title source of truth',
    () async {
      final auth = _Auth(_User('restored-token'));
      final session = FirebaseDashboardSession(
        auth,
        client: _Client([http.Response('{}', 200)]),
        applyBranding: () async => 'Ember Familiar',
      );
      session.start();
      await Future<void>.delayed(Duration.zero);

      expect(session.browserTitle, 'Ember Familiar');

      session.dispose();
      await auth.close();
    },
  );
  test('local mode never asks the server about a session', () async {
    final session = LocalDashboardSession();

    expect(session.authenticationEnabled, isFalse);
    // A refused stream reconnect in local mode has nothing to check: there is
    // no cookie session and no `/api/auth/session` route to ask.
    await session.checkSession();

    expect(session.status, DashboardSessionStatus.local);
    expect(session.isIdle, isFalse);
  });

  test('profile display label prefers name, then email, then Operator', () {
    final named = FirebaseDashboardSession(
      _Auth(_User('token', displayName: 'Ada Lovelace')),
    );
    final emailed = FirebaseDashboardSession(
      _Auth(_User('token', displayName: ' ', email: 'ada@example.test')),
    );
    final unnamed = FirebaseDashboardSession(_Auth(_User('token')));

    expect(named.operatorDisplayName, 'Ada Lovelace');
    expect(emailed.operatorDisplayName, 'ada@example.test');
    expect(unnamed.operatorDisplayName, 'Operator');
  });

  test(
    'an account switch while signed in expires the session instead of relabeling it',
    () async {
      final auth = _Auth(
        _User('old-token', uid: 'old-user', displayName: 'Ada Lovelace'),
      );
      final client = _Client([http.Response('{}', 200)]);
      final session = FirebaseDashboardSession(auth, client: client);
      session.start();
      await Future<void>.delayed(Duration.zero);
      expect(session.status, DashboardSessionStatus.signedIn);

      final newUser = _User(
        'new-token',
        uid: 'new-user',
        displayName: 'Grace Hopper',
      );
      auth.currentUser = newUser;
      auth.changes.add(newUser);
      await Future<void>.delayed(Duration.zero);

      expect(session.status, DashboardSessionStatus.signedOut);
      expect(auth.signOutCount, 1);
      expect(client.paths, ['/api/auth/session']);

      session.dispose();
      await auth.close();
    },
  );

  test(
    'a refused stream reconnect checks the session and only a 401 expires it',
    () async {
      final auth = _Auth(_User('restored-token'));
      final client = _Client([
        http.Response('{}', 200), // start()
        http.Response('{}', 200), // still live
        http.Response('{}', 401), // gone
      ]);
      final session = FirebaseDashboardSession(
        auth,
        client: client,
        csrfToken: () => 'csrf',
      );
      session.start();
      await Future<void>.delayed(Duration.zero);

      await session.checkSession();
      expect(session.status, DashboardSessionStatus.signedIn);
      expect(auth.signOutCount, 0);

      await session.checkSession();
      expect(session.status, DashboardSessionStatus.signedOut);
      expect(auth.signOutCount, 1);
      expect(client.paths, [
        '/api/auth/session',
        '/api/auth/session',
        '/api/auth/session',
      ]);

      session.dispose();
      await auth.close();
    },
  );

  test('a failed session check keeps a signed-in user', () async {
    final auth = _Auth(_User('restored-token'));
    final session = FirebaseDashboardSession(
      auth,
      client: _Client([http.Response('{}', 200)]),
      csrfToken: () => 'csrf',
    );
    session.start();
    await Future<void>.delayed(Duration.zero);

    // The fake client throws once its scripted responses run out.
    await session.checkSession();

    expect(session.status, DashboardSessionStatus.signedIn);
    expect(auth.signOutCount, 0);

    session.dispose();
    await auth.close();
  });
}
