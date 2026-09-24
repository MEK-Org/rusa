// Design mock-up harness for issue #664 (rendered review artifact, item 1 of
// the design proposal in docs/run-outcomes-dashboard-design.md).
//
// This file is DESIGN-ONLY: it adds no runtime code and changes no shipped
// screen. It renders one work item's identity across the three surfaces the
// issue calls out — queued (overview), selected (actor detail), and recent
// activity (the proposed run-outcome rows that replace the yield-note list) —
// using the real dashboard components where they exist (ObligationRow, status
// chips, kind chips, avatars, theme) and small private stand-ins, clearly
// tagged [proposed], for the parts that do not exist yet.
//
// Run it with:
//
//   flutter test test/design_664_mockup_test.dart
//
// and it writes flutter_dashboard/screenshots/664_run_outcomes_mock.png.

import 'dart:async';
import 'dart:io';
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart' show FontLoader;
import 'package:flutter_test/flutter_test.dart';
import 'package:rusa_dashboard/models.dart';
import 'package:rusa_dashboard/store.dart';
import 'package:rusa_dashboard/theme.dart';
import 'package:rusa_dashboard/widgets/avatar.dart';
import 'package:rusa_dashboard/widgets/obligation_card.dart';
import 'package:rusa_dashboard/widgets/reference_preview.dart';

import 'fakes.dart';

final String _outDir = '${Directory.current.path}/screenshots';

// The ONE work item whose identity threads through all three surfaces, as the
// issue acceptance requires. Fictional reviewer-facing content, public-safe.
const _kActorId = '99999999-9999-4999-8999-999999999999';
const _kHandle = 'kestrel-coder';
const _kObligationId = '0e655f00-0000-4000-8000-000000000001';
const _kObligationHeading = 'Render work-outcome dashboard mock-up';
const _kObligationIntent =
    'Deliver a source-grounded design proposal and rendered mock-up before '
    'runtime implementation. Public request on 2026-09-23.';
const _kObligationRef = 'github:MEK-Org/rusa/issues/664';

void main() {
  setUpAll(() async {
    await _loadFonts();
  });

  testWidgets('renders the #664 work-identity / run-outcomes design mock-up', (
    tester,
  ) async {
    await tester.runAsync(() async {
      HttpOverrides.global = _FakeImageHttpOverrides(await _portraits());
      addTearDown(() => HttpOverrides.global = null);

      final obligation = makeObligation(
        _kObligationId,
        ownerId: _kActorId,
        title: _kObligationHeading,
        intent: _kObligationIntent,
        externalRef: _kObligationRef,
        status: 'ready',
        checkpoint:
            'Design mock-up rendered; waiting on operator design approval. '
            'Next: preserve the selected notification until review settles.',
        checkpointAt: '2026-09-23T09:40:00.000Z',
        checkpointBy: _kActorId,
      );
      final api = FakeApi()
        ..threadsResult = [
          makeThread(
            _kActorId,
            parent: 'root',
            status: 'active',
            runState: RunState.queued,
            title: 'pool-selection implementer',
            queuePosition: 1,
            estimatedStartAt: '2026-09-23T09:52:00.000Z',
            selectedObligation: obligation,
            selectedProvider: 'claude',
            selectedModel: 'claude-opus-4-6',
            selectedEffort: 'high',
          ),
        ]
        ..obligationsResult = [obligation];
      final store = DashboardStore(api: api, stream: FakeStream());
      await store.init();
      addTearDown(store.dispose);
      addTearDown(() => tester.binding.setSurfaceSize(null));

      final key = GlobalKey();
      await tester.binding.setSurfaceSize(const Size(1560, 1340));
      await tester.pumpWidget(
        MaterialApp(
          debugShowCheckedModeBanner: false,
          theme: buildMeshTheme(),
          home: Scaffold(
            backgroundColor: MeshColors.bgPrimary,
            body: RepaintBoundary(
              key: key,
              child: SingleChildScrollView(
                padding: const EdgeInsets.all(24),
                child: _MockSheet(store: store, obligation: obligation),
              ),
            ),
          ),
        ),
      );
      await tester.pump();
      await _settleImages(tester, [
        _portraitUrl(_kActorId),
        _portraitUrl('root'),
      ]);

      await _capture(key, '$_outDir/664_run_outcomes_mock.png');
      expect(tester.takeException(), isNull);
    });
  });
}

