import 'actor_hierarchy_cache.dart';
import 'api.dart';
import 'app.dart';
import 'avatar_platform.dart';
import 'mesh_stream.dart';
import 'obligations_cache.dart';
import 'quota_cache.dart';
import 'session.dart';
import 'tree_preferences_cache.dart';
import 'voice_platform.dart';

void platformInit() => throw UnsupportedError('platformInit');

String? get platformDocumentTitle => null;

Future<DashboardSession> platformBootstrapSession() =>
    throw UnsupportedError('platformBootstrapSession');

DashboardSessionHooksDisposer Function(DashboardSession session)?
    get platformBrowserHooksBuilder => null;

Uri platformServerBaseUrl() => Uri.base;

DashboardApi platformCreateDashboardApi(DashboardSession session) =>
    DashboardApi(session: session);

MeshStreamSource platformCreateMeshStream(
  DashboardSession session,
  Uri base,
) =>
    throw UnsupportedError('platformCreateMeshStream');

QuotaCache platformCreateQuotaCache() => const NoopQuotaCache();

TreePreferencesCache platformCreateTreePreferencesCache() =>
    const NoopTreePreferencesCache();

ActorHierarchyCache platformCreateActorHierarchyCache() =>
    const NoopActorHierarchyCache();

ObligationsCache platformCreateObligationsCache() =>
    const NoopObligationsCache();

WalkieDeps? platformCreateWalkieDeps(
  DashboardApi api,
  DashboardSession session,
) =>
    null;

AvatarFilePicker platformCreateAvatarFilePicker() =>
    const NoopAvatarFilePicker();
