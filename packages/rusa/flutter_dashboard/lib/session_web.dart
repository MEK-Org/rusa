import 'dart:convert';
import 'dart:js_interop';

import 'package:firebase_auth/firebase_auth.dart';
import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_core_web/firebase_core_web.dart';
import 'package:http/http.dart' as http;
import 'package:web/web.dart' as web;

import 'session.dart';

@JS('firebase_core.initializeApp')
external JSObject _initializeJsApp(_FirebaseAppOptions options);

@JS('firebase_auth.initializeAuth')
external JSObject _initializeJsAuth(JSObject app, _FirebaseAuthOptions options);

@JS('firebase_auth.connectAuthEmulator')
external void _connectJsAuthEmulator(JSObject auth, JSString origin);

@JS('firebase_auth.debugErrorMap')
external JSAny? get _debugErrorMap;

@JS('firebase_auth.indexedDBLocalPersistence')
external JSAny? get _indexedDbLocalPersistence;

@JS('firebase_auth.browserLocalPersistence')
external JSAny? get _browserLocalPersistence;

@JS('firebase_auth.browserSessionPersistence')
external JSAny? get _browserSessionPersistence;

@JS('firebase_auth.browserPopupRedirectResolver')
external JSAny? get _browserPopupRedirectResolver;

extension type _FirebaseAppOptions._(JSObject _) implements JSObject {
  external _FirebaseAppOptions({
    required String apiKey,
    required String appId,
    required String authDomain,
    required String messagingSenderId,
    required String projectId,
  });
}

extension type _FirebaseAuthOptions._(JSObject _) implements JSObject {
  external _FirebaseAuthOptions({
    JSAny? errorMap,
    JSArray<JSAny?>? persistence,
    JSAny? popupRedirectResolver,
  });
}

class _FirebaseSessionUser implements SessionUser {
  _FirebaseSessionUser(this._user);

  final User _user;

  @override
  String? get photoUrl => _user.photoURL;

  @override
  String? get displayName => _user.displayName;

  @override
  String? get email => _user.email;

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

class _FirebaseConfiguration {
  const _FirebaseConfiguration({
    required this.apiKey,
    required this.appId,
    required this.authDomain,
    required this.messagingSenderId,
    required this.projectId,
  });

  factory _FirebaseConfiguration.fromJson(Map<String, dynamic> json) {
    return _FirebaseConfiguration(
      apiKey: _firebaseValue(json, 'apiKey'),
      appId: _firebaseWebMetadata(json, 'appId'),
      authDomain: _firebaseValue(json, 'authDomain'),
      messagingSenderId: _firebaseWebMetadata(json, 'messagingSenderId'),
      projectId: _firebaseValue(json, 'projectId'),
    );
  }

  final String apiKey;
  final String appId;
  final String authDomain;
  final String messagingSenderId;
  final String projectId;

  FirebaseOptions get flutterOptions => FirebaseOptions(
    apiKey: apiKey,
    appId: appId,
    messagingSenderId: messagingSenderId,
    projectId: projectId,
    authDomain: authDomain,
  );

  _FirebaseAppOptions get jsOptions => _FirebaseAppOptions(
    apiKey: apiKey,
    appId: appId,
    authDomain: authDomain,
    messagingSenderId: messagingSenderId,
    projectId: projectId,
  );
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

  final firebaseConfiguration = _FirebaseConfiguration.fromJson(firebase);
  final emulator = config['emulatorUrl'];
  if (emulator != null) {
    await _configureAuthEmulator(emulator, firebaseConfiguration);
  }
  await Firebase.initializeApp(options: firebaseConfiguration.flutterOptions);
  final auth = FirebaseAuth.instance;
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

Future<void> _configureAuthEmulator(
  Object value,
  _FirebaseConfiguration firebase,
) async {
  if (value is! String) {
    throw StateError(
      'Dashboard Firebase emulator URL must be an http(s) origin with host and port',
    );
  }
  final emulator = Uri.tryParse(value);
  final supportedScheme =
      emulator?.scheme == 'http' || emulator?.scheme == 'https';
  if (emulator == null ||
      !supportedScheme ||
      emulator.host.isEmpty ||
      !emulator.hasPort ||
      emulator.userInfo.isNotEmpty) {
    throw StateError(
      'Dashboard Firebase emulator URL must be an http(s) origin with host and port',
    );
  }
  try {
    // The runtime config is not available to index.html, and FlutterFire
    // creates Auth while initializing its registered service. Prepare the
    // emulator first, using its exact pinned loader globals and Auth recipe.
    final core = FirebaseCoreWeb();
    // ignore: invalid_use_of_visible_for_testing_member
    final sdkBase =
        // ignore: invalid_use_of_visible_for_testing_member
        'https://www.gstatic.com/firebasejs/${core.firebaseSDKVersion}';
    // ignore: invalid_use_of_visible_for_testing_member
    await core.injectSrcScript('$sdkBase/firebase-app.js', 'firebase_core');
    // ignore: invalid_use_of_visible_for_testing_member
    await core.injectSrcScript('$sdkBase/firebase-auth.js', 'firebase_auth');
    final app = _initializeJsApp(firebase.jsOptions);
    // Matches firebase_auth_web 6.3.0's getAuthInstance exactly; its later
    // delegate call reuses this initialized Auth instance.
    final options = _FirebaseAuthOptions(
      errorMap: _debugErrorMap,
      persistence: [
        _indexedDbLocalPersistence,
        _browserLocalPersistence,
        _browserSessionPersistence,
      ].toJS,
      popupRedirectResolver: _browserPopupRedirectResolver,
    );
    final auth = _initializeJsAuth(app, options);
    _connectJsAuthEmulator(auth, emulator.origin.toJS);
  } catch (_) {
    throw StateError(
      'Dashboard Firebase emulator bridge failed to initialize; verify pinned FlutterFire web packages and run the documented emulator browser regression',
    );
  }
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

/// Refresh the public manifest after sign-in, including for a cached shell
/// from a version that omitted its manifest link before authentication.
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
