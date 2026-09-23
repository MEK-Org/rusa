import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_web_plugins/url_strategy.dart';
import 'package:web/web.dart' as web;

import 'api.dart';
import 'breakpoints.dart';
import 'avatar_upload_web.dart';
import 'dashboard_title.dart';
import 'iu/iu_reports_view.dart';
import 'iu/iu_tree_view.dart';
import 'sse.dart';
import 'store.dart';
import 'session.dart';
import 'session_events_web.dart';
import 'session_web.dart';
import 'theme.dart';
import 'voice_web.dart';
import 'web_actor_hierarchy_cache.dart';
import 'web_obligations_cache.dart';
import 'web_quota_cache.dart';
import 'web_tree_preferences_cache.dart';
import 'widgets/dashboard_body.dart';

/// The live actor-mesh viewer dashboard (an issue). Reads the PR2 Data API +
/// SSE stream and renders the locked V1.4.0 design: an alive-actor tree on the
/// left and the selected actor's Events / Live Output on the right.
void main() {
  WidgetsFlutterBinding.ensureInitialized();
  usePathUrlStrategy();
  // Read the served shell's title before the first frame — see
  // `dashboard_title.dart` for why MaterialApp would otherwise overwrite it.
  runApp(RusaDashboardApp(title: resolveDashboardTitle(web.document.title)));
}

class RusaDashboardApp extends StatefulWidget {
  const RusaDashboardApp({super.key, this.title = defaultDashboardTitle});

  /// Browser tab title; the served `index.html`'s, branded with this instance's
  /// configured root actor name when one is set.
  final String title;

  @override
  State<RusaDashboardApp> createState() => _RusaDashboardAppState();
}

class _RusaDashboardAppState extends State<RusaDashboardApp> {
  DashboardSession? _resolvedSession;
  String? _authenticatedTitle;
  late final Future<DashboardSession> _session = _bootstrapSession();

  Future<DashboardSession> _bootstrapSession() async {
    final session = await bootstrapDashboardSession();
    _resolvedSession = session;
    session.addListener(_onSessionChanged);
    _onSessionChanged();
    return session;
  }

  void _onSessionChanged() {
    final title = _resolvedSession?.browserTitle;
    if (title == null || title == _authenticatedTitle) return;
    if (!mounted) {
      _authenticatedTitle = title;
      return;
    }
    setState(() => _authenticatedTitle = title);
  }

  @override
  void dispose() {
    _resolvedSession?.removeListener(_onSessionChanged);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      // Flutter's Title widget owns document.title on rebuild. Once the
      // authenticated manifest has supplied the instance title, feed it back
      // into MaterialApp so route and window rebuilds retain it.
      title: _authenticatedTitle ?? widget.title,
      debugShowCheckedModeBanner: false,
      theme: buildMeshTheme(),
      // Keep one DashboardPage for every initial path. With path URL strategy,
      // Navigator's default initial-route expansion asks for each path prefix;
      // an onGenerateRoute that built DashboardPage for them would leave
      // duplicate stores and SSE connections mounted. The home fallback is
      // intentional, including its debug-only initial-route diagnostic; direct
      // deep links still select their view in DashboardBody.
      home: FutureBuilder<DashboardSession>(
        future: _session,
        builder: (context, snapshot) {
          if (snapshot.connectionState != ConnectionState.done) {
            return const _DarkFrame();
          }
          final session = snapshot.data;
          if (snapshot.hasError || session == null) {
            return const _AuthStartupError();
          }
          return _DashboardSessionHost(session: session);
        },
      ),
    );
  }
}

/// Keeps browser visit hooks scoped to the session that owns them.
class _DashboardSessionHost extends StatefulWidget {
  const _DashboardSessionHost({required this.session});

  final DashboardSession session;

  @override
  State<_DashboardSessionHost> createState() => _DashboardSessionHostState();
}

class _DashboardSessionHostState extends State<_DashboardSessionHost> {
  late final DashboardSessionBrowserHooks _browserHooks;

  @override
  void initState() {
    super.initState();
    _browserHooks = DashboardSessionBrowserHooks(widget.session);
  }

  @override
  void dispose() {
    _browserHooks.dispose();
    widget.session.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => AnimatedBuilder(
    animation: widget.session,
    builder: (context, _) {
      return switch (widget.session.status) {
        DashboardSessionStatus.local || DashboardSessionStatus.signedIn =>
          DashboardPage(session: widget.session),
        DashboardSessionStatus.signedOut => SignInPage(session: widget.session),
      };
    },
  );
}

class _DarkFrame extends StatelessWidget {
  const _DarkFrame();

  @override
  Widget build(BuildContext context) => const Scaffold(
    backgroundColor: MeshColors.bgPrimary,
    body: SizedBox.expand(),
  );
}

class _AuthStartupError extends StatelessWidget {
  const _AuthStartupError();

