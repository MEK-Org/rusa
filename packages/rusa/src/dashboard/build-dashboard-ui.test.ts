import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));

describe("build-dashboard-ui.mjs instrumentation", () => {
  it("folds flutter stdout and stderr into the thrown error on failure and tees live output", () => {
    // The dashboard build is invoked as a script in the e2e path, not imported.
    // Read the script source to assert its spawn behavior, matching ISSUE_NUM's style.
    const scriptPath = join(__dirname, "..", "..", "scripts", "build-dashboard-ui.mjs");
    const code = readFileSync(scriptPath, "utf8");

    // The script must use spawn with stdio: "pipe" to capture output, not "inherit"
    // otherwise the flutter real error text is swallowed when it dies.
    expect(code).toContain('stdio: "pipe"');

    // The script must tee stdout and stderr live to process.stdout/stderr
    // so humans watching journalctl still see output live.
    expect(code).toContain('flutterProc.stdout.on("data",');
    expect(code).toContain("process.stdout.write(");
    expect(code).toContain('flutterProc.stderr.on("data",');
    expect(code).toContain("process.stderr.write(");

    // The script must fold the captured output into the thrown Error
    // so the real failure text propagates up to the e2e harness's thrown error.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting exact source code template in script
    expect(code).toContain("throw new Error(`Flutter build failed (exit ${code}):\\n${output}`);");
  });
});
