import 'package:firebase_auth_platform_interface/firebase_auth_platform_interface.dart';
// The host API's codec and reply types are what the Android plugin encodes;
// replying with them is how this test stands in for the native side.
// ignore: implementation_imports
import 'package:firebase_auth_platform_interface/src/pigeon/messages.pigeon.dart';
import 'package:firebase_core_platform_interface/test.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:google_sign_in_android/google_sign_in_android.dart';
// ignore: implementation_imports
import 'package:google_sign_in_android/src/messages.g.dart';

import 'package:rusa_dashboard/io_firebase_auth.dart';

const _googleChannel =
    'dev.flutter.pigeon.google_sign_in_android.GoogleSignInApi';
const _authChannel =
    'dev.flutter.pigeon.firebase_auth_platform_interface.FirebaseAuthHostApi';

/// Answers one pigeon host-API channel the way the native plugin would.
void _answer(
  String channel,
  MessageCodec<Object?> codec,
  Object? Function(List<Object?> args) reply,
) {
  TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
      .setMockMessageHandler(channel, (message) async {
        final args = codec.decodeMessage(message) as List<Object?>? ?? const [];
        return codec.encodeMessage(<Object?>[reply(args)]);
      });
}

/// Firebase core on a device build without google-services.json: no native
/// default app exists until Dart initializes one from served options.
class _NoResourceFirebaseCore implements TestFirebaseCoreHostApi {
  @override
  Future<List<CoreInitializeResponse>> initializeCore() async => [];

  @override
  Future<CoreInitializeResponse> initializeApp(
    String appName,
    CoreFirebaseOptions initializeAppRequest,
  ) async => CoreInitializeResponse(
    name: appName,
    options: initializeAppRequest,
    pluginConstants: {},
  );

  @override
  Future<CoreFirebaseOptions> optionsFromResource() =>
      throw StateError('no google-services.json in this build');
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  // Crosses the real Dart halves of google_sign_in_android and firebase_auth
  // down to their platform channels, so a regression to a flow the Android
  // plugins do not document for Google (signInWithProvider) fails here.
  test('native sign-in exchanges a Credential Manager Google ID token for a '
      'Firebase Google credential', () async {
    TestFirebaseCoreHostApi.setUp(_NoResourceFirebaseCore());
    GoogleSignInAndroid.registerWith();
    final messenger =
        TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;

    final credentialRequests = <GetCredentialRequestParams>[];
    _answer(
      '$_googleChannel.getCredential',
      GoogleSignInApi.pigeonChannelCodec,
      (args) {
        credentialRequests.add(args.single! as GetCredentialRequestParams);
        return GetCredentialSuccess(
          credential: PlatformGoogleIdTokenCredential(
            email: 'person@example.com',
            idToken: 'synthetic-google-id-token',
          ),
        );
      },
    );
    var credentialStateCleared = 0;
    _answer(
      '$_googleChannel.clearCredentialState',
      GoogleSignInApi.pigeonChannelCodec,
      (_) {
        credentialStateCleared++;
        return null;
      },
    );

    const authCodec = FirebaseAuthHostApi.pigeonChannelCodec;
    for (final listener in [
      'registerIdTokenListener',
      'registerAuthStateListener',
    ]) {
      final events = 'synthetic/$listener';
      _answer('$_authChannel.$listener', authCodec, (_) => events);
      messenger.setMockStreamHandler(
        EventChannel(events),
        MockStreamHandler.inline(onListen: (_, _) {}),
      );
    }
    final signInInputs = <Map<Object?, Object?>>[];
    _answer('$_authChannel.signInWithCredential', authCodec, (args) {
      signInInputs.add(args[1]! as Map<Object?, Object?>);
      return InternalUserCredential(
        user: InternalUserDetails(
          userInfo: InternalUserInfo(
            uid: 'synthetic-uid',
            email: 'person@example.com',
            isAnonymous: false,
            isEmailVerified: true,
          ),
          providerData: const [],
        ),
      );
    });
    var firebaseSignOuts = 0;
    _answer('$_authChannel.signOut', authCodec, (_) {
      firebaseSignOuts++;
      return null;
    });

    final auth = await initializeNativeFirebaseAuth(
      {
        'apiKey': 'synthetic-api-key',
        'authDomain': 'synthetic.example.com',
        'projectId': 'synthetic-project',
      },
      androidAppId: '1:000000000000:android:0000000000000000',
      googleServerClientId: 'synthetic-web-client.example.com',
    );
    final user = await auth.signInWithGoogle();

    expect(user.uid, 'synthetic-uid');
    final request = credentialRequests.single;
    expect(request.useButtonFlow, isTrue);
    expect(request.serverClientId, 'synthetic-web-client.example.com');
    final input = signInInputs.single;
    expect(input['providerId'], GoogleAuthProvider.PROVIDER_ID);
    expect(input['idToken'], 'synthetic-google-id-token');

    await auth.signOut();
    expect(firebaseSignOuts, 1);
    expect(credentialStateCleared, 1);
  });

  test('a build without the Google web client ID fails startup by name', () {
    expect(
      () => initializeNativeFirebaseAuth(
        const {},
        androidAppId: '1:000000000000:android:0000000000000000',
        googleServerClientId: '',
      ),
      throwsA(
        isA<StateError>().having(
          (e) => e.message,
          'message',
          contains('RUSA_GOOGLE_SERVER_CLIENT_ID'),
        ),
      ),
    );
  });
}
