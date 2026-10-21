import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_CHAT_ATTACHMENT_DOWNLOAD_BYTES } from "../chat/types.js";
import { createFollowerFileOps } from "./follower-file-ops.js";
import type { FollowerFileOperation } from "./protocol.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
}

function credentials(...files: string[]): string {
  const dir = tempDir("rusa-follower-creds-");
  for (const file of files) writeFileSync(join(dir, file), "{}");
  return dir;
}

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

function chatClient(body = "attachment-bytes") {
  return {
    downloadAttachmentStream: vi.fn(async (_resourceName: string, _maxBytes?: number) => ({
      resp: new Response(body),
      name: "spec.pdf",
      contentType: "application/pdf",
    })),
  };
}

function driveClient(body = "drive-bytes") {
  return {
    downloadFileStream: vi.fn(
      async (_fileId: string) => new Response(body, { headers: { "content-type": "text/plain" } })
    ),
  };
}

const chatOp: FollowerFileOperation = {
  kind: "chatAttachmentDownload",
  resourceName: "spaces/A/messages/M1/attachments/ATT1",
  destinationPath: "spec.pdf",
  maxBytes: 1234,
};
const driveOp: FollowerFileOperation = {
  kind: "driveFileDownload",
  fileId: "file-1",
  destinationPath: "out.bin",
};

describe("follower file operations (#1013)", () => {
  it("streams a Chat attachment with this follower's credentials into the actor's root", async () => {
    const credentialDir = credentials("client.json", "token.json");
    const workDir = tempDir("rusa-follower-work-");
    const chat = chatClient();
    const factory = vi.fn(() => chat);
    const run = createFollowerFileOps({ credentialDir, chatClient: factory });

    await expect(run(workDir, chatOp)).resolves.toEqual({
      path: join(workDir, "spec.pdf"),
      bytes: "attachment-bytes".length,
      sha256: sha("attachment-bytes"),
      name: "spec.pdf",
      contentType: "application/pdf",
    });
    expect(readFileSync(join(workDir, "spec.pdf"), "utf8")).toBe("attachment-bytes");
    expect(factory).toHaveBeenCalledWith(credentialDir);
    expect(chat.downloadAttachmentStream).toHaveBeenCalledWith(
      "spaces/A/messages/M1/attachments/ATT1",
      1234
    );
  });

  it("streams a Drive file with this follower's credentials into the actor's root", async () => {
    const credentialDir = credentials("client.json", "drive-token.json");
    const workDir = tempDir("rusa-follower-work-");
    const drive = driveClient();
    const run = createFollowerFileOps({ credentialDir, driveClient: () => drive });

    await expect(run(workDir, driveOp)).resolves.toEqual({
      path: join(workDir, "out.bin"),
      bytes: "drive-bytes".length,
      sha256: sha("drive-bytes"),
      contentType: "text/plain",
    });
    expect(drive.downloadFileStream).toHaveBeenCalledWith("file-1");
  });

  it("refuses with the missing credential files named, before any provider call", async () => {
    const workDir = tempDir("rusa-follower-work-");
    const chat = chatClient();
    const drive = driveClient();
    const run = createFollowerFileOps({
      credentialDir: credentials("client.json"),
      chatClient: () => chat,
      driveClient: () => drive,
    });

    await expect(run(workDir, chatOp)).rejects.toThrow(
      "this follower has no Google Chat credentials: missing token.json"
    );
    await expect(run(workDir, driveOp)).rejects.toThrow(
      "this follower has no Google Drive credentials: missing drive-token.json"
    );
    const none = createFollowerFileOps({ credentialDir: credentials(), driveClient: () => drive });
    await expect(none(workDir, driveOp)).rejects.toThrow(
      "this follower has no Google Drive credentials: missing client.json, drive-token.json"
    );
    expect(chat.downloadAttachmentStream).not.toHaveBeenCalled();
    expect(drive.downloadFileStream).not.toHaveBeenCalled();
  });

  it("refuses a destination outside the actor's root", async () => {
    const workDir = tempDir("rusa-follower-work-");
    const drive = driveClient();
    const run = createFollowerFileOps({
      credentialDir: credentials("client.json", "drive-token.json"),
      driveClient: () => drive,
    });

    await expect(run(workDir, { ...driveOp, destinationPath: "../escape.bin" })).rejects.toThrow(
      "access denied: destinationPath escapes the actor workdir"
    );
    await expect(
      run(workDir, { ...driveOp, destinationPath: join(tempDir("rusa-elsewhere-"), "x.bin") })
    ).rejects.toThrow("access denied: destinationPath escapes the actor workdir");
    expect(drive.downloadFileStream).not.toHaveBeenCalled();
  });

  it("never overwrites an existing file", async () => {
    const workDir = tempDir("rusa-follower-work-");
    writeFileSync(join(workDir, "out.bin"), "keep");
    const run = createFollowerFileOps({
      credentialDir: credentials("client.json", "drive-token.json"),
      driveClient: () => driveClient(),
    });

    await expect(run(workDir, driveOp)).rejects.toThrow(/EEXIST/);
    expect(readFileSync(join(workDir, "out.bin"), "utf8")).toBe("keep");
  });

  it("holds the leader's limit to the follower's own ceiling", async () => {
    const workDir = tempDir("rusa-follower-work-");
    mkdirSync(join(workDir, "sub"));
    const chat = chatClient();
    const run = createFollowerFileOps({
      credentialDir: credentials("client.json", "token.json"),
      chatClient: () => chat,
    });

    await run(workDir, {
      ...chatOp,
      destinationPath: "sub/big.bin",
      maxBytes: MAX_CHAT_ATTACHMENT_DOWNLOAD_BYTES * 4,
    });
    expect(chat.downloadAttachmentStream).toHaveBeenCalledWith(
      chatOp.kind === "chatAttachmentDownload" ? chatOp.resourceName : "",
      MAX_CHAT_ATTACHMENT_DOWNLOAD_BYTES
    );
    await expect(run(workDir, { ...chatOp, maxBytes: 0 })).rejects.toThrow(
      "invalid Chat attachment byte limit"
    );
  });

  it("refuses an operation outside the closed set or with a malformed name", async () => {
    const workDir = tempDir("rusa-follower-work-");
    const chat = chatClient();
    const run = createFollowerFileOps({
      credentialDir: credentials("client.json", "token.json", "drive-token.json"),
      chatClient: () => chat,
    });

    await expect(
      run(workDir, {
        kind: "chatAttachmentUpload",
        destinationPath: "x",
      } as unknown as FollowerFileOperation)
    ).rejects.toThrow("unsupported file operation");
    await expect(
      run(workDir, { ...chatOp, resourceName: "spaces/A/../../etc" } as FollowerFileOperation)
    ).rejects.toThrow("invalid Chat attachment resource name");
    expect(chat.downloadAttachmentStream).not.toHaveBeenCalled();
  });
});
