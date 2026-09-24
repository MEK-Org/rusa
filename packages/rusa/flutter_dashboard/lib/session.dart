import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;

import 'session_client.dart';

const sessionIdleDuration = Duration(hours: 1);

enum DashboardSessionStatus { local, signedOut, signedIn }

abstract interface class SessionUser {
  /// Stable Firebase identity, distinct from mutable profile presentation.
  String get uid;
  String? get photoUrl;
  String? get displayName;
  String? get email;
  Future<String> getIdToken({bool forceRefresh = false});
}

abstract interface class SessionAuth {
  SessionUser? get currentUser;

  /// A superset of authentication changes that also emits profile updates and
  /// token refreshes for the current user.
  Stream<SessionUser?> userChanges();
  Future<SessionUser> signInWithGoogle();
  Future<void> signOut();
}

/// The one owner of browser authentication state. Its concrete Firebase adapter
/// lives in `session_web.dart`, leaving this policy testable without Firebase.
abstract class DashboardSession extends ChangeNotifier
    implements SessionRequestState {
  DashboardSessionStatus get status;
  bool get isIdle;
  String? get profilePhotoUrl;
  String get operatorDisplayName;
  int get profilePresentationRevision;
  String? get browserTitle;
  String? get errorMessage;

  Future<void> signIn();
  Future<void> signOut();
  Future<void> visit();
  void idleFromServer();

  /// Asks the server whether the cookie session is still live and expires the
  /// dashboard on a 401. Local mode has no session to check, so it never
  /// issues a request; callers recovering from a refused stream reconnect rely
  /// on that.
  Future<void> checkSession();
}

class LocalDashboardSession extends DashboardSession {
  @override
  bool get authenticationEnabled => false;

  @override
  String? get csrfToken => null;

  @override
  bool get isIdle => false;

  @override
  String? get profilePhotoUrl => null;

  @override
  String get operatorDisplayName => 'Operator';

  @override
  int get profilePresentationRevision => 0;

  @override
  String? get browserTitle => null;

  @override
  String? get errorMessage => null;

  @override
  DashboardSessionStatus get status => DashboardSessionStatus.local;

  @override
  Future<void> requireAuthentication() async {}

  @override
  Future<void> signIn() async {}

  @override
  Future<void> signOut() async {}

  @override
  Future<void> visit() async {}

  @override
  void idleFromServer() {}

  @override
  Future<void> checkSession() async {}
}

class FirebaseDashboardSession extends DashboardSession {
  FirebaseDashboardSession(
    this._auth, {
    http.Client? client,
    String? Function()? csrfToken,
    void Function()? clearDashboardCaches,
    Future<String?> Function()? applyBranding,
    Duration idleDuration = sessionIdleDuration,
  }) : _csrfToken = csrfToken ?? (() => null),
       _clearDashboardCaches = clearDashboardCaches ?? (() {}),
       _applyBranding = applyBranding ?? (() async => null),
       _idleDuration = idleDuration {
    _client = SessionClient(client, this);
  }

  final SessionAuth _auth;
  late final http.Client _client;
  final String? Function() _csrfToken;
  final void Function() _clearDashboardCaches;
  final Future<String?> Function() _applyBranding;
  final Duration _idleDuration;
  StreamSubscription<SessionUser?>? _authSubscription;
  Timer? _idleTimer;
  Future<void>? _renewing;
  SessionUser? _user;
  // This stays on the server-confirmed account during an account transition.
  // Do not let a new Firebase profile label render against the prior account's
  // dashboard config while a replacement cookie is being established.
  SessionUser? _presentationUser;
  int _profilePresentationRevision = 0;
  DashboardSessionStatus _status = DashboardSessionStatus.signedOut;
  bool _idle = false;
  bool _creatingSession = false;
  bool _expiring = false;
  String? _browserTitle;
  String? _errorMessage;

  @override
  bool get authenticationEnabled => true;

  @override
  String? get csrfToken => _csrfToken();

  @override
  bool get isIdle => _idle;

  @override
  String? get profilePhotoUrl => _displayUser?.photoUrl;

  @override
  String get operatorDisplayName {
    final user = _displayUser;
    return _firstProfileLabel(user?.displayName, user?.email);
  }

  SessionUser? get _displayUser =>
      _presentationUser ?? _user ?? _auth.currentUser;

  @override
  int get profilePresentationRevision => _profilePresentationRevision;

  @override
  String? get browserTitle => _browserTitle;

  @override
  String? get errorMessage => _errorMessage;

  @override
  DashboardSessionStatus get status => _status;

  /// Starts listening before the first frame. A restored Firebase user is made
  /// available synchronously by FlutterFire after `Firebase.initializeApp`.
  void start() {
    _authSubscription = _auth.userChanges().listen(_onAuthStateChanged);
    _user = _auth.currentUser;
    _presentationUser = _user;
    if (_user == null) {
      _setStatus(DashboardSessionStatus.signedOut);
      return;
    }
    _markSignedIn();
    unawaited(checkSession());
  }

  void _onAuthStateChanged(SessionUser? user) {
    final previous = _user;
    _user = user;
    if (user == null) {
      if (_status == DashboardSessionStatus.signedIn) unawaited(_expire());
      return;
    }
    if (_status == DashboardSessionStatus.signedOut && !_creatingSession) {
      _markSignedIn();
      unawaited(checkSession());
      return;
    }
    if (previous != null && previous.uid != user.uid) {
      unawaited(_replaceSessionForAccount(user));
      return;
    }
    _setPresentationUser(user);
    // A user-change event can carry a new profile photo/display name or a
    // refreshed credential without changing identity. The mounted page refreshes
    // its server-resolved config before applying this presentation update.
    notifyListeners();
  }

