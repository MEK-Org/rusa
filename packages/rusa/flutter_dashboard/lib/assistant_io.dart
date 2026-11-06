import 'dart:async';

import 'package:flutter/services.dart';

import 'assistant_platform.dart';

/// The `assistant_platform.dart` seams over the activity's
/// `org.mek.rusa.dashboard/assistant` channel (`AssistantChannel.kt`). Both
/// activities register the channel; only the assist activity sends `trigger`
/// and `end`, and only a routed headset sends `routeLost`.
class IoAssistantChannel implements AssistantPlatform {
  IoAssistantChannel({MethodChannel channel = const MethodChannel(kName)})
    : _channel = channel {
    _channel.setMethodCallHandler(_handle);
  }

  static const kName = 'org.mek.rusa.dashboard/assistant';

  final MethodChannel _channel;
  final _triggers = StreamController<void>.broadcast();
  final _routeLost = StreamController<void>.broadcast();

  @override
  Stream<void> get triggers => _triggers.stream;

  @override
  Stream<void> get routeLost => _routeLost.stream;

  @override
  Future<void> playReadyCue() async {
    try {
      await _channel.invokeMethod('playReadyCue');
    } on PlatformException {
      // Audio cue failure should not disrupt recording.
    } on MissingPluginException {
      // Non-Android or unhandled test environment.
    }
  }

  @override
  Future<void> Function()? onBackground;

  @override
  Future<void> Function()? onForeground;

  @override
  Future<void> Function()? onLockedAssist;

  @override
  Future<void> Function(AssistantReplyTarget target)? onReply;

  Future<Object?> _handle(MethodCall call) async {
    switch (call.method) {
      case 'trigger':
        _triggers.add(null);
      case 'routeLost':
        _routeLost.add(null);
      case 'background':
        await onBackground?.call();
      case 'foreground':
        await onForeground?.call();
      case 'lockedAssist':
        await onLockedAssist?.call();
      case 'reply':
        final args = call.arguments;
        if (args is Map) {
          final actorId = args['actorId'];
          final announcementId = args['announcementId'];
          if (actorId is String &&
              announcementId is String &&
              actorId.isNotEmpty &&
              announcementId.isNotEmpty) {
            await onReply?.call(
              AssistantReplyTarget(
                actorId: actorId,
                announcementId: announcementId,
              ),
            );
          }
        }
    }
    return null;
  }

  @override
  Future<AssistantRoleStatus> status() async {
    final map = await _channel.invokeMapMethod<String, bool>('roleStatus');
    return AssistantRoleStatus(
      available: map?['available'] ?? false,
      held: map?['held'] ?? false,
    );
  }

  @override
  Future<void> openSettings() => _channel.invokeMethod('openAssistantSettings');

  @override
  Future<bool> acquire() async {
    try {
      return await _channel.invokeMethod<bool>('acquireHeadset') ?? false;
    } on PlatformException {
      return false;
    } on MissingPluginException {
      return false;
    }
  }

  @override
  Future<void> release() async {
    try {
      await _channel.invokeMethod('releaseHeadset');
    } on PlatformException {
      // Nothing more to undo from here.
    } on MissingPluginException {
      // No native half (tests, non-Android hosts): nothing was routed.
    }
  }
}
