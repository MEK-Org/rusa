import 'dart:async';
import 'package:flutter/material.dart';

import '../breakpoints.dart';
import '../dashboard_url.dart';
import '../models.dart';
import '../store.dart';
import '../theme.dart';
import 'actor_tree.dart';
import 'detail_panel.dart';
import 'header.dart';
import 'mobile_nav_drawer.dart';
import 'overview_tab.dart';
import 'work_tab.dart';

/// The header + responsive master-detail body. Lives in its own (VM-safe) file
/// — importing no web-only code — so the screenshot harness can render the real
/// layout headlessly.
///
///  • Wide  (≥ [kNarrowBreakpoint]): actor tree on the left, detail on the right,
///    with the nav and quota inline in the header.
///  • Narrow (< [kNarrowBreakpoint]): a full-width list; tapping an actor
///    navigates to its full-width detail. The nav moves into a drawer opened
///    from the header's hamburger, and inside a detail a back arrow takes that
///    same slot rather than adding a row of its own.
class DashboardBody extends StatefulWidget {
  const DashboardBody({
    super.key,
    required this.store,
    this.understandingBuilder,
    this.reportsBuilder,
  });

  final DashboardStore store;

  /// Builds the Integrated Understanding view shown when its nav item is active.
  /// Injected by the web entrypoint (main.dart) so THIS file stays free of the
  /// web-only IU / glass-goals imports — keeping it VM-safe for the headless
  /// screenshot harness. Null in tests → the IU nav still renders, but selecting
  /// it shows a small placeholder.
  final WidgetBuilder? understandingBuilder;

  /// Builds the IU Reports view — since ISSUE_NUM a sub-view of the IU route
  /// (selected by the in-route switch), not its own nav destination.
  final WidgetBuilder? reportsBuilder;

  @override
  State<DashboardBody> createState() => _DashboardBodyState();
}

class _DashboardBodyState extends State<DashboardBody> {
  late DashboardView _view;
  StreamSubscription<String?>? _focusSub;
  StreamSubscription<String?>? _actorSub;
  final GlobalKey<ScaffoldState> _scaffoldKey = GlobalKey<ScaffoldState>();

  /// The view the address named when this body was mounted, read exactly once:
  /// the first [writeDashboardViewToUrl] (the seeded streams replay one as soon
  /// as they are subscribed) puts a view in the address, so re-reading it later
  /// would no longer tell us whether the *load* was addressed.
  DashboardView? _urlNamedView;

  /// Whether the landing view has been settled against the viewport, which
  /// takes the body's own layout constraints and so can only happen once it is
  /// being laid out.
  bool _landingViewResolved = false;

  @override
  void initState() {
    super.initState();
    _urlNamedView = dashboardViewFromUrl();
    _view = _urlNamedView ?? DashboardView.overview;
    final initialObligation = focusedObligationIdFromUrl();
    if (initialObligation != null) {
      widget.store.setFocusedObligationId(initialObligation);
    }
    final initialActor = focusedActorIdFromUrl();
    if (initialActor != null) {
      widget.store.clickActor(initialActor);
    }
    // Both seeded BehaviorSubjects replay after subscription, supplying the
    // initial URL write as well as later focus and actor updates.
    _focusSub = widget.store.focusedObligationId.listen((id) {
      if (mounted) {
        writeDashboardViewToUrl(
          _view,
          focusedObligationId: id,
          focusedActorId: widget.store.primary.valueOrNull,
        );
      }
    });

    _actorSub = widget.store.primary.listen((id) {
      if (mounted) {
        writeDashboardViewToUrl(
          _view,
          focusedObligationId: widget.store.focusedObligationId.valueOrNull,
          focusedActorId: id,
        );
      }
    });
  }

  /// Settles where the load lands, once the body knows how much room it has.
  /// Taken only for the first bounded layout, so a later rotation never yanks
  /// you off the view you are reading. Assigns [_view] directly rather than
  /// through `setState`: this runs during layout, and every read of `_view` in
  /// this same pass happens below it.
  void _resolveLandingView(BoxConstraints constraints) {
    if (_landingViewResolved || !constraints.hasBoundedHeight) return;
    _landingViewResolved = true;
    _view = landingViewFor(
      urlNamedView: _urlNamedView,
      height: constraints.maxHeight,
    );
  }

  @override
  void dispose() {
    _focusSub?.cancel();
    _actorSub?.cancel();
    super.dispose();
  }

