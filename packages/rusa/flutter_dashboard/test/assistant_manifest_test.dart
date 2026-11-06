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
}
