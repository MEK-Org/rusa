import 'actor_hierarchy_cache.dart';
import 'api.dart';
import 'app.dart';
import 'avatar_platform.dart';
import 'io_session.dart';
import 'io_sse.dart';
import 'mesh_stream.dart';
import 'obligations_cache.dart';
import 'quota_cache.dart';
import 'session.dart';
import 'tree_preferences_cache.dart';
import 'voice_platform.dart';

void platformInit() {
  // No-op on Dart IO / Android
}

String? get platformDocumentTitle => null;

Future<DashboardSession> platformBootstrapSession() =>
    bootstrapIoDashboardSession();

DashboardSessionHooksDisposer Function(DashboardSession session)?
    get platformBrowserHooksBuilder => null;

DashboardApi platformCreateDashboardApi(DashboardSession session) {
  if (session is IoDashboardSession) {
    return DashboardApi(
      client: session.client,
      base: session.baseUrl,
      session: session,
    );
  }
  return DashboardApi(
    base: resolveIoServerBaseUrl(),
    session: session,
  );
}

MeshStreamSource platformCreateMeshStream(
  DashboardSession session,
  Uri base,
) =>
    IoEventSourceStream(session: session, baseUrl: base);

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

AvatarFilePicker? platformCreateAvatarFilePicker() => null;
