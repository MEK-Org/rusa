import 'package:flutter/material.dart';
import 'package:intl/intl.dart';

import '../models.dart';
import '../store.dart';
import '../theme.dart';

/// The top-level dashboard views the header nav switches between.
enum DashboardView { overview, actors, understanding, reports, work }

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

/// Top bar matching the locked V1.4.0 header: brand on the left, a compact live
/// status indicator in the brand cluster, and quota rings on the right.
/// Deliberately NO summary stats (alive/events/messages) — Operator cut them.
///
/// Carries a minimal nav ("Overview" / "Actors" / "IU") that slots into the
/// existing brand row — no layout restructure. The nav is shown only when
/// [onSelect] is wired; header-only/standalone uses render brand + status
/// exactly as before. IU reports are NOT a fourth destination : they are
/// a sub-view of the IU route, switched inside the body.
class MeshHeader extends StatelessWidget {
  const MeshHeader({
    super.key,
    required this.store,
    this.selected = DashboardView.actors,
    this.onSelect,
    this.quotaProviders = kDefaultQuotaProviders,
  });

  final DashboardStore store;

  /// Which top-level view is active (drives the nav highlight).
  final DashboardView selected;

  /// Invoked when a nav item is tapped. When null, the nav items are hidden.
  final ValueChanged<DashboardView>? onSelect;

  /// Per-provider quota window config. Defaults each provider to weekly.
  final Map<String, QuotaProviderConfig> quotaProviders;

  @override
  Widget build(BuildContext context) {
    Widget buildQuota() {
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
          ),
        ),
      );
    }

    final height = MediaQuery.of(context).size.height;
    return StreamBuilder<bool>(
      stream: store.walkieActive,
      initialData: store.walkieActive.valueOrNull ?? false,
      builder: (context, walkieActiveSnap) {
        final walkieActive = walkieActiveSnap.data ?? false;
        if (walkieActive && height < 500) {
          return const SizedBox.shrink();
        }
        return Container(
          padding: const EdgeInsets.symmetric(horizontal: 20),
          decoration: const BoxDecoration(
            color: MeshColors.bgSecondary,
            border: Border(bottom: BorderSide(color: MeshColors.border)),
          ),
          child: LayoutBuilder(
            builder: (context, constraints) {
              final compact = constraints.maxWidth < 520;
              final twoTier = constraints.maxWidth < 850;
              return Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  SizedBox(
                    height: 56,
                    child: Row(
                      children: [
                        Expanded(
                          child: Row(
                            children: [
                              const Icon(
                                Icons.hub_outlined,
                                color: MeshColors.accent,
                                size: 22,
                              ),
                              const SizedBox(width: 10),
                              const Text(
                                'RUSA MESH',
                                maxLines: 1,
                                style: TextStyle(
                                  color: MeshColors.textPrimary,
                                  fontWeight: FontWeight.w700,
                                  fontSize: 16,
                                  letterSpacing: 0.5,
                                ),
                              ),
                              const SizedBox(width: 10),
                              StreamBuilder<bool>(
                                stream: store.halted,
                                initialData: store.halted.valueOrNull ?? false,
                                builder: (_, snap) => (snap.data ?? false)
                                    ? _HaltedBadge(compact: compact)
                                    : _LivePulse(compact: compact),
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
                              if (!compact) ...[const SizedBox(width: 6)],
                              if (onSelect != null)
                                Expanded(
                                  child: SingleChildScrollView(
                                    scrollDirection: Axis.horizontal,
                                    child: Row(
                                      children: [
                                        SizedBox(width: compact ? 8 : 16),
                                        _NavItem(
                                          label: 'Overview',
                                          view: DashboardView.overview,
                                          selected: selected,
                                          onSelect: onSelect!,
                                          compact: compact,
                                        ),
                                        _NavItem(
                                          label: 'Actors',
                                          view: DashboardView.actors,
                                          selected: selected,
                                          onSelect: onSelect!,
                                          compact: compact,
                                        ),
                                        _NavItem(
                                          label: 'Work',
                                          view: DashboardView.work,
                                          selected: selected,
                                          onSelect: onSelect!,
                                          compact: compact,
                                        ),
                                        // ISSUE_NUM: ONE top-level IU button. The
                                        // node/report choice now lives inside
                                        // the IU route (`_IuBody` in
                                        // dashboard_body.dart), so this item
                                        // stays active for either sub-view and
                                        // a tap while already in IU keeps the
                                        // sub-view you were on.
                                        _NavItem(
                                          label: 'IU',
                                          view: DashboardView.understanding,
                                          alsoActiveFor: const [
                                            DashboardView.reports,
                                          ],
                                          selected: selected,
                                          onSelect: onSelect!,
                                          compact: compact,
                                        ),
                                      ],
                                    ),
                                  ),
                                ),
                            ],
                          ),
                        ),
                        if (!twoTier) ...[
                          const SizedBox(width: 14),
                          buildQuota(),
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
                              child: buildQuota(),
                            ),
                          ),
                        ],
                      ),
                    ),
                ],
              );
            },
          ),
        );
      },
    );
  }
}

