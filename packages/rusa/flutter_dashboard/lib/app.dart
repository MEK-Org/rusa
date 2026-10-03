import 'dart:async';

import 'package:flutter/material.dart';

import 'dashboard_title.dart';
import 'route_scope.dart';
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

class _DashboardRouteInformationParser
    extends RouteInformationParser<RouteInformation> {
  const _DashboardRouteInformationParser();

  @override
  Future<RouteInformation> parseRouteInformation(
    RouteInformation routeInformation,
  ) async {
    return routeInformation;
  }

  @override
  RouteInformation restoreRouteInformation(RouteInformation configuration) {
    return configuration;
  }
}

class _DashboardRouterDelegate extends RouterDelegate<RouteInformation>
    with ChangeNotifier, PopNavigatorRouterDelegateMixin<RouteInformation> {
  _DashboardRouterDelegate({
    required this.builder,
    required this.routeNotifier,
    required RouteInformation initialRoute,
  }) : _currentRoute = initialRoute;

  final WidgetBuilder builder;
  final ValueNotifier<RouteInformation?> routeNotifier;

  @override
  final GlobalKey<NavigatorState> navigatorKey = GlobalKey<NavigatorState>();

  RouteInformation _currentRoute;

  @override
  RouteInformation get currentConfiguration => _currentRoute;

  @override
  Future<void> setNewRoutePath(RouteInformation configuration) async {
    _currentRoute = configuration;
    routeNotifier.value = configuration;
  }

  @override
  Widget build(BuildContext context) {
    return Navigator(
      key: navigatorKey,
      pages: [
        MaterialPage<void>(
          key: const ValueKey('dashboard-root'),
          child: builder(context),
        ),
      ],
      onDidRemovePage: (page) {},
    );
  }
}

class _RusaDashboardAppState extends State<RusaDashboardApp> {
  DashboardSession? _resolvedSession;
  String? _authenticatedTitle;
  late final Future<DashboardSession> _session = _bootstrapSession();
  final ValueNotifier<RouteInformation?> _routeNotifier =
      ValueNotifier<RouteInformation?>(null);
  late final RouterConfig<RouteInformation> _routerConfig;

  @override
  void initState() {
    super.initState();
    final initialUri = _resolveInitialUri();
    final initialRoute = RouteInformation(uri: initialUri);
    _routerConfig = RouterConfig<RouteInformation>(
      routeInformationProvider: PlatformRouteInformationProvider(
        initialRouteInformation: initialRoute,
      ),
      routeInformationParser: const _DashboardRouteInformationParser(),
      routerDelegate: _DashboardRouterDelegate(
        builder: (context) => _buildHost(),
        routeNotifier: _routeNotifier,
        initialRoute: initialRoute,
      ),
    );
  }

  static Uri _resolveInitialUri() {
    final defaultRoute =
        WidgetsBinding.instance.platformDispatcher.defaultRouteName;
    return Uri.parse(defaultRoute.isEmpty ? '/' : defaultRoute);
  }

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
    _routeNotifier.dispose();
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
      return DashboardRouteScope(
        routeNotifier: _routeNotifier,
        child: _DashboardSessionHost(
          session: session,
          pageBuilder: widget.pageBuilder,
          browserHooksBuilder: widget.browserHooksBuilder,
        ),
      );
    },
  );

  @override
  Widget build(BuildContext context) {
    return MaterialApp.router(
      title: _authenticatedTitle ?? widget.title,
      debugShowCheckedModeBanner: false,
      theme: buildMeshTheme(),
      routerConfig: _routerConfig,
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
