import 'package:flutter/material.dart';
import 'package:intl/intl.dart';

import '../breakpoints.dart';
import '../models.dart';
import '../store.dart';
import '../theme.dart';
import 'actor_status_badge.dart';
import 'actor_tree.dart';
import 'avatar.dart';
import 'brand_mark.dart';
import 'quota_tooltip.dart';

/// The top-level dashboard views the header nav switches between.
enum DashboardView { overview, actors, chatRoom, understanding, reports, work }

/// One top-level destination the navigation offers. The desktop header renders
/// these inline and the phone drawer renders them as rows, from this one list —
/// a fifth destination, or a change to what `IU` covers, lands in both places
/// at once.
class DashboardDestination {
  const DashboardDestination({
    required this.label,
    required this.view,
    required this.icon,
    this.alsoActiveFor = const [],
  });

  final String label;
  final DashboardView view;

  /// Shown by the drawer, which has room for one; the inline header nav is
  /// labels only.
  final IconData icon;

  /// Extra views this one destination also represents (ISSUE_NUM: `IU` covers both
  /// the node and the report sub-view). Selecting any of them keeps it lit, and
  /// tapping it while already there is a no-op rather than a jump back to
  /// [view] — otherwise a tap on the lit `IU` button would silently throw away
  /// the sub-view the user is reading.
  final List<DashboardView> alsoActiveFor;

  bool isActive(DashboardView selected) =>
      view == selected || alsoActiveFor.contains(selected);

  /// What a tap should select: the view itself, or — when already here — the
  /// sub-view you are on, left alone.
  DashboardView targetFrom(DashboardView selected) =>
      isActive(selected) ? selected : view;
}

const List<DashboardDestination> kDashboardDestinations = [
  DashboardDestination(
    label: 'Overview',
    view: DashboardView.overview,
    icon: Icons.dashboard_outlined,
  ),
  DashboardDestination(
    label: 'Actors',
    view: DashboardView.actors,
    icon: Icons.account_tree_outlined,
  ),
  // #663's dashboard-global Chat Room. The nav label is the short "Room" so
  // all five destinations still fit the inline nav at [kNarrowBreakpoint];
  // the room's own controls carry the full "Chat Room" name.
  DashboardDestination(
    label: 'Room',
    view: DashboardView.chatRoom,
    icon: Icons.forum_outlined,
  ),
  DashboardDestination(
    label: 'Work',
    view: DashboardView.work,
    icon: Icons.checklist_outlined,
  ),
  // ISSUE_NUM: ONE top-level IU destination. The node/report choice lives inside
  // the IU route (`_IuBody` in dashboard_body.dart), so it stays active for
  // either sub-view.
  DashboardDestination(
    label: 'IU',
    view: DashboardView.understanding,
    icon: Icons.insights_outlined,
    alsoActiveFor: [DashboardView.reports],
  ),
];

/// Per-provider quota UI config. Each provider owns the windows that drive its
/// header rings: `primaryWindow` (weekly, outer ring) and `sessionWindow`
/// (the short-rolling window — session/5h — inner ring), concentric with it.
/// `sessionWindow` is nullable so a provider can opt out of the inner ring
/// entirely; there is no global primary provider/window.
class QuotaProviderConfig {
  const QuotaProviderConfig({required this.primaryWindow, this.sessionWindow});

  final String primaryWindow;
  final String? sessionWindow;
}

const Map<String, QuotaProviderConfig> kDefaultQuotaProviders = {
  'claude': QuotaProviderConfig(
    primaryWindow: 'weekly',
    sessionWindow: 'session',
  ),
  // ISSUE_NUM: 'five_hour', not '5h' — window ids are now the LLM-classified kind
  // enum (session | five_hour | weekly | other), not a label-derived string.
  'codex': QuotaProviderConfig(
    primaryWindow: 'weekly',
    sessionWindow: 'five_hour',
  ),
  'agy': QuotaProviderConfig(
    primaryWindow: 'weekly',
    sessionWindow: 'five_hour',
  ),
  // ISSUE_NUM: kimi now surfaces its five_hour session window too — the probe/DTO
  // carries both (weekly headline + five_hour), and the pty /usage switch means
  // the old weekly-only opt-out (era of the synthesized hardcoded weekly window)
  // no longer applies. Inner ring matches codex/agy.
  'kimi': QuotaProviderConfig(
    primaryWindow: 'weekly',
    sessionWindow: 'five_hour',
  ),
};

/// Top bar matching the locked V1.4.0 header: brand on the left (the
/// antler/tree mark, issue #412), a halted badge only while an active halt
/// exists — no routine status indicator during normal operation — and quota
/// rings on the right.
/// Deliberately NO summary stats (alive/events/messages) — Operator cut them.
///
/// Carries a minimal nav ("Overview" / "Actors" / "IU") that slots into the
/// existing brand row — no layout restructure. The nav is shown only when
/// [onSelect] is wired; header-only/standalone uses render brand + status
/// exactly as before. IU reports are NOT a fourth destination : they are
/// a sub-view of the IU route, switched inside the body.
///
/// On phones the header instead carries a single leading action in the slot the
/// mesh icon occupies on the desktop — a hamburger that opens the navigation
/// drawer ([onMenuTap]), or, once you are inside a detail view, a back arrow
/// ([onBack]) that replaces it rather than costing the detail a second row of
/// vertical space. Both the inline nav and the quota rings move into the drawer
/// in that mode.
///
/// In that phone shape the header also names the page instead of the product
/// (issue #462): [pageTitle] — the active destination's label — takes the
/// wordmark's slot, and once an actor detail is open, [detailActor] replaces
/// it with the actor's avatar and handle plus an accessible overflow
/// (three-dot) menu of the actor's actions at the upper right. The desktop
/// shape (no [onMenuTap]/[onBack] wired) keeps the brand row exactly as
/// before: wordmark, inline nav, quota rings, and no page title.
class MeshHeader extends StatelessWidget {
  const MeshHeader({
    super.key,
    required this.store,
    this.selected = DashboardView.actors,
    this.onSelect,
    this.quotaProviders = kDefaultQuotaProviders,
    this.onMenuTap,
    this.onBack,
    this.pageTitle,
    this.detailActor,
    this.destinations,
    this.onLogout,
    this.profilePhotoUrl,
    this.profileDisplayName,
    this.haltTooltipNow,
  });

