import 'package:firebase_auth/firebase_auth.dart';
import 'package:firebase_core/firebase_core.dart';
import 'package:google_sign_in/google_sign_in.dart';

import 'session.dart';

/// The Firebase app ID this device build is registered under. The server
/// serves the Firebase *Web* app's public configuration; a native Firebase
/// client must identify as the project's Android app instead, whose ID is
/// operator configuration supplied at build time like `RUSA_SERVER_URL`
/// (never committed; see docs/dashboard-auth.md).
const _androidAppId = String.fromEnvironment('RUSA_FIREBASE_ANDROID_APP_ID');

/// The OAuth client ID of the Firebase project's *web* client. Android's
/// Credential Manager issues the Google ID token for this audience, which
/// Firebase then accepts as a Google credential. Build-time operator
/// configuration, like the app ID above.
const _googleServerClientId = String.fromEnvironment(
  'RUSA_GOOGLE_SERVER_CLIENT_ID',
);

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
  _NativeSessionAuth(this._auth, this._google);

  final FirebaseAuth _auth;
  final GoogleSignIn _google;

  @override
  SessionUser? get currentUser {
    final user = _auth.currentUser;
    return user == null ? null : _NativeSessionUser(user);
  }

  @override
  Stream<SessionUser?> authStateChanges() => _auth.authStateChanges().map(
    (user) => user == null ? null : _NativeSessionUser(user),
  );

  /// Firebase's documented native Google flow: Credential Manager's account
  /// chooser yields a Google ID token, which signs in to Firebase as a Google
  /// credential. The server then verifies the Firebase ID token exactly as it
  /// does for the browser.
  @override
  Future<SessionUser> signInWithGoogle() async {
    final account = await _google.authenticate();
    final idToken = account.authentication.idToken;
    if (idToken == null) {
      throw StateError('Google sign in returned no ID token');
    }
    final result = await _auth.signInWithCredential(
      GoogleAuthProvider.credential(idToken: idToken),
    );
    final user = result.user;
    if (user == null) throw StateError('Google sign in returned no user');
    return _NativeSessionUser(user);
  }

  /// Clears Credential Manager's selection too, so the next sign-in offers
  /// the account chooser like the web dashboard's `select_account` prompt.
  @override
  Future<void> signOut() async {
    await _auth.signOut();
    await _google.signOut();
  }
}

String _firebaseValue(Map<String, dynamic> config, String name) {
  final value = config[name];
  if (value is! String || value.isEmpty) {
    throw StateError('Dashboard Firebase configuration is unavailable');
  }
  return value;
}

/// Initializes the native Firebase SDK from the server's public Firebase
/// configuration and this build's Android app ID, and Google Sign-In with the
/// project's web client ID. Fails startup explicitly, rather than offering a
/// sign-in that cannot succeed, when the build carries either value empty.
/// The named parameters are test seams for the build-time defines.
Future<SessionAuth> initializeNativeFirebaseAuth(
  Map<String, dynamic> firebase, {
  String androidAppId = _androidAppId,
  String googleServerClientId = _googleServerClientId,
}) async {
  if (androidAppId.isEmpty) {
    throw StateError(
      'This dashboard build has no Firebase Android app ID; rebuild with '
      '--dart-define=RUSA_FIREBASE_ANDROID_APP_ID=<app id>',
    );
  }
  if (googleServerClientId.isEmpty) {
    throw StateError(
      'This dashboard build has no Google web client ID; rebuild with '
      '--dart-define=RUSA_GOOGLE_SERVER_CLIENT_ID=<client id>',
    );
  }
  final messagingSenderId = firebase['messagingSenderId'];
  await Firebase.initializeApp(
    options: FirebaseOptions(
      apiKey: _firebaseValue(firebase, 'apiKey'),
      appId: androidAppId,
      messagingSenderId: messagingSenderId is String ? messagingSenderId : '',
      projectId: _firebaseValue(firebase, 'projectId'),
      authDomain: _firebaseValue(firebase, 'authDomain'),
    ),
  );
  await GoogleSignIn.instance.initialize(serverClientId: googleServerClientId);
  return _NativeSessionAuth(FirebaseAuth.instance, GoogleSignIn.instance);
}
