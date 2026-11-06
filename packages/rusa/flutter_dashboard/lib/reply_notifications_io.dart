import 'dart:async';
import 'dart:io';

import 'package:firebase_messaging/firebase_messaging.dart';

import 'api.dart';
import 'reply_notifications.dart';

ReplyNotifications? platformCreateReplyNotifications() =>
    Platform.isAndroid ? IoReplyNotifications() : null;

/// FCM token lifecycle for an Android device. Registration failures deliberately
/// leave walkie capture usable; the live SSE path remains the foreground route.
class IoReplyNotifications implements ReplyNotifications {
  IoReplyNotifications({FirebaseMessaging? messaging})
    : _messaging = messaging ?? FirebaseMessaging.instance;

  final FirebaseMessaging _messaging;
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
    } catch (_) {
      // A future app foreground/register retries an unavailable server.
    }
  }

  @override
  Future<void> revoke(DashboardApi api) async {
    final token = _registeredToken ?? await _messaging.getToken();
    if (token == null || token.isEmpty) return;
    await api.revokePushToken(token);
    _registeredToken = null;
  }

  @override
  void dispose() {
    unawaited(_refreshes?.cancel());
    _refreshes = null;
    _api = null;
  }
}
