import { createHash } from "node:crypto";
import { type Dirent, existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { captureRawInput } from "./ingest.js";

/**
 * Recursively find all markdown files in a directory.
 */
function findMarkdownFiles(dir: string): string[] {
  const results: string[] = [];
  if (!existsSync(dir)) return results;

  let list: Dirent[] = [];
  try {
    list = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    console.warn(`[seed] Warning: Could not read directory ${dir}: ${err}`);
    return results;
  }

  for (const file of list) {
    const filePath = join(dir, String(file.name));
    if (file.isDirectory()) {
      // Skip common ignore directories to avoid massive scans
      if (
        ["node_modules", ".git", "dist", "build", ".rusa", "target", "vendor"].includes(
          String(file.name)
        )
      ) {
        continue;
      }
      results.push(...findMarkdownFiles(filePath));
    } else if (file.isFile() && String(file.name).endsWith(".md")) {
      results.push(filePath);
    }
  }
  return results;
}

/**
 * Safety limit: if a target directory contains more than this many .md files,
 * skip the sync entirely and warn. Protects against repos whose .md files are
 * test fixtures or generated content rather than documentation.
 * Raise this constant if a legitimate documentation repo exceeds it.
 */
const MARKDOWN_SYNC_FILE_LIMIT = 100;

/**
 * Continuously sync markdown files from the target directory into understanding.
 * Reads all .md files and inserts them as raw inputs if their content hash hasn't been seen before.
 */
export function syncMarkdownToUnderstanding(repoPath: string, repo: string | null = null): void {
  const markdownFiles = findMarkdownFiles(repoPath);

  if (markdownFiles.length > MARKDOWN_SYNC_FILE_LIMIT) {
    console.warn(
      `[seed] ⚠️ Skipping markdown sync for ${repo ?? repoPath}: found ${markdownFiles.length} .md files, ` +
        `which exceeds the safety limit of ${MARKDOWN_SYNC_FILE_LIMIT}. ` +
        `If this repo intentionally has many .md files, set disableMarkdownSync: true in the target config ` +
        `to silence this warning, or raise MARKDOWN_SYNC_FILE_LIMIT in seed.ts.`
    );
    return;
  }

  for (const fullPath of markdownFiles) {
    const relativePath = relative(repoPath, fullPath);
    let content: string;
    try {
      content = readFileSync(fullPath, "utf-8").trim();
    } catch (err) {
      console.warn(`[seed] Warning: Could not read file ${fullPath}: ${err}`);
      continue;
    }
    if (!content) continue;

    const contentHash = createHash("sha256").update(content).digest("hex").slice(0, 8);
    // Use repo in ID if available to allow same relative file path in different repos
    const providerEventId = `markdown:${repo ?? "global"}:${relativePath}:${contentHash}`;

    captureRawInput({
      providerEventId,
      platform: "manual",
      repo,
      issueNumber: null,
      prNumber: null,
      author: "system",
      content,
      metadata: { source: "markdown_sync", file: relativePath },
    });
  }
}