  final DashboardStore store;
  final List<DashboardDestination>? destinations;
  final VoidCallback? onLogout;
  final String? profilePhotoUrl;
  final String? profileDisplayName;

  /// Test clock for the lazily built halt tooltip. Production callers leave
  /// this null, so each presentation reads the wall clock.
  final DateTime Function()? haltTooltipNow;

  /// Which top-level view is active (drives the nav highlight).
  final DashboardView selected;

  /// Invoked when a nav item is tapped. When null, the nav items are hidden.
  final ValueChanged<DashboardView>? onSelect;

  /// Per-provider quota window config. Defaults each provider to weekly.
  final Map<String, QuotaProviderConfig> quotaProviders;

  /// Opens the phone navigation drawer. Wiring it switches the header into its
  /// phone shape: a hamburger in the brand slot, nav and quota in the drawer.
  final VoidCallback? onMenuTap;

  /// Returns from a phone detail view to the list behind it. Takes the same
  /// leading slot as [onMenuTap] and wins it while a detail is open.
  final VoidCallback? onBack;

  /// The page identity shown in the wordmark's slot in the phone shape (the
  /// active destination's label). Ignored on the desktop shape, which keeps
  /// the RUSA wordmark.
  final String? pageTitle;

  /// The actor whose phone detail is open, when one is. Switches the phone
  /// title from [pageTitle] to the actor's avatar + handle and adds the
  /// actions overflow menu at the upper right.
  final ThreadDto? detailActor;

