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
        // One scrollable for the whole drawer, so the quota slot sits at the
        // bottom when there is room for it and scrolls into reach when there is
        // not — a landscape phone with large text has less drawer height than
        // the brand row, the destinations and four providers' rings need.
        child: CustomScrollView(
          slivers: [
            SliverToBoxAdapter(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  // The mesh icon keeps its place here, where the hamburger took
                  // its slot in the header.
                  Padding(
                    padding: const EdgeInsets.fromLTRB(20, 20, 20, 16),
                    child: Row(
                      children: const [
                        Icon(
                          Icons.hub_outlined,
                          color: MeshColors.accent,
                          size: 22,
                        ),
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
                  const SizedBox(height: 8),
                  for (final destination in kDashboardDestinations)
                    _DrawerNavItem(
                      destination: destination,
                      selected: selected,
                      onSelect: onSelect,
                    ),
                  const SizedBox(height: 8),
                ],
              ),
            ),
            SliverFillRemaining(
              hasScrollBody: false,
              // Quota rides the bottom of whatever height is left over. The slot
              // goes away entirely until there is a reading to put in it, rather
              // than pinning an empty strip below the nav.
              child: Align(
                alignment: Alignment.bottomCenter,
                child: StreamBuilder<QuotaSnapshotDto?>(
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
                              padding: const EdgeInsets.fromLTRB(
                                20,
                                16,
                                20,
                                20,
                              ),
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
    required this.destination,
    required this.selected,
    required this.onSelect,
  });

  final DashboardDestination destination;
  final DashboardView selected;
  final ValueChanged<DashboardView> onSelect;

  @override
  Widget build(BuildContext context) {
    final active = destination.isActive(selected);
    return ListTile(
      key: ValueKey('drawer-nav-${destination.view.name}'),
      leading: Icon(
        destination.icon,
        size: 20,
        color: active ? MeshColors.accent : MeshColors.textSecondary,
      ),
      title: Text(
        destination.label,
        style: TextStyle(
          color: active ? MeshColors.accent : MeshColors.textSecondary,
          fontSize: 15,
          fontWeight: active ? FontWeight.w700 : FontWeight.w500,
        ),
      ),
      selected: active,
      onTap: () {
        Navigator.of(context).maybePop();
        onSelect(destination.targetFrom(selected));
      },
    );
  }
}