  /// Account switches need a new server cookie before their profile is visible.
  /// The dashboard page then reloads `/api/dashboard/config` before rendering
  /// this user's label, so durable principal and presentation stay aligned.
  Future<void> _replaceSessionForAccount(SessionUser user) async {
    try {
      final response = await _post(
        'session',
        idToken: await user.getIdToken(forceRefresh: true),
      );
      if (response.statusCode != 200 || _user?.uid != user.uid) {
        if (_user?.uid == user.uid) await _expire();
        return;
      }
      _setPresentationUser(user);
      notifyListeners();
    } catch (_) {
      // A failed account transition must not keep a prior account's cookie
      // paired with the new Firebase identity.
      if (_user?.uid == user.uid) await _expire();
    }
  }

  void _setPresentationUser(SessionUser user) {
    _presentationUser = user;
    _profilePresentationRevision++;
  }

  void _markSignedIn() {
    _setError(null);
    _setIdle(false);
    _setStatus(DashboardSessionStatus.signedIn);
    _scheduleIdle();
    unawaited(_applyBrandingAndNotify());
  }

  Future<void> _applyBrandingAndNotify() async {
    try {
      final title = await _applyBranding();
      if (title == null || title == _browserTitle) return;
      _browserTitle = title;
      notifyListeners();
    } catch (_) {
      // Branding must not prevent a valid authenticated session from loading.
    }
  }

  void _scheduleIdle() {
    _idleTimer?.cancel();
    _idleTimer = Timer(_idleDuration, () => _setIdle(true));
  }

  void _setIdle(bool value) {
    if (_idle == value) return;
    _idle = value;
    notifyListeners();
  }

  void _setStatus(DashboardSessionStatus value) {
    if (_status == value) return;
    _status = value;
    notifyListeners();
  }

  void _setError(String? value) {
    if (_errorMessage == value) return;
    _errorMessage = value;
    notifyListeners();
  }

  Future<http.Response> _post(String path, {String? idToken}) => _client.post(
    Uri.base.resolve('/api/auth/$path'),
    headers: const {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
    },
    body: jsonEncode(
      idToken == null ? const <String, String>{} : {'idToken': idToken},
    ),
  );

  @override
  Future<void> checkSession() async {
    try {
      final response = await _client.get(Uri.base.resolve('/api/auth/session'));
      if (response.statusCode == 401) await _expire();
    } catch (_) {
      // A transient check failure does not invalidate a locally restored user.
    }
  }

  @override
  Future<void> signIn() async {
    if (_creatingSession) return;
    _creatingSession = true;
    try {
      final user = await _auth.signInWithGoogle();
      final response = await _post(
        'session',
        idToken: await user.getIdToken(forceRefresh: true),
      );
      if (response.statusCode != 200) {
        await _auth.signOut();
        throw StateError('Sign in denied');
      }
      // A successful response only proves the server attempted to set the
      // HttpOnly cookie. Confirm that the browser retained it before mounting
      // the authenticated UI, otherwise HTTPS/cookie-policy failures loop on
      // the next dashboard request.
      try {
        final check = await _client.get(Uri.base.resolve('/api/auth/session'));
        if (check.statusCode != 200) {
          throw StateError('Sign in session was not retained');
        }
      } catch (_) {
        await _auth.signOut();
        _user = null;
        _presentationUser = null;
        rethrow;
      }
      _user = user;
      _setPresentationUser(user);
      _markSignedIn();
    } finally {
      _creatingSession = false;
    }
  }

  @override
  Future<void> visit() {
    if (_status != DashboardSessionStatus.signedIn) return Future.value();
    _scheduleIdle();
    final inFlight = _renewing;
    if (inFlight != null) return inFlight;
    _renewing = _renew();
    return _renewing!;
  }

  /// A stream can observe server-side inactivity before a throttled browser
  /// timer runs. Keep the controller authoritative so the next visit changes
  /// idle state and reconnects every stream listening to this session.
  @override
  void idleFromServer() {
    if (_status == DashboardSessionStatus.signedIn) _setIdle(true);
  }

  Future<void> _renew() async {
    try {
      final user = _user;
      if (user == null) {
        await _expire();
        return;
      }
      final response = await _post('refresh', idToken: await user.getIdToken());
      if (response.statusCode == 401) {
        await _expire();
        return;
      }
      if (response.statusCode != 200) {
        throw StateError('Session refresh unavailable');
      }
      _setIdle(false);
    } finally {
      _renewing = null;
    }
  }

  @override
  Future<void> signOut() async {
    final response = await _post('logout');
    if (response.statusCode != 200) {
      _setError('Unable to log out. Please try again.');
      return;
    }
    await _expire();
  }

  @override
  Future<void> requireAuthentication() => _expire();

  Future<void> _expire() async {
    if (_expiring || _status == DashboardSessionStatus.signedOut) return;
    _expiring = true;
    try {
      _setError(null);
      _clearDashboardCaches();
      _idleTimer?.cancel();
      _setIdle(true);
      await _auth.signOut();
      _user = null;
      _presentationUser = null;
      _setStatus(DashboardSessionStatus.signedOut);
    } finally {
      _expiring = false;
    }
  }

  @override
  void dispose() {
    _idleTimer?.cancel();
    _authSubscription?.cancel();
    _client.close();
    super.dispose();
  }
}

/// Profile fields are display-only. Principal identity and authorization remain
/// server-owned; the dashboard falls back rather than exposing a raw id.
String _firstProfileLabel(String? displayName, String? email) {
  for (final value in [displayName, email]) {
    final trimmed = value?.trim();
    if (trimmed != null && trimmed.isNotEmpty) return trimmed;
  }
  return 'Operator';
}
