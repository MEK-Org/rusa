import 'package:flutter/material.dart';

import '../models.dart';
import '../store.dart';
import '../theme.dart';
import 'owner_selector.dart';

Future<void> showCreateObligationDialog(
  BuildContext context,
  DashboardStore store, {
  String? defaultParentId,
  String? defaultOwnerId,
  VoidCallback? onCreated,
}) async {
  final formKey = GlobalKey<FormState>();
  final titleCtrl = TextEditingController();
  final intentCtrl = TextEditingController();
  final ownerIdCtrl = TextEditingController(text: (defaultOwnerId == 'human:operator' ? 'human operator' : defaultOwnerId) ?? '');
  final parentIdCtrl = TextEditingController(text: defaultParentId ?? '');
  final externalRefCtrl = TextEditingController();
  final priorityCtrl = TextEditingController();
  bool isSubmitting = false;

  await showDialog<void>(
    context: context,
    builder: (dialogContext) => StatefulBuilder(
      builder: (context, setState) {
        return AlertDialog(
          backgroundColor: MeshColors.bgSecondary,
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(10),
            side: const BorderSide(color: MeshColors.border),
          ),
          title: Text(
            defaultParentId == null ? 'Create Root Obligation' : 'Create Child Obligation',
            style: const TextStyle(color: MeshColors.textPrimary, fontSize: 16, fontWeight: FontWeight.bold),
          ),
          content: SingleChildScrollView(
            child: SizedBox(
              width: 440,
              child: Form(
                key: formKey,
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    if (defaultParentId != null) ...[
                      Container(
                        padding: const EdgeInsets.all(10),
                        margin: const EdgeInsets.only(bottom: 12),
                        decoration: BoxDecoration(
                          color: MeshColors.bgTertiary,
                          borderRadius: BorderRadius.circular(6),
                          border: Border.all(color: MeshColors.border),
                        ),
                        child: Row(
                          children: [
                            const Text('Parent ID: ', style: TextStyle(color: MeshColors.textSecondary, fontSize: 12)),
                            Expanded(
                              child: Text(
                                defaultParentId,
                                style: const TextStyle(
                                  color: MeshColors.accent,
                                  fontFamily: kMonoFontFamily,
                                  fontSize: 12,
                                  fontWeight: FontWeight.w600,
                                ),
                              ),
                            ),
                          ],
                        ),
                      ),
                    ],
                    const Text('Title *', style: TextStyle(color: MeshColors.textSecondary, fontSize: 12)),
                    const SizedBox(height: 4),
                    TextFormField(
                      controller: titleCtrl,
                      maxLength: kObligationTitleMax,
                      style: const TextStyle(color: MeshColors.textPrimary, fontSize: 13),
                      decoration: const InputDecoration(
                        hintText: 'e.g. Game Type',
                        hintStyle: TextStyle(color: MeshColors.textMuted, fontSize: 12),
                        filled: true,
                        fillColor: MeshColors.bgPrimary,
                        border: OutlineInputBorder(borderSide: BorderSide(color: MeshColors.border)),
                        contentPadding: EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                        counterStyle: TextStyle(color: MeshColors.textMuted, fontSize: 10),
                      ),
                      validator: (val) => (val == null || val.trim().isEmpty) ? 'Title is required' : null,
                    ),
                    const SizedBox(height: 12),
                    const Text('Intent / Description', style: TextStyle(color: MeshColors.textSecondary, fontSize: 12)),
                    const SizedBox(height: 4),
                    TextFormField(
                      controller: intentCtrl,
                      maxLines: 4,
                      minLines: 2,
                      style: const TextStyle(color: MeshColors.textPrimary, fontSize: 13),
                      decoration: const InputDecoration(
                        hintText: 'What should become true, in words that still read months from now.',
                        hintStyle: TextStyle(color: MeshColors.textMuted, fontSize: 12),
                        filled: true,
                        fillColor: MeshColors.bgPrimary,
                        border: OutlineInputBorder(borderSide: BorderSide(color: MeshColors.border)),
                        contentPadding: EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                      ),
                    ),
                    const SizedBox(height: 12),
                    const SizedBox(height: 12),
                    const Text('Owner ID or Handle *', style: TextStyle(color: MeshColors.textSecondary, fontSize: 12)),
                    const SizedBox(height: 4),
                    OwnerSelector(
                      store: store,
                      ownerIdCtrl: ownerIdCtrl,
                      decoration: const InputDecoration(
                        hintText: 'e.g. root, cloudy-porpoise',
                        hintStyle: TextStyle(color: MeshColors.textMuted, fontSize: 12),
                        filled: true,
                        fillColor: MeshColors.bgPrimary,
                        border: OutlineInputBorder(borderSide: BorderSide(color: MeshColors.border)),
                        contentPadding: EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                      ),
                    ),
                    if (defaultParentId == null) ...[
                      const SizedBox(height: 12),
                      const Text('Parent ID (optional)', style: TextStyle(color: MeshColors.textSecondary, fontSize: 12)),
                      const SizedBox(height: 4),
                      TextFormField(
                        controller: parentIdCtrl,
                        style: const TextStyle(color: MeshColors.textPrimary, fontSize: 13, fontFamily: kMonoFontFamily),
                        decoration: const InputDecoration(
                          hintText: 'Leave blank for root obligation',
                          hintStyle: TextStyle(color: MeshColors.textMuted, fontSize: 12),
                          filled: true,
                          fillColor: MeshColors.bgPrimary,
                          border: OutlineInputBorder(borderSide: BorderSide(color: MeshColors.border)),
                          contentPadding: EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                        ),
                      ),
                    ],
                    const SizedBox(height: 12),
                    const Text('External Reference (optional)', style: TextStyle(color: MeshColors.textSecondary, fontSize: 12)),
                    const SizedBox(height: 4),
                    TextFormField(
                      controller: externalRefCtrl,
                      style: const TextStyle(color: MeshColors.textPrimary, fontSize: 13, fontFamily: kMonoFontFamily),
                      decoration: const InputDecoration(
                        hintText: 'e.g. github_issue:Rusa-Org/rusaISSUE_NUM',
                        hintStyle: TextStyle(color: MeshColors.textMuted, fontSize: 12),
                        filled: true,
                        fillColor: MeshColors.bgPrimary,
                        border: OutlineInputBorder(borderSide: BorderSide(color: MeshColors.border)),
                        contentPadding: EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                      ),
                    ),
                    const SizedBox(height: 12),
                    const Text('Explicit Priority Override (optional)', style: TextStyle(color: MeshColors.textSecondary, fontSize: 12)),
                    const SizedBox(height: 4),
                    TextFormField(
                      controller: priorityCtrl,
                      keyboardType: const TextInputType.numberWithOptions(decimal: true),
                      style: const TextStyle(color: MeshColors.textPrimary, fontSize: 13, fontFamily: kMonoFontFamily),
                      decoration: const InputDecoration(
                        hintText: 'e.g. 100.0 (defaults to parent or timestamp)',
                        hintStyle: TextStyle(color: MeshColors.textMuted, fontSize: 12),
                        filled: true,
                        fillColor: MeshColors.bgPrimary,
                        border: OutlineInputBorder(borderSide: BorderSide(color: MeshColors.border)),
                        contentPadding: EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
          actions: [
            TextButton(
              onPressed: isSubmitting ? null : () => Navigator.of(dialogContext).pop(),
              child: const Text('Cancel', style: TextStyle(color: MeshColors.textSecondary)),
            ),
            ElevatedButton(
              onPressed: isSubmitting
                  ? null
                  : () async {
                      if (!formKey.currentState!.validate()) return;
                      setState(() => isSubmitting = true);
                      try {
                        final rawParent = defaultParentId ?? parentIdCtrl.text.trim();
                        final parentId = rawParent.isEmpty ? null : rawParent;
                        final rawExt = externalRefCtrl.text.trim();
                        final externalRef = rawExt.isEmpty ? null : rawExt;
                        final rawPrio = priorityCtrl.text.trim();
                        final priority = rawPrio.isEmpty ? null : double.tryParse(rawPrio);

                        final typedText = ownerIdCtrl.text.trim();
                        String resolvedId;
                        if (typedText == 'operator' || typedText == 'human:operator' || typedText == 'human operator') {
                          resolvedId = 'human:operator';
                        } else {
                          final matches = store.actorStates.value.actors.values
                              .where((a) => a.handle == typedText || a.id == typedText)
                              .map((a) => a.id);
                          resolvedId = matches.isNotEmpty ? matches.first : typedText;
                        }

                        final bodyText = intentCtrl.text.trim();
                        await store.api.createObligation(
                          ownerId: resolvedId,
                          title: titleCtrl.text.trim(),
                          parentId: parentId,
                          intent: bodyText.isEmpty ? null : bodyText,
                          externalRef: externalRef,
                          priority: priority,
                        );

                        if (context.mounted) {
                          Navigator.of(dialogContext).pop();
                          ScaffoldMessenger.of(context).showSnackBar(
                            const SnackBar(content: Text('Obligation created successfully')),
                          );
                          onCreated?.call();
                        }
                      } catch (err) {
                        setState(() => isSubmitting = false);
                        if (context.mounted) {
                          ScaffoldMessenger.of(context).showSnackBar(
                            SnackBar(content: Text('Failed to create obligation: $err'), backgroundColor: MeshColors.statusHalted),
                          );
                        }
                      }
                    },
              style: ElevatedButton.styleFrom(
                backgroundColor: MeshColors.accent,
                foregroundColor: MeshColors.bgPrimary,
              ),
              child: isSubmitting
                  ? const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2))
                  : const Text('Create'),
            ),
          ],
        );
      },
    ),
  );
}

Future<void> showReparentObligationDialog(
  BuildContext context,
  DashboardStore store,
  ObligationDto obligation, {
  VoidCallback? onReparented,
}) async {
  final formKey = GlobalKey<FormState>();
  final parentIdCtrl = TextEditingController(text: obligation.parentId ?? '');
  bool makeRoot = obligation.parentId == null;
  bool isSubmitting = false;

  await showDialog<void>(
    context: context,
    builder: (dialogContext) => StatefulBuilder(
      builder: (context, setState) {
        return AlertDialog(
          backgroundColor: MeshColors.bgSecondary,
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(10),
            side: const BorderSide(color: MeshColors.border),
          ),
          title: const Text(
            'Reparent Obligation',
            style: TextStyle(color: MeshColors.textPrimary, fontSize: 16, fontWeight: FontWeight.bold),
          ),
          content: SizedBox(
            width: 420,
            child: Form(
              key: formKey,
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    'Target: ${obligation.heading}',
                    style: const TextStyle(color: MeshColors.textPrimary, fontWeight: FontWeight.w600, fontSize: 13),
                  ),
                  const SizedBox(height: 4),
                  Text(
                    'Current Parent: ${obligation.parentId ?? 'None (Root)'}',
                    style: const TextStyle(color: MeshColors.textMuted, fontSize: 12, fontFamily: kMonoFontFamily),
                  ),
                  const SizedBox(height: 16),
                  Row(
                    children: [
                      Expanded(
                        child: OutlinedButton(
                          onPressed: () => setState(() => makeRoot = true),
                          style: OutlinedButton.styleFrom(
                            backgroundColor: makeRoot ? MeshColors.bgSelected : MeshColors.bgPrimary,
                            foregroundColor: makeRoot ? MeshColors.accent : MeshColors.textSecondary,
                            side: BorderSide(
                              color: makeRoot ? MeshColors.accent : MeshColors.border,
                            ),
                          ),
                          child: const Text('Make Root', style: TextStyle(fontSize: 12)),
                        ),
                      ),
                      const SizedBox(width: 8),
                      Expanded(
                        child: OutlinedButton(
                          onPressed: () => setState(() => makeRoot = false),
                          style: OutlinedButton.styleFrom(
                            backgroundColor: !makeRoot ? MeshColors.bgSelected : MeshColors.bgPrimary,
                            foregroundColor: !makeRoot ? MeshColors.accent : MeshColors.textSecondary,
                            side: BorderSide(
                              color: !makeRoot ? MeshColors.accent : MeshColors.border,
                            ),
                          ),
                          child: const Text('Attach to Parent', style: TextStyle(fontSize: 12)),
                        ),
                      ),
                    ],
                  ),
                  if (!makeRoot) ...[
                    const SizedBox(height: 8),
                    TextFormField(
                      controller: parentIdCtrl,
                      style: const TextStyle(color: MeshColors.textPrimary, fontSize: 13, fontFamily: kMonoFontFamily),
                      decoration: const InputDecoration(
                        labelText: 'New Parent ID *',
                        labelStyle: TextStyle(color: MeshColors.textSecondary, fontSize: 12),
                        hintText: 'Enter parent obligation ID',
                        hintStyle: TextStyle(color: MeshColors.textMuted, fontSize: 12),
                        filled: true,
                        fillColor: MeshColors.bgPrimary,
                        border: OutlineInputBorder(borderSide: BorderSide(color: MeshColors.border)),
                        contentPadding: EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                      ),
                      validator: (val) {
                        if (!makeRoot && (val == null || val.trim().isEmpty)) {
                          return 'Parent ID is required';
                        }
                        if (val?.trim() == obligation.id) {
                          return 'Cannot set obligation as its own parent';
                        }
                        return null;
                      },
                    ),
                  ],
                ],
              ),
            ),
          ),
          actions: [
            TextButton(
              onPressed: isSubmitting ? null : () => Navigator.of(dialogContext).pop(),
              child: const Text('Cancel', style: TextStyle(color: MeshColors.textSecondary)),
            ),
            ElevatedButton(
              onPressed: isSubmitting
                  ? null
                  : () async {
                      if (!formKey.currentState!.validate()) return;
                      setState(() => isSubmitting = true);
                      try {
                        final targetParentId = makeRoot ? null : parentIdCtrl.text.trim();
                        await store.api.reparentObligation(obligation.id, parentId: targetParentId);

                        if (context.mounted) {
                          Navigator.of(dialogContext).pop();
                          ScaffoldMessenger.of(context).showSnackBar(
                            const SnackBar(content: Text('Obligation reparented successfully')),
                          );
                          onReparented?.call();
                        }
                      } catch (err) {
                        setState(() => isSubmitting = false);
                        if (context.mounted) {
                          ScaffoldMessenger.of(context).showSnackBar(
                            SnackBar(content: Text('Failed to reparent: $err'), backgroundColor: MeshColors.statusHalted),
                          );
                        }
                      }
                    },
              style: ElevatedButton.styleFrom(
                backgroundColor: MeshColors.accent,
                foregroundColor: MeshColors.bgPrimary,
              ),
              child: isSubmitting
                  ? const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2))
                  : const Text('Reparent'),
            ),
          ],
        );
      },
    ),
  );
}

