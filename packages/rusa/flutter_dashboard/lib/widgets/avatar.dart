import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../store.dart';
import '../theme.dart';

/// A circular per-actor avatar .
///
/// Loads `GET /api/mesh/avatar/<id>.png` — keyed by the unique thread **id**
/// (the handle is collision-prone, so it's a display label only, never the
/// avatar's identity). The server returns the cached, AI-generated worker image
/// or, for the root id, the fixed root image (the URL extension is irrelevant;
/// the image codec sniffs the bytes). The image is masked to a circle with a
/// subtle border.
///
/// Availability is best-effort: an avatar is generated asynchronously on spawn,
/// so it may not exist yet (404) on first sighting. While the image loads — or
/// if it 404s / fails — a graceful silhouette placeholder shows instead, so the
/// UI never blocks on avatar availability. The tree pairs this with the live
/// status dot, so run-state is always visible even before the image resolves.
/// Retired actors render muted.
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
  /// config-driven via `rootActor.avatar`) and re-fetches past the browser's
  /// URL-keyed image cache after a successful upload.
  final DashboardStore? store;

  @override
  Widget build(BuildContext context) {
    return StreamBuilder<int>(
      stream: store?.avatarEpoch,
      initialData: 0,
      builder: (context, snapshot) {
        // Relative to the page origin (Uri.base) so the same build works on
        // localhost and behind `tailscale serve`, matching DashboardApi.
        final epoch = snapshot.data ?? 0;
        final url = Uri.base
            .resolve('/api/mesh/avatar/$id.png${epoch > 0 ? '?v=$epoch' : ''}')
            .toString();

        final image = Image.network(
          url,
          width: size,
          height: size,
          fit: BoxFit.cover,
          // Keep the last frame during a rebuild so the avatar never flickers
          // when the tree re-renders on SSE updates.
          gaplessPlayback: true,
          loadingBuilder: (_, child, progress) =>
              progress == null ? child : _placeholder(),
          errorBuilder: (_, _, _) => _placeholder(),
        );

        // A true circle, with no flat tangent edges. A circular `BoxDecoration`
        // with `clipBehavior` can leave flat sides at the cardinal points (the
        // decoration clip aliases against a child that paints to the box edge);
        // `ClipOval` masks to a real circular path instead. The layout box is
        // square (size×size) so the oval is a circle, and `BoxFit.cover` fills
        // it edge-to-edge. The border is a separate circular ring painted over
        // the masked image's rim.
        Widget avatar = ClipOval(
          child: SizedBox(width: size, height: size, child: image),
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

  /// Neutral silhouette shown until the image resolves (or if it never does).
  Widget _placeholder() => Container(
    color: MeshColors.bgTertiary,
    alignment: Alignment.center,
    child: Icon(
      id == 'human:operator' ? Icons.person : Icons.pets,
      size: size * 0.55,
      color: MeshColors.textMuted,
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
                          builder: (context, snapshot) {
                            final epoch = snapshot.data ?? 0;
                            final url = Uri.base
                                .resolve(
                                  '/api/mesh/avatar/${widget.id}.png${epoch > 0 ? '?v=$epoch' : ''}',
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
