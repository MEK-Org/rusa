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

import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rusa_dashboard/models.dart';
import 'package:rusa_dashboard/store.dart';
import 'package:rusa_dashboard/theme.dart';
import 'package:rusa_dashboard/widgets/avatar.dart';
import 'package:rusa_dashboard/widgets/obligation_card.dart';
import 'package:rusa_dashboard/widgets/reference_preview.dart';

import 'fakes.dart';
import 'screenshot_support.dart';

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
const _portraitIds = [_kActorId, 'root', 'heron-reviewer', 'amber-owl'];

void main() {
  setUpAll(() async {
    await loadFonts();
  });

  testWidgets('renders the #664 work-identity / run-outcomes design mock-up', (
    tester,
  ) async {
    await tester.runAsync(() async {
      HttpOverrides.global = FakeImageHttpOverrides(
        await portraits(_portraitIds),
      );
      addTearDown(() => HttpOverrides.global = null);

      // Queue and selected views intentionally use two snapshots of the same
      // work identity. A queued card must not borrow an approval-wait
      // checkpoint from a later selected run.
      final queuedObligation = makeObligation(
        _kObligationId,
        ownerId: _kActorId,
        title: _kObligationHeading,
        intent: _kObligationIntent,
        externalRef: _kObligationRef,
        status: 'ready',
        checkpoint:
            'Queued behind one run; no inbox item is selected yet. '
            'Next: await the available provider lane.',
        checkpointAt: '2026-09-23T09:38:00.000Z',
        checkpointBy: _kActorId,
      );
      final selectedObligation = makeObligation(
        _kObligationId,
        ownerId: _kActorId,
        title: _kObligationHeading,
        intent: _kObligationIntent,
        externalRef: _kObligationRef,
        status: 'ready',
        checkpoint:
            'Selected for run 14:07; #664 feedback remains unhandled. '
            'Next: record the run result before changing the obligation.',
        checkpointAt: '2026-09-23T14:07:03.000Z',
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
            selectedObligation: selectedObligation,
            selectedProvider: 'claude',
            selectedModel: 'claude-opus-4-6',
            selectedEffort: 'high',
          ),
          makeThread(
            'heron-reviewer',
            parent: 'root',
            status: 'idle',
            title: 'rusa reviewer',
          ),
          makeThread(
            'amber-owl',
            parent: 'root',
            status: 'idle',
            title: 'quota docs coder',
          ),
        ]
        ..obligationsResult = [selectedObligation];
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
                child: _MockSheet(
                  store: store,
                  queuedObligation: queuedObligation,
                  selectedObligation: selectedObligation,
                ),
              ),
            ),
          ),
        ),
      );
      await tester.pump();
      await settleImages(tester, portraitUrls(_portraitIds));

      await captureBoundary(key, '$_outDir/664_run_outcomes_mock.png');
      expect(tester.takeException(), isNull);
    });
  });
}

// ── The mock sheet ───────────────────────────────────────────────────────────

class _MockSheet extends StatelessWidget {
  const _MockSheet({
    required this.store,
    required this.queuedObligation,
    required this.selectedObligation,
  });

  final DashboardStore store;
  final ObligationDto queuedObligation;
  final ObligationDto selectedObligation;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const _Banner(),
        const SizedBox(height: 16),
        _IdentityRibbon(obligation: selectedObligation),
        const SizedBox(height: 16),
        Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Expanded(
              child: _QueuedPanel(store: store, obligation: queuedObligation),
            ),
            const SizedBox(width: 16),
            Expanded(
              child: _SelectedPanel(
                store: store,
                obligation: selectedObligation,
              ),
            ),
          ],
        ),
        const SizedBox(height: 16),
        _RecentActivityPanel(store: store),
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
            'One work item threads through queued -> selected -> recent activity.',
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

