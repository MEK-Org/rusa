import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { GoogleDriveClient } from "./drive-client.js";

function setupConfigDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "drive-client-test-"));
  writeFileSync(
    join(dir, "client.json"),
    JSON.stringify({
      installed: {
        client_id: "mock-client-id",
        client_secret: "mock-client-secret",
      },
    })
  );
  writeFileSync(
    join(dir, "drive-token.json"),
    JSON.stringify({
      refresh_token: "mock-refresh-token",
    })
  );
  return dir;
}

describe("GoogleDriveClient & DriveOAuth", () => {
  it("refreshes token and lists children of a folder", async () => {
    const dir = setupConfigDir();
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: "mock-access", expires_in: 3600 }), {
          status: 200,
        })
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            files: [
              {
                id: "file-1",
                name: "test-file",
                mimeType: "text/plain",
                parents: ["folder-1"],
              },
            ],
          }),
          { status: 200 }
        )
      );

    const client = new GoogleDriveClient(dir, fetchImpl);
    const children = await client.listChildren("folder-1");

    expect(children).toEqual([
      { id: "file-1", name: "test-file", mimeType: "text/plain", parents: ["folder-1"] },
    ]);
    expect(fetchImpl.mock.calls.map((call) => call[0])).toEqual([
      "https://oauth2.googleapis.com/token",
      "https://www.googleapis.com/drive/v3/files?q=%27folder-1%27+in+parents+and+trashed+%3D+false&fields=nextPageToken%2C+files%28id%2C+name%2C+mimeType%2C+parents%2C+size%2C+modifiedTime%29&pageSize=1000",
    ]);
  });

  it("handles recursive walks correctly", async () => {
    const dir = setupConfigDir();
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: "mock-access", expires_in: 3600 }), {
          status: 200,
        })
      )
      // First page listing folder-1
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            files: [
              {
                id: "subfolder-2",
                name: "subfolder-2",
                mimeType: "application/vnd.google-apps.folder",
                parents: ["folder-1"],
              },
              {
                id: "file-3",
                name: "file-3",
                mimeType: "text/plain",
                parents: ["folder-1"],
              },
            ],
          }),
          { status: 200 }
        )
      )
      // Second page listing subfolder-2
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            files: [
              {
                id: "file-4",
                name: "file-4",
                mimeType: "image/png",
                parents: ["subfolder-2"],
              },
            ],
          }),
          { status: 200 }
        )
      );

    const client = new GoogleDriveClient(dir, fetchImpl);
    const children = await client.listChildren("folder-1", true);

    expect(children).toHaveLength(3);
    expect(children).toContainEqual({
      id: "subfolder-2",
      name: "subfolder-2",
      mimeType: "application/vnd.google-apps.folder",
      parents: ["folder-1"],
    });
    expect(children).toContainEqual({
      id: "file-3",
      name: "file-3",
      mimeType: "text/plain",
      parents: ["folder-1"],
    });
    expect(children).toContainEqual({
      id: "file-4",
      name: "file-4",
      mimeType: "image/png",
      parents: ["subfolder-2"],
    });
  });

  it("retrieves file metadata", async () => {
    const dir = setupConfigDir();
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: "mock-access", expires_in: 3600 }), {
          status: 200,
        })
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: "file-1",
            name: "test-file",
            mimeType: "text/plain",
          }),
          { status: 200 }
        )
      );

    const client = new GoogleDriveClient(dir, fetchImpl);
    const meta = await client.getFileMetadata("file-1");

    expect(meta).toEqual({ id: "file-1", name: "test-file", mimeType: "text/plain" });
  });

  it("downloads a binary file via alt=media", async () => {
    const dir = setupConfigDir();
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: "mock-access", expires_in: 3600 }), {
          status: 200,
        })
      )
      .mockResolvedValueOnce(new Response("raw-file-content", { status: 200 }));

    const client = new GoogleDriveClient(dir, fetchImpl);
    const data = await client.downloadFile("file-1");

    expect(data.toString()).toBe("raw-file-content");
    expect(fetchImpl.mock.calls.map((call) => call[0])).toEqual([
      "https://oauth2.googleapis.com/token",
      "https://www.googleapis.com/drive/v3/files/file-1?alt=media",
    ]);
  });

  it("exports a Google-native document to a portable format", async () => {
    const dir = setupConfigDir();
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: "mock-access", expires_in: 3600 }), {
          status: 200,
        })
      )
      .mockResolvedValueOnce(new Response("exported-pdf-content", { status: 200 }));

    const client = new GoogleDriveClient(dir, fetchImpl);
    const data = await client.exportDoc("doc-1", "application/pdf");

    expect(data.toString()).toBe("exported-pdf-content");
    expect(fetchImpl.mock.calls.map((call) => call[0])).toEqual([
      "https://oauth2.googleapis.com/token",
      "https://www.googleapis.com/drive/v3/files/doc-1/export?mimeType=application%2Fpdf",
    ]);
  });

  it("fails to download a file exceeding the maximum size limit", async () => {
    const dir = setupConfigDir();
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: "mock-access", expires_in: 3600 }), {
          status: 200,
        })
      )
      .mockResolvedValueOnce(new Response("too-large-content", { status: 200 }));

    // Limit to 5 bytes, whereas "too-large-content" is 17 bytes
    const client = new GoogleDriveClient(dir, fetchImpl, "drive-token.json", 5);
    await expect(client.downloadFile("file-1")).rejects.toThrow("file size limit exceeded");
  });

  it("fails to export a document exceeding the maximum size limit", async () => {
    const dir = setupConfigDir();
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: "mock-access", expires_in: 3600 }), {
          status: 200,
        })
      )
      .mockResolvedValueOnce(new Response("too-large-export", { status: 200 }));

    // Limit to 5 bytes
    const client = new GoogleDriveClient(dir, fetchImpl, "drive-token.json", 5);
    await expect(client.exportDoc("doc-1", "application/pdf")).rejects.toThrow(
      "file size limit exceeded"
    );
  });

  it("fails closed on non-streamable response body", async () => {
    const dir = setupConfigDir();
    const mockResp = new Response("", { status: 200 });
    Object.defineProperty(mockResp, "body", {
      get() {
        return {}; // present, but neither getReader nor [Symbol.asyncIterator]
      },
    });

    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: "mock-access", expires_in: 3600 }), {
          status: 200,
        })
      )
      .mockResolvedValueOnce(mockResp);

    const client = new GoogleDriveClient(dir, fetchImpl);
    await expect(client.downloadFile("file-1")).rejects.toThrow(
      "cannot enforce size limit: response body is not streamable"
    );
  });

  it("cancels the stream reader when the file exceeds the size limit", async () => {
    const dir = setupConfigDir();
    const mockCancel = vi.fn().mockResolvedValue(undefined);
    const mockReader = {
      read: vi
        .fn()
        .mockResolvedValueOnce({ done: false, value: new Uint8Array([1, 2, 3]) })
        .mockResolvedValueOnce({ done: false, value: new Uint8Array([4, 5, 6]) }),
      cancel: mockCancel,
      releaseLock: vi.fn(),
    };
    const mockBody = {
      getReader: () => mockReader,
    };
    const mockResp = new Response("", { status: 200 });
    Object.defineProperty(mockResp, "body", {
      get() {
        return mockBody;
      },
    });

    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: "mock-access", expires_in: 3600 }), {
          status: 200,
        })
      )
      .mockResolvedValueOnce(mockResp);

    // Set maxSizeBytes = 4. The first read (3 bytes) is fine, the second read (3 bytes, total 6) triggers the limit.
    const client = new GoogleDriveClient(dir, fetchImpl, "drive-token.json", 4);
    await expect(client.downloadFile("file-1")).rejects.toThrow("file size limit exceeded");
    expect(mockCancel).toHaveBeenCalled();
  });
});
