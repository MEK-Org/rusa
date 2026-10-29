import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

/// The assistant's unlock boundary lives in the Android manifest (#1193): the
/// assist and voice-command triggers reach only a native gate that asks for
/// the unlock, and the Flutter assist screen cannot be drawn over the keyguard
/// or started by another app. A stopped activity gets no callback when the
/// phone locks later, so both finish on every stop, not only a locked one.
/// These read the shipped sources; device behavior is unproven here. The
/// session teardown before finishing is exercised in `assistant_test.dart`.
void main() {
  String kotlin(String name) => File(
    'android/app/src/main/kotlin/org/mek/rusa/dashboard/$name.kt',
  ).readAsStringSync();

  /// The trimmed, non-blank statements of [source]'s `onStop`.
  List<String> onStop(String source) {
    final body = RegExp(
      r'override fun onStop\(\) \{(.*?)\n    \}',
      dotAll: true,
    ).firstMatch(source);
    expect(body, isNotNull);
    return [
      for (final line in body!.group(1)!.split('\n'))
        if (line.trim().isNotEmpty) line.trim(),
    ];
  }

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

  test('the gate finishes on every stop but a configuration change', () {
    final source = kotlin('AssistGateActivity');
    expect(onStop(source), [
      'super.onStop()',
      'if (!isChangingConfigurations) finish()',
    ]);
    expect(source, contains('if (savedInstanceState != null) return finish()'));
  });

  test('the assist screen ends its session on every stop but a '
      'configuration change', () {
    final statements = onStop(kotlin('AssistActivity'));
    expect(statements.take(2), [
      'super.onStop()',
      'if (isChangingConfigurations || ending) return',
    ]);
    expect(statements, contains('channel.end {'));
    expect(statements, contains('main.postDelayed(close, END_DEADLINE_MS)'));
  });
}