/// The shared identity strip: this is the work item whose progression through
/// queued -> selected -> recent activity the mock demonstrates.
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
          const ReferenceKindChip('WORK ITEM'),
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
          'Tap the card -> the same obligation opens focused in Work; the run '
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
                    '$_kHandle · run started 14:07 · mid-run snapshot 14:07:03',
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
                    'opens Work -> focused node',
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
/// what actors have completed recently, answering "what have the actors
/// completed recently?". Each row follows the structure:
///   [Time] [Actor] [ Handled card [Optional "(+ N more)"] ]
/// with resolution explanations matching the "Handled Inbox Items" presentation
/// on the actor inbox panel. Non-zero exits and search/filter controls are removed.
class _RecentActivityPanel extends StatelessWidget {
  const _RecentActivityPanel({required this.store});
  final DashboardStore store;

  @override
  Widget build(BuildContext context) {
    return _Panel(
      step: '3',
      title: 'Recent Activity',
      subtitle:
          'What actors have completed recently, newest first. Handled cards report '
          'what was addressed, with resolution notes and completion time.',
      tag: _proposedTag,
      child: Column(
        children: [
          _HandledActivityRow(
            timeLabel: '14:21:37',
            actorId: _kActorId,
            actorHandle: _kHandle,
            actorModel: 'claude-opus-4-6, high',
            store: store,
            sourceKind: 'GITHUB ISSUE',
            sourceRef: _kObligationRef,
            summary: 'issue_comment.created · UI proposal feedback on #664',
            handledTime: '14:21:37',
            addressedNote:
                'Packaged design proposal and repeatable Flutter render harness into PR #665; awaiting operator review.',
            moreCount: 1,
            linkedObligation:
                'Obligation: Render work-outcome dashboard mock-up',
          ),
          const Divider(height: 1, color: MeshColors.border),
          _HandledActivityRow(
            timeLabel: '13:42:18',
            actorId: 'heron-reviewer',
            actorHandle: 'heron-reviewer',
            actorModel: 'gpt-5-turbo, high',
            store: store,
            sourceKind: 'GITHUB PR',
            sourceRef: 'github:MEK-Org/rusa/pulls/661',
            summary: 'pull_request_review.submitted · Review pass on PR #661',
            handledTime: '13:42:18',
            addressedNote:
                'Verified socket-boundary outage regression and removed unsupported cache retention; posted APPROVE.',
            moreCount: 2,
            linkedObligation:
                'Obligation: PR #661 — skip exhausted lanes; responsive pacing ranks',
          ),
          const Divider(height: 1, color: MeshColors.border),
          _HandledActivityRow(
            timeLabel: '12:15:40',
            actorId: 'amber-owl',
            actorHandle: 'amber-owl',
            actorModel: 'gemini-2.5-pro, high',
            store: store,
            sourceKind: 'MESH CHAT',
            sourceRef: 'mesh:messages/e3c5ab08-c8d2-4d49-b889-c44d7d83d5be',
            summary: 'mesh:message · Operator decision on stage-2 withdrawal',
            handledTime: '12:15:40',
            addressedNote:
                'Completed stage-3 handoff confirmed; cancelled child obligation 0fb4ecd9 and closed PR #666.',
            linkedObligation: 'Obligation: Add compare-only quota client',
          ),
        ],
      ),
    );
  }
}

class _HandledActivityRow extends StatelessWidget {
  const _HandledActivityRow({
    required this.timeLabel,
    required this.actorId,
    required this.actorHandle,
    required this.actorModel,
    required this.store,
    required this.sourceKind,
    required this.sourceRef,
    required this.summary,
    required this.handledTime,
    required this.addressedNote,
    this.moreCount,
    this.linkedObligation,
  });

