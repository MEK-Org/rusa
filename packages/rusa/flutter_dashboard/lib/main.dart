import 'dart:async';

import 'package:flutter/material.dart';

import 'api.dart';
import 'app.dart';
import 'assistant_page.dart';
import 'assistant_platform.dart';
import 'breakpoints.dart';
import 'dashboard_title.dart';
import 'io_session.dart';
import 'iu/iu_reports_view.dart';
import 'iu/iu_tree_view.dart';
import 'platform_bootstrap.dart';
import 'reply_notifications.dart';
import 'store.dart';
import 'session.dart';
import 'theme.dart';
import 'widgets/dashboard_body.dart';

/// The live actor-mesh viewer dashboard. Reads the PR2 Data API +
/// SSE stream and renders the locked V1.4.0 design: an alive-actor tree on the
/// left and the selected actor's Events / Live Output on the right.
void main() {
  WidgetsFlutterBinding.ensureInitialized();
  platformInit();
  // Read the served shell's title before the first frame — see
  // `dashboard_title.dart` for why MaterialApp would otherwise overwrite it.
  runApp(
    RusaDashboardApp(
      title: resolveDashboardTitle(platformDocumentTitle),
      bootstrapSession: platformBootstrapSession,
      browserHooksBuilder: platformBrowserHooksBuilder,
      pageBuilder: (context, session) => DashboardPage(session: session),
    ),
  );
}

/// The Android assist activity's entrypoint (`AssistActivity.kt`): the same
/// sign-in shell, with the walkie-to-root screen as its page.
@pragma('vm:entry-point')
void assistMain() {
  WidgetsFlutterBinding.ensureInitialized();
  platformInit();
  final assistant = platformCreateAssistant();
  final launch = parseAssistantLaunch(
    WidgetsBinding.instance.platformDispatcher.defaultRouteName,
  );
  runApp(
    RusaDashboardApp(
      title: resolveDashboardTitle(platformDocumentTitle),
      bootstrapSession: platformBootstrapSession,
      browserHooksBuilder: platformBrowserHooksBuilder,
      pageBuilder: (context, session) => AssistantPage(
        createApi: () => platformCreateDashboardApi(session),
        createWalkieDeps: (api) =>
            platformCreateWalkieDeps(api, session, headset: assistant),
        signals: assistant,
        initialReply: launch.reply,
        notificationOpening: launch.waitingForUnlock,
        restoringFromRecents: launch.restoringFromRecents,
      ),
    ),
  );
}

class AssistantLaunch {
  const AssistantLaunch({
    this.reply,
    this.waitingForUnlock = false,
    this.restoringFromRecents = false,
  });

  final AssistantReplyTarget? reply;
  final bool waitingForUnlock;
  final bool restoringFromRecents;
}

/// Parses only the content-free routes native code is allowed to pass to Dart.
AssistantLaunch parseAssistantLaunch(String route) {
  final uri = Uri.tryParse(route);
  if (uri == null) return const AssistantLaunch();
  if (uri.path == 'reply-pending' || uri.path == '/reply-pending') {
    return const AssistantLaunch(waitingForUnlock: true);
  }
  if (uri.path == 'recents' || uri.path == '/recents') {
    return const AssistantLaunch(restoringFromRecents: true);
  }
  if (uri.path != 'reply' && uri.path != '/reply') {
    return const AssistantLaunch();
  }
  final actorId = uri.queryParameters['actorId'];
  final announcementId = uri.queryParameters['announcementId'];
  if (actorId == null ||
      actorId.isEmpty ||
      announcementId == null ||
      announcementId.isEmpty) {
    return const AssistantLaunch();
  }
  return AssistantLaunch(
    reply: AssistantReplyTarget(
      actorId: actorId,
      announcementId: announcementId,
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
  ReplyNotifications? _replyNotifications;
  late Future<void> _ready;

  @override
  void initState() {
    super.initState();
    _api = platformCreateDashboardApi(widget.session);
    _replyNotifications = platformCreateReplyNotifications();
    widget.session.addBeforeLogoutListener(_revokePushToken);
    if (widget.session.authenticationEnabled) {
      // Ask while the ordinary unlocked dashboard is visible. An FCM
      // permission prompt must never interrupt an immediate assist capture or
      // be presented over the keyguard.
      unawaited(_registerPushToken());
    }
    _store = DashboardStore(
      api: _api,
      stream: platformCreateMeshStream(widget.session, _api.base),
      quotaCache: platformCreateQuotaCache(),
      treePreferencesCache: platformCreateTreePreferencesCache(),
      actorHierarchyCache: platformCreateActorHierarchyCache(),
      obligationsCache: platformCreateObligationsCache(),
      operatorDisplayName: widget.session.operatorDisplayName,
      walkie: platformCreateWalkieDeps(_api, widget.session),
      avatarFilePicker: platformCreateAvatarFilePicker(),
    );
    // Opens the SSE stream before the initial /threads fetch (seam-safe).
    _ready = _store.init();
  }

  @override
  void dispose() {
    widget.session.removeBeforeLogoutListener(_revokePushToken);
    _replyNotifications?.dispose();
    _store.dispose();
    super.dispose();
  }

  Future<void> _revokePushToken() async {
    try {
      await _replyNotifications?.revoke(_api);
    } catch (_) {
      // Logout still clears the authenticated dashboard session. The server's
      // generic notification contains no reply body and cleans invalid tokens.
    }
  }

  Future<void> _registerPushToken() async {
    try {
      await _replyNotifications?.register(_api);
    } catch (_) {
      // Registration is additive: dashboard use and normal session refresh
      // remain available when Firebase Messaging is unavailable.
      debugPrint('dashboard: Android reply-notification registration failed');
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: MeshColors.bgPrimary,
      body: Column(
        children: [
          // The header nav (inside DashboardBody) switches between the Actors
          // dashboard and the IU route; within IU, its own switch picks the
          // node or the report sub-view. Both IU bodies are injected
          // here so DashboardBody stays free of the
          // web-only glass-goals imports and renders headlessly in the
          // screenshot harness.
          Expanded(
            child: FutureBuilder<void>(
              future: _ready,
              builder: (context, snapshot) {
                if (snapshot.connectionState != ConnectionState.done) {
                  return const Center(child: CircularProgressIndicator());
                }
                if (snapshot.hasError) {
                  return Center(
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Text(
                          '${snapshot.error}',
                          style: const TextStyle(
                            color: MeshColors.textSecondary,
                          ),
                        ),
                        TextButton(
                          onPressed: () => setState(() {
                            _ready = _store.init();
                          }),
                          child: const Text('Retry'),
                        ),
                      ],
                    ),
                  );
                }
                return DashboardBody(
                  onLogout: widget.session.authenticationEnabled
                      ? () => unawaited(widget.session.signOut())
                      : null,
                  onNavigation: widget.session.visit,
                  profilePhotoUrl: widget.session.profilePhotoUrl,
                  assistantRole: platformCreateAssistant(),
                  store: _store,
                  understandingBuilder: (_) {
                    final session = widget.session;
                    return IuTreeBody(
                      session: session,
                      baseUrl: _api.base,
                      client: switch (session) {
                        final IoSessionTransport transport => transport.client,
                        _ => null,
                      },
                    );
                  },
                  reportsBuilder: (_) => IuReportsBody(store: _store),
                );
              },
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
