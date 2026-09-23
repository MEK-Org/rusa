import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

import 'widgets/header.dart';

/// Test override for simulating browser URLs in unit and widget tests.
@visibleForTesting
String? debugDashboardUrl;

/// The view the current address names, or null when the path names none —
/// the bare `/` landing, where the caller picks the default that suits the
/// viewport.
DashboardView? dashboardViewFromUrl() {
  final path = debugDashboardUrl != null
      ? Uri.parse(debugDashboardUrl!).path
      : Uri.base.path;
  return _parse(path);
}

String? focusedObligationIdFromUrl() {
  final uri = debugDashboardUrl != null
      ? Uri.parse(debugDashboardUrl!)
      : Uri.base;
  final path = uri.path.replaceFirst(RegExp(r'/+$'), '');
  if (path.startsWith('/work/')) {
    return path.substring('/work/'.length);
  }
  return uri.queryParameters['obligation'];
}

String? focusedActorIdFromUrl() {
  final uri = debugDashboardUrl != null
      ? Uri.parse(debugDashboardUrl!)
      : Uri.base;
  final path = uri.path.replaceFirst(RegExp(r'/+$'), '');
  if (path.startsWith('/actors/')) {
    return path.substring('/actors/'.length);
  }
  return null;
}

/// Keep the current browser address shareable without a page reload.
void writeDashboardViewToUrl(
  DashboardView view, {
  String? focusedObligationId,
  String? focusedActorId,
  Future<void> Function()? onNavigation,
}) {
  final baseUri = debugDashboardUrl != null
      ? Uri.parse(debugDashboardUrl!)
      : Uri.base;
  var queryParams = Map<String, String>.from(baseUri.queryParameters);
  queryParams.remove('obligation');

  var newPath = '/${view.name}';
  if (view == DashboardView.work && focusedObligationId != null) {
    newPath = '/work/$focusedObligationId';
  } else if (view == DashboardView.actors && focusedActorId != null) {
    newPath = '/actors/$focusedActorId';
  }

  final url = Uri(
    path: newPath,
    queryParameters: queryParams.isEmpty ? null : queryParams,
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

DashboardView? _parse(String path) {
  final cleanPath = path.replaceFirst(RegExp(r'/+$'), '');
  if (cleanPath.startsWith('/actors')) return DashboardView.actors;
  if (cleanPath == '/understanding') return DashboardView.understanding;
  if (cleanPath == '/reports') return DashboardView.reports;
  if (cleanPath.startsWith('/work')) return DashboardView.work;
  if (cleanPath == '/overview') return DashboardView.overview;
  return null;
}
