import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

import 'widgets/header.dart';

/// Test override for simulating browser URLs in unit and widget tests.
@visibleForTesting
String? debugDashboardUrl;

/// VM/test fallback. The browser implementation reads and writes the URL; off
/// the browser there is no address to read, so no view is named unless
/// [debugDashboardUrl] is set by a test.
DashboardView? dashboardViewFromUrl() {
  if (debugDashboardUrl == null) return null;
  return _parse(Uri.parse(debugDashboardUrl!).path);
}

String? focusedObligationIdFromUrl() {
  if (debugDashboardUrl == null) return null;
  final uri = Uri.parse(debugDashboardUrl!);
  final path = uri.path.replaceFirst(RegExp(r'/+$'), '');
  if (path.startsWith('/work/')) {
    return path.substring('/work/'.length);
  }
  return uri.queryParameters['obligation'];
}

String? focusedActorIdFromUrl() {
  if (debugDashboardUrl == null) return null;
  final uri = Uri.parse(debugDashboardUrl!);
  final path = uri.path.replaceFirst(RegExp(r'/+$'), '');
  if (path.startsWith('/actors/')) {
    return path.substring('/actors/'.length);
  }
  return null;
}

void writeDashboardViewToUrl(
  DashboardView view, {
  String? focusedObligationId,
  String? focusedActorId,
  Future<void> Function()? onNavigation,
}) {
  final baseUri = debugDashboardUrl != null
      ? Uri.parse(debugDashboardUrl!)
      : Uri();
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
