import 'package:flutter/material.dart';

import '../models.dart';
import '../store.dart';
import '../theme.dart';
import 'header.dart';

/// The phone navigation drawer behind the header's hamburger: the same top-level
/// destinations the desktop header carries inline, with the quota rings pinned
/// to the bottom. A phone header has room for one row, and navigation earns it
/// over a strip of rings you consult occasionally.
class MobileNavDrawer extends StatelessWidget {
  const MobileNavDrawer({
    super.key,
    required this.store,
    required this.selected,
    required this.onSelect,
    this.quotaProviders = kDefaultQuotaProviders,
  });

  final DashboardStore store;

  /// The active destination, lit in the list.
  final DashboardView selected;

  /// Invoked with the tapped destination, after the drawer closes.
  final ValueChanged<DashboardView> onSelect;

  final Map<String, QuotaProviderConfig> quotaProviders;

  @override
  Widget build(BuildContext context) {
    return Drawer(
      backgroundColor: MeshColors.bgSecondary,
      child: SafeArea(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            // The mesh icon keeps its place here, where the hamburger took its
            // slot in the header.
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 20, 20, 16),
              child: Row(
                children: const [
                  Icon(Icons.hub_outlined, color: MeshColors.accent, size: 22),
                  SizedBox(width: 10),
                  Text(
                    'RUSA',
                    style: TextStyle(
                      color: MeshColors.textPrimary,
                      fontWeight: FontWeight.w700,
                      fontSize: 16,
                      letterSpacing: 0.5,
                    ),
                  ),
                ],
              ),
            ),
            const Divider(height: 1, color: MeshColors.border),
            Expanded(
              child: ListView(
                padding: const EdgeInsets.symmetric(vertical: 8),
                children: [
                  _DrawerNavItem(
                    label: 'Overview',
                    icon: Icons.dashboard_outlined,
                    view: DashboardView.overview,
                    selected: selected,
                    onSelect: onSelect,
                  ),
                  _DrawerNavItem(
                    label: 'Actors',
                    icon: Icons.account_tree_outlined,
                    view: DashboardView.actors,
                    selected: selected,
                    onSelect: onSelect,
                  ),
                  _DrawerNavItem(
                    label: 'Work',
                    icon: Icons.checklist_outlined,
                    view: DashboardView.work,
                    selected: selected,
                    onSelect: onSelect,
                  ),
                  // One IU destination, lit for either sub-view, exactly as the
                  // desktop header carries it — the node/report choice stays
                  // inside the route.
                  _DrawerNavItem(
                    label: 'IU',
                    icon: Icons.insights_outlined,
                    view: DashboardView.understanding,
                    alsoActiveFor: const [DashboardView.reports],
                    selected: selected,
                    onSelect: onSelect,
                  ),
                ],
              ),
            ),
            // The bottom slot goes away entirely until there is a reading to
            // put in it, rather than pinning an empty strip below the nav.
            StreamBuilder<QuotaSnapshotDto?>(
              stream: store.quota,
              initialData: store.quota.valueOrNull,
              builder: (_, snap) => snap.data == null
                  ? const SizedBox.shrink()
                  : Column(
                      mainAxisSize: MainAxisSize.min,
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        const Divider(height: 1, color: MeshColors.border),
                        Padding(
                          padding: const EdgeInsets.fromLTRB(20, 16, 20, 20),
                          child: QuotaIndicators(
                            key: const ValueKey('drawer-quota'),
                            store: store,
                            quotaProviders: quotaProviders,
                            axis: Axis.vertical,
                          ),
                        ),
                      ],
                    ),
            ),
          ],
        ),
      ),
    );
  }
}

/// One drawer destination. Tapping it closes the drawer first, so the view you
/// chose is what you see when the animation ends.
class _DrawerNavItem extends StatelessWidget {
  const _DrawerNavItem({
    required this.label,
    required this.icon,
    required this.view,
    required this.selected,
    required this.onSelect,
    this.alsoActiveFor = const [],
  });

  final String label;
  final IconData icon;
  final DashboardView view;
  final DashboardView selected;
  final ValueChanged<DashboardView> onSelect;

  /// Extra views this one destination also represents, matching the header's
  /// `IU` item: tapping it while already there keeps the sub-view you were on.
  final List<DashboardView> alsoActiveFor;

  @override
  Widget build(BuildContext context) {
    final active = view == selected || alsoActiveFor.contains(selected);
    return ListTile(
      key: ValueKey('drawer-nav-${view.name}'),
      leading: Icon(
        icon,
        size: 20,
        color: active ? MeshColors.accent : MeshColors.textSecondary,
      ),
      title: Text(
        label,
        style: TextStyle(
          color: active ? MeshColors.accent : MeshColors.textSecondary,
          fontSize: 15,
          fontWeight: active ? FontWeight.w700 : FontWeight.w500,
        ),
      ),
      selected: active,
      onTap: () {
        Navigator.of(context).maybePop();
        onSelect(active ? selected : view);
      },
    );
  }
}
