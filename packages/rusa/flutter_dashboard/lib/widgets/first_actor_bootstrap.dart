import 'dart:async';

import 'package:flutter/widgets.dart';

import '../store.dart';
import 'actor_tree.dart';

/// Dialog title for the empty-mesh bootstrap; distinct from the spawn
/// control's "Spawn actor" so a captured screen names what is happening.
const String kFirstActorDialogTitle = 'Create your first actor';

/// What the first actor is, in operator terms: the ordinary spawn path,
/// parentless because there is no parent to attach to. On an empty mesh the
/// first actor is also the oldest active parentless actor, which is the
/// criterion for the default actor — so it receives the default capability
/// grants and serves as the fallback recipient for unrouted root events and
/// dashboard spawns (#465 separates topology from authorization; here the
/// default-actor role, not the parentlessness, carries the capabilities).
/// Isolation is the operator's choice in the dialog, defaulting unsandboxed.
const String kFirstActorDialogIntro =
    "This mesh doesn't have any actors yet. The first one starts as a "
    'top-level actor through the same spawn path as any other. As the '
    'oldest active parentless actor it becomes the default actor: it '
    'receives the default capability grants and serves as the fallback '
    'recipient for unrouted root events and dashboard spawns. It runs '
    'unsandboxed unless you choose sandboxed below.';

/// Empty-mesh first-actor bootstrap (#1260).
///
/// Once the first authoritative actor snapshot has landed and the mesh has no
/// actors at all, offer the shared spawn dialog automatically. A non-empty
/// mesh — including one whose only actors are retired — never sees it, and
/// cancel dismisses for the session.
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
    // actorsLoaded is a seeded BehaviorSubject, so this replays its current
    // value synchronously; the first evaluation is deferred to the first
    // post-frame callback because a dialog cannot be shown during build.
    _subs.add(widget.store.actorsLoaded.listen((_) => _maybeOffer()));
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _framePainted = true;
      _maybeOffer();
    });
  }

  Future<void> _maybeOffer() async {
    if (!_framePainted || _dismissed || _offering) return;
    if (!widget.store.actorsLoaded.value) return;
    if (widget.store.actorStates.value.actors.isNotEmpty) return;
    if (!mounted) return;
    _offering = true;
    try {
      await showSpawnActorDialog(
        context,
        widget.store,
        dialogTitle: kFirstActorDialogTitle,
        intro: kFirstActorDialogIntro,
        submitLabel: 'Create',
        offerUnsandboxedChoice: true,
      );
      // Once the bootstrap dialog has closed — whether created, cancelled,
      // barrier-tapped, or failed — dismiss it unconditionally for the
      // session so it is never re-offered. The tree's spawn control remains
      // available.
      if (mounted) setState(() => _dismissed = true);
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
