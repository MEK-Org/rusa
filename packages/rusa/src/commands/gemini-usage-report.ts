import { createReadStream } from "node:fs";
import {
  buildGeminiUsageReport,
  formatGeminiUsageReport,
  type UsageReportOptions,
} from "../observability/gemini-usage-report.js";

export async function runGeminiUsageReport(
  files: string[],
  options: UsageReportOptions & { json?: boolean }
): Promise<void> {
  if (files.filter((file) => file === "-").length > 1) throw new Error("Read stdin only once");
  const sources = files.map((file) => ({
    name: file === "-" ? "stdin" : file,
    stream: (async function* () {
      if (file === "-") {
        yield* process.stdin;
      } else {
        const input = createReadStream(file);
        try {
          yield* input;
        } finally {
          input.destroy();
        }
      }
    })(),
  }));
  const report = await buildGeminiUsageReport(sources, options);
  process.stdout.write(
    options.json ? `${JSON.stringify(report, null, 2)}\n` : formatGeminiUsageReport(report)
  );
}
