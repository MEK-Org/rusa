import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

import 'dashboard_url_core.dart';
import 'widgets/header.dart';

/// Test override for simulating browser URLs in unit and widget tests.
@visibleForTesting
String? debugDashboardUrl;

Uri _currentUri() =>
    debugDashboardUrl != null ? Uri.parse(debugDashboardUrl!) : Uri.base;

/// The view the current address names, or null when the path names none —
/// the bare `/` landing, where the caller picks the default that suits the
/// viewport.
DashboardView? dashboardViewFromUrl() => parseDashboardView(_currentUri());

String? focusedObligationIdFromUrl() => parseFocusedObligationId(_currentUri());

String? focusedActorIdFromUrl() => parseFocusedActorId(_currentUri());

/// Keep the current browser address shareable without a page reload.
void writeDashboardViewToUrl(
  DashboardView view, {
  String? focusedObligationId,
  String? focusedActorId,
  Future<void> Function()? onNavigation,
}) {
  final baseUri = _currentUri();
  final url = buildDashboardUri(
    baseUri,
    view,
    focusedObligationId: focusedObligationId,
    focusedActorId: focusedActorId,
  );
  if (debugDashboardUrl != null) {
    debugDashboardUrl = url.toString();
  }
  if (url.path != baseUri.path || url.query != baseUri.query) {
    if (onNavigation != null) unawaited(onNavigation());
  }
  // Let Flutter update its own browser-history entry. Calling the DOM History
  // API directly replaces the engine's serialized state and breaks teardown.
  // This is deliberately fire-and-forget: a view selection must not wait for
  // best-effort address-bar synchronization.
  unawaited(SystemNavigator.routeInformationUpdated(uri: url, replace: true));
}
