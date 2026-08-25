import 'package:flutter/material.dart';
import '../store.dart';
import '../theme.dart';
import 'simple_markdown.dart';

class IuReportsBody extends StatefulWidget {
  const IuReportsBody({super.key, required this.store});
  final DashboardStore store;

  @override
  State<IuReportsBody> createState() => _IuReportsBodyState();
}

class _IuReportsBodyState extends State<IuReportsBody> {
  Map<String, dynamic>? _index;
  String? _error;
  String? _selectedRunId;
  String? _selectedReportContent;
  String? _selectedReportError;
  bool _loadingReport = false;

  @override
  void initState() {
    super.initState();
    _loadIndex();
  }

  Future<void> _loadIndex() async {
    try {
      final idx = await widget.store.fetchIuReports();
      setState(() {
        _index = idx;
        _error = null;
      });
    } catch (e) {
      setState(() {
        _error = e.toString();
        _index = null;
      });
    }
  }

  Future<void> _selectRun(String runId) async {
    setState(() {
      _selectedRunId = runId;
      _loadingReport = true;
      _selectedReportContent = null;
      _selectedReportError = null;
    });

    try {
      final res = await widget.store.fetchIuReportContent(runId);
      if (mounted) {
        setState(() {
          _loadingReport = false;
          if (res['error'] != null) {
            _selectedReportError = res['error'];
          } else {
            _selectedReportContent = res['markdown'];
          }
        });
      }
    } catch (e) {
      if (mounted) {
        setState(() {
          _loadingReport = false;
          _selectedReportError = e.toString();
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_error != null) {
      return Center(
        child: Text(
          'Error loading reports: $_error',
          style: const TextStyle(color: MeshColors.statusHalted),
        ),
      );
    }
    if (_index == null) {
      return const Center(child: CircularProgressIndicator());
    }

    if (_index!['unsupportedVersion'] == true) {
      return const Center(
        child: Text(
          'Unsupported index version. Please update the dashboard.',
          style: TextStyle(color: MeshColors.textSecondary),
        ),
      );
    }

    final runs = (_index!['runs'] as List?)?.cast<Map<String, dynamic>>() ?? [];
    if (runs.isEmpty) {
      return const Center(
        child: Text(
          'No reports generated yet.',
          style: TextStyle(color: MeshColors.textSecondary),
        ),
      );
    }

    return Row(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Expanded(
          flex: 1,
          child: ListView.builder(
            itemCount: runs.length,
            itemBuilder: (context, idx) {
              final run = runs[idx];
              final runId = run['run_id'] as String? ?? 'unknown';
              final date = run['date'] as String? ?? 'Unknown date';
              final status = run['status'] as String? ?? 'Unknown status';
              final counts =
                  (run['counts'] as Map?)?.cast<String, dynamic>() ?? {};

              final isSelected = runId == _selectedRunId;

              return InkWell(
                onTap: () => _selectRun(runId),
                child: Container(
                  color: isSelected ? MeshColors.bgSecondary : null,
                  padding: const EdgeInsets.symmetric(
                    horizontal: 16,
                    vertical: 12,
                  ),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        date,
                        style: const TextStyle(fontWeight: FontWeight.bold),
                      ),
                      const SizedBox(height: 4),
                      Text(
                        'Status: $status',
                        style: const TextStyle(
                          color: MeshColors.textSecondary,
                          fontSize: 12,
                        ),
                      ),
                      const SizedBox(height: 4),
                      Text(
                        'Counts: ${counts.length} categories',
                        style: const TextStyle(
                          color: MeshColors.textSecondary,
                          fontSize: 12,
                        ),
                      ),
                    ],
                  ),
                ),
              );
            },
          ),
        ),
        if (_selectedRunId != null) ...[
          Container(width: 1, color: MeshColors.border),
          Expanded(
            flex: 2,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Padding(
                  padding: const EdgeInsets.all(8.0),
                  child: Row(
                    mainAxisAlignment: MainAxisAlignment.end,
                    children: [
                      IconButton(
                        icon: const Icon(Icons.close),
                        onPressed: () {
                          setState(() {
                            _selectedRunId = null;
                            _selectedReportContent = null;
                            _selectedReportError = null;
                          });
                        },
                      ),
                    ],
                  ),
                ),
                Expanded(
                  child: _loadingReport
                      ? const Center(child: CircularProgressIndicator())
                      : _selectedReportError != null
                      ? Center(
                          child: Text(
                            'Error: $_selectedReportError',
                            style: const TextStyle(
                              color: MeshColors.statusHalted,
                            ),
                          ),
                        )
                      : _selectedReportContent != null
                      ? SingleChildScrollView(
                          padding: const EdgeInsets.all(16.0),
                          child: SimpleMarkdown(_selectedReportContent!),
                        )
                      : const Center(
                          child: Text(
                            'No content available.',
                            style: TextStyle(color: MeshColors.textSecondary),
                          ),
                        ),
                ),
              ],
            ),
          ),
        ],
      ],
    );
  }
}
