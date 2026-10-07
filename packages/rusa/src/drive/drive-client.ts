import { boundedResponse } from "../chat/bounded-response.js";
import { defaultGchatConfigDir } from "../chat/gchat-oauth.js";
import { DriveOAuth } from "./drive-oauth.js";

const DRIVE_API = "https://www.googleapis.com/drive/v3";

/** Default ceiling for downloaded Drive files. */
export const MAX_DRIVE_FILE_DOWNLOAD_BYTES = 1024 * 1024 * 1024; // 1 GiB

const MAX_DRIVE_EXPORT_BYTES = 50 * 1024 * 1024; // 50 MiB

export interface DriveFileMetadata {
  id: string;
  name: string;
  mimeType: string;
  parents?: string[];
  size?: string;
  modifiedTime?: string;
}

export interface DriveClient {
  listChildren(folderId: string, recursive?: boolean): Promise<DriveFileMetadata[]>;
  getFileMetadata(fileId: string): Promise<DriveFileMetadata>;
  /** Stream a file's response; `maxBytes` can only lower the client's configured limit. */
  downloadFileStream(fileId: string, maxBytes?: number): Promise<Response>;
  exportDoc(fileId: string, mimeType: string): Promise<Buffer>;
}

export class GoogleDriveClient implements DriveClient {
  private readonly oauth: DriveOAuth;

  private readonly maxDownloadSizeBytes: number;

  private readonly maxExportSizeBytes: number;

  constructor(
    configDir = defaultGchatConfigDir(),
    private readonly fetchImpl: typeof fetch = fetch,
    tokenFilename = "drive-token.json",
    maxSizeBytes?: number
  ) {
    this.oauth = new DriveOAuth(configDir, fetchImpl, tokenFilename);
    this.maxDownloadSizeBytes = maxSizeBytes ?? MAX_DRIVE_FILE_DOWNLOAD_BYTES;
    this.maxExportSizeBytes = maxSizeBytes ?? MAX_DRIVE_EXPORT_BYTES;
  }

  private async get(path: string, query?: Record<string, string>): Promise<unknown> {
    const token = await this.oauth.token();
    const qs = query ? `?${new URLSearchParams(query).toString()}` : "";
    const resp = await this.fetchImpl(`${DRIVE_API}/${path}${qs}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!resp.ok) {
      throw new Error(
        `drive GET ${path} -> HTTP ${resp.status} ${(await resp.text()).slice(0, 300)}`
      );
    }
    return resp.json();
  }

  async listChildren(folderId: string, recursive?: boolean): Promise<DriveFileMetadata[]> {
    if (!recursive) {
      return this.listPage(folderId);
    }

    const accumulated: DriveFileMetadata[] = [];
    const queue = [folderId];
    const visited = new Set<string>([folderId]);

    while (queue.length > 0) {
      const current = queue.shift();
      if (current === undefined) {
        break;
      }
      const children = await this.listPage(current);
      accumulated.push(...children);

      for (const child of children) {
        if (child.mimeType === "application/vnd.google-apps.folder") {
          if (!visited.has(child.id)) {
            visited.add(child.id);
            queue.push(child.id);
          }
        }
      }
    }

    return accumulated;
  }

  private async listPage(folderId: string): Promise<DriveFileMetadata[]> {
    const files: DriveFileMetadata[] = [];
    let pageToken: string | undefined;
    do {
      const query: Record<string, string> = {
        q: `'${folderId}' in parents and trashed = false`,
        fields: "nextPageToken, files(id, name, mimeType, parents, size, modifiedTime)",
        pageSize: "1000",
      };
      if (pageToken) {
        query.pageToken = pageToken;
      }
      const res = (await this.get("files", query)) as {
        files?: DriveFileMetadata[];
        nextPageToken?: string;
      };
      files.push(...(res.files ?? []));
      pageToken = res.nextPageToken;
    } while (pageToken);
    return files;
  }

  async getFileMetadata(fileId: string): Promise<DriveFileMetadata> {
    return (await this.get(`files/${encodeURIComponent(fileId)}`, {
      fields: "id, name, mimeType, parents, size, modifiedTime",
    })) as DriveFileMetadata;
  }

  private async readBodyWithLimit(resp: Response, maxBytes: number): Promise<Buffer> {
    const body = resp.body;
    if (!body) {
      return Buffer.alloc(0);
    }

    // Web Stream ReadableStreamReader
    if (typeof (body as unknown as ReadableStream).getReader === "function") {
      const reader = (body as unknown as ReadableStream).getReader();
      const chunks: Uint8Array[] = [];
      let totalSize = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) {
            totalSize += value.byteLength;
            if (totalSize > maxBytes) {
              throw new Error(`file size limit exceeded: file is larger than ${maxBytes} bytes`);
            }
            chunks.push(value);
          }
        }
      } catch (err) {
        try {
          await reader.cancel(err instanceof Error ? err.message : String(err));
        } catch (_) {}
        throw err;
      } finally {
        reader.releaseLock();
      }
      return Buffer.concat(chunks);
    }

    // Node.js Readable stream or async iterator
    // Note: JavaScript specification guarantees that a 'for await...of' loop
    // automatically calls iterator.return() if aborted early (e.g. by throw).
    if (
      body &&
      typeof (body as unknown as AsyncIterable<unknown>)[Symbol.asyncIterator] === "function"
    ) {
      const chunks: Uint8Array[] = [];
      let totalSize = 0;
      for await (const chunk of body as unknown as AsyncIterable<Uint8Array | string>) {
        const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
        totalSize += buf.byteLength;
        if (totalSize > maxBytes) {
          try {
            await resp.body?.cancel();
          } catch (_) {}
          throw new Error(`file size limit exceeded: file is larger than ${maxBytes} bytes`);
        }
        chunks.push(buf);
      }
      return Buffer.concat(chunks);
    }

    // Fallback - fail closed on non-streamable bodies
    throw new Error("cannot enforce size limit: response body is not streamable");
  }

  async downloadFileStream(fileId: string, maxBytes?: number): Promise<Response> {
    const token = await this.oauth.token();
    const resp = await this.fetchImpl(
      `${DRIVE_API}/files/${encodeURIComponent(fileId)}?alt=media`,
      {
        headers: { authorization: `Bearer ${token}` },
      }
    );
    if (!resp.ok) {
      throw new Error(
        `drive download ${fileId} -> HTTP ${resp.status} ${(await resp.text()).slice(0, 300)}`
      );
    }
    return boundedResponse(resp, this.downloadLimit(maxBytes), "file");
  }

  /** A per-call limit can lower the configured limit, never raise it. */
  private downloadLimit(maxBytes?: number): number {
    return Math.min(this.maxDownloadSizeBytes, maxBytes ?? this.maxDownloadSizeBytes);
  }

  async exportDoc(fileId: string, mimeType: string): Promise<Buffer> {
    const token = await this.oauth.token();
    const resp = await this.fetchImpl(
      `${DRIVE_API}/files/${encodeURIComponent(fileId)}/export?mimeType=${encodeURIComponent(mimeType)}`,
      {
        headers: { authorization: `Bearer ${token}` },
      }
    );
    if (!resp.ok) {
      throw new Error(
        `drive export ${fileId} -> HTTP ${resp.status} ${(await resp.text()).slice(0, 300)}`
      );
    }
    return this.readBodyWithLimit(resp, this.maxExportSizeBytes);
  }
}
