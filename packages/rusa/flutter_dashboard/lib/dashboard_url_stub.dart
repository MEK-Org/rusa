import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

import 'dashboard_url_core.dart';
import 'widgets/header.dart';

/// Test override for simulating browser URLs in unit and widget tests.
@visibleForTesting
String? debugDashboardUrl;

Uri? _currentUri() =>
    debugDashboardUrl != null ? Uri.parse(debugDashboardUrl!) : null;

/// VM/test fallback. The browser implementation reads and writes the URL; off
/// the browser there is no address to read, so no view is named unless
/// [debugDashboardUrl] is set by a test.
DashboardView? dashboardViewFromUrl() {
  final uri = _currentUri();
  return uri != null ? parseDashboardView(uri) : null;
}

String? focusedObligationIdFromUrl() {
  final uri = _currentUri();
  return uri != null ? parseFocusedObligationId(uri) : null;
}

String? focusedActorIdFromUrl() {
  final uri = _currentUri();
  return uri != null ? parseFocusedActorId(uri) : null;
}

void writeDashboardViewToUrl(
  DashboardView view, {
  String? focusedObligationId,
  String? focusedActorId,
  Future<void> Function()? onNavigation,
}) {
  final baseUri = _currentUri() ?? Uri();
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
  unawaited(SystemNavigator.routeInformationUpdated(uri: url, replace: true));
}