  @override
  Widget build(BuildContext context) {
    final height = MediaQuery.sizeOf(context).height;
    return StreamBuilder<bool>(
      stream: store.walkieActive,
      initialData: store.walkieActive.valueOrNull ?? false,
      builder: (context, walkieActiveSnap) {
        final walkieActive = walkieActiveSnap.data ?? false;
        if (walkieActive && height < kShortViewportHeight) {
          return const SizedBox.shrink();
        }
        return LayoutBuilder(
          builder: (context, constraints) {
            final compact = constraints.maxWidth < 520;
            final compactControls = constraints.maxWidth < 350;
            // Phone shape: navigation and quota both live in the drawer, so
            // the header keeps to its single brand row.
            final drawerNav = onMenuTap != null || onBack != null;
            final twoTier = !drawerNav && constraints.maxWidth < 850;
            final detail = drawerNav ? detailActor : null;
            final detailActions = detail == null
                ? const <_ActorHeaderAction>[]
                : _actorHeaderActions(store: store, actor: detail);
            return Container(
              padding: EdgeInsets.symmetric(horizontal: compact ? 8 : 20),
              decoration: const BoxDecoration(
                color: MeshColors.bgSecondary,
                border: Border(bottom: BorderSide(color: MeshColors.border)),
              ),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  // 70px: #423 asked for ~25% over the original 56px.
                  SizedBox(
                    height: 70,
                    child: Row(
                      children: [
                        Expanded(
                          child: Row(
                            children: [
                              _LeadingAction(
                                onMenuTap: onMenuTap,
                                onBack: onBack,
                              ),
                              SizedBox(width: compact ? 6 : 10),
                              // Phone identity (issue #462): the page — or the
                              // open actor — takes the wordmark's slot. The
                              // desktop shape keeps the brand untouched.
                              if (detail != null)
                                Flexible(
                                  child: _DetailIdentity(
                                    actor: detail,
                                    store: store,
                                  ),
                                )
                              else if (drawerNav && pageTitle != null)
                                Flexible(
                                  child: Text(
                                    pageTitle!,
                                    maxLines: 1,
                                    overflow: TextOverflow.ellipsis,
                                    style: const TextStyle(
                                      color: MeshColors.textPrimary,
                                      fontWeight: FontWeight.w700,
                                      fontSize: 16,
                                    ),
                                  ),
                                )
                              else if (drawerNav)
                                const Flexible(
                                  child: Text(
                                    'RUSA',
                                    maxLines: 1,
                                    overflow: TextOverflow.ellipsis,
                                    style: TextStyle(
                                      color: MeshColors.textPrimary,
                                      fontWeight: FontWeight.w700,
                                      fontSize: 16,
                                      letterSpacing: 0.5,
                                    ),
                                  ),
                                )
                              else
                                const Text(
                                  'RUSA',
                                  maxLines: 1,
                                  style: TextStyle(
                                    color: MeshColors.textPrimary,
                                    fontWeight: FontWeight.w700,
                                    fontSize: 16,
                                    letterSpacing: 0.5,
                                  ),
                                ),
                              if (!compact) const SizedBox(width: 10),
                              StreamBuilder<bool>(
                                stream: store.halted,
                                initialData: store.halted.valueOrNull ?? false,
                                builder: (_, haltSnap) =>
                                    StreamBuilder<HaltStatusDto?>(
                                      stream: store.haltStatus,
                                      initialData: store.haltStatus.valueOrNull,
                                      builder: (_, statusSnap) {
                                        if (!(haltSnap.data ?? false)) {
                                          return const SizedBox.shrink();
                                        }
                                        // The structured status rides the same
                                        // snapshot as the bool; a null here only
                                        // means an older server without the field.
                                        return _HaltedBadge(
                                          halt: statusSnap.data,
                                          compact: compact,
                                          now: haltTooltipNow,
                                        );
                                      },
                                    ),
                              ),
                              StreamBuilder<List<String>?>(
                                stream: store.schedulerWarning,
                                initialData: store.schedulerWarning.valueOrNull,
                                builder: (_, snap) {
                                  final issues = snap.data;
                                  if (issues == null || issues.isEmpty) {
                                    return const SizedBox.shrink();
                                  }
                                  return Padding(
                                    padding: const EdgeInsets.only(left: 6),
                                    child: _SchedulerWarningBadge(
                                      issues: issues,
                                      compact: compact,
                                    ),
                                  );
                                },
                              ),
                              if (drawerNav &&
                                  selected == DashboardView.actors &&
                                  detail == null)
                                StreamBuilder<bool>(
                                  stream: store.actorsStale,
                                  initialData:
                                      store.actorsStale.valueOrNull ?? false,
                                  builder: (_, snap) => (snap.data == true)
                                      ? Padding(
                                          padding: const EdgeInsets.only(
                                            left: 6,
                                          ),
                                          child: CachedHierarchyBadge(
                                            compact: compact,
                                          ),
                                        )
                                      : const SizedBox.shrink(),
                                ),
                              if (!compact) ...[const SizedBox(width: 6)],
                              if (onSelect != null && !drawerNav)
                                Expanded(
                                  child: SingleChildScrollView(
                                    scrollDirection: Axis.horizontal,
                                    child: Row(
                                      children: [
                                        SizedBox(width: compact ? 8 : 16),
                                        for (final destination
                                            in (destinations ??
                                                kDashboardDestinations))
                                          _NavItem(
                                            destination: destination,
                                            selected: selected,
                                            onSelect: onSelect!,
                                          ),
                                      ],
                                    ),
                                  ),
                                ),
                            ],
                          ),
                        ),
                        if (!twoTier && !drawerNav) ...[
                          const SizedBox(width: 14),
                          QuotaIndicators(
                            store: store,
                            quotaProviders: quotaProviders,
                          ),
                        ],
                        if (detailActions.isNotEmpty) ...[
                          SizedBox(width: compact ? 6 : 10),
                          _ActorActionMenu(actions: detailActions),
                        ],
                        if (drawerNav &&
                            selected == DashboardView.actors &&
                            detail == null) ...[
                          SizedBox(width: compact ? 6 : 10),
                          ActorTreeControls(
                            store: store,
                            compact: compactControls,
                          ),
                        ],
                        if (!drawerNav && onLogout != null) ...[
                          const SizedBox(width: 10),
                          ProfileMenu(
                            photoUrl: profilePhotoUrl,
                            displayName: profileDisplayName,
                            onLogout: onLogout!,
                          ),
                        ],
                      ],
                    ),
                  ),
                  if (twoTier)
                    Padding(
                      padding: const EdgeInsets.only(bottom: 12),
                      child: Row(
                        children: [
                          Expanded(
                            child: Align(
                              alignment: Alignment.centerRight,
                              child: QuotaIndicators(
                                store: store,
                                quotaProviders: quotaProviders,
                              ),
                            ),
                          ),
                        ],
                      ),
                    ),
                ],
              ),
            );
          },
        );
      },
    );
  }
}

/// Authenticated operator menu; omitted entirely in auth-disabled mode.
class ProfileMenu extends StatelessWidget {
  const ProfileMenu({
    super.key,
    this.photoUrl,
    this.displayName,
    required this.onLogout,
    this.showLabel = false,
    this.tooltip,
  });

  final String? photoUrl;
  final String? displayName;
  final VoidCallback onLogout;
  final bool showLabel;
  final String? tooltip;

  @override
  Widget build(BuildContext context) {
    final avatarRadius = showLabel ? 14.0 : 16.0;
    final fallback = Icon(Icons.person_outline, size: showLabel ? 18 : 22);
    final avatar = CircleAvatar(
      radius: avatarRadius,
      backgroundColor: MeshColors.border,
      foregroundColor: MeshColors.textPrimary,
      child: photoUrl == null || photoUrl!.isEmpty
          ? fallback
          : ClipOval(
              child: Image.network(
                photoUrl!,
                width: avatarRadius * 2,
                height: avatarRadius * 2,
                fit: BoxFit.cover,
                errorBuilder: (_, _, _) => fallback,
              ),
            ),
    );

    if (showLabel) {
      return PopupMenuButton<String>(
        tooltip: tooltip ?? 'Account menu',
        position: PopupMenuPosition.over,
        onSelected: (_) => onLogout(),
        itemBuilder: (_) => const [
          PopupMenuItem(
            value: 'logout',
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Icon(Icons.logout, size: 18),
                SizedBox(width: 10),
                Text('Log out'),
              ],
            ),
          ),
        ],
        child: Padding(
          padding: const EdgeInsets.fromLTRB(16, 12, 16, 16),
          child: Row(
            children: [
              avatar,
              const SizedBox(width: 12),
              Text(
                displayName?.trim().isNotEmpty == true
                    ? displayName!.trim()
                    : 'Account',
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(
                  color: MeshColors.textPrimary,
                  fontSize: 15,
                  fontWeight: FontWeight.w500,
                ),
              ),
            ],
          ),
        ),
      );
    }

    return PopupMenuButton<String>(
      tooltip: tooltip ?? 'Profile menu',
      position: PopupMenuPosition.under,
      onSelected: (_) => onLogout(),
      itemBuilder: (_) => const [
        PopupMenuItem(
          value: 'logout',
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(Icons.logout, size: 18),
              SizedBox(width: 10),
              Text('Log out'),
            ],
          ),
        ),
      ],
      icon: avatar,
    );
  }
}

