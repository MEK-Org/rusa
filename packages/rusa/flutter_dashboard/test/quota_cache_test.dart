import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:rusa_dashboard/models.dart';
import 'package:rusa_dashboard/quota_cache.dart';

/// The persistence path (ISSUE_NUM ask 4) is only honest if a snapshot survives a
/// `toJson` → JSON string → `fromJson` round-trip byte-for-byte — most of all
/// `scrapedAt`, which must never be restamped on restore (ISSUE_NUM ask 5). These
/// tests pin that at the serialization boundary the browser `WebQuotaCache`
/// depends on, without needing `package:web`.
void main() {
  // A snapshot exercising flat-window providers, null-valued fields, and
  // populated scrapedAt strings.
  const snapshot = QuotaSnapshotDto(
    generatedAt: '2026-07-14T09:20:00.000Z',
    providers: [
      ProviderQuotaDto(
        provider: 'claude',
        status: 'available',
        usedPercent: 12.5,
        tier: 'max',
        message: null,
        scrapedAt: '2026-07-14T09:15:00.000Z',
        throttle: QuotaThrottleDto(
          intervalSeconds: 73,
          held: false,
          expired: false,
          updatedAt: '2026-07-14T09:15:00.000Z',
          buckets: [
            QuotaThrottleBucketDto(
              key: 'claude:weekly',
              error: 21,
              percentLeft: 30,
              timeRemainingPct: 51,
            ),
          ],
        ),
        windows: [
          QuotaWindowDto(
            id: 'weekly',
            label: 'Weekly',
            usedPercent: 12.5,
            status: 'available',
            headline: true,
            resetAtIso: '2026-07-21T09:00:00.000Z',
            windowMs: 604800000,
            scrapedAt: '2026-07-14T09:15:00.000Z',
            carriedForward: true,
          ),
          QuotaWindowDto(
            id: 'five_hour',
            label: '5h',
            usedPercent: null,
            status: 'unknown',
            headline: false,
            scrapedAt: null,
            carriedForward: false,
          ),
        ],
      ),
      ProviderQuotaDto(
        provider: 'agy',
        status: 'available',
        usedPercent: null,
        tier: null,
        message: null,
        scrapedAt: null,
        windows: [
          QuotaWindowDto(
            id: 'weekly',
            label: 'Weekly',
            usedPercent: 40,
            status: 'available',
            headline: true,
            windowMs: 604800000,
            scrapedAt: '2026-07-14T09:10:00.000Z',
          ),
        ],
      ),
    ],
  );

  const history = QuotaHistoryDto(
    generatedAt: '2026-07-14T09:20:00.000Z',
    historySince: '2026-07-13T09:20:00.000Z',
    history: [
      QuotaHistorySeriesDto(
        provider: 'claude',
        windowId: 'weekly',
        label: 'Weekly',
        points: [
          QuotaHistoryPointDto(
            observedAt: '2026-07-14T08:15:00.000Z',
            remainingPercent: 90,
          ),
          QuotaHistoryPointDto(
            observedAt: '2026-07-14T09:15:00.000Z',
            remainingPercent: 87.5,
          ),
        ],
      ),
    ],
  );

  test('QuotaSnapshotDto survives a toJson → jsonEncode → fromJson round-trip '
      'with scrapedAt preserved verbatim', () {
    final restored = QuotaSnapshotDto.fromJson(
      jsonDecode(jsonEncode(snapshot.toJson())) as Map<String, dynamic>,
    );

    expect(restored.generatedAt, snapshot.generatedAt);
    expect(restored.providers.length, 2);

    final claude = restored.provider('claude')!;
    expect(claude.status, 'available');
    expect(claude.usedPercent, 12.5);
    expect(claude.tier, 'max');
    expect(claude.message, isNull);
    expect(claude.scrapedAt, '2026-07-14T09:15:00.000Z');
    expect(claude.throttle?.intervalSeconds, 73);
    expect(claude.throttle?.buckets.single.key, 'claude:weekly');

    final weekly = claude.windows[0];
    expect(weekly.id, 'weekly');
    expect(weekly.label, 'Weekly');
    expect(weekly.usedPercent, 12.5);
    expect(weekly.resetAtIso, '2026-07-21T09:00:00.000Z');
    expect(weekly.windowMs, 604800000);
    expect(weekly.headline, isTrue);
    // The verbatim honesty invariant (ISSUE_NUM ask 5).
    expect(weekly.scrapedAt, '2026-07-14T09:15:00.000Z');
    expect(weekly.carriedForward, isTrue);

    final session = claude.windows[1];
    expect(session.id, 'five_hour');
    expect(session.usedPercent, isNull);
    expect(session.status, 'unknown');
    expect(session.scrapedAt, isNull);
    expect(session.carriedForward, isFalse);

    final agy = restored.provider('agy')!;
    expect(agy.windows.single.scrapedAt, '2026-07-14T09:10:00.000Z');
  });

  test('QuotaHistoryDto survives a toJson → jsonEncode → fromJson round-trip', () {
    final restored = QuotaHistoryDto.fromJson(
      jsonDecode(jsonEncode(history.toJson())) as Map<String, dynamic>,
    );

    expect(restored.generatedAt, history.generatedAt);
    expect(restored.historySince, history.historySince);
    expect(restored.history.single.provider, 'claude');
    expect(restored.history.single.windowId, 'weekly');
    expect(restored.history.single.points.last.remainingPercent, 87.5);
  });

  test('NoopQuotaCache never persists — every load is a cold start', () {
    const cache = NoopQuotaCache();
    expect(cache.load(), isNull);
    // save/clear are no-ops and must not throw.
    cache.save(snapshot);
    cache.clear();
    expect(cache.load(), isNull);
  });
}
