import 'widgets/header.dart';

/// The view the URI path names, or null when the path names none.
DashboardView? parseDashboardView(Uri uri) {
  final cleanPath = uri.path.replaceFirst(RegExp(r'/+$'), '');
  if (cleanPath.startsWith('/actors')) return DashboardView.actors;
  if (cleanPath == '/understanding') return DashboardView.understanding;
  if (cleanPath == '/reports') return DashboardView.reports;
  if (cleanPath.startsWith('/work')) return DashboardView.work;
  if (cleanPath == '/overview') return DashboardView.overview;
  return null;
}

/// Extracts the focused obligation ID from path `/work/<id>` or legacy query
/// parameter `?obligation=<id>`. Path segments need decoding; queryParameters
/// has already decoded query values.
String? parseFocusedObligationId(Uri uri) {
  final cleanPath = uri.path.replaceFirst(RegExp(r'/+$'), '');
  if (cleanPath.startsWith('/work/')) {
    final raw = cleanPath.substring('/work/'.length);
    return Uri.decodeComponent(raw);
  }
  final queryParam = uri.queryParameters['obligation'];
  return queryParam;
}

/// Extracts and decodes the focused actor ID from path `/actors/<id>`.
String? parseFocusedActorId(Uri uri) {
  final cleanPath = uri.path.replaceFirst(RegExp(r'/+$'), '');
  if (cleanPath.startsWith('/actors/')) {
    final raw = cleanPath.substring('/actors/'.length);
    return Uri.decodeComponent(raw);
  }
  return null;
}

/// Constructs a new dashboard [Uri] reflecting the selected view and focus target.
Uri buildDashboardUri(
  Uri baseUri,
  DashboardView view, {
  String? focusedObligationId,
  String? focusedActorId,
}) {
  final queryParams = Map<String, String>.from(baseUri.queryParameters);
  queryParams.remove('obligation');

  var newPath = '/${view.name}';
  if (view == DashboardView.work && focusedObligationId != null) {
    newPath = '/work/$focusedObligationId';
  } else if (view == DashboardView.actors && focusedActorId != null) {
    newPath = '/actors/$focusedActorId';
  }

  return Uri(
    path: newPath,
    queryParameters: queryParams.isEmpty ? null : queryParams,
  );
}
