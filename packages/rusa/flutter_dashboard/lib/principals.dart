/// Principal identity helpers shared by the widgets that act "as the person".
///
/// Identity comes from the server-resolved durable principal.
library;

/// What the owner field shows and accepts for the viewing person.
const String kOperatorDisplayHandle = 'human operator';

/// The viewing person's sole durable identity, once config has loaded.
List<String> viewerPrincipalIds(String? userPrincipalId) => [
  if (userPrincipalId != null && userPrincipalId.isNotEmpty) userPrincipalId,
];

/// A missing config has no identity; an empty owner fails normal validation.
String viewerOwnerId(String? userPrincipalId) => userPrincipalId ?? '';

/// Whether `id` names the viewing person.
bool isViewerPrincipal(String? id, String? userPrincipalId) =>
    id != null && id.isNotEmpty && id == userPrincipalId;

/// Whether typed owner text means "the viewing person" rather than an actor.
///
/// Profile data is deliberately absent here. It is mutable presentation data,
/// rather than an identifier, and could collide with an actor handle.
bool isOperatorOwnerText(String text, String? userPrincipalId) {
  final t = text.trim();
  return t == 'operator' ||
      t == kOperatorDisplayHandle ||
      isViewerPrincipal(t, userPrincipalId);
}

/// Whether `id` names the server-resolved durable user principal.
///
/// Scope: the only durable id the dashboard can name is the *viewer's*, because
/// that is the only one the server reports (`/api/dashboard/config`). A second
/// user's durable id is not enumerable client-side today, so their rows still
/// resolve as an unknown actor — lifting that needs the server to expose the
/// user list (or an owner kind on the obligation), not a wider match here.
bool isHumanPrincipal(String? id, String? userPrincipalId) {
  if (id == null) return false;
  return isViewerPrincipal(id, userPrincipalId);
}
