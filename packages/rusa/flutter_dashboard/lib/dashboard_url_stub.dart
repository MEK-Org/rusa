import 'widgets/header.dart';

/// VM/test fallback. The browser implementation reads and writes the URL; off
/// the browser there is no address to read, so no view is named.
DashboardView? dashboardViewFromUrl() => null;

String? focusedObligationIdFromUrl() => null;

String? focusedActorIdFromUrl() => null;

void writeDashboardViewToUrl(
  DashboardView view, {
  String? focusedObligationId,
  String? focusedActorId,
}) {}
