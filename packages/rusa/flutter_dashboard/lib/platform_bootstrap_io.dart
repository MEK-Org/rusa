import 'dart:async';
import 'dart:io';

import 'package:flutter/widgets.dart';

import 'actor_hierarchy_cache.dart';
import 'api.dart';
import 'app.dart';
import 'assistant_io.dart';
import 'assistant_platform.dart';
import 'avatar_platform.dart';
import 'avatar_upload_io.dart';
import 'io_session.dart';
import 'io_session_client.dart';
import 'io_session_secure_storage.dart';
import 'io_sse.dart';
import 'mesh_stream.dart';
import 'obligations_cache.dart';
import 'quota_cache.dart';
import 'session.dart';
import 'tree_preferences_cache.dart';
import 'voice_io.dart';
import 'voice_platform.dart';

void platformInit() {
  // No-op on Dart IO / Android
}

String? get platformDocumentTitle => null;

Future<DashboardSession> platformBootstrapSession() =>
    bootstrapIoDashboardSession(
      credentialStorage: SecureIoSessionCredentialStorage(),
    );

// Returning the app to the foreground is a visit, as the browser's
// visibilitychange is: it renews an idled session and lets its streams reopen.
DashboardSessionHooksDisposer Function(DashboardSession session)?
get platformBrowserHooksBuilder =>
    (session) => AppLifecycleListener(
      onResume: () => unawaited(session.visit()),
    ).dispose;

DashboardApi platformCreateDashboardApi(DashboardSession session) {
  if (session case final IoSessionTransport transport) {
    return DashboardApi(
      // The session owns this client across signed-in page transitions. The
      // DashboardApi wrapper is page-scoped, so closing it must not close the
      // session's transport before a later sign-in can reuse it.
      client: NonClosingHttpClient(transport.client),
      base: transport.baseUrl,
      session: session,
      imageHeaders: transport.client.headersFor,
    );
  }
  return DashboardApi(base: resolveIoServerBaseUrl(), session: session);
}

MeshStreamSource platformCreateMeshStream(DashboardSession session, Uri base) =>
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
  DashboardSession session, {
  HeadsetRoute? headset,
}) => switch (session) {
  final IoSessionTransport transport => ioWalkieDeps(
    api,
    session,
    transport,
    headset: headset,
  ),
  _ => null,
};

AvatarFilePicker? platformCreateAvatarFilePicker() =>
    const IoAvatarFilePicker();

/// One channel per engine: each activity runs its own engine and registers
/// its own native half.
final AssistantPlatform? _assistant = Platform.isAndroid
    ? IoAssistantChannel()
    : null;

AssistantPlatform? platformCreateAssistant() => _assistant;
