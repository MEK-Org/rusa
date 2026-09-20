import 'dart:convert';

import 'package:firebase_auth/firebase_auth.dart';
import 'package:firebase_core/firebase_core.dart';
import 'package:http/http.dart' as http;
import 'package:web/web.dart' as web;

import 'session.dart';

class _FirebaseSessionUser implements SessionUser {
  _FirebaseSessionUser(this._user);

  final User _user;

  @override
  String? get photoUrl => _user.photoURL;

  @override
  Future<String> getIdToken({bool forceRefresh = false}) async {
    final token = await _user.getIdToken(forceRefresh);
    if (token == null) throw StateError('Firebase did not provide an ID token');
    return token;
  }
}

class _FirebaseSessionAuth implements SessionAuth {
  _FirebaseSessionAuth(this._auth);

  final FirebaseAuth _auth;

  @override
  SessionUser? get currentUser {
    final user = _auth.currentUser;
    return user == null ? null : _FirebaseSessionUser(user);
  }

  @override
  Stream<SessionUser?> authStateChanges() => _auth.authStateChanges().map(
    (user) => user == null ? null : _FirebaseSessionUser(user),
  );

  @override
  Future<SessionUser> signInWithGoogle() async {
    final provider = GoogleAuthProvider()
      ..setCustomParameters({'prompt': 'select_account'});
    final result = await _auth.signInWithPopup(provider);
    final user = result.user;
    if (user == null) throw StateError('Google sign in returned no user');
    return _FirebaseSessionUser(user);
  }

  @override
  Future<void> signOut() => _auth.signOut();
}

String _firebaseValue(Map<String, dynamic> config, String name) {
  final value = config[name];
  if (value is! String || value.isEmpty) {
    throw StateError('Dashboard Firebase configuration is unavailable');
  }
  return value;
}

/// The Web SDK accepts these as absent/empty for Firebase Auth, but Flutter's
/// FirebaseOptions constructor keeps them non-nullable for all platforms.
String _firebaseWebMetadata(Map<String, dynamic> config, String name) {
  final value = config[name];
  return value is String ? value : '';
}

Future<DashboardSession> bootstrapDashboardSession() async {
  final response = await http.get(
    Uri.base.resolve('/api/auth/config'),
    headers: const {'Accept': 'application/json'},
  );
  if (response.statusCode != 200) {
    throw StateError('Dashboard authentication configuration is unavailable');
  }
  final config = jsonDecode(response.body);
  if (config is! Map<String, dynamic>) {
    throw StateError('Dashboard authentication configuration is unavailable');
  }
  if (config['enabled'] == false) return LocalDashboardSession();
  final firebase = config['firebase'];
  if (config['enabled'] != true || firebase is! Map<String, dynamic>) {
    throw StateError('Dashboard authentication configuration is unavailable');
  }

  await Firebase.initializeApp(
    options: FirebaseOptions(
      apiKey: _firebaseValue(firebase, 'apiKey'),
      appId: _firebaseWebMetadata(firebase, 'appId'),
      messagingSenderId: _firebaseWebMetadata(firebase, 'messagingSenderId'),
      projectId: _firebaseValue(firebase, 'projectId'),
      authDomain: _firebaseValue(firebase, 'authDomain'),
    ),
  );
  final auth = FirebaseAuth.instance;
  final emulator = config['emulatorUrl'];
  if (emulator != null) _connectAuthEmulator(auth, emulator);
  await auth.setPersistence(Persistence.LOCAL);
  final session = FirebaseDashboardSession(
    _FirebaseSessionAuth(auth),
    csrfToken: _csrfToken,
    clearDashboardCaches: _clearDashboardCaches,
    applyBranding: _applyBranding,
  );
  session.start();
  return session;
}

void _connectAuthEmulator(FirebaseAuth auth, Object value) {
  if (value is! String) {
    throw StateError('Dashboard Firebase configuration is unavailable');
  }
  final emulator = Uri.tryParse(value);
  if (emulator == null || emulator.host.isEmpty || !emulator.hasPort) {
    throw StateError('Dashboard Firebase configuration is unavailable');
  }
  auth.useAuthEmulator(emulator.host, emulator.port);
}

String? _csrfToken() {
  final matches = web.document.cookie
      .split(';')
      .map((part) => part.trim())
      .where((part) => part.startsWith('__Host-rusa_csrf='));
  return matches.length == 1
      ? matches.single.substring('__Host-rusa_csrf='.length)
      : null;
}

void _clearDashboardCaches() {
  try {
    final storage = web.window.localStorage;
    final keys = <String>[];
    for (var index = 0; index < storage.length; index++) {
      final key = storage.key(index);
      if (key != null) keys.add(key);
    }
    for (final key in keys) {
      if (key.startsWith('rusa.dashboard.')) {
        web.window.localStorage.removeItem(key);
      }
    }
  } catch (_) {
    // Storage is unavailable in some private browsing modes.
  }
}

Future<String?> _applyBranding() async {
  final response = await http.get(Uri.base.resolve('/manifest.json'));
  if (response.statusCode != 200) return null;
  final manifest = jsonDecode(response.body);
  if (manifest is! Map<String, dynamic>) return null;
  _installAuthenticatedManifest();
  final name = manifest['name'];
  final icon =
      (manifest['icons'] is List && (manifest['icons'] as List).isNotEmpty)
      ? (manifest['icons'] as List).first
      : null;
  if (icon is Map && icon['src'] is String) {
    final previous = web.document.head?.querySelector(
      'link[data-rusa-auth-icon]',
    );
    previous?.remove();
    final link = web.document.createElement('link')
      ..setAttribute('data-rusa-auth-icon', '')
      ..setAttribute('rel', 'icon')
      ..setAttribute('href', icon['src'] as String);
    web.document.head?.append(link);
  }
  return name is String && name.trim().isNotEmpty ? name : null;
}

/// The public shell intentionally omits this link: the manifest is branded
/// instance metadata and the server returns it only to an authenticated user.
/// Installing it after the authenticated fetch lets the browser load PWA
/// metadata without an initial 401 being cached as its manifest result.
void _installAuthenticatedManifest() {
  final head = web.document.head;
  if (head == null) return;
  head.querySelector('link[data-rusa-auth-manifest]')?.remove();
  final link = web.document.createElement('link')
    ..setAttribute('data-rusa-auth-manifest', '')
    ..setAttribute('rel', 'manifest')
    ..setAttribute('href', 'manifest.json');
  head.append(link);
}
