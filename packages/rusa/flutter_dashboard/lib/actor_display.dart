/// Resolves an actor/thread id to a human-safe display label. A raw id is
/// never an acceptable result — every id resolves to one of four outcomes:
/// `Operator` for `human:*`, `System component` for `system:*`, the known
/// handle when [lookupHandle] finds one, or `Unknown actor` when it does not.
/// The prefix check mirrors the server's `isHumanOperator`/`isSystemActor`.
String actorDisplayLabel(
  String id, [
  String? Function(String id)? lookupHandle,
]) {
  if (id.startsWith('human:')) return 'Operator';
  if (id.startsWith('system:')) return 'System component';
  final handle = lookupHandle?.call(id);
  if (handle != null && handle.trim().isNotEmpty) return handle;
  return 'Unknown actor';
}