// ── The mock sheet ───────────────────────────────────────────────────────────

class _MockSheet extends StatelessWidget {
  const _MockSheet({required this.store, required this.obligation});

  final DashboardStore store;
  final ObligationDto obligation;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const _Banner(),
        const SizedBox(height: 16),
        _IdentityRibbon(obligation: obligation),
        const SizedBox(height: 16),
        Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Expanded(
              child: _QueuedPanel(store: store, obligation: obligation),
            ),
            const SizedBox(width: 16),
            Expanded(
              child: _SelectedPanel(store: store, obligation: obligation),
            ),
          ],
        ),
        const SizedBox(height: 16),
        const _RecentActivityPanel(),
        const SizedBox(height: 16),
        const _FooterNotes(),
      ],
    );
  }
}

class _Banner extends StatelessWidget {
  const _Banner();

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: MeshColors.bgSecondary,
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: MeshColors.accent.withValues(alpha: 0.55)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            'DESIGN MOCK-UP · #664 run outcomes replace ceremonial yield',
            style: kMonoStyle.copyWith(
              color: MeshColors.accent,
              fontSize: 15,
              fontWeight: FontWeight.w700,
            ),
          ),
          const SizedBox(height: 6),
          Text(
            'Review artifact only — nothing here ships. Real dashboard components '
            'are tagged [existing]; proposed elements are tagged [proposed]. '
            'One work item threads through queued → selected → recent activity.',
            style: TextStyle(
              color: MeshColors.textSecondary.withValues(alpha: 0.95),
              fontSize: 12,
              height: 1.4,
            ),
          ),
        ],
      ),
    );
  }
}

class _Tag extends StatelessWidget {
  const _Tag(this.label, {required this.color});
  final String label;
  final Color color;

  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
    decoration: BoxDecoration(
      color: color.withValues(alpha: 0.14),
      borderRadius: BorderRadius.circular(4),
      border: Border.all(color: color.withValues(alpha: 0.45)),
    ),
    child: Text(
      label,
      style: kMonoStyle.copyWith(
        fontSize: 9.5,
        fontWeight: FontWeight.w600,
        color: color,
      ),
    ),
  );
}

const _existingTag = _Tag('existing component', color: MeshColors.statusActive);
const _proposedTag = _Tag('proposed', color: MeshColors.statusIdle);

class _Panel extends StatelessWidget {
  const _Panel({
    required this.step,
    required this.title,
    required this.subtitle,
    required this.tag,
    required this.child,
  });

  final String step;
  final String title;
  final String subtitle;
  final Widget tag;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: MeshColors.bgSecondary,
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: MeshColors.border),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Text(
                '$step · $title',
                style: const TextStyle(
                  color: MeshColors.textPrimary,
                  fontSize: 13.5,
                  fontWeight: FontWeight.w700,
                ),
              ),
              const Spacer(),
              tag,
            ],
          ),
          const SizedBox(height: 4),
          Text(
            subtitle,
            style: const TextStyle(color: MeshColors.textMuted, fontSize: 11),
          ),
          const SizedBox(height: 12),
          child,
        ],
      ),
    );
  }
}

