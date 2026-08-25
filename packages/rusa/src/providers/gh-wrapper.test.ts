import { exec } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execAsync = promisify(exec);

interface ExecError extends Error {
  code?: number;
  stdout?: string;
  stderr?: string;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
// The path to our wrapper script under development
const wrapperPath = join(__dirname, "../../scripts/gh-hint-wrapper.sh");

describe("gh failure-hint wrapper tests", () => {
  const temps: string[] = [];

  afterEach(() => {
    for (const d of temps) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        // best effort
      }
    }
    temps.length = 0;
  });

  it("should pass through success exit, stdout, and stderr exactly without hint", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "mc-gh-test-"));
    temps.push(tmp);

    // Create a mock gh executable in the temp dir
    const mockGh = join(tmp, "gh");
    writeFileSync(
      mockGh,
      `#!/bin/bash
if [ -n "$MOCK_GH_STDOUT" ]; then
  echo -n "$MOCK_GH_STDOUT"
fi
if [ -n "$MOCK_GH_STDERR" ]; then
  echo -n "$MOCK_GH_STDERR" >&2
fi
exit \${MOCK_GH_EXIT_CODE:-0}
`
    );
    chmodSync(mockGh, 0o755);

    // Run the wrapper with modified PATH pointing to our mock gh
    const { stdout, stderr } = await execAsync(`"${wrapperPath}" arg1 arg2`, {
      env: {
        ...process.env,
        PATH: `${tmp}:${process.env.PATH}`,
        MOCK_GH_STDOUT: "success stdout data",
        MOCK_GH_STDERR: "success stderr data",
        MOCK_GH_EXIT_CODE: "0",
      },
    });

    expect(stdout).toBe("success stdout data");
    expect(stderr).toBe("success stderr data");
  });

  it("should append hint to stderr on failure and preserve exit code", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "mc-gh-test-"));
    temps.push(tmp);

    const mockGh = join(tmp, "gh");
    writeFileSync(
      mockGh,
      `#!/bin/bash
if [ -n "$MOCK_GH_STDOUT" ]; then
  echo -n "$MOCK_GH_STDOUT"
fi
if [ -n "$MOCK_GH_STDERR" ]; then
  echo -n "$MOCK_GH_STDERR" >&2
fi
exit \${MOCK_GH_EXIT_CODE:-1}
`
    );
    chmodSync(mockGh, 0o755);

    // Run the wrapper and expect it to fail
    let error: ExecError | null = null;
    try {
      await execAsync(`"${wrapperPath}" arg1 arg2`, {
        env: {
          ...process.env,
          PATH: `${tmp}:${process.env.PATH}`,
          MOCK_GH_STDOUT: "failure stdout data",
          MOCK_GH_STDERR: "GraphQL: Resource not accessible by personal access token\n",
          MOCK_GH_EXIT_CODE: "42",
        },
      });
    } catch (err: unknown) {
      error = err as ExecError;
    }

    expect(error).not.toBeNull();
    expect(error?.code).toBe(42);
    expect(error?.stdout).toBe("failure stdout data");

    const expectedHint =
      "hint: GitHub writes go through the tracker MCP (it stamps identity and works around the read-only worker PAT). Raw 'gh' writes fail with \"Resource not accessible by personal access token\"; reads on raw gh are fine.\n";

    expect(error?.stderr).toBe(
      `GraphQL: Resource not accessible by personal access token\n${expectedHint}`
    );
  });

  it("should detect self-recursion and exit 127", async () => {
    // To trigger recursion, we mock `realpath` to return `/usr/bin/gh` so it matches the fallback
    let error: ExecError | null = null;
    try {
      // We run via bash -c to define the realpath function and export it
      await execAsync(`realpath() { echo "/usr/bin/gh"; }; export -f realpath; "${wrapperPath}"`, {
        shell: "/bin/bash",
        env: {
          ...process.env,
          // Shadow PATH so the loop falls back to /usr/bin/gh
          PATH: "/usr/sbin:/sbin",
        },
      });
    } catch (err: unknown) {
      error = err as ExecError;
    }

    expect(error).not.toBeNull();
    expect(error?.code).toBe(127);
    expect(error?.stderr).toContain(
      "error: gh wrapper self-recursion detected. Ensure the real gh is installed and accessible."
    );
  });
});
