import 'package:web/web.dart' as web;

import 'widgets/header.dart';

DashboardView dashboardViewFromUrl() => _parse(Uri.base.path);

String? focusedObligationIdFromUrl() {
  final path = Uri.base.path.replaceFirst(RegExp(r'/+$'), '');
  if (path.startsWith('/work/')) {
    return path.substring('/work/'.length);
  }
  return Uri.base.queryParameters['obligation'];
}

String? focusedActorIdFromUrl() {
  final path = Uri.base.path.replaceFirst(RegExp(r'/+$'), '');
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
}) {
  final base = Uri.base;
  var queryParams = Map<String, String>.from(base.queryParameters);
  queryParams.remove('obligation');

  var newPath = '/${view.name}';
  if (view == DashboardView.work && focusedObligationId != null) {
    newPath = '/work/$focusedObligationId';
  } else if (view == DashboardView.actors && focusedActorId != null) {
    newPath = '/actors/$focusedActorId';
  }

  final url = Uri(
    scheme: base.scheme,
    userInfo: base.userInfo,
    host: base.host,
    port: base.hasPort ? base.port : null,
    path: newPath,
    queryParameters: queryParams.isEmpty ? null : queryParams,
  ).toString();
  web.window.history.replaceState(null, '', url);
}

DashboardView _parse(String path) {
  final cleanPath = path.replaceFirst(RegExp(r'/+$'), '');
  if (cleanPath.startsWith('/actors')) return DashboardView.actors;
  if (cleanPath == '/understanding') return DashboardView.understanding;
  if (cleanPath == '/reports') return DashboardView.reports;
  if (cleanPath.startsWith('/work')) return DashboardView.work;
  return DashboardView.overview;
}
