import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../store.dart';
import '../theme.dart';
import 'status_dot.dart';

/// A circular per-actor avatar .
///
/// Loads `GET /api/mesh/avatar/<id>.png` — keyed by the unique thread **id**
/// (the handle is collision-prone, so it's a display label only, never the
/// avatar's identity). The server returns the cached, AI-generated worker image
/// or, for the root id, the fixed root image (the URL extension is irrelevant;
/// the image codec sniffs the bytes). The image is masked to a circle with a
/// subtle border.
///
/// A missing avatar is an immediate 404 (the fallback silhouette) that also
/// starts one server-side generation attempt for a live actor. The server
/// reports that attempt over the SSE stream: while it is generating, the store
/// shows an edge progress ring over the silhouette; on `ready` the store bumps
/// this actor's URL version and the new image fades in; on `failed` the ring
/// simply goes away — there is no client-side retry. The tree pairs this with
/// the live status dot, so run-state is always visible. Retired actors render
/// muted.
class ActorAvatar extends StatelessWidget {
  const ActorAvatar({
    super.key,
    required this.id,
    this.size = 22,
    this.retired = false,
    this.store,
  });

  /// The unique thread id — the avatar's identity and cache key.
  final String id;
  final double size;
  final bool retired;

  /// Optional store . When present, the lightbox opened from this
  /// avatar offers an upload control (root excluded — it stays
  /// config-driven via `rootActor.avatar`), re-fetches past the browser's
  /// URL-keyed image cache after a successful upload, and drives the
  /// generating ring from the server's `avatar` SSE frames.
  final DashboardStore? store;

  @override
  Widget build(BuildContext context) {
    return StreamBuilder<int>(
      stream: store?.avatarEpoch,
      initialData: 0,
      builder: (context, _) {
        // Relative to the page origin (Uri.base) so the same build works on
        // localhost and behind `tailscale serve`, matching DashboardApi.
        final version = store?.avatarVersion(id) ?? 0;
        final generating = store?.isAvatarGenerating(id) ?? false;
        final url = Uri.base
            .resolve(
              '/api/mesh/avatar/$id.png${version > 0 ? '?v=$version' : ''}',
            )
            .toString();

        final image = Image.network(
          url,
          // A new version (upload, manual generate, or lazy `ready`) must start
          // from a clean image state rather than inherit the previous URL's
          // error, so the replacement image fades in instead of snapping.
          key: ValueKey(url),
          width: size,
          height: size,
          fit: BoxFit.cover,
          // Keep the last frame during a rebuild so the avatar never flickers
          // when the tree re-renders on SSE updates.
          gaplessPlayback: true,
          frameBuilder: (_, child, frame, wasSynchronouslyLoaded) {
            // An in-memory-cached image needs no transition. Otherwise the
            // silhouette sits underneath and the decoded frame fades over it.
            if (wasSynchronouslyLoaded) return child;
            return Stack(
              fit: StackFit.expand,
              children: [
                _avatarPlaceholder(id, size),
                AnimatedOpacity(
                  opacity: frame == null ? 0 : 1,
                  duration: const Duration(milliseconds: 200),
                  child: child,
                ),
              ],
            );
          },
          errorBuilder: (_, _, _) => _avatarPlaceholder(id, size),
        );

        // A true circle, with no flat tangent edges. A circular `BoxDecoration`
        // with `clipBehavior` can leave flat sides at the cardinal points (the
        // decoration clip aliases against a child that paints to the box edge);
        // `ClipOval` masks to a real circular path instead. The layout box is
        // square (size×size) so the oval is a circle, and `BoxFit.cover` fills
        // it edge-to-edge. The border is a separate circular ring painted over
        // the masked image's rim.
        Widget avatar = ClipOval(
          child: SizedBox(
            width: size,
            height: size,
            child: Stack(
              fit: StackFit.expand,
              children: [
                image,
                // The ring means exactly one thing: the server is generating
                // this avatar right now. Ordinary loads of a cached image
                // never show it.
                if (generating)
                  Padding(
                    padding: const EdgeInsets.all(1.5),
                    child: CircularProgressIndicator(
                      strokeWidth: size >= 20 ? 2 : 1,
                      semanticsLabel: 'Generating avatar',
                    ),
                  ),
              ],
            ),
          ),
        );
        if (retired) avatar = Opacity(opacity: 0.55, child: avatar);

        final avatarWidget = Container(
          width: size,
          height: size,
          decoration: BoxDecoration(
            shape: BoxShape.circle,
            color: MeshColors.bgTertiary,
            border: Border.all(
              color: retired
                  ? MeshColors.statusRetired.withValues(alpha: 0.5)
                  : MeshColors.border,
              width: 1.5,
            ),
          ),
          child: avatar,
        );

        return MouseRegion(
          cursor: SystemMouseCursors.click,
          child: GestureDetector(
            onTap: () {
              showDialog<void>(
                context: context,
                barrierDismissible: true,
                barrierColor: Colors.black.withValues(alpha: 0.85),
                builder: (context) => AvatarLightbox(id: id, store: store),
              );
            },
            child: avatarWidget,
          ),
        );
      },
    );
  }
}

/// Neutral silhouette shown until the image resolves, or after its one lazy
/// request fails. The error path deliberately has no retry mechanism.
Widget _avatarPlaceholder(String id, double size) => Container(
  color: MeshColors.bgTertiary,
  alignment: Alignment.center,
  child: Icon(
    id == 'human:operator' ? Icons.person : Icons.pets,
    size: size * 0.55,
    color: MeshColors.textMuted,
  ),
);