/// One actor-detail action surfaced by the phone app bar's overflow menu
/// (issue #462). Rendered as labelled rows in [_ActorActionMenu].
class _ActorHeaderAction {
  const _ActorHeaderAction({
    required this.label,
    required this.icon,
    required this.invoke,
  });

  final String label;
  final IconData icon;
  final VoidCallback invoke;
}

/// The phone actions an actor's current run state supports: queued actors can
/// run now or drop their queued run; running ones can be interrupted; idle ones
/// can be run. Retired actors offer nothing.
List<_ActorHeaderAction> _actorHeaderActions({
  required DashboardStore store,
  required ThreadDto actor,
}) {
  switch (store.dotFor(actor)) {
    case DotState.queued:
      return [
        _ActorHeaderAction(
          label: 'Run now',
          icon: Icons.fast_forward_rounded,
          invoke: () => store.runNowActor(actor.id),
        ),
        _ActorHeaderAction(
          label: 'Cancel queued run',
          icon: Icons.stop_rounded,
          invoke: () => store.interruptActor(actor.id),
        ),
      ];
    case DotState.active:
      return [
        _ActorHeaderAction(
          label: 'Interrupt',
          icon: Icons.stop_rounded,
          invoke: () => store.interruptActor(actor.id),
        ),
      ];
    case DotState.idle:
      return [
        _ActorHeaderAction(
          label: 'Run now',
          icon: Icons.fast_forward_rounded,
          invoke: () => store.runNowActor(actor.id),
        ),
      ];
    case DotState.retired:
      return const [];
  }
}

/// The phone detail title: the actor's avatar, handle, and status in the app
/// bar, so the page identifies who you are looking at without a duplicate
/// detail-body identity block. Sits in the wordmark's slot; the handle
/// ellipsizes rather than pushing the chip or overflow off the row.
class _DetailIdentity extends StatelessWidget {
  const _DetailIdentity({required this.actor, required this.store});

  final ThreadDto actor;
  final DashboardStore store;

  @override
  Widget build(BuildContext context) {
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        ActorAvatar(
          id: actor.id,
          size: 30,
          retired: actor.isRetired,
          store: store,
        ),
        const SizedBox(width: 8),
        Flexible(
          child: Text(
            actor.handle,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: kMonoStyle.copyWith(
              fontSize: 16,
              fontWeight: FontWeight.w700,
              color: MeshColors.textPrimary,
            ),
          ),
        ),
        const SizedBox(width: 6),
        ActorStatusBadge(state: store.dotFor(actor)),
      ],
    );
  }
}

/// The phone actor-detail overflow: the actor's actions behind a three-dot
/// button at the upper right of the app bar (issue #462). A PopupMenuButton
/// gives the button a tooltip and each entry a text label, so the menu is
/// reachable through assistive technology without any extra semantics.
class _ActorActionMenu extends StatelessWidget {
  const _ActorActionMenu({required this.actions});

  final List<_ActorHeaderAction> actions;

  @override
  Widget build(BuildContext context) {
    return PopupMenuButton<_ActorHeaderAction>(
      tooltip: 'Actor actions',
      position: PopupMenuPosition.under,
      style: IconButton.styleFrom(
        foregroundColor: MeshColors.textSecondary,
        iconSize: 22,
      ),
      onSelected: (action) => action.invoke(),
      itemBuilder: (_) => [
        for (final action in actions)
          PopupMenuItem<_ActorHeaderAction>(
            value: action,
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Icon(action.icon, size: 18),
                const SizedBox(width: 10),
                // Flexible + ellipsis: at accessibility text scales the label
                // fits the menu's bounded width instead of overflowing it.
                Flexible(
                  child: Text(
                    action.label,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                  ),
                ),
              ],
            ),
          ),
      ],
      icon: const Icon(Icons.more_vert),
    );
  }
}

/// The brand slot's leading widget: the antler/tree mark on the desktop, a
/// hamburger once a drawer is wired, and a back arrow while a phone detail
/// view is open. Only ever one of them — the phone header has exactly one
/// leading action, and a detail view spends no separate row on its back
/// affordance.
class _LeadingAction extends StatelessWidget {
  const _LeadingAction({required this.onMenuTap, required this.onBack});

  final VoidCallback? onMenuTap;
  final VoidCallback? onBack;