class _QuotaHeaderStrip extends StatelessWidget {
  const _QuotaHeaderStrip({
    required this.snapshot,
    required this.quotaProviders,
    this.refreshing = false,
  });

  final QuotaSnapshotDto? snapshot;
  final Map<String, QuotaProviderConfig> quotaProviders;

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
    return AnimatedOpacity(
      opacity: refreshing ? 0.55 : 1.0,
      duration: const Duration(milliseconds: 200),
      child: ClipRect(
        child: SingleChildScrollView(
          scrollDirection: Axis.horizontal,
          physics: const ClampingScrollPhysics(),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              for (final entry in providers) ...[
                _ProviderQuotaRing(
                  provider: entry.provider!,
                  weeklyWindow: _findWindow(
                    entry.provider,
                    entry.config.primaryWindow,
                  ),
                  sessionWindow: entry.config.sessionWindow == null
                      ? null
                      : _findWindow(
                          entry.provider,
                          entry.config.sessionWindow!,
                        ),
                ),
                if (entry != providers.last) const SizedBox(width: 18),
              ],
            ],
          ),
        ),
      ),
    );
  }
}

QuotaWindowDto? _findWindow(ProviderQuotaDto? provider, String windowId) {
  if (provider == null) return null;
  for (final w in provider.windows) {
    if (w.id == windowId) return w;
  }
  return null;
}

/// Renders a provider's weekly quota as the outer ring and its session/5h
/// quota as a smaller concentric ring inside it . Either ring shows grey
/// (no crash) when its window is missing, unread, or otherwise unknown.
class _ProviderQuotaRing extends StatelessWidget {
  const _ProviderQuotaRing({
    required this.provider,
    required this.weeklyWindow,
    required this.sessionWindow,
  });

  final ProviderQuotaDto provider;
  final QuotaWindowDto? weeklyWindow;
  final QuotaWindowDto? sessionWindow;

