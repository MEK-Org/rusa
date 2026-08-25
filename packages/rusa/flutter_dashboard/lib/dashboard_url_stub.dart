import 'widgets/header.dart';

/// VM/test fallback. The browser implementation reads and writes the URL.
DashboardView dashboardViewFromUrl() => DashboardView.overview;

String? focusedObligationIdFromUrl() => null;

String? focusedActorIdFromUrl() => null;

void writeDashboardViewToUrl(
  DashboardView view, {
  String? focusedObligationId,
  String? focusedActorId,
}) {}