Future<void> showReassignObligationDialog(
  BuildContext context,
  DashboardStore store,
  ObligationDto obligation, {
  VoidCallback? onReassigned,
}) async {
  final formKey = GlobalKey<FormState>();
  final ownerIdCtrl = TextEditingController(text: '');
  var isSubmitting = false;

  await showDialog<void>(
    context: context,
    builder: (dialogContext) => StatefulBuilder(
      builder: (context, setState) => AlertDialog(
        backgroundColor: MeshColors.bgSecondary,
        title: const Text(
          'Reassign Obligation',
          style: TextStyle(color: MeshColors.textPrimary, fontSize: 16, fontWeight: FontWeight.bold),
        ),
        content: SizedBox(
          width: 420,
          child: Form(
            key: formKey,
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  'Current owner: ${store.actor(obligation.ownerId)?.handle ?? obligation.ownerId}',
                  style: const TextStyle(color: MeshColors.textMuted, fontFamily: kMonoFontFamily),
                ),
                const SizedBox(height: 16),
                OwnerSelector(
                  store: store,
                  ownerIdCtrl: ownerIdCtrl,
                  decoration: const InputDecoration(
                    labelText: 'Owner ID or Handle *',
                    hintText: 'e.g. cloudy-porpoise, operator, or UUID',
                    filled: true,
                    fillColor: MeshColors.bgPrimary,
                    border: OutlineInputBorder(borderSide: BorderSide(color: MeshColors.border)),
                    contentPadding: EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                  ),
                ),
              ],
            ),
          ),
        ),
        actions: [
          TextButton(
            onPressed: isSubmitting ? null : () => Navigator.of(dialogContext).pop(),
            child: const Text('Cancel'),
          ),
          ElevatedButton(
            onPressed: isSubmitting
                ? null
                : () async {
                    if (!formKey.currentState!.validate()) return;
                    setState(() => isSubmitting = true);
                    try {
                      final typedText = ownerIdCtrl.text.trim();
                      String resolvedId;
                      if (typedText == 'operator' || typedText == 'human:operator' || typedText == 'human operator') {
                        resolvedId = 'human:operator';
                      } else {
                        final matches = store.actorStates.value.actors.values
                            .where((a) => a.handle == typedText || a.id == typedText)
                            .map((a) => a.id);
                        resolvedId = matches.isNotEmpty ? matches.first : typedText;
                      }

                      await store.api.reassignObligation(
                        obligation.id,
                        ownerId: resolvedId,
                      );
                      if (context.mounted) {
                        Navigator.of(dialogContext).pop();
                        ScaffoldMessenger.of(context).showSnackBar(
                          const SnackBar(content: Text('Obligation reassigned successfully')),
                        );
                        onReassigned?.call();
                      }
                    } catch (err) {
                      setState(() => isSubmitting = false);
                      if (context.mounted) {
                        ScaffoldMessenger.of(context).showSnackBar(
                          SnackBar(content: Text('Failed to reassign: $err')),
                        );
                      }
                    }
                  },
            child: isSubmitting
                ? const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2))
                : const Text('Reassign'),
          ),
        ],
      ),
    ),
  );
}

