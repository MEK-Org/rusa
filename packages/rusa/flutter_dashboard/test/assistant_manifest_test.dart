import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

/// The assistant's unlock boundary lives in the Android manifest (#1193): the
/// assist and voice-command triggers reach only a native gate that asks for
/// the unlock, and the Flutter assist screen cannot be drawn over the keyguard
/// or started by another app. These read the shipped manifest; device behavior
/// is unproven here. The session teardown before the screen finishes is
/// exercised in `assistant_test.dart`.
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

  test('the gate shows over the keyguard, one per trigger', () {
    final gate = activities['.AssistGateActivity']!;
    expect(gate, contains('android:showWhenLocked="true"'));
    expect(gate, contains('android:exported="true"'));
    // A second trigger during the unlock prompt reuses this gate, and an
    // unlock that rotates the screen does not recreate it to open again.
    expect(gate, contains('android:launchMode="singleTop"'));
    expect(gate, contains('android:configChanges="orientation|'));
  });

  test('no Flutter activity shows over the keyguard, and the assist screen '
      'cannot be started from outside the app', () {
    for (final name in ['.MainActivity', '.AssistActivity']) {
      expect(activities[name], isNotNull, reason: name);
      expect(activities[name], isNot(contains('showWhenLocked')), reason: name);
      expect(activities[name], isNot(contains('turnScreenOn')), reason: name);
    }
    expect(activities['.AssistActivity'], contains('android:exported="false"'));
  });
}
