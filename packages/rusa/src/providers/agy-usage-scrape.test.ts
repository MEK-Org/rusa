import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { buildTmuxScript, isAgyQuotaPanelReady } from "./agy-usage-scrape.js";

const fixture = (path: string) => readFileSync(new URL(path, import.meta.url), "utf-8");

// Sanitized frames: a startup screen behind the model-announcement banner with
// `/usage` still in the prompt, the panel's loading placeholder, and a full
// Models & Quota view.
const FRAMES = {
  banner: fixture("./fixtures/agy-usage-banner.txt"),
  loading: fixture("./fixtures/agy-usage-loading.txt"),
  panel: fixture("../mcp/fixtures/agy-usage.txt"),
};

const PROMPT = " Antigravity CLI\n Signed in · Google AI Pro\n\n >\n\n ? for shortcuts\n";

// A fake tmux: the pane shows $FAKE_PROMPT until `/usage` + Enter, then
// $FAKE_PANEL. Every key sent is logged, and each pane capture after `/usage`
// is counted.
const FAKE_TMUX = [
  "#!/usr/bin/env bash",
  "set -u",
  'STATE="$FAKE_TMUX_STATE"',
  'case "$3" in',
  "  send-keys)",
  // The key is the last argument.
  "    for key; do :; done",
  '    printf "%s\\n" "$key" >> "$STATE/keys"',
  '    [ "$key" = "/usage" ] && : > "$STATE/typed"',
  '    [ "$key" = "Enter" ] && [ -e "$STATE/typed" ] && : > "$STATE/opened"',
  "    exit 0 ;;",
  "  capture-pane)",
  '    if [ -e "$STATE/opened" ]; then',
  '      printf "x" >> "$STATE/panel_captures"',
  '      cat "$FAKE_PANEL"',
  "    else",
  '      cat "$FAKE_PROMPT"',
  "    fi",
  "    exit 0 ;;",
  "esac",
  "exit 0",
].join("\n");

const TIMING = { readyTries: 5, panelTries: 4, pollSecs: 0.05 };

function runScript(prompt: string, panel: string) {
  const dir = mkdtempSync(join(tmpdir(), "agy-scrape-faketmux-"));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  const state = join(dir, "state");
  mkdirSync(state);
  writeFileSync(join(dir, "tmux"), FAKE_TMUX, { mode: 0o755 });
  writeFileSync(join(dir, "prompt.txt"), prompt);
  writeFileSync(join(dir, "panel.txt"), panel);
  const res = spawnSync("bash", ["-c", buildTmuxScript("agy", join(dir, "probe.sock"), TIMING)], {
    encoding: "utf-8",
    env: {
      ...process.env,
      PATH: `${dir}:${process.env.PATH ?? ""}`,
      FAKE_TMUX_STATE: state,
      FAKE_PROMPT: join(dir, "prompt.txt"),
      FAKE_PANEL: join(dir, "panel.txt"),
    },
  });
  const read = (name: string) =>
    existsSync(join(state, name)) ? readFileSync(join(state, name), "utf-8") : "";
  return {
    code: res.status,
    stdout: res.stdout ?? "",
    keys: read("keys").split("\n").filter(Boolean),
    panelCaptures: read("panel_captures").length,
  };
}

describe("agy /usage panel readiness (#982)", () => {
  it.each([
    ["banner", false],
    ["loading", false],
    ["panel", true],
  ] as const)("treats the %s frame as ready=%s", (frame, ready) => {
    expect(isAgyQuotaPanelReady(FRAMES[frame])).toBe(ready);
  });

  it.each([
    ["banner", false],
    ["loading", false],
    ["panel", true],
  ] as const)("the script's panel wait agrees with the predicate on the %s frame", (frame, ready) => {
    const r = runScript(PROMPT, FRAMES[frame]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(FRAMES[frame].trim());
    // A ready frame ends the wait on its first poll; anything else polls
    // out the bounded budget. One more capture is the final read.
    expect(r.panelCaptures).toBe((ready ? 1 : TIMING.panelTries) + 1);
  });

  it("dismisses the model-announcement banner before typing /usage, only when it is on screen", () => {
    const withBanner = runScript(FRAMES.banner, FRAMES.panel);
    expect(withBanner.keys.slice(0, 3)).toEqual(["Escape", "/usage", "Enter"]);

    const plain = runScript(PROMPT, FRAMES.panel);
    expect(plain.keys.slice(0, 2)).toEqual(["/usage", "Enter"]);
  });
});