Future<void> confirmAndSetObligationStatus(
  BuildContext context,
  DashboardStore store,
  ObligationDto obligation,
  String status, {
  VoidCallback? onUpdated,
}) async {
  final label = status == 'done' ? 'Mark Done' : 'Cancel';
  // The note is the only record of *why* this transition happened. For a
  // cancellation it is the only trace the intent ever existed, and for a
  // human-owned decision child it is the answer itself, so it is offered on
  // every transition rather than only on cancel.
  //
  // Captured through onChanged rather than a TextEditingController: the dialog
  // keeps rebuilding the field through its exit animation, so a controller
  // disposed on the await's far side is used after disposal.
  var note = '';
  final confirmed = await showDialog<bool>(
    context: context,
    builder: (dialogContext) => AlertDialog(
      backgroundColor: MeshColors.bgSecondary,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(10),
        side: const BorderSide(color: MeshColors.border),
      ),
      title: Text(
        '$label Obligation?',
        style: const TextStyle(color: MeshColors.textPrimary, fontSize: 16, fontWeight: FontWeight.bold),
      ),
      // SizedBox inside a scroll view, matching the create/reparent dialogs:
      // AlertDialog wraps content in IntrinsicWidth, and a TextField has no
      // bounded intrinsic width, so an unwrapped one overflows the flex.
      content: SingleChildScrollView(
        child: SizedBox(
          width: 440,
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                'Are you sure you want to transition "${obligation.heading}" to status "$status"?',
                style: const TextStyle(color: MeshColors.textSecondary, fontSize: 13),
              ),
              const SizedBox(height: 14),
              Text(
                status == 'done' ? 'Why is this done? (optional)' : 'Why cancel? (optional)',
                style: const TextStyle(color: MeshColors.textSecondary, fontSize: 12),
              ),
              const SizedBox(height: 4),
              TextField(
                onChanged: (value) => note = value,
                maxLines: 3,
                style: const TextStyle(color: MeshColors.textPrimary, fontSize: 13),
                decoration: InputDecoration(
                  hintText: status == 'done'
                      ? 'What became true, or the answer if this was a question.'
                      : 'Why this intent is no longer current.',
                  hintStyle: const TextStyle(color: MeshColors.textMuted, fontSize: 12),
                ),
              ),
            ],
          ),
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(dialogContext).pop(false),
          child: const Text('Cancel', style: TextStyle(color: MeshColors.textSecondary)),
        ),
        ElevatedButton(
          onPressed: () => Navigator.of(dialogContext).pop(true),
          style: ElevatedButton.styleFrom(
            backgroundColor: status == 'done' ? MeshColors.statusActive : MeshColors.statusHalted,
            foregroundColor: MeshColors.textPrimary,
          ),
          child: Text(label),
        ),
      ],
    ),
  );

  if (confirmed != true || !context.mounted) return;

  try {
    // Blank stays null all the way down: "no reason given" has one
    // representation, and it is not the empty string.
    final trimmed = note.trim();
    await store.api.setObligationStatus(
      obligation.id,
      status,
      note: trimmed.isEmpty ? null : trimmed,
    );
    if (context.mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('Obligation transitioned to $status')),
      );
      onUpdated?.call();
    }
  } catch (err) {
    if (context.mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('Failed to update status: $err'), backgroundColor: MeshColors.statusHalted),
      );
    }
  }
}

class OwnerOption {
  final String kind;
  final String id;
  final String handle;

  OwnerOption({required this.kind, required this.id, required this.handle});
  String get display => handle;
}