  final String timeLabel;
  final String actorId;
  final String actorHandle;
  final String actorModel;
  final DashboardStore store;
  final String sourceKind;
  final String sourceRef;
  final String summary;
  final String handledTime;
  final String addressedNote;
  final int? moreCount;
  final String? linkedObligation;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 10),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            width: 80,
            child: Padding(
              padding: const EdgeInsets.only(top: 4),
              child: Text(
                timeLabel,
                style: kMonoStyle.copyWith(
                  color: MeshColors.textMuted,
                  fontSize: 11.5,
                  fontWeight: FontWeight.w600,
                ),
              ),
            ),
          ),
          const SizedBox(width: 8),
          SizedBox(
            width: 170,
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                ActorAvatarWithStatus(
                  id: actorId,
                  state: DotState.idle,
                  size: 26,
                  store: store,
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        actorHandle,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: kMonoStyle.copyWith(
                          color: MeshColors.textPrimary,
                          fontSize: 12,
                          fontWeight: FontWeight.w700,
                        ),
                      ),
                      const SizedBox(height: 1),
                      Text(
                        actorModel,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(
                          color: MeshColors.textSecondary,
                          fontSize: 10.5,
                        ),
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Container(
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(
                color: MeshColors.bgTertiary,
                borderRadius: BorderRadius.circular(6),
                border: Border.all(color: MeshColors.border),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      ReferenceKindChip(sourceKind),
                      const SizedBox(width: 8),
                      Expanded(
                        child: Text(
                          '$sourceRef   ·   $summary',
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: const TextStyle(
                            color: MeshColors.textPrimary,
                            fontSize: 12,
                            fontWeight: FontWeight.w600,
                          ),
                        ),
                      ),
                      if (moreCount != null && moreCount! > 0) ...[
                        const SizedBox(width: 8),
                        Container(
                          padding: const EdgeInsets.symmetric(
                            horizontal: 6,
                            vertical: 2,
                          ),
                          decoration: BoxDecoration(
                            color: MeshColors.bgSecondary,
                            borderRadius: BorderRadius.circular(4),
                            border: Border.all(color: MeshColors.border),
                          ),
                          child: Text(
                            '(+ $moreCount more)',
                            style: kMonoStyle.copyWith(
                              color: MeshColors.accent,
                              fontSize: 10,
                              fontWeight: FontWeight.w600,
                            ),
                          ),
                        ),
                      ],
                    ],
                  ),
                  const SizedBox(height: 8),
                  Container(
                    width: double.infinity,
                    padding: const EdgeInsets.symmetric(
                      horizontal: 11,
                      vertical: 9,
                    ),
                    decoration: const BoxDecoration(
                      color: Color(0xFF0D201D),
                      border: Border(
                        left: BorderSide(
                          color: MeshColors.statusActive,
                          width: 2,
                        ),
                      ),
                    ),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          'Handled: $handledTime',
                          style: const TextStyle(
                            color: Color(0xFF6EE7B7),
                            fontSize: 11,
                            fontFamily: kMonoFontFamily,
                            fontWeight: FontWeight.w600,
                          ),
                        ),
                        const SizedBox(height: 4),
                        Text.rich(
                          TextSpan(
                            style: const TextStyle(
                              color: Color(0xFFC8DED7),
                              fontSize: 12,
                              height: 1.4,
                            ),
                            children: [
                              const TextSpan(
                                text: 'Addressed: ',
                                style: TextStyle(fontWeight: FontWeight.w700),
                              ),
                              TextSpan(text: addressedNote),
                            ],
                          ),
                        ),
                      ],
                    ),
                  ),
                  if (linkedObligation != null) ...[
                    const SizedBox(height: 6),
                    Row(
                      children: [
                        const Icon(
                          Icons.account_tree_outlined,
                          size: 13,
                          color: MeshColors.textMuted,
                        ),
                        const SizedBox(width: 5),
                        Text(
                          linkedObligation!,
                          style: kMonoStyle.copyWith(
                            color: MeshColors.textMuted,
                            fontSize: 10.5,
                          ),
                        ),
                      ],
                    ),
                  ],
                ],
              ),
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
            '· Recent Activity answers “what have the actors completed recently?” via handled cards, replacing ceremonial yields.\n'
            '· Handled cards show the resolution explanation (matching the actor inbox panel) and optional (+ N more) coalesced count.\n'
            '· Routine non-zero exits / runtime failures do not appear as completions in this view; searches and filters are removed.\n'
            '· Work identity threads across queued -> selected -> recent activity.',
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
