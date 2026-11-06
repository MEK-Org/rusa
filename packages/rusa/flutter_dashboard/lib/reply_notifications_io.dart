import 'dart:async';
import 'dart:convert';

import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import 'api.dart';
import 'reply_notifications.dart';

/// The token is an opaque device credential. Keep the one successful
/// registration in the same keystore-backed class of storage as the Android
/// session, scoped to the server origin, so a later logout can revoke it
/// without creating Firebase Messaging merely to call `getToken`.
abstract interface class PushTokenStorage {
  Future<String?> read(Uri origin);
  Future<void> write(Uri origin, String token);
  Future<void> delete(Uri origin);
}

String _storageScope(Uri origin) => switch (origin.scheme) {
  'http' || 'https' => origin.origin,
  _ => origin.toString(),
};

class SecurePushTokenStorage implements PushTokenStorage {
  SecurePushTokenStorage({FlutterSecureStorage? storage})
    : _storage = storage ?? const FlutterSecureStorage();

  static const _version = 1;
  static const _prefix = 'rusa.io.push-token.';
  final FlutterSecureStorage _storage;

  @override
  Future<String?> read(Uri origin) async {
    final value = await _storage.read(key: _key(origin));
    if (value == null) return null;
    try {
      final decoded = jsonDecode(value);
      final token = decoded is Map<String, dynamic> ? decoded['token'] : null;
      if (decoded is! Map<String, dynamic> ||
          decoded['version'] != _version ||
          decoded['origin'] != _storageScope(origin) ||
          token is! String ||
          token.isEmpty) {
        await delete(origin);
        return null;
      }
      return token;
    } catch (_) {
      await delete(origin);
      return null;
    }
  }

  @override
  Future<void> write(Uri origin, String token) => _storage.write(
    key: _key(origin),
    value: jsonEncode({
      'version': _version,
      'origin': _storageScope(origin),
      'token': token,
    }),
  );

  @override
  Future<void> delete(Uri origin) => _storage.delete(key: _key(origin));

  String _key(Uri origin) =>
      '$_prefix${base64Url.encode(utf8.encode(_storageScope(origin)))}';
}

/// FCM token lifecycle for an Android device. Registration failures deliberately
/// leave walkie capture usable; the live SSE path remains the foreground route.
class IoReplyNotifications implements ReplyNotifications {
  IoReplyNotifications({
    FirebaseMessaging? messaging,
    PushTokenStorage? storage,
  }) : _providedMessaging = messaging,
       _storage = storage ?? SecurePushTokenStorage();

  FirebaseMessaging? _providedMessaging;
  final PushTokenStorage _storage;
  FirebaseMessaging get _messaging =>
      _providedMessaging ??= FirebaseMessaging.instance;
  StreamSubscription<String>? _refreshes;
  String? _registeredToken;
  DashboardApi? _api;

  @override
  Future<void> register(DashboardApi api) async {
    _api = api;
    final settings = await _messaging.requestPermission();
    if (settings.authorizationStatus != AuthorizationStatus.authorized &&
        settings.authorizationStatus != AuthorizationStatus.provisional) {
      return;
    }
    final token = await _messaging.getToken();
    if (token == null || token.isEmpty) return;
    await api.registerPushToken(token);
    _registeredToken = token;
    await _storage.write(api.base, token);
    _refreshes ??= _messaging.onTokenRefresh.listen((refreshed) {
      final activeApi = _api;
      if (activeApi == null) return;
      unawaited(_registerRefresh(activeApi, refreshed));
    });
  }

  Future<void> _registerRefresh(DashboardApi api, String token) async {
    try {
      await api.registerPushToken(token);
      _registeredToken = token;
      await _storage.write(api.base, token);
    } catch (_) {
      // A future app foreground/register retries an unavailable server.
    }
  }

  @override
  Future<void> revoke(DashboardApi api) async {
    // Do not initialize Firebase Messaging merely to sign out. A prior
    // successful registration is instead recovered from local secure storage.
    final token = _registeredToken ?? await _storage.read(api.base);
    if (token == null || token.isEmpty) return;
    await api.revokePushToken(token);
    _registeredToken = null;
    await _storage.delete(api.base);
  }

  @override
  void dispose() {
    unawaited(_refreshes?.cancel());
    _refreshes = null;
    _api = null;
  }
}