/// The hierarchy's actor identity marker: a circular avatar with its live run
/// state overlaid at the lower-right corner. Overview rows use this same widget
/// so the two views never disagree about which actor is active or queued.
class ActorAvatarWithStatus extends StatelessWidget {
  const ActorAvatarWithStatus({
    super.key,
    required this.id,
    required this.state,
    this.size = 52,
    this.retired = false,
    this.store,
  });

  final String id;
  final DotState state;
  final double size;
  final bool retired;
  final DashboardStore? store;

  @override
  Widget build(BuildContext context) => SizedBox(
    width: size,
    height: size,
    child: Stack(
      clipBehavior: Clip.none,
      children: [
        ActorAvatar(id: id, size: size, retired: retired, store: store),
        Positioned(
          right: -1,
          bottom: -1,
          child: Container(
            padding: const EdgeInsets.all(1.5),
            decoration: const BoxDecoration(
              shape: BoxShape.circle,
              color: MeshColors.bgSecondary,
            ),
            child: StatusDot(state: state, size: 7),
          ),
        ),
      ],
    ),
  );
}

class AvatarLightbox extends StatefulWidget {
  const AvatarLightbox({super.key, required this.id, this.store});

  final String id;

  /// Optional store . See [ActorAvatar.store].
  final DashboardStore? store;

  @override
  State<AvatarLightbox> createState() => _AvatarLightboxState();
}

class _AvatarLightboxState extends State<AvatarLightbox> {
  bool _uploading = false;
  bool _generating = false;

  bool get _canEditAvatar => widget.store != null;

  Future<void> _upload() async {
    setState(() => _uploading = true);
    try {
      await widget.store!.pickAndUploadAvatar(widget.id);
    } catch (_) {
      // Surfaced via the store's shared error stream (global footer); nothing
      // further to do here.
    } finally {
      if (mounted) setState(() => _uploading = false);
    }
  }

  Future<void> _generate() async {
    setState(() => _generating = true);
    try {
      await widget.store!.generateAvatar(widget.id);
    } catch (_) {
      // Surfaced via the store's shared error stream (global footer); nothing
      // further to do here.
    } finally {
      if (mounted) setState(() => _generating = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return CallbackShortcuts(
      bindings: {
        const SingleActivator(LogicalKeyboardKey.escape): () {
          Navigator.of(context).pop();
        },
      },
      child: Focus(
        autofocus: true,
        child: GestureDetector(
          behavior: HitTestBehavior.opaque,
          onTap: () => Navigator.of(context).pop(),
          child: Padding(
            padding: const EdgeInsets.all(48.0),
            child: Center(
              child: GestureDetector(
                onTap: () {}, // Prevent taps on image from dismissing lightbox
                child: Column(
                  mainAxisSize: MainAxisSize.max,
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: [
                    Flexible(
                      child: ClipRRect(
                        borderRadius: BorderRadius.circular(8.0),
                        child: StreamBuilder<int>(
                          stream: widget.store?.avatarEpoch,
                          initialData: 0,
                          builder: (context, _) {
                            final version =
                                widget.store?.avatarVersion(widget.id) ?? 0;
                            final url = Uri.base
                                .resolve(
                                  '/api/mesh/avatar/${widget.id}.png${version > 0 ? '?v=$version' : ''}',
                                )
                                .toString();
                            return Image.network(
                              url,
                              fit: BoxFit.contain,
                              gaplessPlayback: true,
                              loadingBuilder: (_, child, progress) =>
                                  progress == null ? child : _placeholder(),
                              errorBuilder: (_, _, _) => _placeholder(),
                            );
                          },
                        ),
                      ),
                    ),
                    if (_canEditAvatar) ...[
                      const SizedBox(height: 16),
                      Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          TextButton.icon(
                            onPressed: (_uploading || _generating)
                                ? null
                                : _upload,
                            icon: _uploading
                                ? const SizedBox(
                                    width: 16,
                                    height: 16,
                                    child: CircularProgressIndicator(
                                      strokeWidth: 2,
                                    ),
                                  )
                                : const Icon(Icons.upload, size: 18),
                            label: Text(
                              _uploading ? 'Uploading…' : 'Upload image',
                              style: kMonoStyle,
                            ),
                            style: TextButton.styleFrom(
                              foregroundColor: MeshColors.accent,
                            ),
                          ),
                          const SizedBox(width: 8),
                          TextButton.icon(
                            onPressed: (_uploading || _generating)
                                ? null
                                : _generate,
                            icon: _generating
                                ? const SizedBox(
                                    width: 16,
                                    height: 16,
                                    child: CircularProgressIndicator(
                                      strokeWidth: 2,
                                    ),
                                  )
                                : const Icon(Icons.auto_awesome, size: 18),
                            label: Text(
                              _generating ? 'Generating…' : 'Generate',
                              style: kMonoStyle,
                            ),
                            style: TextButton.styleFrom(
                              foregroundColor: MeshColors.accent,
                            ),
                          ),
                        ],
                      ),
                    ],
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }

  Widget _placeholder() => Container(
    color: MeshColors.bgTertiary,
    alignment: Alignment.center,
    width: 400,
    height: 400,
    child: Icon(
      widget.id == 'human:operator' ? Icons.person : Icons.pets,
      size: 160,
      color: MeshColors.textMuted,
    ),
  );
}