  @override
  Widget build(BuildContext context) {
    final now = DateTime.now();
    final tooltipParts = [
      quotaWindowTooltip(weeklyWindow, fallbackLabel: 'Weekly', now: now),
      if (sessionWindow != null)
        quotaWindowTooltip(sessionWindow, fallbackLabel: 'Session', now: now),
    ];
    // Ground-truth "as of" scrape stamp (ISSUE_NUM ask 5) — the same instant rides
    // every window on this provider, so either one supplies it.
    final asOf = _asOfLine(
      weeklyWindow?.scrapedAt ?? sessionWindow?.scrapedAt,
      now: now,
    );
    final tooltip = [
      _providerLabel(provider.provider),
      tooltipParts.join('\n\n'),
      if (provider.throttle != null) quotaThrottleTooltip(provider.throttle!),
      ?asOf,
    ].join('\n');
    return Tooltip(
      message: tooltip,
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
                ],
              ),
            ),
            const SizedBox(width: 8),
            Text(
              _providerLabel(provider.provider),
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(
                fontSize: 13,
                color: MeshColors.textSecondary,
                fontWeight: FontWeight.w500,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// The ring's fill fraction (quota remaining), or 0 (empty, grey) when the
/// window is missing, past its reset, or its reading isn't known yet.
double _ringValue(QuotaWindowDto? window, {DateTime? now}) {
  final used = window?.usedPercent;
  if (window == null || used == null || !window.isKnown) return 0.0;
  if (now != null && window.isPastReset(now)) return 0.0;
  return (100 - used.clamp(0, 100)) / 100;
}

/// Self-explaining, multi-line tooltip text for one window (ISSUE_NUM ask 1 + ask
/// 3): quota remaining AND time remaining (both count down, battery
/// metaphor — ask 2) with a pace verdict, then the window's own expiry
/// ("resets ..."), then an unambiguous rate-based projection so the verdict
/// is never a bare adjective. When a window is past its reset (resetAtIso < now),
/// honestly reports that the window has reset without a fresh reading instead of
/// showing the pre-reset percentage (issue #9). Falls back to a quota-only
/// phrasing (plus the raw reset text, when there is one) when the window's
/// schedule position can't be resolved to an absolute instant (see [_schedulePosition]) —
/// several provider CLIs report free-form reset text with no reliable epoch.
String quotaWindowTooltip(
  QuotaWindowDto? window, {
  required String fallbackLabel,
  required DateTime now,
}) {
  final label = (window?.label != null && window!.label.isNotEmpty)
      ? window.label
      : fallbackLabel;
  if (window == null) return '$label: n/a';
  if (window.isPastReset(now)) {
    final reset = DateTime.tryParse(window.resetAtIso!);
    final resetStr = reset != null
        ? DateFormat('EEE h:mm a').format(reset.toLocal())
        : window.resetAtIso!;
    return '$label: window reset at $resetStr; no fresh read since';
  }
  final pos = _schedulePosition(window, now);
  if (pos == null) {
    // Belt-and-braces fallback: reachable if window has no known usedPercent
    // or sits precisely at the millisecond tick where remainingMs <= 0.
    // Windows with unparseable/missing reset text produce pos != null with
    // timeRemainingPct == null, handled below.
    if (!window.isKnown) return '$label: n/a';
    final reset = _resetLine(window);
    final remaining = (100 - (window.usedPercent ?? 0)).clamp(0, 100).round();
    return reset == null
        ? '$label: $remaining% remaining'
        : '$label: $remaining% remaining\n$reset';
  }
  final remaining = pos.quotaRemainingPct.round();
  final timeRemainingPct = pos.timeRemainingPct;
  if (timeRemainingPct == null) {
    final reset = _resetLine(window);
    return reset == null
        ? '$label: $remaining% remaining'
        : '$label: $remaining% remaining\n$reset';
  }
  final lines = <String>[
    '$label: $remaining% quota remaining, ${timeRemainingPct.round()}% time remaining '
        '(${_paceVerdict(pos.delta!)})',
  ];
  final reset = _resetLine(window);
  if (reset != null) lines.add(reset);
  final projection = _projection(pos, window, now);
  if (projection != null) lines.add(projection);
  return lines.join('\n');
}

/// Ratified 3-term pace wording (Operator, ISSUE_NUM): "burning fast" (meaningfully
/// behind schedule), "on pace" (within a neutral band either side of dead-on),
/// "burning slow" (meaningfully ahead) — replaces the old 2-term "behind
/// pace"/"well behind" wording. Shared by the ring color
/// ([quotaScheduleColor]) and this tooltip text so they never disagree.
String _paceVerdict(double delta) {
  if (delta <= -_kPaceBandPct) return 'burning fast';
  if (delta >= _kPaceBandPct) return 'burning slow';
  return 'on pace';
}

/// "resets Thu 3:50 PM" — the window's own expiry (ISSUE_NUM ask 1).
/// Provider reset instants stay UTC internally and are converted to the
/// viewer's local timezone only for presentation. Null when there's
/// no reset text to show at all.
String? _resetLine(QuotaWindowDto window) {
  final resetText = window.resetAtIso;
  if (resetText == null) return null;
  final reset = DateTime.tryParse(resetText);
  if (reset == null) return 'resets $resetText';
  return 'resets ${DateFormat('EEE h:mm a').format(reset.toLocal())}';
}

/// "as of <HH:mm>" — the ground-truth scrape stamp (ISSUE_NUM ask 5), never a
/// cache hit or client SWR fetch time. Formatted in the viewer's local timezone
/// to match reset timestamps. Carries relative age when [now] is provided so
/// stale readings are visibly distinct. Null when the state behind this window
/// never reached a probe, or the stamp can't be parsed.
String? _asOfLine(
  String? scrapedAtIso, {
  DateTime? now,
}) {
  if (scrapedAtIso == null) return null;
  final scraped = DateTime.tryParse(scrapedAtIso);
  if (scraped == null) return null;
  final timeStr = DateFormat('HH:mm').format(scraped.toLocal());
  final parts = <String>['as of $timeStr'];
  if (now != null && now.isAfter(scraped)) {
    final age = now.difference(scraped);
    if (age.inHours >= 24) {
      parts.add('(${age.inDays}d ago)');
    } else if (age.inHours >= 1) {
      parts.add('(${age.inHours}h ago)');
    } else if (age.inMinutes >= 2) {
      parts.add('(${age.inMinutes}m ago)');
    }
  }
  return parts.join(' ');
}

/// Explain the control loop's current pacing decision in the same tooltip as
/// the quota rings, so a slow provider is distinguishable from a busy mesh.
String quotaThrottleTooltip(QuotaThrottleDto throttle) {
  final lines = [
    'Normal launch pacing: one start every '
        '${_formatInterval(throttle.intervalSeconds)}',
  ];
  if (throttle.expired) {
    lines.add(
      'previous quota window expired; returning to the configured interval',
    );
  } else if (throttle.buckets.isNotEmpty) {
    final hottest = throttle.buckets.reduce(
      (a, b) => a.error >= b.error ? a : b,
    );
    lines.add(
      'hottest bucket ${hottest.key}: ${hottest.error.toStringAsFixed(1)} points over pace',
    );
  }
  if (throttle.capped) {
    lines.add('limited to the configured maximum interval');
  }
  return lines.join('\n');
}

String _formatInterval(double seconds) {
  if (seconds < 60) return '${seconds.toStringAsFixed(1)}s';
  if (seconds < 3600) return '${(seconds / 60).toStringAsFixed(1)}m';
  return '${(seconds / 3600).toStringAsFixed(1)}h';
}

/// An unambiguous rate-based read alongside the pace verdict (ISSUE_NUM ask 3):
/// extrapolates the observed burn rate (`usedPercent` over elapsed window
/// time) forward. When that rate would exhaust the window's quota before
/// `resetAt`, says so with a projected empty date; otherwise projects how
/// much would be left at reset. Falls back to a simple quota-only phrasing
/// when there isn't enough signal to extrapolate a rate (no elapsed time yet,
/// or the reset instant places the window's remaining time outside anything
/// the window duration can explain — e.g. a degenerate/placeholder reading).
String? _projection(
  _SchedulePosition pos,
  QuotaWindowDto window,
  DateTime now,
) {
  final remainingMs = pos.remainingMs;
  final used = window.usedPercent;
  if (remainingMs == null || used == null || used <= 0) {
    return '~${pos.quotaRemainingPct.round()}% left at reset';
  }
  final elapsedMs = window.windowMs - remainingMs;
  if (elapsedMs <= 0) {
    return '~${pos.quotaRemainingPct.round()}% left at reset';
  }
  final ratePerMs = used / elapsedMs;
  final emptyInMs = pos.quotaRemainingPct / ratePerMs;
  if (emptyInMs < remainingMs) {
    final emptyAt = now.add(Duration(milliseconds: emptyInMs.round()));
    final resetAt = now.add(Duration(milliseconds: remainingMs));
    return 'at this rate: empty ~${DateFormat('EEE').format(emptyAt)} '
        '(resets ${DateFormat('EEE').format(resetAt)})';
  }
  final projectedUsedAtReset = used + ratePerMs * remainingMs;
  final leftAtReset = (100 - projectedUsedAtReset).clamp(0, 100);
  return '~${leftAtReset.round()}% left at reset';
}

String _providerLabel(String provider) => switch (provider) {
  'agy' => 'Agy',
  'codex' => 'Codex',
  'claude' => 'Claude',
  'kimi' => 'Kimi',
  _ => provider,
};

/// Symmetric band either side of dead-on-pace (delta == 0) that reads as "on
/// pace" (amber); outside it the ring/tooltip read "burning fast" (red, quota
/// draining faster than the schedule) or "burning slow" (green, draining
/// slower). Ratified 3-term wording (Operator, ISSUE_NUM) — tuned for legibility, not
/// a correctness threshold .
const double _kPaceBandPct = 15;

/// Colors a ring by how far ahead or behind schedule its burn-down is —
/// `quotaRemainingPct` vs `timeRemainingPct` (how much of the window's
/// duration is left before `resetAt`) — rather than by raw quota remaining.
/// Only meaningfully ahead of pace (delta >= 15) reads green; meaningfully
/// behind (delta <= -15) reads red; the neutral band between reads amber
/// ("on pace"), matching [_paceVerdict]'s wording exactly so the ring and its
/// tooltip never disagree. Falls back to a quota-only threshold when the
/// window's reset time can't be resolved to an absolute instant (several
/// provider CLIs report free-form reset text with no reliable epoch to
/// parse) — never crashes, never leaves a ring uncolored.
Color quotaScheduleColor(QuotaWindowDto? window, {required DateTime now}) {
  final pos = _schedulePosition(window, now);
  if (pos == null) return MeshColors.textMuted;
  final delta = pos.delta;
  if (delta == null) return _legacyColorForRemaining(pos.quotaRemainingPct);
  if (delta <= -_kPaceBandPct) return MeshColors.statusHalted;
  if (delta >= _kPaceBandPct) return MeshColors.statusActive;
  return MeshColors.statusIdle;
}

/// A window's burn-down position at [now]: quota remaining vs. time remaining
/// in its window, shared by the ring color and the tooltip text so they never
/// disagree. `timeRemainingPct`/`remainingMs`/`delta` are null when
/// `resetAt`/`windowMs` aren't enough to place `now` inside the window
/// (missing, unparseable, or a zero-length window) — several provider CLIs
/// report free-form reset text with no reliable epoch to parse.
class _SchedulePosition {
  const _SchedulePosition({
    required this.quotaRemainingPct,
    required this.timeRemainingPct,
    required this.remainingMs,
  });

  final double quotaRemainingPct;
  final double? timeRemainingPct;

  /// Raw (unclamped) milliseconds until `resetAt` — kept separate from the
  /// clamped `timeRemainingPct` so the burn-rate projection ([_projection])
  /// can do its own elapsed/remaining math without re-deriving it from a
  /// percentage.
  final int? remainingMs;

  double? get delta =>
      timeRemainingPct == null ? null : quotaRemainingPct - timeRemainingPct!;
}

_SchedulePosition? _schedulePosition(QuotaWindowDto? window, DateTime now) {
  final used = window?.usedPercent;
  if (window == null || used == null || !window.isKnown) return null;
  if (window.isPastReset(now)) return null;
  final remainingMs = _remainingMs(window, now);
  if (remainingMs != null && remainingMs <= 0) return null;
  return _SchedulePosition(
    quotaRemainingPct: (100 - used).clamp(0, 100).toDouble(),
    timeRemainingPct: remainingMs == null
        ? null
        : (remainingMs / window.windowMs * 100).clamp(0, 100).toDouble(),
    remainingMs: remainingMs,
  );
}

/// Milliseconds until `resetAtIso`, or null when `windowMs`/the
/// reset text aren't enough to place `now` inside the window (missing,
/// unparseable, or a zero-length window).
int? _remainingMs(QuotaWindowDto window, DateTime now) {
  if (window.windowMs <= 0) return null;
  final resetText = window.resetAtIso;
  if (resetText == null) return null;
  final reset = DateTime.tryParse(resetText);
  if (reset == null) return null;
  return reset.difference(now).inMilliseconds;
}

Color _legacyColorForRemaining(double remainingPercent) {
  if (remainingPercent <= 20) return MeshColors.statusHalted;
  if (remainingPercent <= 60) return MeshColors.statusIdle;
  return MeshColors.statusActive;
}

/// The engaged-emergency-brake indicator: a solid (non-pulsing) red pause icon
/// and a bold "Halted" label — visually distinct from the active green pulse.
class _HaltedBadge extends StatelessWidget {
  const _HaltedBadge({this.compact = false});

  final bool compact;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
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
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
        decoration: BoxDecoration(
          color: MeshColors.statusIdle.withValues(alpha: 0.12),
          borderRadius: BorderRadius.circular(4),
          border: Border.all(color: MeshColors.statusIdle.withValues(alpha: 0.5)),
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

class _LivePulse extends StatefulWidget {
  const _LivePulse({this.compact = false});
  final bool compact;
  @override
  State<_LivePulse> createState() => _LivePulseState();
}

class _LivePulseState extends State<_LivePulse>
    with SingleTickerProviderStateMixin {
  late final AnimationController _c = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 1600),
  )..repeat(reverse: true);

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        FadeTransition(
          opacity: Tween(begin: 0.4, end: 1.0).animate(_c),
          child: Container(
            width: 8,
            height: 8,
            decoration: const BoxDecoration(
              color: MeshColors.statusActive,
              shape: BoxShape.circle,
            ),
          ),
        ),
        if (!widget.compact) ...[
          const SizedBox(width: 8),
          const Text(
            'Active',
            style: TextStyle(color: MeshColors.textSecondary, fontSize: 13),
          ),
        ],
      ],
    );
  }
}

