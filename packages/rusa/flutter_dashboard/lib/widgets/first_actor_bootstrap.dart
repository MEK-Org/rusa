import 'dart:async';

import 'package:flutter/widgets.dart';

import '../models.dart';
import '../store.dart';
import 'actor_tree.dart';

/// Dialog title for the empty-mesh bootstrap; distinct from the spawn
/// control's "Spawn actor" so a captured screen names what is happening.
const String kFirstActorDialogTitle = 'Create your first actor';

/// What the first actor is, in operator terms: the ordinary spawn path,
/// parentless because there is no parent to attach to — not a privileged
/// position (#465: top-level, unsandboxed and authorized are separate facts).
const String kFirstActorDialogIntro =
    "This mesh doesn't have any actors yet. The first one starts as a "
    'top-level actor through the same spawn path as any other; nothing about '
    'being first or top-level grants it extra authority.';

/// Empty-mesh first-actor bootstrap (#1260).
///
/// Once the first authoritative actor snapshot has landed and the mesh has no
/// actors at all, offer the shared spawn dialog automatically. A non-empty
/// mesh — including one whose only actors are retired — never sees it, and a
/// mesh that empties after actors existed offers it again.
///
/// Lives below [DashboardBody]'s views so every destination (Overview, Actors,
/// …) gets the same behaviour, and only in the authenticated tree: the
/// sign-in page renders without it.
class FirstActorBootstrap extends StatefulWidget {
  const FirstActorBootstrap({
    super.key,
    required this.store,
    required this.child,
  });

  final DashboardStore store;
  final Widget child;

  @override
  State<FirstActorBootstrap> createState() => _FirstActorBootstrapState();
}

class _FirstActorBootstrapState extends State<FirstActorBootstrap> {
  final List<StreamSubscription<dynamic>> _subs = <StreamSubscription<dynamic>>[];
  bool _framePainted = false;
  bool _dismissed = false;
  bool _offering = false;

  @override
  void initState() {
    super.initState();
    // Both streams are seeded BehaviorSubjects, so these replay their current
    // values synchronously; the first evaluation is deferred to the first
    // post-frame callback because a dialog cannot be shown during build.
    _subs
      ..add(widget.store.actorsLoaded.listen((_) => _maybeOffer()))
      ..add(widget.store.actorStates.listen(_onActors));
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _framePainted = true;
      _maybeOffer();
    });
  }

  void _onActors(ActorStateSnapshot snapshot) {
    // Any actor at all re-arms the gate: retiring the last actor later brings
    // the modal back.
    if (snapshot.actors.isNotEmpty && _dismissed) {
      setState(() => _dismissed = false);
    }
    _maybeOffer();
  }

  Future<void> _maybeOffer() async {
    if (!_framePainted || _dismissed || _offering) return;
    if (!widget.store.actorsLoaded.value) return;
    if (widget.store.actorStates.value.actors.isNotEmpty) return;
    if (!mounted) return;
    _offering = true;
    try {
      final created = await showSpawnActorDialog(
        context,
        widget.store,
        dialogTitle: kFirstActorDialogTitle,
        intro: kFirstActorDialogIntro,
        submitLabel: 'Create',
      );
      // A dismissal — cancel, barrier tap, or a failed spawn already reported
      // as a snackbar — does not nag again while the mesh stays empty. The
      // tree's spawn control remains available, and the gate re-arms once any
      // actor exists.
      if (!created && mounted) setState(() => _dismissed = true);
    } finally {
      _offering = false;
    }
  }

  @override
  void dispose() {
    for (final sub in _subs) {
      sub.cancel();
    }
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => widget.child;
}
