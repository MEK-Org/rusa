import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Explicit executable paths. No inherited credentials or prompt commands.
const [supervisorPath, nodePath, piPath] = process.argv.slice(2);
assert(supervisorPath && nodePath && piPath, "Expected supervisor bundle, Node, Pi CLI paths");
const { runSubprocess } = await import(pathToFileURL(resolve(supervisorPath)).href);
const node = resolve(nodePath);
const pi = resolve(piPath);

for (const scenario of ["baseline", "untrusted-poison", "trusted-control"]) {
  const root = await mkdtemp(join(tmpdir(), "pi-offline-"));
  let transport;
  let failure;
  let closing;
  let buffer = "";
  let stderr = "";
  const responses = [];
  const migrationLine = "Migrated Project commands/ → prompts/";
  const hasMigrationFixture = scenario === "untrusted-poison";
  const cwd = join(root, "work");
  const marker = "Synthetic migration marker. No prompt or credential.\n";
  const commands = [
    { id: "state", type: "get_state" },
    { id: "levels", type: "get_available_thinking_levels" },
    { id: "retry", type: "set_auto_retry", enabled: false },
    { id: "compaction", type: "set_auto_compaction", enabled: false },
    { id: "final", type: "get_state" },
  ];
  const env = {
    HOME: join(root, "home"),
    PI_CODING_AGENT_DIR: join(root, "agent"),
    PI_OFFLINE: "1",
    PI_SKIP_VERSION_CHECK: "1",
    PI_TELEMETRY: "0",
    NODE_COMPILE_CACHE: join(root, "compile-cache"),
  };
  const args = [
    pi,
    "--mode",
    "rpc",
    "--no-session",
    "--no-tools",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-context-files",
    "--no-themes",
    scenario === "trusted-control" ? "--approve" : "--no-approve",
    "--provider",
    "openrouter",
    "--model",
    "anthropic/claude-sonnet-4",
  ];
  const settings = (enabled) =>
    JSON.stringify({
      cacheWarming: "off",
      retry: { enabled: false },
      compaction: { enabled },
      defaultProvider: "openai",
      defaultModel: "deliberately-conflicting-model",
    });
  const fail = (error) => {
    failure ??= error;
    closing = transport.close();
  };
  const send = () => {
    void transport.write(JSON.stringify(commands[responses.length]) + "\n").catch(fail);
  };
  try {
    for (const dir of ["home/.pi/agent", "agent", "work/.pi"]) {
      await mkdir(join(root, dir), { recursive: true });
    }
    await writeFile(join(root, "agent/settings.json"), settings(false));
    if (scenario !== "baseline") {
      await writeFile(join(root, "home/.pi/agent/settings.json"), settings(true));
      await writeFile(join(root, "work/.pi/settings.json"), settings(true));
    }
    if (hasMigrationFixture) {
      for (const dir of ["work/.pi/commands", "home/.pi/agent/commands"]) {
        await mkdir(join(root, dir), { recursive: true });
        await writeFile(join(root, dir, "marker.md"), marker);
      }
    }
    console.log(JSON.stringify({ scenario, command: node, args, env, cwd, commands }));
    const result = await runSubprocess({
      command: node,
      args,
      env,
      cwd,
      timeoutMs: 20000,
      onDuplex(t) {
        transport = t;
        send();
      },
      handleStdoutData(chunk) {
        buffer += chunk.toString();
        for (;;) {
          const end = buffer.indexOf("\n");
          if (end < 0) break;
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 1);
          try {
            const response = JSON.parse(line);
            console.log(JSON.stringify({ scenario, received: response }));
            if (response.type !== "response") continue;
            const command = commands[responses.length];
            assert(command, "Unexpected extra response");
            assert.equal(response.id, command.id);
            assert.equal(response.command, command.type);
            assert.equal(response.success, true);
            responses.push(response);
            if (responses.length === commands.length) closing = transport.close();
            else send();
          } catch (error) {
            fail(error);
          }
        }
      },
      handleStderrData(chunk) {
        stderr += chunk.toString();
      },
      buildKilledResult() {
        return { success: false, output: "deadline", exitCode: 1 };
      },
      buildSignalResult(_output, signal) {
        return { success: true, output: signal, exitCode: 0 };
      },
      buildExitResult(output, exitCode) {
        return { success: false, output, exitCode };
      },
      buildSpawnErrorResult(error) {
        return { success: false, output: error.message, exitCode: 1 };
      },
    });
    await closing;
    console.log(JSON.stringify({ scenario, result, stderr }));
    if (failure) throw failure;
    assert.equal(responses.length, commands.length);
    for (const index of [0, 4]) {
      const state = responses[index].data;
      assert.equal(state.model.provider, "openrouter");
      assert.equal(state.model.id, "anthropic/claude-sonnet-4");
      assert.equal(state.messageCount, 0);
      assert.equal(state.pendingMessageCount, 0);
      assert.equal(state.isStreaming, false);
      assert.equal(state.sessionFile, undefined);
      // Observed Pi 0.99.2 precedence, not desired behavior or a classified upstream bug.
      assert.equal(state.autoCompactionEnabled, scenario === "trusted-control");
    }
    assert.deepEqual(responses[1].data.levels, ["off", "minimal", "low", "medium", "high"]);
    assert.equal(result.output, "SIGKILL");
    assert.equal(stderr, hasMigrationFixture ? `${migrationLine}\n` : "");
    assert.equal(buffer, "");
    if (hasMigrationFixture) {
      await assert.rejects(access(join(root, "work/.pi/commands")), { code: "ENOENT" });
      assert.equal(await readFile(join(root, "work/.pi/prompts/marker.md"), "utf8"), marker);
      assert.equal(await readFile(join(root, "home/.pi/agent/commands/marker.md"), "utf8"), marker);
      await assert.rejects(access(join(root, "home/.pi/agent/prompts")), { code: "ENOENT" });
      console.log(
        JSON.stringify({
          scenario,
          projectCommands: "renamed-to-prompts-marker-preserved",
          ambientCommands: "unchanged-no-prompts",
        })
      );
    }
    // Pi calls enableCompileCache() before main. Its cache belongs to this launch.
    await access(env.NODE_COMPILE_CACHE);
    console.log(JSON.stringify({ scenario, compileCache: "present-inside-launch" }));
    console.log(JSON.stringify({ scenario, assertions: "pass" }));
  } finally {
    await transport?.close();
    await rm(root, { recursive: true, force: true });
    await assert.rejects(access(root), { code: "ENOENT" });
    console.log(JSON.stringify({ scenario, cleanup: "ENOENT" }));
  }
}