/// A single header nav label: accent + bold when it's the active view, muted
/// otherwise. A plain text button so it sits in the brand row without adding
/// chrome to the locked V1.4.0 layout.
class _NavItem extends StatelessWidget {
  const _NavItem({
    required this.label,
    required this.view,
    required this.selected,
    required this.onSelect,
    this.alsoActiveFor = const [],
    this.compact = false,
  });

  final String label;
  final DashboardView view;
  final DashboardView selected;
  final ValueChanged<DashboardView> onSelect;

  /// Extra views this one item also represents (ISSUE_NUM: `IU` covers both the
  /// node and the report sub-view). Selecting any of them keeps the item lit,
  /// and tapping it while already there is a no-op rather than a jump back to
  /// [view] — otherwise a tap on the lit `IU` button would silently throw away
  /// the sub-view the user is reading.
  final List<DashboardView> alsoActiveFor;

  /// Tighter horizontal padding on phones  — the desktop padding left the
  /// nav items too wide to fit alongside the brand + status on a ~390px phone,
  /// overflowing the header row by a few pixels.
  final bool compact;

  @override
  Widget build(BuildContext context) {
    final active = view == selected || alsoActiveFor.contains(selected);
    return Padding(
      padding: EdgeInsets.symmetric(horizontal: compact ? 0 : 2),
      child: TextButton(
        onPressed: () => onSelect(active ? selected : view),
        style: TextButton.styleFrom(
          foregroundColor: active
              ? MeshColors.accent
              : MeshColors.textSecondary,
          padding: EdgeInsets.symmetric(
            horizontal: compact ? 6 : 10,
            vertical: 8,
          ),
          minimumSize: Size.zero,
          tapTargetSize: MaterialTapTargetSize.shrinkWrap,
          textStyle: TextStyle(
            fontSize: 13,
            fontWeight: active ? FontWeight.w700 : FontWeight.w500,
          ),
        ),
        child: Text(label),
      ),
    );
  }
}
