import 'dart:async';
import 'package:flutter/material.dart';

import '../dashboard_url.dart';
import '../models.dart';
import '../store.dart';
import '../theme.dart';
import 'actor_tree.dart';
import 'detail_panel.dart';
import 'header.dart';
import 'overview_tab.dart';
import 'work_tab.dart';

/// Below which width (logical px) the dashboard reflows from the desktop
/// side-by-side master-detail to the mobile master-detail *navigation* layout
/// (full-width list → tap → full-width detail with a back affordance).
const double kNarrowBreakpoint = 700;

/// The header + responsive master-detail body. Lives in its own (VM-safe) file
/// — importing no web-only code — so the screenshot harness can render the real
/// layout headlessly.
///
///  • Wide  (≥ [kNarrowBreakpoint]): actor tree on the left, detail on the right.
///  • Narrow (< [kNarrowBreakpoint]): a full-width list; tapping an actor
///    navigates to its full-width detail, and a back bar returns to the list.
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

  @override
  void initState() {
    super.initState();
    _view = dashboardViewFromUrl();
    final initialObligation = focusedObligationIdFromUrl();
    if (initialObligation != null) {
      widget.store.setFocusedObligationId(initialObligation);
    }
    final initialActor = focusedActorIdFromUrl();
    if (initialActor != null) {
      widget.store.clickActor(initialActor);
    }
    writeDashboardViewToUrl(
      _view,
      focusedObligationId: widget.store.focusedObligationId.valueOrNull,
      focusedActorId: widget.store.primary.valueOrNull,
    );

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
    // Paint the dark base color directly (not just via the Scaffold) so the
    // detail pane — which draws no background of its own — stays on-theme
    // everywhere, including the headless screenshot capture.
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
/// actor is selected, then swaps to that actor's full-width detail view with a
/// back bar. Driven by the store's `primary` (a back tap clears it).
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
        final height = MediaQuery.of(context).size.height;
        return StreamBuilder<bool>(
          stream: store.walkieActive,
          initialData: store.walkieActive.valueOrNull ?? false,
          builder: (_, walkieActiveSnap) {
            final walkieActive = walkieActiveSnap.data ?? false;
            final isFullScreenWalkie = walkieActive && height < 500;
            return Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                _BackBar(store: store),
                if (!isFullScreenWalkie)
                  const Divider(height: 1, color: MeshColors.border),
                Expanded(
                  child: DetailPanel(
                    store: store,
                    narrow: true,
                    onSelectView: onSelectView,
                  ),
                ),
              ],
            );
          },
        );
      },
    );
  }
}

/// The narrow-layout back affordance: a tap returns from an actor's detail view
/// to the full-width list.
class _BackBar extends StatelessWidget {
  const _BackBar({required this.store});

  final DashboardStore store;

  @override
  Widget build(BuildContext context) {
    final height = MediaQuery.of(context).size.height;
    return StreamBuilder<bool>(
      stream: store.walkieActive,
      initialData: store.walkieActive.valueOrNull ?? false,
      builder: (context, walkieActiveSnap) {
        final walkieActive = walkieActiveSnap.data ?? false;
        if (walkieActive && height < 500) {
          return const SizedBox.shrink();
        }
        return Material(
          color: MeshColors.bgSecondary,
          child: InkWell(
            onTap: store.clearSelection,
            child: Container(
              height: 48,
              padding: const EdgeInsets.symmetric(horizontal: 12),
              child: Row(
                children: const [
                  Icon(
                    Icons.arrow_back,
                    size: 20,
                    color: MeshColors.textSecondary,
                  ),
                  SizedBox(width: 8),
                  Text(
                    'Actors',
                    style: TextStyle(
                      color: MeshColors.textSecondary,
                      fontSize: 14,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ],
              ),
            ),
          ),
        );
      },
    );
  }
}
