import 'package:flutter/material.dart';

/// Exact palette + type from the locked V1.4.0 mockup
/// (`mockups/dashboard-520/index.html` :root CSS variables). Kept as plain
/// constants so widgets match the mockup pixel-for-pixel.
abstract final class MeshColors {
  static const bgPrimary = Color(0xFF0B0F19);
  static const bgSecondary = Color(0xFF121824);
  static const bgTertiary = Color(0xFF1A2333);
  static const bgSelected = Color(0xFF222E43);
  static const bgHover = Color(0xFF1B263B);
  static const bgConsole = Color(0xFF070A12);

  static const border = Color(0xFF26334D);
  static const borderFocus = Color(0xFF38BDF8);

  static const textPrimary = Color(0xFFF8FAFC);
  static const textSecondary = Color(0xFF94A3B8);
  static const textMuted = Color(0xFF64748B);

  static const accent = Color(0xFF38BDF8);
  static const accentHover = Color(0xFF7DD3FC);

  static const statusActive = Color(0xFF10B981);
  static const statusIdle = Color(0xFFF59E0B);
  static const statusRetired = Color(0xFF64748B);
  static const statusHalted = Color(0xFFEF4444);
}

/// Per-kind chip colors, lifted verbatim from the mockup's `.inline-kind-chip`
/// rules. Unknown kinds fall back to a neutral slate.
abstract final class KindChipColors {
  static const _map = <String, Color>{
    'run_queued': Color(0xFFF59E0B),
    'run_start': Color(0xFF10B981),
    'run_end': Color(0xFFEF4444),
    'run_yielded': Color(0xFFF59E0B),
    'run_continued': Color(0xFF3B82F6),
    'actor_spawned': Color(0xFFA855F7),
    'message_sent': Color(0xFFEC4899),
    'message_received': Color(0xFFEC4899),
    'message_acknowledged': Color(0xFF14B8A6),
    'handle_granted': Color(0xFF14B8A6),
    'root_control_action': Color(0xFF38BDF8),
    'continuation_capped': Color(0xFFF59E0B),
  };

  static Color forKind(String kind) => _map[kind] ?? MeshColors.textSecondary;
}

const String kMonoFontFamily = 'monospace';

/// Mono text style for handles, ids, and timestamps (mockup `--font-mono`).
const TextStyle kMonoStyle = TextStyle(
  fontFamily: kMonoFontFamily,
  fontSize: 13,
);

/// The shared dark theme.
ThemeData buildMeshTheme() {
  final base = ThemeData.dark(useMaterial3: true);
  return base.copyWith(
    scaffoldBackgroundColor: MeshColors.bgPrimary,
    colorScheme: base.colorScheme.copyWith(
      surface: MeshColors.bgSecondary,
      primary: MeshColors.accent,
      onPrimary: MeshColors.bgPrimary,
      onSurface: MeshColors.textPrimary,
    ),
    dividerColor: MeshColors.border,
    textTheme: base.textTheme.apply(
      bodyColor: MeshColors.textPrimary,
      displayColor: MeshColors.textPrimary,
      fontFamily: 'system-ui',
    ),
  );
}