  @override
  Widget build(BuildContext context) {
    final back = onBack;
    final menu = onMenuTap;
    if (back == null && menu == null) {
      return const BrandMark();
    }
    return IconButton(
      onPressed: back ?? menu,
      icon: Icon(
        back != null ? Icons.arrow_back : Icons.menu,
        color: MeshColors.accent,
        size: 22,
      ),
      tooltip: back != null ? 'Back' : 'Navigation',
      padding: EdgeInsets.zero,
      // The Material minimum touch target, which the 70px header row has room
      // for — the same standard the phone actor list asks for with
      // `touchTargets: true`. Left at the default (standard) visual density,
      // since `VisualDensity.compact` would shave these constraints back to 40.
      constraints: const BoxConstraints.tightFor(
        width: kMinInteractiveDimension,
        height: kMinInteractiveDimension,
      ),
    );
  }
}

/// The store-bound quota rings. The header renders them inline; the phone
/// navigation drawer renders the same reading stacked at its bottom, so quota
/// stays one tap away without spending header height on a phone.
class QuotaIndicators extends StatelessWidget {
  const QuotaIndicators({
    super.key,
    required this.store,
    this.quotaProviders = kDefaultQuotaProviders,
    this.axis = Axis.horizontal,
  });

  final DashboardStore store;
  final Map<String, QuotaProviderConfig> quotaProviders;

  /// Lay the per-provider rings out in a scrollable row (header) or a stacked
  /// column (drawer).
  final Axis axis;

  @override
  Widget build(BuildContext context) {
    return StreamBuilder<QuotaSnapshotDto?>(
      stream: store.quota,
      initialData: store.quota.valueOrNull,
      builder: (_, snap) => StreamBuilder<bool>(
        stream: store.quotaRefreshing,
        initialData: store.quotaRefreshing.valueOrNull ?? false,
        builder: (_, refreshingSnap) => _QuotaHeaderStrip(
          snapshot: snap.data,
          quotaProviders: quotaProviders,
          refreshing: refreshingSnap.data ?? false,
          axis: axis,
        ),
      ),
    );
  }
}

class _QuotaHeaderStrip extends StatelessWidget {
  const _QuotaHeaderStrip({
    required this.snapshot,
    required this.quotaProviders,
    this.refreshing = false,
    this.axis = Axis.horizontal,
  });

  final QuotaSnapshotDto? snapshot;
  final Map<String, QuotaProviderConfig> quotaProviders;
  final Axis axis;

  /// True while a background SWR revalidation is in flight (ISSUE_NUM ask 4). The
  /// strip keeps rendering its last-known reading throughout — never a
  /// spinner or a blank state — and just dims subtly to hint a fresher
  /// number is on its way.
  final bool refreshing;

  @override
  Widget build(BuildContext context) {
    final snap = snapshot;
    if (snap == null) return const SizedBox.shrink();
    final providerIds = quotaProviders.keys.toList(growable: false);
    final providers = providerIds
        .map((id) => (config: quotaProviders[id]!, provider: snap.provider(id)))
        .where((entry) => entry.provider != null)
        .toList(growable: false);
    if (providers.isEmpty) return const SizedBox.shrink();
    final rings = [
      for (final entry in providers) ...[
        _ProviderQuotaRing(
          axis: axis,
          provider: entry.provider!,
          weeklyWindow: _findWindow(entry.provider, entry.config.primaryWindow),
          sessionWindow: entry.config.sessionWindow == null
              ? null
              : _findWindow(entry.provider, entry.config.sessionWindow!),
        ),
        // #752: Fable rides the Claude reading but has its own weekly
        // allocation, so it gets its own ring beside Claude's. It is shown
        // wherever Claude is, reading unknown when no Fable window is known.
        if (entry.provider!.provider == 'claude')
          _ProviderQuotaRing(
            axis: axis,
            provider: entry.provider!,
            weeklyWindow: fableWeeklyWindow(entry.provider!),
            sessionWindow: null,
            label: 'Fable',
            throttle: fableThrottle(entry.provider!),
            showThrottle: true,
          ),
      ],
    ];
    return AnimatedOpacity(
      opacity: refreshing ? 0.55 : 1.0,
      duration: const Duration(milliseconds: 200),
      child: axis == Axis.vertical
          ? Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                for (final ring in rings) ...[
                  ring,
                  if (ring != rings.last) const SizedBox(height: 14),
                ],
              ],
            )
          : ClipRect(
              child: SingleChildScrollView(
                scrollDirection: Axis.horizontal,
                physics: const ClampingScrollPhysics(),
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    for (final ring in rings) ...[
                      ring,
                      if (ring != rings.last) const SizedBox(width: 18),
                    ],
                  ],
                ),
              ),
            ),
    );
  }
}

/// Lets a ring's provider label ellipsize inside a bounded row (the drawer's
/// stacked strip, where large text would otherwise push the row past the drawer
/// width) and keep its natural width in the header's unbounded scrolling one.
class _LabelSlot extends StatelessWidget {
  const _LabelSlot({required this.axis, required this.child});

  final Axis axis;
  final Widget child;

  @override
  Widget build(BuildContext context) =>
      axis == Axis.vertical ? Flexible(child: child) : child;
}

QuotaWindowDto? _findWindow(ProviderQuotaDto? provider, String windowId) {
  if (provider == null) return null;
  for (final w in provider.windows) {
    if (w.id == windowId) return w;
  }
  return null;
}

/// Fable's weekly window on the Claude reading (#752): the one weekly model
/// window scoped to Fable alone. Null when there is none, or when more than one
/// claims to be it — an ambiguous identity reads unknown rather than picking
/// one. Claude's provider windows are never consulted, so neither ring can
/// stand in for the other.
QuotaWindowDto? fableWeeklyWindow(ProviderQuotaDto claude) {
  final matches = [
    for (final window in claude.modelWindows)
      if (window.id == 'weekly' && isFableModelScope(window.modelIds)) window,
  ];
  return matches.length == 1 ? matches.single : null;
}

