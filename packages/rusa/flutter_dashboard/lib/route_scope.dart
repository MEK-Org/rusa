import 'package:flutter/foundation.dart';
import 'package:flutter/widgets.dart';

/// Injects route updates from platform popstate/back navigation to descendant dashboard widgets.
///
/// Because [RusaDashboardApp] defines [MaterialApp.onGenerateRoute] as returning null
/// (to prevent duplicate hosts on named pushes), [WidgetsApp]'s built-in
/// [WidgetsBindingObserver.didPushRouteInformation] would attempt [Navigator.pushNamed]
/// and fail. Intercepting platform route pushes at the root [_RusaDashboardAppState]
/// observer and providing them via [DashboardRouteScope] lets [DashboardBody] reconcile
/// view and focus state without reloading the app or breaking ongoing session streams.
class DashboardRouteScope extends InheritedWidget {
  const DashboardRouteScope({
    super.key,
    required this.routeNotifier,
    required super.child,
  });

  final ValueListenable<RouteInformation?> routeNotifier;

  static ValueListenable<RouteInformation?>? maybeOf(BuildContext context) {
    return context
        .dependOnInheritedWidgetOfExactType<DashboardRouteScope>()
        ?.routeNotifier;
  }

  @override
  bool updateShouldNotify(DashboardRouteScope oldWidget) =>
      routeNotifier != oldWidget.routeNotifier;
}
