/// Principal identity helpers shared by the widgets that act "as the person".
///
/// Before #438 the dashboard had exactly one name for its human: the alias
/// `human:operator`, minted client-side. Durable user principals replaced it,
/// and the legacy alias migration (#460) rewrites the old rows to the durable
/// id. Both can therefore be present in one database — migrated rows carry the
/// durable id, rows a pre-migration build wrote still carry the alias — so a
/// reader must ask about both, while a writer must only ever name the durable
/// principal once the server knows one.
library;

/// The pre-#438 alias. Read-side only: never sent as a new attribution.
const String kLegacyOperatorPrincipalId = 'human:operator';

/// What the owner field shows and accepts for the viewing person.
const String kOperatorDisplayHandle = 'human operator';

/// The ids that stand for the viewing person, durable id first.
///
/// The alias stays in the list because unmigrated rows are still the person's
/// work; dropping it here would silently empty an un-migrated instance's queue.
List<String> viewerPrincipalIds(String? userPrincipalId) => [
  if (userPrincipalId != null &&
      userPrincipalId.isNotEmpty &&
      userPrincipalId != kLegacyOperatorPrincipalId)
    userPrincipalId,
  kLegacyOperatorPrincipalId,
];

/// The id to attribute *new* work to: the durable principal when the server
/// has resolved one, and only otherwise the alias the server still accepts.
String viewerOwnerId(String? userPrincipalId) =>
    userPrincipalId != null && userPrincipalId.isNotEmpty
    ? userPrincipalId
    : kLegacyOperatorPrincipalId;

/// Whether `id` names the viewing person under either of their ids.
bool isViewerPrincipal(String? id, String? userPrincipalId) =>
    id != null && viewerPrincipalIds(userPrincipalId).contains(id);

/// Whether typed owner text means "the viewing person" rather than an actor.
/// The legacy handles remain accepted while the authenticated profile label is
/// only a display affordance that resolves back to the same durable principal.
bool isOperatorOwnerText(
  String text,
  String? userPrincipalId, [
  String? operatorDisplayName,
]) {
  final t = text.trim();
  final profileLabel = operatorDisplayName?.trim();
  return t == 'operator' ||
      t == kOperatorDisplayHandle ||
      (profileLabel != null && profileLabel.isNotEmpty && t == profileLabel) ||
      isViewerPrincipal(t, userPrincipalId);
}

/// Whether `id` names a human principal — either the legacy alias, any
/// `human:*` prefix, or the server-resolved durable user principal.
///
/// Scope: the only durable id the dashboard can name is the *viewer's*, because
/// that is the only one the server reports (`/api/dashboard/config`). A second
/// user's durable id is not enumerable client-side today, so their rows still
/// resolve as an unknown actor — lifting that needs the server to expose the
/// user list (or an owner kind on the obligation), not a wider match here.
bool isHumanPrincipal(String? id, String? userPrincipalId) {
  if (id == null) return false;
  if (id.startsWith('human:')) return true;
  return isViewerPrincipal(id, userPrincipalId);
}