  void _selectView(DashboardView view) {
    if (_view == view) return;
    setState(() => _view = view);
    writeDashboardViewToUrl(
      view,
      focusedObligationId: widget.store.focusedObligationId.valueOrNull,
      focusedActorId: widget.store.primary.valueOrNull,
    );
  }

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(
      builder: (context, constraints) {
        _resolveLandingView(constraints);
        if (constraints.maxWidth >= kNarrowBreakpoint) {
          return _chrome();
        }
        // On a phone the header's leading slot carries the navigation: the
        // hamburger that opens the drawer, or — once an actor's detail is open
        // — the back arrow out of it.
        return StreamBuilder<String?>(
          stream: widget.store.primary,
          initialData: widget.store.primary.valueOrNull,
          builder: (context, snap) {
            final inActorDetail =
                _view == DashboardView.actors && snap.data != null;
            // A nested Scaffold of our own: the drawer has to hang off a
            // Scaffold, and this body is rendered directly — without main.dart's
            // — by the screenshot harness and the widget tests, so owning one
            // keeps the drawer (and this file) VM-safe.
            return Scaffold(
              key: _scaffoldKey,
              backgroundColor: MeshColors.bgPrimary,
              drawer: MobileNavDrawer(
                store: widget.store,
                selected: _view,
                onSelect: _selectView,
                quotaProviders: _quotaProviders(
                  widget.store.dashboardConfig.valueOrNull,
                ),
              ),
              body: _chrome(
                onMenuTap: () => _scaffoldKey.currentState?.openDrawer(),
                onBack: inActorDetail ? widget.store.clearSelection : null,
              ),
            );
          },
        );
      },
    );
  }

  /// The header + current view. Paints the dark base color directly (not just
  /// via the Scaffold) so the detail pane — which draws no background of its
  /// own — stays on-theme everywhere, including the headless screenshot capture.
  Widget _chrome({VoidCallback? onMenuTap, VoidCallback? onBack}) {
    return ColoredBox(
      color: MeshColors.bgPrimary,
      child: Column(
        children: [
          MeshHeader(
            store: widget.store,
            selected: _view,
            onSelect: _selectView,
            quotaProviders: _quotaProviders(
              widget.store.dashboardConfig.valueOrNull,
            ),
            onMenuTap: onMenuTap,
            onBack: onBack,
          ),
          Expanded(
            child: _view == DashboardView.overview
                ? OverviewTab(store: widget.store, onSelectView: _selectView)
                : (_view == DashboardView.understanding ||
                      _view == DashboardView.reports)
                ? _IuBody(
                    view: _view,
                    onSelect: _selectView,
                    understandingBuilder: widget.understandingBuilder,
                    reportsBuilder: widget.reportsBuilder,
                  )
                : _view == DashboardView.work
                ? WorkTab(store: widget.store, onSelectView: _selectView)
                : _ActorsBody(store: widget.store, onSelectView: _selectView),
          ),
        ],
      ),
    );
  }
}

/// Where a load lands: the view the address named, if it named one, and
/// otherwise the default that suits [height]. On a truly short viewport — the
/// geometry the walkie-talkie takes over full screen — the overview's stacked
/// cards have nowhere to go, so the actor hierarchy is the useful landing.
///
/// Short means short at any width: the header already collapses its walkie row
/// on the same [kShortViewportHeight] threshold regardless of width, and a wide
/// 450px-tall window has no more room for stacked overview cards than a
/// landscape phone does.
DashboardView landingViewFor({
  required DashboardView? urlNamedView,
  required double height,
}) {
  if (urlNamedView != null) return urlNamedView;
  return height < kShortViewportHeight
      ? DashboardView.actors
      : DashboardView.overview;
}

Map<String, QuotaProviderConfig> _quotaProviders(DashboardConfigDto? config) {
  // The server config only overrides `primaryWindow` today, so carry the
  // default `sessionWindow` (the concentric inner ring, ISSUE_NUM) forward rather
  // than losing it whenever a provider has a server-side override.
  final fromConfig =
      config?.quotaProviders.map(
        (provider, entry) => MapEntry(
          provider,
          QuotaProviderConfig(
            primaryWindow: entry.primaryWindow,
            sessionWindow: kDefaultQuotaProviders[provider]?.sessionWindow,
          ),
        ),
      ) ??
      const <String, QuotaProviderConfig>{};
  return {...kDefaultQuotaProviders, ...fromConfig};
}

/// The IU experience : ONE route carrying both sub-views, with the
/// node/report choice switched here rather than from a second top-level nav
/// destination.
///
/// Each sub-view keeps its own path (`/understanding`, `/reports`), so existing
/// links stay valid and the address bar still names what you are looking at —
/// the switch just moved from the header into the route.
class _IuBody extends StatelessWidget {
  const _IuBody({
    required this.view,
    required this.onSelect,
    this.understandingBuilder,
    this.reportsBuilder,
  });

