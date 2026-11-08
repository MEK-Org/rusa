import 'api.dart';

/// Android FCM registration lives behind this seam so web and headless tests
/// never load a native messaging plugin.
abstract interface class ReplyNotifications {
  /// Ask the platform for notification permission and register its current FCM
  /// token after the dashboard session has been authenticated.
  Future<void> register(DashboardApi api);

  /// Best-effort device-token revocation before an authenticated logout.
  Future<void> revoke(DashboardApi api);

  void dispose();
}
