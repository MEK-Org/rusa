import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

/// The assistant's unlock boundary lives in the Android manifest (#1193): the
/// assist and voice-command triggers reach only a native gate that asks for
/// the unlock, and the Flutter assist screen cannot be drawn over the keyguard
/// or started by another app. A stopped assist screen gets no callback when
/// the phone locks later, so it must finish on every stop, not only a locked
/// one. These read the shipped sources; device behavior is unproven here.
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

  test('only the unlock gate handles the assist triggers', () {
    for (final action in ['ASSIST', 'VOICE_COMMAND']) {
      final handlers = [
        for (final e in activities.entries)
          if (handles(e.value, action)) e.key,
      ];
      expect(handlers, ['.AssistGateActivity'], reason: action);
    }
  });

  test('the gate shows over the keyguard to ask for the unlock', () {
    final gate = activities['.AssistGateActivity']!;
    expect(gate, contains('android:showWhenLocked="true"'));
    expect(gate, contains('android:exported="true"'));
  });

  test('the assist screen cannot be drawn over the keyguard or started '
      'from outside the app', () {
    final assist = activities['.AssistActivity']!;
    expect(assist, isNot(contains('showWhenLocked')));
    expect(assist, isNot(contains('turnScreenOn')));
    expect(assist, contains('android:exported="false"'));
  });

  test('no Flutter activity shows over the keyguard', () {
    for (final name in ['.MainActivity', '.AssistActivity']) {
      expect(activities[name], isNotNull, reason: name);
      expect(activities[name], isNot(contains('showWhenLocked')), reason: name);
    }
  });

  test('the assist screen finishes on every stop but a configuration '
      'change', () {
    final source = File(
      'android/app/src/main/kotlin/org/mek/rusa/dashboard/AssistActivity.kt',
    ).readAsStringSync();
    final onStop = RegExp(
      r'override fun onStop\(\) \{(.*?)\n    \}',
      dotAll: true,
    ).firstMatch(source);
    expect(onStop, isNotNull);
    final statements = onStop!
        .group(1)!
        .split('\n')
        .map((l) => l.trim())
        .where((l) => l.isNotEmpty)
        .toList();
    expect(statements, [
      'super.onStop()',
      'if (!isChangingConfigurations) finish()',
    ]);
  });
}
