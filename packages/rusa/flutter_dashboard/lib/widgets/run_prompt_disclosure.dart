import 'package:flutter/material.dart';

import '../api.dart';
import '../theme.dart';

/// A run's bounded, retained launch text. No request occurs before expansion.
class RunPromptDisclosure extends StatefulWidget {
  const RunPromptDisclosure({
    super.key,
    required this.runId,
    required this.api,
  });

  final String runId;
  final DashboardApi api;

  @override
  State<RunPromptDisclosure> createState() => _RunPromptDisclosureState();
}

class _PromptResult {
  const _PromptResult(this.data, {this.failed = false});
  final Map<String, dynamic>? data;
  final bool failed;
}

class _RunPromptDisclosureState extends State<RunPromptDisclosure> {
  bool _expanded = false;
  Future<_PromptResult>? _prompt;

  Future<_PromptResult> _fetch() async {
    try {
      return _PromptResult(await widget.api.fetchRunPrompt(widget.runId));
    } catch (_) {
      return const _PromptResult(null, failed: true);
    }
  }

  @override
  Widget build(BuildContext context) => Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      TextButton.icon(
        onPressed: () => setState(() {
          _expanded = !_expanded;
          if (_expanded) _prompt ??= _fetch();
        }),
        icon: Icon(_expanded ? Icons.expand_less : Icons.expand_more, size: 18),
        label: const Text('Run prompt'),
      ),
      if (_expanded)
        FutureBuilder<_PromptResult>(
          future: _prompt,
          builder: (context, snapshot) {
            if (snapshot.connectionState != ConnectionState.done) {
              return const Text('Loading prompt…');
            }
            if (snapshot.data?.failed == true) {
              return TextButton(
                onPressed: () => setState(() {
                  _prompt = _fetch();
                }),
                child: const Text('Could not load prompt. Retry'),
              );
            }
            final data = snapshot.data?.data;
            if (data == null) {
              return const Text('Prompt no longer retained or unavailable.');
            }
            final prompt = data['prompt'] as String;
            return Container(
              width: double.infinity,
              padding: const EdgeInsets.all(10),
              color: MeshColors.bgTertiary,
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    'Launched provider: ${data['provider']}',
                    style: kMonoStyle.copyWith(
                      color: MeshColors.textMuted,
                      fontSize: 11,
                    ),
                  ),
                  if (data['truncated'] == true)
                    Text(
                      'Showing the first 256 KiB of ${data['promptBytes']} bytes.',
                      style: const TextStyle(color: MeshColors.textSecondary),
                    ),
                  const SizedBox(height: 6),
                  ConstrainedBox(
                    constraints: const BoxConstraints(maxHeight: 400),
                    child: SingleChildScrollView(
                      child: SelectableText(
                        prompt,
                        style: kMonoStyle.copyWith(
                          color: MeshColors.textPrimary,
                          fontSize: 12,
                        ),
                      ),
                    ),
                  ),
                ],
              ),
            );
          },
        ),
    ],
  );
}