/// The shared identity strip: this is the "same work item" the acceptance test
/// asks a user to follow. Every surface renders this same heading + status +
/// reference, so the eye can track it across panels.
class _IdentityRibbon extends StatelessWidget {
  const _IdentityRibbon({required this.obligation});
  final ObligationDto obligation;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
      decoration: BoxDecoration(
        color: MeshColors.bgTertiary,
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: MeshColors.borderFocus),
      ),
      child: Row(
        children: [
          const Icon(Icons.linear_scale, size: 16, color: MeshColors.accent),
          const SizedBox(width: 10),
          const ReferenceKindChip('SAME WORK ITEM'),
          const SizedBox(width: 10),
          Expanded(
            child: Text(
              '${obligation.heading}   ·   $_kObligationRef   ·   tracked by kestrel-coder',
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(
                color: MeshColors.textPrimary,
                fontSize: 12.5,
                fontWeight: FontWeight.w600,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

// ── ① Queued ─────────────────────────────────────────────────────────────────

class _QueuedPanel extends StatelessWidget {
  const _QueuedPanel({required this.store, required this.obligation});
  final DashboardStore store;
  final ObligationDto obligation;

  @override
  Widget build(BuildContext context) {
    return _Panel(
      step: '1',
      title: 'QUEUED — overview · Queued Actors',
      subtitle:
          'The card the operator scans: actor identity + the obligation it will '
          'work (obligation wins over the raw inbox item, per #610), + why it waits.',
      tag: _existingTag,
      child: Container(
        decoration: BoxDecoration(
          color: MeshColors.bgTertiary,
          borderRadius: BorderRadius.circular(6),
          border: Border.all(color: MeshColors.border),
        ),
        child: Column(
          children: [
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Expanded(
                  flex: 5,
                  child: Padding(
                    padding: const EdgeInsets.all(12),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Row(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            ActorAvatarWithStatus(
                              id: _kActorId,
                              state: DotState.queued,
                              size: 40,
                              store: store,
                            ),
                            const SizedBox(width: 10),
                            Expanded(
                              child: Column(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  Text.rich(
                                    TextSpan(
                                      text: _kHandle,
                                      children: const [
                                        TextSpan(
                                          text: ' (claude-opus-4-6, high)',
                                          style: TextStyle(
                                            color: MeshColors.textSecondary,
                                            fontWeight: FontWeight.w400,
                                          ),
                                        ),
                                      ],
                                    ),
                                    maxLines: 1,
                                    overflow: TextOverflow.ellipsis,
                                    style: kMonoStyle.copyWith(
                                      color: MeshColors.textPrimary,
                                      fontWeight: FontWeight.w700,
                                      fontSize: 13,
                                    ),
                                  ),
                                  const SizedBox(height: 2),
                                  const Text(
                                    'dashboard design implementer',
                                    maxLines: 1,
                                    overflow: TextOverflow.ellipsis,
                                    style: TextStyle(
                                      color: MeshColors.textSecondary,
                                      fontSize: 12,
                                    ),
                                  ),
                                  const SizedBox(height: 4),
                                  Text(
                                    'Runs in ~8 min',
                                    style: kMonoStyle.copyWith(
                                      color: MeshColors.statusIdle,
                                      fontSize: 11,
                                    ),
                                  ),
                                  const SizedBox(height: 2),
                                  const Text(
                                    'Queued behind 1 run · lane has quota',
                                    style: TextStyle(
                                      color: MeshColors.textMuted,
                                      fontSize: 10.5,
                                    ),
                                  ),
                                ],
                              ),
                            ),
                          ],
                        ),
                      ],
                    ),
                  ),
                ),
                Expanded(
                  flex: 7,
                  child: Padding(
                    padding: const EdgeInsets.fromLTRB(0, 12, 12, 12),
                    child: Container(
                      decoration: BoxDecoration(
                        color: MeshColors.bgSecondary,
                        borderRadius: BorderRadius.circular(5),
                        border: Border.all(color: MeshColors.border),
                      ),
                      child: ObligationRow(
                        obligation: obligation,
                        store: store,
                        showActions: false,
                        contentPadding: const EdgeInsets.all(12),
                      ),
                    ),
                  ),
                ),
              ],
            ),
            const Divider(height: 1, color: MeshColors.border),
            const Padding(
              padding: EdgeInsets.all(10),
              child: Row(
                children: [
                  Icon(
                    Icons.schedule_outlined,
                    size: 14,
                    color: MeshColors.textMuted,
                  ),
                  SizedBox(width: 7),
                  Expanded(
                    child: Text(
                      'DEFERRED BACKLOG · dependency follow-up',
                      style: TextStyle(
                        color: MeshColors.textSecondary,
                        fontSize: 11.5,
                      ),
                    ),
                  ),
                  Text(
                    'unselected · remains in Queue',
                    style: TextStyle(
                      color: MeshColors.textMuted,
                      fontSize: 10.5,
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

// ── ② Selected ───────────────────────────────────────────────────────────────

class _SelectedPanel extends StatelessWidget {
  const _SelectedPanel({required this.store, required this.obligation});
  final DashboardStore store;
  final ObligationDto obligation;

  @override
  Widget build(BuildContext context) {
    return _Panel(
      step: '2',
      title: 'SELECTED — actor detail · Work focus',
      subtitle:
          'Tap the card → the same obligation opens focused in Work; the run '
          'header shows who is working it, and selected-but-unfinished items '
          'stay listed instead of being implied by a yield note.',
      tag: _existingTag,
      child: Container(
        decoration: BoxDecoration(
          color: MeshColors.bgTertiary,
          borderRadius: BorderRadius.circular(6),
          border: Border.all(color: MeshColors.border),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(12, 10, 12, 0),
              child: Row(
                children: [
                  ActorAvatarWithStatus(
                    id: _kActorId,
                    state: DotState.active,
                    size: 24,
                    store: store,
                  ),
                  const SizedBox(width: 8),
                  Text(
                    '$_kHandle · run started 14:07 · local CLI',
                    style: kMonoStyle.copyWith(
                      color: MeshColors.textPrimary,
                      fontSize: 11.5,
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                  const Spacer(),
                  const Icon(
                    Icons.account_tree_outlined,
                    size: 14,
                    color: MeshColors.textMuted,
                  ),
                  const SizedBox(width: 4),
                  Text(
                    'opens Work → focused node',
                    style: kMonoStyle.copyWith(
                      color: MeshColors.textMuted,
                      fontSize: 10.5,
                    ),
                  ),
                ],
              ),
            ),
            ObligationRow(
              obligation: obligation,
              store: store,
              showActions: true,
              contentPadding: const EdgeInsets.all(12),
            ),
            const Divider(height: 1, color: MeshColors.border),
            const Padding(
              padding: EdgeInsets.all(12),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    'SELECTED WORK THIS RUN',
                    style: TextStyle(
                      color: MeshColors.textMuted,
                      fontSize: 9.5,
                      fontWeight: FontWeight.w700,
                      letterSpacing: 0.6,
                    ),
                  ),
                  SizedBox(height: 6),
                  _KeyValue(
                    keyText: 'unhandled',
                    value: '1 inbox item — #664 mock-up feedback',
                    valueColor: MeshColors.statusIdle,
                  ),
                  SizedBox(height: 3),
                  _KeyValue(
                    keyText: 'drill-through',
                    value: 'Inbox tab · Events tab · Work tree',
                    valueColor: MeshColors.textSecondary,
                  ),
                  SizedBox(height: 3),
                  _KeyValue(
                    keyText: 'backlog',
                    value: '2 unselected deferred items remain in Queue',
                    valueColor: MeshColors.textMuted,
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

class _KeyValue extends StatelessWidget {
  const _KeyValue({
    required this.keyText,
    required this.value,
    required this.valueColor,
  });
  final String keyText;
  final String value;
  final Color valueColor;

  @override
  Widget build(BuildContext context) => Row(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      SizedBox(
        width: 110,
        child: Text(
          keyText,
          style: kMonoStyle.copyWith(
            color: MeshColors.textMuted,
            fontSize: 10.5,
          ),
        ),
      ),
      Expanded(
        child: Text(value, style: TextStyle(color: valueColor, fontSize: 11.5)),
      ),
    ],
  );
}

// ── ③ Recent activity (proposed) ─────────────────────────────────────────────

/// The proposed replacement for the "Recent Yields" section: rows keyed by
/// RUN SETTLEMENT, each carrying the same work identity plus two DISTINCT
/// outcome columns — handled messages vs obligation changes — plus bounded
/// recovery state. A handled message is never rendered as goal completion.
class _RecentActivityPanel extends StatelessWidget {
  const _RecentActivityPanel();

  @override
  Widget build(BuildContext context) {
    return _Panel(
      step: '3',
      title: 'RECENT ACTIVITY — replaces “Recent Yields”',
      subtitle:
          'One row per settled run (or per genuine wait). Outcome pills come '
          'from the run record — returned / failed / interrupted / waiting — '
          'not from a yield note. Columns: HANDLED (inbox outcomes) vs '
          'OBLIGATION CHANGES (actual tree movement) vs GOAL.',
      tag: _proposedTag,
      child: Column(
        children: [
          _RunOutcomeRow(
            pill: _OutcomePill.returnedOk(),
            startLabel: '14:07:03',
            duration: '2m 18s',
            identityTitle: _kObligationHeading,
            identityRef: _kObligationRef,
            handled: const [
              '#664 design-review notification handled at 14:07',
              'note: waiting on design approval',
            ],
            obligationChanges: const [
              'status unchanged · Waiting on operator',
              'dependency edge: design approval',
            ],
            goalState: _GoalState.waiting,
            drillThrough: 'handled notification · work tree',
          ),
          const Divider(height: 1, color: MeshColors.border),
          _RunOutcomeRow(
            pill: _OutcomePill.failed(),
            startLabel: '14:12:40',
            duration: '38s',
            identityTitle: _kObligationHeading,
            identityRef: _kObligationRef,
            handled: const [
              '0 handled — selected #664 notification remains unhandled',
            ],
            obligationChanges: const [
              'none — Waiting on operator remains durable',
            ],
            goalState: _GoalState.notCompleted,
            drillThrough: 'run · selected notification · bounded output',
            errorTail: 'provider CLI failed: coordinator unavailable',
            recovery:
                'retry 2/2 exhausted for this work → NEEDS ATTENTION; explicit action required',
          ),
          const Divider(height: 1, color: MeshColors.border),
          _RunOutcomeRow(
            pill: _OutcomePill.interrupted(),
            startLabel: '08:58:02',
            duration: '1m 03s',
            identityTitle: _kObligationHeading,
            identityRef: _kObligationRef,
            handled: const ['0 handled — run cut off'],
            obligationChanges: const ['none'],
            goalState: _GoalState.notCompleted,
            drillThrough: 'events · work tree',
            recovery: '1 selected item left unhandled → re-queued for next run',
          ),
          const Divider(height: 1, color: MeshColors.border),
          const _DependencyWaitRow(),
        ],
      ),
    );
  }
}

enum _GoalState { completed, working, waiting, notCompleted }

extension on _GoalState {
  String get label => switch (this) {
    _GoalState.completed => 'goal completed',
    _GoalState.working => 'goal in progress — not a completion',
    _GoalState.waiting => 'goal waiting on a real dependency',
    _GoalState.notCompleted => 'goal NOT completed',
  };
  Color get color => switch (this) {
    _GoalState.completed => MeshColors.statusActive,
    _GoalState.working => MeshColors.textSecondary,
    _GoalState.waiting => MeshColors.statusIdle,
    _GoalState.notCompleted => MeshColors.statusIdle,
  };
}

class _OutcomePill extends StatelessWidget {
  const _OutcomePill._(this.label, this.color);
  final String label;
  final Color color;

  factory _OutcomePill.returnedOk() =>
      const _OutcomePill._('RETURNED · ok', MeshColors.statusActive);
  factory _OutcomePill.failed() =>
      const _OutcomePill._('FAILED · exit 1', MeshColors.statusHalted);
  factory _OutcomePill.interrupted() =>
      const _OutcomePill._('INTERRUPTED', MeshColors.statusIdle);

  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 3),
    decoration: BoxDecoration(
      color: color.withValues(alpha: 0.14),
      borderRadius: BorderRadius.circular(4),
      border: Border.all(color: color.withValues(alpha: 0.45)),
    ),
    child: Text(
      label,
      style: kMonoStyle.copyWith(
        fontSize: 10.5,
        fontWeight: FontWeight.w700,
        color: color,
      ),
    ),
  );
}

class _RunOutcomeRow extends StatelessWidget {
  const _RunOutcomeRow({
    required this.pill,
    required this.startLabel,
    required this.duration,
    required this.identityTitle,
    required this.identityRef,
    required this.handled,
    required this.obligationChanges,
    required this.goalState,
    required this.drillThrough,
    this.errorTail,
    this.recovery,
  });

  final _OutcomePill pill;
  final String startLabel;
  final String duration;
  final String identityTitle;
  final String identityRef;
  final List<String> handled;
  final List<String> obligationChanges;
  final _GoalState goalState;
  final String drillThrough;
  final String? errorTail;
  final String? recovery;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 10),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            width: 168,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                pill,
                const SizedBox(height: 5),
                Text(
                  startLabel,
                  style: kMonoStyle.copyWith(
                    color: MeshColors.textMuted,
                    fontSize: 11,
                  ),
                ),
                Text(
                  'ran $duration',
                  style: const TextStyle(
                    color: MeshColors.textMuted,
                    fontSize: 10.5,
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(width: 12),
          SizedBox(
            width: 300,
            child: Container(
              padding: const EdgeInsets.all(9),
              decoration: BoxDecoration(
                color: MeshColors.bgTertiary,
                borderRadius: BorderRadius.circular(5),
                border: Border.all(color: MeshColors.border),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const ReferenceKindChip('SAME WORK ITEM'),
                  const SizedBox(height: 5),
                  Text(
                    identityTitle,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(
                      color: MeshColors.textPrimary,
                      fontSize: 12,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                  const SizedBox(height: 2),
                  Text(
                    identityRef,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: kMonoStyle.copyWith(
                      color: MeshColors.textMuted,
                      fontSize: 10,
                    ),
                  ),
                  if (errorTail != null) ...[
                    const SizedBox(height: 5),
                    Text(
                      errorTail!,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(
                        color: MeshColors.statusHalted,
                        fontSize: 10.5,
                      ),
                    ),
                  ],
                  if (recovery != null) ...[
                    const SizedBox(height: 3),
                    Text(
                      recovery!,
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(
                        color: MeshColors.statusIdle,
                        fontSize: 10.5,
                      ),
                    ),
                  ],
                ],
              ),
            ),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                _OutcomeColumn(
                  header: 'HANDLED',
                  headerColor: MeshColors.accent,
                  items: handled,
                ),
                const SizedBox(height: 8),
                _OutcomeColumn(
                  header: 'OBLIGATION CHANGES',
                  headerColor: MeshColors.accent,
                  items: obligationChanges,
                ),
                const SizedBox(height: 8),
                Row(
                  children: [
                    Text(
                      'GOAL',
                      style: TextStyle(
                        color: goalState.color,
                        fontSize: 9.5,
                        fontWeight: FontWeight.w700,
                        letterSpacing: 0.6,
                      ),
                    ),
                    const SizedBox(width: 8),
                    Text(
                      goalState.label,
                      style: TextStyle(color: goalState.color, fontSize: 11),
                    ),
                    const Spacer(),
                    Icon(
                      Icons.open_in_new,
                      size: 12,
                      color: MeshColors.textMuted.withValues(alpha: 0.8),
                    ),
                    const SizedBox(width: 4),
                    Text(
                      drillThrough,
                      style: kMonoStyle.copyWith(
                        color: MeshColors.textMuted,
                        fontSize: 10,
                      ),
                    ),
                  ],
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _OutcomeColumn extends StatelessWidget {
  const _OutcomeColumn({
    required this.header,
    required this.headerColor,
    required this.items,
  });
  final String header;
  final Color headerColor;
  final List<String> items;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          header,
          style: TextStyle(
            color: headerColor,
            fontSize: 9.5,
            fontWeight: FontWeight.w700,
            letterSpacing: 0.6,
          ),
        ),
        const SizedBox(height: 3),
        for (final item in items)
          Padding(
            padding: const EdgeInsets.only(top: 2),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Padding(
                  padding: EdgeInsets.only(top: 4),
                  child: Icon(
                    Icons.circle,
                    size: 4,
                    color: MeshColors.textMuted,
                  ),
                ),
                const SizedBox(width: 6),
                Expanded(
                  child: Text(
                    item,
                    style: const TextStyle(
                      color: MeshColors.textSecondary,
                      fontSize: 11,
                    ),
                  ),
                ),
              ],
            ),
          ),
      ],
    );
  }
}

/// Delegation and dependency waits remain visible as first-class rows — the
/// point is that a wait is NOT a run and gets no fake run outcome.
class _DependencyWaitRow extends StatelessWidget {
  const _DependencyWaitRow();

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 10),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const SizedBox(
            width: 168,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                _OutcomePill._(
                  'WAITING · dependency',
                  MeshColors.statusRetired,
                ),
                SizedBox(height: 5),
                Text(
                  'since 09:51',
                  style: TextStyle(color: MeshColors.textMuted, fontSize: 11),
                ),
              ],
            ),
          ),
          const SizedBox(width: 12),
          const SizedBox(
            width: 300,
            child: Text(
              'Delegated: review verdict from heron-reviewer',
              style: TextStyle(color: MeshColors.textPrimary, fontSize: 12),
            ),
          ),
          const SizedBox(width: 12),
          const Expanded(
            child: Text(
              'No run is active — the actor waits on a peer obligation. Shown '
              'so a dependency never masquerades as progress or as a yield.',
              style: TextStyle(color: MeshColors.textSecondary, fontSize: 11),
            ),
          ),
        ],
      ),
    );
  }
}

class _FooterNotes extends StatelessWidget {
  const _FooterNotes();

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: MeshColors.bgSecondary,
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: MeshColors.border),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            'WHAT THE MOCK-UP SETTLES',
            style: kMonoStyle.copyWith(
              color: MeshColors.textMuted,
              fontSize: 10,
              fontWeight: FontWeight.w700,
              letterSpacing: 0.6,
            ),
          ),
          const SizedBox(height: 6),
          const Text(
            '· Handled-message outcome and obligation-change outcome are separate '
            'columns; a handled message is never rendered as a completed goal.\n'
            '· Run settlement (return / fail / interrupt) comes from the run '
            'record; the yield note is gone from normal progress.\n'
            '· Interruption recovery is explicit: unhandled selected work is '
            're-queued and named.\n'
            '· Waits stay visible without a ceremonial yield row.',
            style: TextStyle(
              color: MeshColors.textSecondary,
              fontSize: 11.5,
              height: 1.5,
            ),
          ),
        ],
      ),
    );
  }
}