/// Fable's throttle on the Claude reading (#811): the one model lane scoped to
/// Fable alone with a valid interval. Null when there is none, or when more
/// than one claims to be it — an ambiguous, missing, or malformed identity
/// reads null so the tooltip renders "Pacing: n/a".
QuotaThrottleModelLaneDto? fableThrottle(ProviderQuotaDto claude) {
  final throttle = claude.throttle;
  if (throttle == null) return null;
  final matches = [
    for (final lane in throttle.modelLanes)
      if (isFableModelScope(lane.models) &&
          lane.intervalSeconds.isFinite &&
          lane.intervalSeconds >= 0)
        lane,
  ];
  return matches.length == 1 ? matches.single : null;
}

/// Renders a provider's weekly quota as the outer ring and its session/5h
/// quota as a smaller concentric ring inside it . Either ring shows grey
/// (no crash) when its window is missing, unread, or otherwise unknown.
class _ProviderQuotaRing extends StatelessWidget {
  const _ProviderQuotaRing({
    required this.provider,
    required this.weeklyWindow,
    required this.sessionWindow,
    this.axis = Axis.horizontal,
    this.label,
    this.throttle,
    this.showThrottle = true,
  });

  final ProviderQuotaDto provider;
  final QuotaWindowDto? weeklyWindow;
  final QuotaWindowDto? sessionWindow;

  /// Overrides the provider name, for a ring that shows one model's
  /// allocation within the provider (#752).
  final String? label;

  /// Overrides the provider throttle, for a model ring showing its own lane (#811).
  final QuotaThrottleDto? throttle;

  /// Whether the tooltip carries the provider's launch pacing. A model ring
  /// leaves it out: that pacing is provider-wide, not the model's.
  final bool showThrottle;

  /// How the strip this ring belongs to is laid out. Stacked in the drawer the
  /// row has a real width to fit inside, so the label gives way first; in the
  /// header's scrolling row the width is unbounded and a flexible child there
  /// would have nothing to flex against.
  final Axis axis;

