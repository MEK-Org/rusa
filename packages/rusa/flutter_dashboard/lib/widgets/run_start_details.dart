import 'package:flutter/material.dart';

import '../api.dart';
import '../theme.dart';

/// What an expanded run_start row shows: the model that actually started the
/// run, then the run's complete retained launch text. It is built only on
/// expansion, so the prompt is requested then and on each reopen, never before.
class RunStartDetails extends StatefulWidget {
  const RunStartDetails({
    super.key,
    required this.runId,
    required this.model,
    required this.api,
  });

  /// Null on rows that predate retained prompts; they show the unavailable line.
  final String? runId;
  final String? model;
  final DashboardApi api;

  @override
  State<RunStartDetails> createState() => _RunStartDetailsState();
}

class _PromptResult {
  const _PromptResult(this.data, {this.failed = false});
  final Map<String, dynamic>? data;
  final bool failed;
}

class _RunStartDetailsState extends State<RunStartDetails> {
  late final Future<_PromptResult> _prompt = _fetch();

  Future<_PromptResult> _fetch() async {
    final runId = widget.runId;
    if (runId == null) return const _PromptResult(null);
    try {
      return _PromptResult(await widget.api.fetchRunPrompt(runId));
    } catch (_) {
      return const _PromptResult(null, failed: true);
    }
  }

  static final _labelStyle = kMonoStyle.copyWith(
    color: MeshColors.textSecondary,
    fontSize: 12,
  );

  @override
  Widget build(BuildContext context) => Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      Text('Resolved Model: ${widget.model ?? 'unknown'}', style: _labelStyle),
      const SizedBox(height: 6),
      Text('Prompt:', style: _labelStyle),
      const SizedBox(height: 4),
      Container(
        width: double.infinity,
        padding: const EdgeInsets.all(10),
        decoration: BoxDecoration(
          color: MeshColors.bgTertiary,
          borderRadius: BorderRadius.circular(6),
          border: Border.all(color: MeshColors.border),
        ),
        child: FutureBuilder<_PromptResult>(
          future: _prompt,
          builder: (context, snapshot) {
            if (snapshot.connectionState != ConnectionState.done) {
              return const _MutedLine('Loading prompt…');
            }
            if (snapshot.data?.failed == true) {
              return const _MutedLine('Could not load prompt');
            }
            final prompt = snapshot.data?.data?['prompt'];
            if (prompt is! String) {
              return const _MutedLine('Prompt unavailable');
            }
            return _ClampedPrompt(prompt);
          },
        ),
      ),
    ],
  );
}

class _MutedLine extends StatelessWidget {
  const _MutedLine(this.text);
  final String text;

  @override
  Widget build(BuildContext context) => Text(
    text,
    style: const TextStyle(
      color: MeshColors.textMuted,
      fontSize: 11.5,
      fontStyle: FontStyle.italic,
    ),
  );
}

/// Selectable monospace prompt, clamped to [maxLines] with Show more / Show
/// less, as ReferencePreview clamps a long body.
class _ClampedPrompt extends StatefulWidget {
  const _ClampedPrompt(this.prompt);
  final String prompt;

  static const maxLines = 12;

  @override
  State<_ClampedPrompt> createState() => _ClampedPromptState();
}

class _ClampedPromptState extends State<_ClampedPrompt> {
  bool _expanded = false;

  @override
  Widget build(BuildContext context) {
    final style = kMonoStyle.copyWith(
      color: MeshColors.textPrimary,
      fontSize: 12,
      height: 1.45,
    );
    return LayoutBuilder(
      builder: (context, constraints) {
        final overflows = (TextPainter(
          text: TextSpan(text: widget.prompt, style: style),
          maxLines: _ClampedPrompt.maxLines,
          textDirection: Directionality.of(context),
          textScaler: MediaQuery.textScalerOf(context),
          locale: Localizations.maybeLocaleOf(context),
        )..layout(maxWidth: constraints.maxWidth)).didExceedMaxLines;
        return Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            if (_expanded || !overflows)
              SelectableText(widget.prompt, style: style)
            else
              Text(
                widget.prompt,
                maxLines: _ClampedPrompt.maxLines,
                overflow: TextOverflow.ellipsis,
                style: style,
              ),
            if (overflows) ...[
              const SizedBox(height: 6),
              InkWell(
                onTap: () => setState(() => _expanded = !_expanded),
                child: Text(
                  _expanded ? 'Show less' : 'Show more',
                  style: const TextStyle(
                    color: MeshColors.accent,
                    fontSize: 11,
                    fontWeight: FontWeight.w500,
                  ),
                ),
              ),
            ],
          ],
        );
      },
    );
  }
}