// ── Capture + image settling (mirrors test/screenshots_test.dart) ────────────

Future<void> _settleImages(WidgetTester tester, List<String> urls) async {
  await tester.pump();
  final ctx = tester.element(find.byType(MaterialApp));
  for (final url in urls) {
    await precacheImage(NetworkImage(url), ctx);
  }
  await tester.pump(const Duration(milliseconds: 80));
  await tester.pump(const Duration(milliseconds: 80));
}

Future<void> _capture(GlobalKey key, String path) async {
  final boundary =
      key.currentContext!.findRenderObject()! as RenderRepaintBoundary;
  final image = await boundary.toImage(pixelRatio: 2.0);
  final bytes = (await image.toByteData(
    format: ui.ImageByteFormat.png,
  ))!.buffer.asUint8List();
  final file = File(path)..createSync(recursive: true);
  file.writeAsBytesSync(bytes);
}

String _portraitUrl(String id) =>
    Uri.base.resolve('/api/mesh/avatar/$id.png').toString();

Future<Uint8List> _portraitPng() async {
  const w = 120.0, h = 168.0;
  final recorder = ui.PictureRecorder();
  final canvas = Canvas(recorder, const Rect.fromLTWH(0, 0, w, h));
  canvas.drawRect(
    const Rect.fromLTWH(0, 0, w, h),
    Paint()
      ..shader = ui.Gradient.linear(Offset.zero, const Offset(w, h), const [
        Color(0xFF38BDF8),
        Color(0xFF6366F1),
      ]),
  );
  canvas.drawCircle(
    const Offset(w * 0.5, w * 0.46),
    w * 0.34,
    Paint()..color = Colors.white.withValues(alpha: 0.9),
  );
  final picture = recorder.endRecording();
  final image = await picture.toImage(w.toInt(), h.toInt());
  final data = await image.toByteData(format: ui.ImageByteFormat.png);
  return data!.buffer.asUint8List();
}

