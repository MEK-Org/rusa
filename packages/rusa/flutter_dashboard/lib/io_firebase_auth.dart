import 'package:firebase_auth/firebase_auth.dart';
import 'package:firebase_core/firebase_core.dart';

import 'session.dart';

/// The Firebase app ID this device build is registered under. The server
/// serves the Firebase *Web* app's public configuration; a native Firebase
/// client must identify as the project's Android app instead, whose ID is
/// operator configuration supplied at build time like `RUSA_SERVER_URL`
/// (never committed; see docs/dashboard-auth.md).
const _androidAppId = String.fromEnvironment('RUSA_FIREBASE_ANDROID_APP_ID');

class _NativeSessionUser implements SessionUser {
  _NativeSessionUser(this._user);

  final User _user;

  @override
  String get uid => _user.uid;

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

class _NativeSessionAuth implements SessionAuth {
  _NativeSessionAuth(this._auth);

  final FirebaseAuth _auth;

  @override
  SessionUser? get currentUser {
    final user = _auth.currentUser;
    return user == null ? null : _NativeSessionUser(user);
  }

  @override
  Stream<SessionUser?> authStateChanges() => _auth.authStateChanges().map(
    (user) => user == null ? null : _NativeSessionUser(user),
  );

  /// The native SDK's provider flow opens Google's account chooser in a
  /// browser tab and returns the Firebase user, the device counterpart of the
  /// web dashboard's popup. The server then verifies the ID token exactly as
  /// it does for the browser.
  @override
  Future<SessionUser> signInWithGoogle() async {
    final provider = GoogleAuthProvider()
      ..setCustomParameters({'prompt': 'select_account'});
    final result = await _auth.signInWithProvider(provider);
    final user = result.user;
    if (user == null) throw StateError('Google sign in returned no user');
    return _NativeSessionUser(user);
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

/// Initializes the native Firebase SDK from the server's public Firebase
/// configuration and this build's Android app ID. Fails startup explicitly,
/// rather than offering a sign-in that cannot succeed, when the build carries
/// no Android app ID.
Future<SessionAuth> initializeNativeFirebaseAuth(
  Map<String, dynamic> firebase,
) async {
  if (_androidAppId.isEmpty) {
    throw StateError(
      'This dashboard build has no Firebase Android app ID; rebuild with '
      '--dart-define=RUSA_FIREBASE_ANDROID_APP_ID=<app id>',
    );
  }
  final messagingSenderId = firebase['messagingSenderId'];
  await Firebase.initializeApp(
    options: FirebaseOptions(
      apiKey: _firebaseValue(firebase, 'apiKey'),
      appId: _androidAppId,
      messagingSenderId: messagingSenderId is String ? messagingSenderId : '',
      projectId: _firebaseValue(firebase, 'projectId'),
      authDomain: _firebaseValue(firebase, 'authDomain'),
    ),
  );
  return _NativeSessionAuth(FirebaseAuth.instance);
}
