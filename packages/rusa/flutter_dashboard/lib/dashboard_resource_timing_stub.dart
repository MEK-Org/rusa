import 'dashboard_resource_timing.dart';

/// Off the browser there is no Resource Timing, so requests carry no phases.
DashboardResourceTimingSource? defaultDashboardResourceTimingSource() => null;
