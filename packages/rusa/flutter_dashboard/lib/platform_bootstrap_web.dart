import 'package:flutter_web_plugins/url_strategy.dart';
import 'package:web/web.dart' as web;

import 'actor_hierarchy_cache.dart';
import 'api.dart';
import 'app.dart';
import 'avatar_platform.dart';
import 'avatar_upload_web.dart';
import 'mesh_stream.dart';
import 'obligations_cache.dart';
import 'quota_cache.dart';
import 'session.dart';
import 'session_events_web.dart';
import 'session_web.dart';
import 'sse.dart';
import 'tree_preferences_cache.dart';
import 'voice_platform.dart';
import 'voice_web.dart';
import 'web_actor_hierarchy_cache.dart';
import 'web_obligations_cache.dart';
import 'web_quota_cache.dart';
import 'web_tree_preferences_cache.dart';

void platformInit() {
  usePathUrlStrategy();
}

String? get platformDocumentTitle => web.document.title;

Future<DashboardSession> platformBootstrapSession() =>
    bootstrapDashboardSession();

DashboardSessionHooksDisposer Function(DashboardSession session)?
    get platformBrowserHooksBuilder =>
        (session) => DashboardSessionBrowserHooks(session).dispose;

DashboardApi platformCreateDashboardApi(DashboardSession session) =>
    DashboardApi(base: Uri.base, session: session);

MeshStreamSource platformCreateMeshStream(
  DashboardSession session,
  Uri base,
) =>
    WebEventSourceStream(session);

QuotaCache platformCreateQuotaCache() => WebQuotaCache();

TreePreferencesCache platformCreateTreePreferencesCache() =>
    WebTreePreferencesCache();

ActorHierarchyCache platformCreateActorHierarchyCache() =>
    WebActorHierarchyCache();

ObligationsCache platformCreateObligationsCache() => WebObligationsCache();

WalkieDeps? platformCreateWalkieDeps(
  DashboardApi api,
  DashboardSession session,
) =>
    webWalkieDeps(api, session);

AvatarFilePicker platformCreateAvatarFilePicker() => WebAvatarFilePicker();
