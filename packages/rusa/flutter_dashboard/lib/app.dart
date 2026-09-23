import 'dart:async';

import 'package:flutter/material.dart';

import 'dashboard_title.dart';
import 'session.dart';
import 'theme.dart';

typedef DashboardPageBuilder =
    Widget Function(BuildContext context, DashboardSession session);

class RusaDashboardApp extends StatefulWidget {
  const RusaDashboardApp({
    super.key,
    this.title = defaultDashboardTitle,
    this.bootstrapSession,
    this.session,
    this.initialRoute,
    this.pageBuilder,
    this.browserHooksBuilder,
  });

  /// Browser tab title; the served `index.html`'s, branded with this instance's
  /// configured root actor name when one is set.
  final String title;

  /// Optional session bootstrap delegate for runtime environments.
  final Future<DashboardSession> Function()? bootstrapSession;

  /// Optional injected session future, used in tests.
  final Future<DashboardSession>? session;

  /// Optional initial route, used in tests to simulate incoming deep links.
  final String? initialRoute;

  /// Builds the authenticated dashboard page once session is active.
  final DashboardPageBuilder? pageBuilder;

  /// Injects browser lifecycle hooks scoped to the active session.
  final Object Function(DashboardSession session)? browserHooksBuilder;

  @override
  State<RusaDashboardApp> createState() => _RusaDashboardAppState();
}

class _RusaDashboardAppState extends State<RusaDashboardApp> {
  DashboardSession? _resolvedSession;
  String? _authenticatedTitle;
  late final Future<DashboardSession> _session =
      widget.session ??
      (widget.bootstrapSession?.call() ??
          Future.value(LocalDashboardSession()));

  @override
  void initState() {
    super.initState();
    _session.then((session) {
      if (!mounted) return;
      _resolvedSession = session;
      session.addListener(_onSessionChanged);
      _onSessionChanged();
    });
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

  Widget _buildHost() => FutureBuilder<DashboardSession>(
    future: _session,
    builder: (context, snapshot) {
      if (snapshot.connectionState != ConnectionState.done) {
        return const _DarkFrame();
      }
      final session = snapshot.data;
      if (snapshot.hasError || session == null) {
        return const _AuthStartupError();
      }
      return _DashboardSessionHost(
        session: session,
        pageBuilder: widget.pageBuilder,
        browserHooksBuilder: widget.browserHooksBuilder,
      );
    },
  );

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      // Flutter's Title widget owns document.title on rebuild. Once the
      // authenticated manifest has supplied the instance title, feed it back
      // into MaterialApp so route and window rebuilds retain it.
      title: _authenticatedTitle ?? widget.title,
      debugShowCheckedModeBanner: false,
      theme: buildMeshTheme(),
      // With path URL strategy, Navigator's default initial-route expansion
      // asks for each path prefix (/work, /work/<id>); an onGenerateRoute alone
      // would build multiple DashboardPage instances with duplicate stores.
      // Providing onGenerateInitialRoutes generates exactly one page matching
      // the requested deep link without falling back to "/" or replacing the
      // browser URL during asynchronous session bootstrap or sign-in.
      initialRoute: widget.initialRoute,
      onGenerateInitialRoutes: (initialRoute) => [
        MaterialPageRoute<void>(
          settings: RouteSettings(
            name: initialRoute.isEmpty ? '/' : initialRoute,
          ),
          builder: (context) => _buildHost(),
        ),
      ],
      onGenerateRoute: (settings) => MaterialPageRoute<void>(
        settings: settings,
        builder: (context) => _buildHost(),
      ),
    );
  }
}

class _DashboardSessionHost extends StatefulWidget {
  const _DashboardSessionHost({
    required this.session,
    this.pageBuilder,
    this.browserHooksBuilder,
  });

  final DashboardSession session;
  final DashboardPageBuilder? pageBuilder;
  final Object Function(DashboardSession session)? browserHooksBuilder;

  @override
  State<_DashboardSessionHost> createState() => _DashboardSessionHostState();
}

class _DashboardSessionHostState extends State<_DashboardSessionHost> {
  Object? _browserHooks;

  @override
  void initState() {
    super.initState();
    _browserHooks = widget.browserHooksBuilder?.call(widget.session);
  }

  @override
  void dispose() {
    final hooks = _browserHooks;
    if (hooks != null) {
      try {
        (hooks as dynamic).dispose();
      } catch (_) {}
    }
    widget.session.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => AnimatedBuilder(
    animation: widget.session,
    builder: (context, _) {
      return switch (widget.session.status) {
        DashboardSessionStatus.local || DashboardSessionStatus.signedIn =>
          widget.pageBuilder != null
              ? widget.pageBuilder!(context, widget.session)
              : const SizedBox.shrink(),
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
