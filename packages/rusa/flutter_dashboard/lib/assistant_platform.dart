import 'models.dart';

/// Seams over the Android assistant integration (`AssistantChannel.kt`), so
/// the assist page, the drawer entry and the recorder never touch a platform
/// channel directly. The real implementation is `assistant_io.dart`; tests use
/// fakes.

/// Whether this app holds Android's assistant role, and the way to it. The
/// role is not requestable by apps, so setup means the system settings page.
abstract interface class AssistantRole {
  Future<AssistantRoleStatus> status();

  /// Ask for the microphone and Bluetooth permissions the assist trigger
  /// needs (it may run over the lock screen, where a prompt is awkward), then
  /// open the system's digital-assistant settings.
  Future<void> openSettings();
}

class AssistantRoleStatus {
  const AssistantRoleStatus({required this.available, required this.held});

  /// The device has an assistant role at all.
  final bool available;

  /// This app is the current digital assistant app.
  final bool held;
}

/// The Bluetooth headset microphone for one recording: the headset's voice
/// recognition audio (HFP) plus the communication route to it.
abstract interface class HeadsetRoute {
  /// Route capture to a connected headset. Resolves false, holding nothing,
  /// when no headset microphone could be routed; capture then uses the phone.
  Future<bool> acquire();

  /// Return audio routing to normal. Safe to call when nothing is held.
  Future<void> release();
}

/// What the system sends the open assist screen.
abstract interface class AssistantSignals {
  /// Another assist or voice-command trigger while the screen is open.
  Stream<void> get triggers;

  /// The routed headset microphone went away, as when the headset button ends
  /// its voice recognition.
  Stream<void> get routeLost;
}

/// The whole native surface, as the one assistant channel serves it.
abstract interface class AssistantPlatform
    implements AssistantRole, HeadsetRoute, AssistantSignals {}

/// The walkie recipient for the assist trigger: the root actor. Prefers the
/// actor whose id is `root`, else the first active actor without a parent.
String? resolveRootActorId(List<ThreadDto> threads) {
  final active = threads.where((t) => t.status == 'active');
  for (final thread in active) {
    if (thread.id == 'root') return thread.id;
  }
  for (final thread in active) {
    if (thread.parentId == null) return thread.id;
  }
  return null;
}