Future<Map<String, Uint8List>> _portraits() async {
  final png = await _portraitPng();
  return {_kActorId: png, 'root': png};
}

class _FakeImageHttpOverrides extends HttpOverrides {
  _FakeImageHttpOverrides(this.byId);
  final Map<String, Uint8List> byId;
  @override
  HttpClient createHttpClient(SecurityContext? context) =>
      _FakeHttpClient(byId);
}

class _FakeHttpClient implements HttpClient {
  _FakeHttpClient(this.byId);
  final Map<String, Uint8List> byId;
  @override
  bool autoUncompress = true;

  @override
  Future<HttpClientRequest> getUrl(Uri url) async {
    final name = url.pathSegments.isEmpty ? '' : url.pathSegments.last;
    final id = name.endsWith('.png')
        ? name.substring(0, name.length - 4)
        : name;
    final bytes = byId[id] ?? byId.values.first;
    return _FakeHttpClientRequest(bytes);
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

class _FakeHttpClientRequest implements HttpClientRequest {
  _FakeHttpClientRequest(this.bytes);
  final Uint8List bytes;
  @override
  final HttpHeaders headers = _FakeHttpHeaders();
  @override
  Future<HttpClientResponse> close() async => _FakeHttpClientResponse(bytes);
  @override
  Future<HttpClientResponse> get done => close();
  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

class _FakeHttpClientResponse extends Stream<List<int>>
    implements HttpClientResponse {
  _FakeHttpClientResponse(this.bytes);
  final Uint8List bytes;
  @override
  int get statusCode => HttpStatus.ok;
  @override
  int get contentLength => bytes.length;
  @override
  HttpClientResponseCompressionState get compressionState =>
      HttpClientResponseCompressionState.notCompressed;
  @override
  StreamSubscription<List<int>> listen(
    void Function(List<int> event)? onData, {
    Function? onError,
    void Function()? onDone,
    bool? cancelOnError,
  }) => Stream<List<int>>.fromIterable([bytes]).listen(
    onData,
    onError: onError,
    onDone: onDone,
    cancelOnError: cancelOnError,
  );

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

class _FakeHttpHeaders implements HttpHeaders {
  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

// ── Fonts (from the Flutter SDK cache, derived from the test VM path) ────────

Future<void> _loadFonts() async {
  final dir = _materialFontsDir();
  if (dir == null) return; // best-effort: fall back to box glyphs

  Future<void> load(String family, List<String> files) async {
    final loader = FontLoader(family);
    var any = false;
    for (final f in files) {
      final file = File('$dir/$f');
      if (file.existsSync()) {
        loader.addFont(
          Future.value(file.readAsBytesSync().buffer.asByteData()),
        );
        any = true;
      }
    }
    if (any) await loader.load();
  }

  const roboto = ['Roboto-Regular.ttf', 'Roboto-Medium.ttf', 'Roboto-Bold.ttf'];
  await load('Roboto', roboto);
  await load('system-ui', roboto);
  await load('monospace', roboto);
  await load('MaterialIcons', [
    'MaterialIcons-Regular.otf',
    'MaterialIcons-Regular.ttf',
  ]);
}

String? _materialFontsDir() {
  final exe = Platform.resolvedExecutable;
  const marker = '/bin/cache/';
  final idx = exe.indexOf(marker);
  if (idx < 0) return null;
  final root = exe.substring(0, idx);
  final dir = '$root/bin/cache/artifacts/material_fonts';
  return Directory(dir).existsSync() ? dir : null;
}
