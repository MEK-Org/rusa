import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { closeDb, getDb, initDb } from "../db/index.js";
import { syncMarkdownToUnderstanding } from "./seed.js";

let mcHome = "";
let repoDir = "";

beforeEach(() => {
  closeDb();
  mcHome = mkdtempSync(join(tmpdir(), "rusa-seed-test-"));
  repoDir = join(mcHome, "repo");
  mkdirSync(repoDir, { recursive: true });
  initDb(mcHome);
});

afterEach(() => {
  closeDb();
  vi.restoreAllMocks();
  if (mcHome) {
    rmSync(mcHome, { recursive: true, force: true });
    mcHome = "";
    repoDir = "";
  }
});

it("syncs markdown files when the repo stays within the safety limit", () => {
  writeFileSync(join(repoDir, "README.md"), "# Hello\n", "utf8");
  mkdirSync(join(repoDir, "docs"), { recursive: true });
  writeFileSync(join(repoDir, "docs", "guide.md"), "Guide body\n", "utf8");

  syncMarkdownToUnderstanding(repoDir, "dummy-org/dummy-repo");

  const rows = getDb()
    .prepare(`SELECT provider_event_id, metadata FROM raw_inputs ORDER BY provider_event_id ASC`)
    .all() as Array<{ provider_event_id: string; metadata: string | null }>;

  expect(rows).toHaveLength(2);
  expect(rows.map((row) => row.provider_event_id)).toEqual([
    expect.stringContaining("markdown:dummy-org/dummy-repo:README.md:"),
    expect.stringContaining("markdown:dummy-org/dummy-repo:docs/guide.md:"),
  ]);
});

it("skips markdown sync entirely when the repo exceeds the safety limit", () => {
  const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  for (let i = 0; i < 101; i++) {
    writeFileSync(join(repoDir, `doc-${i}.md`), `content ${i}\n`, "utf8");
  }

  syncMarkdownToUnderstanding(repoDir, "dummy-org/dummy-repo");

  const row = getDb().prepare(`SELECT COUNT(*) AS cnt FROM raw_inputs`).get() as { cnt: number };

  expect(row.cnt).toBe(0);
  expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("exceeds the safety limit of 100"));
});