  @override
  Widget build(BuildContext context) {
    final now = DateTime.now();
    final staleFor = staleReadingAge([
      weeklyWindow,
      if (sessionWindow != null) sessionWindow,
    ], now);
    final name = label ?? _providerLabel(provider.provider);
    final windows = <QuotaWindowDto>[
      weeklyWindow ??
          const QuotaWindowDto(
            id: 'weekly',
            label: 'Weekly',
            usedPercent: null,
            status: 'unknown',
            headline: false,
          ),
      ?sessionWindow,
    ];
    if (label == null) {
      final seenIds = {
        'weekly',
        if (weeklyWindow != null) weeklyWindow!.id,
        if (sessionWindow != null) sessionWindow!.id,
      };
      for (final w in provider.windows) {
        if (seenIds.add(w.id)) {
          windows.add(w);
        }
      }
    }
    final scrapedAt =
        weeklyWindow?.scrapedAt ?? sessionWindow?.scrapedAt ?? provider.scrapedAt;
    final effectiveThrottle =
        throttle ?? (label == null ? provider.throttle : null);
    final tooltipWidget = QuotaTooltip(
      providerName: name,
      windows: windows,
      throttle: showThrottle ? effectiveThrottle : null,
      scrapedAt: scrapedAt,
      showThrottle: showThrottle,
      staleFor: staleFor,
      now: now,
    );
    final tooltip = tooltipWidget.toPlainText(now);
    return Tooltip(
      richMessage: WidgetSpan(child: tooltipWidget),
      excludeFromSemantics: true,
      child: Semantics(
        label: tooltip,
        child: Row(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.center,
          children: [
            SizedBox(
              width: 24,
              height: 24,
              child: Stack(
                alignment: Alignment.center,
                children: [
                  SizedBox(
                    width: 20,
                    height: 20,
                    child: CircularProgressIndicator(
                      value: _ringValue(weeklyWindow, now: now),
                      strokeWidth: 4,
                      strokeCap: StrokeCap.butt,
                      color: quotaScheduleColor(weeklyWindow, now: now),
                      backgroundColor: MeshColors.border,
                    ),
                  ),
                  if (sessionWindow != null)
                    SizedBox(
                      width: 11,
                      height: 11,
                      child: CircularProgressIndicator(
                        value: _ringValue(sessionWindow, now: now),
                        strokeWidth: 3,
                        strokeCap: StrokeCap.butt,
                        color: quotaScheduleColor(sessionWindow, now: now),
                        backgroundColor: MeshColors.border,
                      ),
                    ),
                  if (staleFor != null)
                    const Positioned(
                      right: 0,
                      bottom: 0,
                      child: Icon(
                        Icons.warning_rounded,
                        key: ValueKey('quota-ring-stale-warning'),
                        size: 10,
                        color: MeshColors.quotaStaleWarning,
                      ),
                    ),
                ],
              ),
            ),
            const SizedBox(width: 8),
            _LabelSlot(
              axis: axis,
              child: Text(
                name,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(
                  fontSize: 13,
                  color: MeshColors.textSecondary,
                  fontWeight: FontWeight.w500,
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// The ring's fill fraction (quota remaining), or 0 (empty, grey) when the
/// window is missing, past its reset, or its reading isn't known yet. The
/// server estimates the window after a reset (#759), and that estimate carries
/// no reset time, so a window still past its reset here is one it could not
/// estimate.
double _ringValue(QuotaWindowDto? window, {DateTime? now}) {
  if (!ringShowsValue(window, now)) return 0.0;
  return (100 - window!.usedPercent!.clamp(0, 100)) / 100;
}

String _providerLabel(String provider) => switch (provider) {
  'agy' => 'Agy',
  'codex' => 'Codex',
  'claude' => 'Claude',
  'kimi' => 'Kimi',
  _ => provider,
};

/// Symmetric band either side of dead-on-pace (delta == 0) that reads as "on
/// pace" (amber); outside it the ring reads "burning fast" (red, quota
/// draining faster than the schedule) or "burning slow" (green, draining
/// slower).
const double _kPaceBandPct = 15;

/// Colors a ring by how far ahead or behind schedule its burn-down is —
/// `quotaRemainingPct` vs `timeRemainingPct` (how much of the window's
/// duration is left before `resetAt`) — rather than by raw quota remaining.
/// Only meaningfully ahead of pace (delta >= 15) reads green; meaningfully
/// behind (delta <= -15) reads red; the neutral band between reads amber
/// ("on pace"), matching QuotaTooltip's schedulePosition derivation so the ring
/// and its tooltip never disagree. Falls back to a quota-only threshold when the
/// window's reset time can't be resolved to an absolute instant.
Color quotaScheduleColor(QuotaWindowDto? window, {required DateTime now}) {
  final pos = schedulePosition(window, now);
  if (pos == null) return MeshColors.textMuted;
  final delta = pos.delta;
  if (delta == null) return _legacyColorForRemaining(pos.quotaRemainingPct);
  if (delta <= -_kPaceBandPct) return MeshColors.statusHalted;
  if (delta >= _kPaceBandPct) return MeshColors.statusActive;
  return MeshColors.statusIdle;
}

Color _legacyColorForRemaining(double remainingPercent) {
  if (remainingPercent <= 20) return MeshColors.statusHalted;
  if (remainingPercent <= 60) return MeshColors.statusIdle;
  return MeshColors.statusActive;
}

const _scopedHaltEffect =
    'Actors run on an unheld candidate in their pool instead; an actor whose '
    'whole pool is held waits.';

/// Plain-text explanation of the active halt for the header chip's tooltip
/// (#906): the authoritative scope, its scheduling effect, and the expiry.
/// The server retires an expired sentinel, but an idle mesh may not refresh
/// the snapshot at `until`, so a past expiry is worded as passed rather than
/// pending; a missing `until` means indefinite.
///
/// The effect lines mirror `HaltSwitch` and `ActorMesh.prepareRun`: a global
/// halt skips every new run; a scoped halt only skips a run when every
/// candidate in the actor's pool is held, so actors with an unheld candidate
/// keep running there. In-flight runs always finish.
String haltTooltipText(HaltStatusDto? halt, {DateTime? now}) {
  final untilString = halt?.until;
  final until = untilString == null
      ? null
      : DateTime.tryParse(untilString)?.toLocal();
  final local = (now ?? DateTime.now()).toLocal();
  final String expiry;
  if (until == null) {
    expiry = 'No expiry — holds until resumed.';
  } else if (until.isAfter(local)) {
    expiry = 'Expires ${_haltExpiryFormat(until, local)}.';
  } else {
    expiry = 'Expiry passed ${_haltExpiryFormat(until, local)}.';
  }
  // A stale snapshot can still carry a halt after its locally observed
  // expiry. Describe its effects as reported and conditional in that case,
  // rather than implying that they remain in force.
  return _haltDescription(
    halt,
    expiry,
    reported: until != null && !until.isAfter(local),
  );
}

/// The accessible label uses a clock-stable expiry fact. A screen reader may
/// reach the badge after local time passes `until` but before a new snapshot
/// rebuilds it, so it must not retain a stale future-tense expiry claim.
String haltSemanticsText(HaltStatusDto? halt) {
  final untilString = halt?.until;
  final until = untilString == null
      ? null
      : DateTime.tryParse(untilString)?.toUtc();
  final expiry = until == null
      ? 'No expiry — holds until resumed.'
      : 'Reported expiry: '
            "${DateFormat('EEE MMM d, y, h:mm a').format(until)} UTC.";
  return _haltDescription(halt, expiry, reported: true);
}

String _haltDescription(
  HaltStatusDto? halt,
  String expiry, {
  bool reported = false,
}) {
  final inFlight = reported
      ? 'A reported halt does not interrupt runs already in flight.'
      : 'Runs already in flight finish.';
  if (halt == null) {
    // Older server without the structured halt field: the chip is right,
    // the scope is unknown.
    return 'Mesh halted — scope not reported by this server.\n$inFlight';
  }
  final providers = halt.providers.isEmpty
      ? 'any provider'
      : halt.providers.join(', ');
  final String scope;
  final String effect;
  switch (halt.scope) {
    case 'models':
      scope = '${halt.models.join(', ')} on $providers';
      effect = reported
          ? 'While this reported halt is in force, '
                'actors run on an unheld candidate in their pool instead; an '
                'actor whose whole pool is held waits.'
          : _scopedHaltEffect;
    case 'providers':
      scope = providers;
      effect = reported
          ? 'While this reported halt is in force, '
                'actors run on an unheld candidate in their pool instead; an '
                'actor whose whole pool is held waits.'
          : _scopedHaltEffect;
    default:
      scope = 'all providers';
      effect = reported
          ? 'While this reported halt is in force, no new runs start.'
          : 'No new runs start.';
  }
  final label = reported ? 'Reported halt scope' : 'Halt scope';
  return '$label: $scope.\n$effect\n$inFlight\n$expiry';
}

/// Same-day expiries read as a time; later ones carry the weekday and date.
String _haltExpiryFormat(DateTime until, DateTime now) {
  final sameDay =
      until.year == now.year &&
      until.month == now.month &&
      until.day == now.day;
  return sameDay
      ? 'today ${DateFormat('h:mm a').format(until)}'
      : DateFormat('EEE MMM d, h:mm a').format(until);
}

/// The engaged-emergency-brake indicator: a solid red pause icon and a bold
/// "Halted" label — the only status the header surfaces (issue #412), shown
/// solely while an active halt exists. The tooltip names the authoritative
/// scope and expiry from the same snapshot that raised the badge (#906).
class _HaltedBadge extends StatelessWidget {
  const _HaltedBadge({this.halt, this.compact = false, this.now});

  final HaltStatusDto? halt;
  final bool compact;
  final DateTime Function()? now;

  @override
  Widget build(BuildContext context) {
    return Tooltip(
      ignorePointer: true,
      richMessage: WidgetSpan(
        // Evaluated when the tooltip opens, so a passed expiry reads as passed
        // on an idle page; the overlay's DefaultTextStyle supplies the style.
        child: Builder(
          builder: (context) => Text(haltTooltipText(halt, now: now?.call())),
        ),
      ),
      excludeFromSemantics: true,
      child: Semantics(
        label: haltSemanticsText(halt),
        child: Container(
          padding: EdgeInsets.symmetric(
            horizontal: compact ? 6 : 10,
            vertical: 4,
          ),
          decoration: BoxDecoration(
            color: MeshColors.statusHalted.withValues(alpha: 0.12),
            borderRadius: BorderRadius.circular(4),
            border: Border.all(
              color: MeshColors.statusHalted.withValues(alpha: 0.5),
            ),
          ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Icon(
                Icons.pause_circle_filled,
                color: MeshColors.statusHalted,
                size: 14,
              ),
              if (!compact) ...[
                const SizedBox(width: 8),
                Text(
                  'Halted',
                  style: kMonoStyle.copyWith(
                    color: MeshColors.statusHalted,
                    fontSize: 12,
                    fontWeight: FontWeight.w700,
                  ),
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }
}

/// Dashboard/health-visible surface for a non-fatal boot preflight problem
/// (currently `at`/`atrm`/`atd`/`atq` unavailability): cron-only recurrences
/// keep working, so this is a caution badge, not a halt — the full issue list
/// is in the tooltip rather than the console.
class _SchedulerWarningBadge extends StatelessWidget {
  const _SchedulerWarningBadge({required this.issues, this.compact = false});

  final List<String> issues;
  final bool compact;

  @override
  Widget build(BuildContext context) {
    return Tooltip(
      message: 'Scheduler unavailable:\n${issues.join('\n')}',
      child: Container(
        padding: EdgeInsets.symmetric(
          horizontal: compact ? 6 : 10,
          vertical: 4,
        ),
        decoration: BoxDecoration(
          color: MeshColors.statusIdle.withValues(alpha: 0.12),
          borderRadius: BorderRadius.circular(4),
          border: Border.all(
            color: MeshColors.statusIdle.withValues(alpha: 0.5),
          ),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(
              Icons.warning_amber_rounded,
              color: MeshColors.statusIdle,
              size: 14,
            ),
            if (!compact) ...[
              const SizedBox(width: 8),
              Text(
                'Scheduler',
                style: kMonoStyle.copyWith(
                  color: MeshColors.statusIdle,
                  fontSize: 12,
                  fontWeight: FontWeight.w700,
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }
}

/// A single header nav label: accent + bold when it's the active view, muted
/// otherwise. A plain text button so it sits in the brand row without adding
/// chrome to the locked V1.4.0 layout.
///
/// Sizing (issue #423): 16px labels, the nearest whole pixel to 25% over the
/// original 13px, on TextButton's own padding and minimum size — the issue
/// asked for "the typical amount of padding", and the earlier zero-minimum /
/// shrink-wrap overrides were what made the buttons read constrained. The
/// wordmark is also 16px; the brand stays distinct by its mark, letter-spacing
/// and primary color rather than by size. The inline nav rides a horizontal
/// scroller, and the app hands the header a drawer below [kNarrowBreakpoint],
/// so no narrower padding variant is needed.
class _NavItem extends StatelessWidget {
  const _NavItem({
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
    return TextButton(
      onPressed: () => onSelect(destination.targetFrom(selected)),
      style: TextButton.styleFrom(
        foregroundColor: active ? MeshColors.accent : MeshColors.textSecondary,
        // Take only the font family from the theme so the nav renders with
        // the app font instead of the engine default (which the headless
        // screenshot harness draws as box glyphs). Copying the whole
        // `labelLarge` style would also pull in Material 3's line-height
        // multiplier and grow the label's line box past the font size.
        textStyle: TextStyle(
          fontFamily: Theme.of(context).textTheme.labelLarge?.fontFamily,
          fontSize: 16,
          fontWeight: active ? FontWeight.w700 : FontWeight.w500,
        ),
      ),
      child: Text(destination.label),
    );
  }
}