  final DashboardView view;
  final ValueChanged<DashboardView> onSelect;
  final WidgetBuilder? understandingBuilder;
  final WidgetBuilder? reportsBuilder;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        _IuViewSwitch(selected: view, onSelect: onSelect),
        const Divider(height: 1, color: MeshColors.border),
        Expanded(
          child: view == DashboardView.reports
              ? (reportsBuilder?.call(context) ??
                    const _UnavailableView('IU Reports'))
              : (understandingBuilder?.call(context) ??
                    const _UnavailableView('Integrated Understanding')),
        ),
      ],
    );
  }
}

/// The in-route Nodes/Reports switch. Sits directly under the header so the
/// selected IU sub-view is always visible, not buried in the view it selects.
class _IuViewSwitch extends StatelessWidget {
  const _IuViewSwitch({required this.selected, required this.onSelect});

  final DashboardView selected;
  final ValueChanged<DashboardView> onSelect;

  @override
  Widget build(BuildContext context) {
    return Container(
      color: MeshColors.bgSecondary,
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
      child: Row(
        children: [
          _IuViewSegment(
            label: 'Nodes',
            view: DashboardView.understanding,
            selected: selected,
            onSelect: onSelect,
          ),
          const SizedBox(width: 6),
          _IuViewSegment(
            label: 'Reports',
            view: DashboardView.reports,
            selected: selected,
            onSelect: onSelect,
          ),
        ],
      ),
    );
  }
}

class _IuViewSegment extends StatelessWidget {
  const _IuViewSegment({
    required this.label,
    required this.view,
    required this.selected,
    required this.onSelect,
  });

  final String label;
  final DashboardView view;
  final DashboardView selected;
  final ValueChanged<DashboardView> onSelect;

  @override
  Widget build(BuildContext context) {
    final active = view == selected;
    return TextButton(
      onPressed: () => onSelect(view),
      style: TextButton.styleFrom(
        foregroundColor: active ? MeshColors.accent : MeshColors.textSecondary,
        backgroundColor: active ? MeshColors.bgPrimary : Colors.transparent,
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
        minimumSize: Size.zero,
        tapTargetSize: MaterialTapTargetSize.shrinkWrap,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(6),
          side: BorderSide(
            color: active ? MeshColors.accent : MeshColors.border,
          ),
        ),
        textStyle: TextStyle(
          fontSize: 13,
          fontWeight: active ? FontWeight.w700 : FontWeight.w500,
        ),
      ),
      child: Text(label),
    );
  }
}

/// The Actors view: the responsive master-detail that used to be DashboardBody's
/// whole body. Unchanged behaviour — just lifted into its own widget so the
/// header nav can switch it out for the IU view.
class _ActorsBody extends StatelessWidget {
  const _ActorsBody({required this.store, required this.onSelectView});

  final DashboardStore store;
  final ValueChanged<DashboardView> onSelectView;

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(
      builder: (context, constraints) {
        if (constraints.maxWidth < kNarrowBreakpoint) {
          return _NarrowBody(store: store, onSelectView: onSelectView);
        }
        return Row(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            ActorTree(store: store),
            Expanded(
              child: DetailPanel(store: store, onSelectView: onSelectView),
            ),
          ],
        );
      },
    );
  }
}

/// Shown when a nav item is selected but no builder was injected (tests /
/// non-web hosts). Production always injects it from main.dart.
class _UnavailableView extends StatelessWidget {
  const _UnavailableView(this.name);
  final String name;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Text(
        '$name view unavailable in this build.',
        style: const TextStyle(color: MeshColors.textSecondary),
      ),
    );
  }
}

/// Mobile master-detail navigation: shows the full-width actor list until an
/// actor is selected, then gives that actor's detail the whole screen. The way
/// back is the header's back arrow (wired by [DashboardBody] from the same
/// `primary` stream), so the detail spends none of its own height on one.
class _NarrowBody extends StatelessWidget {
  const _NarrowBody({required this.store, required this.onSelectView});

  final DashboardStore store;
  final ValueChanged<DashboardView> onSelectView;

  @override
  Widget build(BuildContext context) {
    return StreamBuilder<String?>(
      stream: store.primary,
      initialData: store.primary.valueOrNull,
      builder: (_, snap) {
        if (snap.data == null) {
          // No actor chosen → the list is the whole screen.
          return ActorTree(
            store: store,
            width: double.infinity,
            touchTargets: true,
          );
        }
        return DetailPanel(
          store: store,
          narrow: true,
          onSelectView: onSelectView,
        );
      },
    );
  }
}