  @override
  Widget build(BuildContext context) => Scaffold(
    backgroundColor: MeshColors.bgPrimary,
    body: Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Text(
          'Unable to connect to Rusa. Please reload and try again.',
          textAlign: TextAlign.center,
          style: Theme.of(context).textTheme.bodyLarge,
        ),
      ),
    ),
  );
}

class SignInPage extends StatefulWidget {
  const SignInPage({super.key, required this.session});

  final DashboardSession session;

  @override
  State<SignInPage> createState() => _SignInPageState();
}

class _SignInPageState extends State<SignInPage> {
  bool _signingIn = false;
  String? _error;

  Future<void> _signIn() async {
    setState(() {
      _signingIn = true;
      _error = null;
    });
    try {
      await widget.session.signIn();
    } catch (_) {
      if (mounted) {
        setState(
          () => _error =
              'Unable to sign in. Check your connection and try again.',
        );
      }
    } finally {
      if (mounted) setState(() => _signingIn = false);
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    backgroundColor: MeshColors.bgPrimary,
    body: Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text('Rusa', style: Theme.of(context).textTheme.headlineMedium),
            const SizedBox(height: 16),
            Text(
              'Sign in to your agent dashboard.',
              style: Theme.of(context).textTheme.bodyLarge,
            ),
            if (_error != null) ...[
              const SizedBox(height: 12),
              Text(
                _error!,
                textAlign: TextAlign.center,
                style: const TextStyle(color: MeshColors.statusHalted),
              ),
            ],
            const SizedBox(height: 20),
            FilledButton(
              onPressed: _signingIn ? null : _signIn,
              child: Text(_signingIn ? 'Signing in…' : 'Sign in with Google'),
            ),
          ],
        ),
      ),
    ),
  );
}

class DashboardPage extends StatefulWidget {
  const DashboardPage({super.key, required this.session});

  final DashboardSession session;

  @override
  State<DashboardPage> createState() => _DashboardPageState();
}

class _DashboardPageState extends State<DashboardPage> {
  late final DashboardApi _api;
  late final DashboardStore _store;

  @override
  void initState() {
    super.initState();
    _api = DashboardApi(session: widget.session);
    _store = DashboardStore(
      api: _api,
      stream: WebEventSourceStream(widget.session),
      quotaCache: WebQuotaCache(),
      treePreferencesCache: WebTreePreferencesCache(),
      actorHierarchyCache: WebActorHierarchyCache(),
      obligationsCache: WebObligationsCache(),
      operatorDisplayName: widget.session.operatorDisplayName,
      walkie: webWalkieDeps(_api, widget.session),
      avatarFilePicker: WebAvatarFilePicker(),
    );
    widget.session.addListener(_syncProfilePresentation);
    // Opens the SSE stream before the initial /threads fetch (seam-safe).
    _store.init();
  }

  void _syncProfilePresentation() {
    _store.setOperatorDisplayName(widget.session.operatorDisplayName);
    if (mounted) setState(() {});
  }

  @override
  void dispose() {
    widget.session.removeListener(_syncProfilePresentation);
    _store.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: MeshColors.bgPrimary,
      body: Column(
        children: [
          // The header nav (inside DashboardBody) switches between the Actors
          // dashboard and the IU route; within IU, its own switch picks the
          // node or the report sub-view . Both IU bodies are injected
          // here — the web entrypoint — so DashboardBody stays free of the
          // web-only glass-goals imports and renders headlessly in the
          // screenshot harness.
          Expanded(
            child: DashboardBody(
              onLogout: widget.session.authenticationEnabled
                  ? () => unawaited(widget.session.signOut())
                  : null,
              onNavigation: widget.session.visit,
              profilePhotoUrl: widget.session.profilePhotoUrl,
              store: _store,
              understandingBuilder: (_) => IuTreeBody(session: widget.session),
              reportsBuilder: (_) => IuReportsBody(store: _store),
            ),
          ),
          AnimatedBuilder(
            animation: widget.session,
            builder: (_, _) =>
                _ErrorBar(store: _store, session: widget.session),
          ),
        ],
      ),
    );
  }
}

/// A thin footer that surfaces the latest API/stream error, if any.
class _ErrorBar extends StatelessWidget {
  const _ErrorBar({required this.store, required this.session});
  final DashboardStore store;
  final DashboardSession session;

  @override
  Widget build(BuildContext context) {
    final width = MediaQuery.of(context).size.width;
    if (width < kNarrowBreakpoint) {
      return const SizedBox.shrink();
    }
    return StreamBuilder<String?>(
      stream: store.error,
      builder: (_, snap) {
        final err = session.errorMessage ?? snap.data;
        if (err == null) return const SizedBox.shrink();
        return Container(
          width: double.infinity,
          color: const Color(0x33EF4444),
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 6),
          child: Text(
            err,
            style: const TextStyle(color: Color(0xFFEF4444), fontSize: 12),
          ),
        );
      },
    );
  }
}
