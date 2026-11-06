import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

/// The assistant's manifest boundary (#1193, #1223): the assist and
/// voice-command triggers reach only the restricted assist screen, which shows
/// over the keyguard without unlocking. The main dashboard activity never
/// shows over the keyguard. These read the shipped manifest; device behavior
/// is unproven here.
void main() {
  final manifest = File(
    'android/app/src/main/AndroidManifest.xml',
  ).readAsStringSync();
  final assistActivity = File(
    'android/app/src/main/kotlin/org/mek/rusa/dashboard/AssistActivity.kt',
  ).readAsStringSync();
  final activities = {
    for (final m in RegExp(
      r'<activity\b(?:[^>]*/>|.*?</activity>)',
      dotAll: true,
    ).allMatches(manifest))
      RegExp(r'android:name="([^"]+)"').firstMatch(m.group(0)!)!.group(1)!: m
          .group(0)!,
  };

  bool handles(String body, String action) =>
      body.contains('<action android:name="android.intent.action.$action"/>');

  test('only the assist screen handles the assist triggers', () {
    for (final action in ['ASSIST', 'VOICE_COMMAND']) {
      final handlers = [
        for (final e in activities.entries)
          if (handles(e.value, action)) e.key,
      ];
      expect(handlers, ['.AssistActivity'], reason: action);
    }
  });

  test('only the assist screen handles a reply-notification tap', () {
    const action = 'org.mek.rusa.dashboard.OPEN_REPLY';
    final handlers = [
      for (final e in activities.entries)
        if (e.value.contains('<action android:name="$action"/>')) e.key,
    ];
    expect(handlers, ['.AssistActivity']);
  });

  test('the assist screen shows over the keyguard without unlocking', () {
    final assist = activities['.AssistActivity']!;
    expect(assist, contains('android:showWhenLocked="true"'));
    expect(assist, contains('android:turnScreenOn="true"'));
    expect(assist, contains('android:exported="true"'));
    expect(assist, contains('android:launchMode="singleTask"'));
  });

  test('the main dashboard activity does not show over the keyguard', () {
    final main = activities['.MainActivity']!;
    expect(main, contains('android:exported="true"'));
    expect(main, isNot(contains('showWhenLocked')));
    expect(main, isNot(contains('turnScreenOn')));
  });

  test('locked re-entry resets retained state and Recents stays dormant', () {
    // This is an Android source-boundary test, not device lifecycle proof.
    // The physical lock-screen flow remains a release/device acceptance gate.
    expect(assistActivity, contains('channel.lockedAssist()'));
    expect(assistActivity, contains('isDeviceLocked()'));
    expect(
      assistActivity,
      contains('Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY'),
    );
    expect(assistActivity, contains('Uri.Builder().path("recents")'));
    expect(assistActivity, contains('assistant?.foreground()'));
    expect(
      assistActivity,
      contains('A retained unlocked task must not render its transcript'),
    );
    expect(assistActivity, contains('setShowWhenLocked(false)'));
    expect(
      assistActivity,
      contains('The initial locked capture is already restricted'),
    );
    expect(assistActivity, contains('channel.trigger()'));
    expect(assistActivity, contains('finish()'));

    final onNewIntent = RegExp(
      r'override fun onNewIntent\(intent: Intent\) \{(.*?)\n    \}',
      dotAll: true,
    ).firstMatch(assistActivity)!.group(1)!;
    final recentsIndex = onNewIntent.indexOf('isRestoringFromRecents(intent)');
    final replyIndex = onNewIntent.indexOf('replyTarget(intent)');
    expect(recentsIndex, isNonNegative);
    expect(replyIndex, isNonNegative);
    expect(
      recentsIndex,
      lessThan(replyIndex),
      reason: 'Recents/history check must precede replyTarget in onNewIntent',
    );
  });

  test('an assist or Recents intent supersedes a reply awaiting unlock', () {
    // Android source-boundary test, not device lifecycle proof. Kotlin is not
    // compiled by this suite.
    final onNewIntent = RegExp(
      r'override fun onNewIntent\(intent: Intent\) \{(.*?)\n    \}',
      dotAll: true,
    ).firstMatch(assistActivity)!.group(1)!;
    final recentsBranch = onNewIntent.substring(
      onNewIntent.indexOf('isRestoringFromRecents(intent)'),
      onNewIntent.indexOf('replyTarget(intent)'),
    );
    expect(recentsBranch, contains('pendingReply = null'));

    // The notification and Recents routes start no capture, so a lock-screen
    // gesture there starts one instead of toggling a capture that isn't there.
    final ordinary = onNewIntent.substring(
      onNewIntent.indexOf('val reply = replyTarget(intent)'),
    );
    final dormant = ordinary.indexOf(
      'val dormantRoute = pendingReply != null || restoringFromRecents',
    );
    expect(dormant, isNonNegative);
    expect(ordinary.indexOf('pendingReply = null'), greaterThan(dormant));
    expect(
      ordinary.indexOf('restoringFromRecents = false', dormant),
      greaterThan(dormant),
    );
    expect(ordinary, contains('if (backgrounded || dormantRoute) {'));

    // A superseded keyguard request must not hide or finish the newer surface.
    final defer = RegExp(
      r'private fun deferReplyUntilUnlocked\(.*?\n    \}\n',
      dotAll: true,
    ).firstMatch(assistActivity)!.group(0)!;
    expect(defer, contains('if (pendingReply !== reply) return@post'));
    expect(
      'if (pendingReply === reply) abandonReplyHandoff(retainBackgroundTask)'
          .allMatches(defer),
      hasLength(2),
    );
  });
}
