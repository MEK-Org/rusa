import 'models.dart';

/// Persists the last-known quota snapshot across page loads so the header can
/// paint the previous reading at 0ms on a cold load, then revalidate behind it
/// (ISSUE_NUM ask 4 — "render immediately from the last-known reading"). The real
/// implementation is `WebQuotaCache` (browser localStorage, in
/// `web_quota_cache.dart`); the store depends only on this interface so it —
/// and its headless tests — never import the web-only `package:web`, mirroring
/// the `MeshStreamSource`/`sse.dart` split.
///
/// Every field, `scrapedAt` included, round-trips verbatim through
/// [QuotaSnapshotDto.toJson]/`fromJson`. A restored snapshot is NEVER restamped
/// (ISSUE_NUM ask 5): the persisted `scrapedAt` is exactly what keeps a stale first
/// paint honest about its own age.
abstract interface class QuotaCache {
  /// The last snapshot [save]d, or null on a cold start / unreadable store.
  /// Implementations must swallow their own errors and return null rather than
  /// throw — a broken cache degrades to a cold load, it never breaks boot.
  QuotaSnapshotDto? load();

  /// Persist [snapshot] as the new last-known reading. Best-effort: a failed
  /// write (quota full, private mode) is swallowed by the implementation.
  void save(QuotaSnapshotDto snapshot);

  /// Drop any persisted snapshot — used when the server reports no quota
  /// service is bound (503), so a no-quota deployment doesn't resurrect stale
  /// rings on the next load.
  void clear();
}

/// A no-op cache: the default when no persistence port is injected (headless
/// store tests, or a host without localStorage). Every load is a cold start.
class NoopQuotaCache implements QuotaCache {
  const NoopQuotaCache();

  @override
  QuotaSnapshotDto? load() => null;

  @override
  void save(QuotaSnapshotDto snapshot) {}

  @override
  void clear() {}
}
