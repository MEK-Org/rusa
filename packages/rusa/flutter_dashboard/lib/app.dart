import 'dart:async';

import 'package:flutter/material.dart';

import 'dashboard_title.dart';
import 'session.dart';
import 'theme.dart';

typedef DashboardPageBuilder =
    Widget Function(BuildContext context, DashboardSession session);

typedef DashboardSessionHooksDisposer = void Function();

class RusaDashboardApp extends StatefulWidget {
  const RusaDashboardApp({
    super.key,
    this.title = defaultDashboardTitle,
    required this.bootstrapSession,
    required this.pageBuilder,
    this.browserHooksBuilder,
  });

  /// Browser tab title; the served `index.html`'s, branded with this instance's
  /// configured root actor name when one is set.
  final String title;

  /// Required session bootstrap delegate for runtime environments and tests.
  final Future<DashboardSession> Function() bootstrapSession;

  /// Required builder for the authenticated dashboard page once session is active.
  final DashboardPageBuilder pageBuilder;

  /// Injects browser lifecycle hooks scoped to the active session.
  final DashboardSessionHooksDisposer Function(DashboardSession session)?
  browserHooksBuilder;

  @override
  State<RusaDashboardApp> createState() => _RusaDashboardAppState();
}

class _RusaDashboardAppState extends State<RusaDashboardApp> {
  DashboardSession? _resolvedSession;
  String? _authenticatedTitle;
  late final Future<DashboardSession> _session = _bootstrapSession();

  Future<DashboardSession> _bootstrapSession() async {
    final session = await widget.bootstrapSession();
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
    _resolvedSession?.dispose();
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
      // Keep one DashboardPage for every initial path. With path URL strategy,
      // Navigator's default initial-route expansion asks for each path prefix;
      // providing onGenerateInitialRoutes generates exactly one page matching
      // the requested deep link without falling back to "/" or replacing the
      // browser URL during asynchronous session bootstrap or sign-in.
      // onGenerateRoute returns null to satisfy WidgetsApp assertion while
      // ensuring no duplicate session host or stores are built on named pushes.
      onGenerateInitialRoutes: (initialRoute) => [
        MaterialPageRoute<void>(
          settings: RouteSettings(
            name: initialRoute.isEmpty ? '/' : initialRoute,
          ),
          builder: (context) => _buildHost(),
        ),
      ],
      onGenerateRoute: (settings) => null,
    );
  }
}

class _DashboardSessionHost extends StatefulWidget {
  const _DashboardSessionHost({
    required this.session,
    required this.pageBuilder,
    this.browserHooksBuilder,
  });

  final DashboardSession session;
  final DashboardPageBuilder pageBuilder;
  final DashboardSessionHooksDisposer Function(DashboardSession session)?
  browserHooksBuilder;

  @override
  State<_DashboardSessionHost> createState() => _DashboardSessionHostState();
}

class _DashboardSessionHostState extends State<_DashboardSessionHost> {
  DashboardSessionHooksDisposer? _disposeHooks;

  @override
  void initState() {
    super.initState();
    _disposeHooks = widget.browserHooksBuilder?.call(widget.session);
  }

  @override
  void dispose() {
    _disposeHooks?.call();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => AnimatedBuilder(
    animation: widget.session,
    builder: (context, _) {
      return switch (widget.session.status) {
        DashboardSessionStatus.local || DashboardSessionStatus.signedIn =>
          widget.pageBuilder(context, widget.session),
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
    } on DashboardAccountSetupError {
      if (mounted) {
        setState(() => _error = DashboardAccountSetupError.message);
      }
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
