#!/usr/bin/env node
// Standalone failure notifier . systemd invokes this via
// `OnFailure=rusa-alert.service` when the daemon fails (e.g. a crash-loop
// that trips StartLimit). It messages a Google Chat space using ONLY the stored
// OAuth creds in ~/.config/gchat and Node built-ins (global fetch).
//
// Deliberately STANDALONE + build-independent: it must still fire when the
// rusa build is broken — which is exactly when OnFailure runs — so it never
// imports the built dist.
//
// Chat-independent fallback (elder fix #5): chat depends on OAuth creds + network,
// which may be stale/down precisely when we most need to alert. So this ALWAYS
// emits a journal ERROR line (stderr → the unit's journal) AND writes a marker
// file, then attempts chat best-effort. There is always SOME signal even if chat
// fails.
//
// Usage: node notify-failure.mjs <message...>
//   space:  $RUSA_ERROR_CHAT (resource name, e.g. spaces/AAAA)
//   creds:  $GCHAT_CONFIG_DIR (default ~/.config/gchat)
//   marker: $RUSA_HOME/alerts/last-failure.txt (default ~/.rusa)

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const CHAT_API = "https://chat.googleapis.com/v1";
const CONFIG_DIR = process.env.GCHAT_CONFIG_DIR || join(homedir(), ".config", "gchat");
const MC_HOME = process.env.RUSA_HOME || join(homedir(), ".rusa");
const MARKER = join(MC_HOME, "alerts", "last-failure.txt");

const message = process.argv.slice(2).join(" ") || "rusa.service entered a failed state";
const space = process.env.RUSA_ERROR_CHAT;
const stamp = new Date().toISOString();
const line = `[${stamp}] ${message}`;

// 1) ALWAYS: journal ERROR line (stderr is captured by the unit's journal).
console.error(`rusa-alert: ${line}`);

// 2) ALWAYS: durable marker file (survives even if chat + journal are unreadable).
try {
  mkdirSync(dirname(MARKER), { recursive: true });
  appendFileSync(MARKER, `${line}\n`, "utf-8");
} catch (err) {
  console.error(`rusa-alert: marker write failed — ${err.message}`);
}

function readJson(name) {
  return JSON.parse(readFileSync(join(CONFIG_DIR, name), "utf-8"));
}

async function accessToken() {
  const { installed } = readJson("client.json");
  const { refresh_token } = readJson("token.json");
  const resp = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: installed.client_id,
      client_secret: installed.client_secret,
      refresh_token,
      grant_type: "refresh_token",
    }),
  });
  if (!resp.ok) throw new Error(`token refresh HTTP ${resp.status}: ${await resp.text()}`);
  return (await resp.json()).access_token;
}

// 3) BEST-EFFORT: Google Chat. Failure here is non-fatal — the journal + marker
// already carried the signal — but we exit non-zero so the alert unit's own status
// reflects that chat didn't go through.
async function chat() {
  if (!space) {
    console.error("rusa-alert: RUSA_ERROR_CHAT unset — skipping chat (journal+marker only)");
    return false;
  }
  const token = await accessToken();
  const resp = await fetch(`${CHAT_API}/${space}/messages`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ text: `❌ ${message}` }),
  });
  if (!resp.ok) throw new Error(`chat send HTTP ${resp.status}: ${await resp.text()}`);
  console.error(`rusa-alert: chat sent to ${space}`);
  return true;
}

chat()
  .then((sent) => process.exit(sent ? 0 : 1))
  .catch((err) => {
    console.error(`rusa-alert: chat FAILED — ${err.message} (journal+marker still emitted)`);
    process.exit(1);
  });
