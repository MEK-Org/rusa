import { defaultGchatConfigDir } from "../chat/gchat-oauth.js";
import { DriveOAuth } from "./drive-oauth.js";

const DRIVE_API = "https://www.googleapis.com/drive/v3";

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
  downloadFile(fileId: string): Promise<Buffer>;
  exportDoc(fileId: string, mimeType: string): Promise<Buffer>;
}

export class GoogleDriveClient implements DriveClient {
  private readonly oauth: DriveOAuth;

  private readonly maxSizeBytes: number;

  constructor(
    configDir = defaultGchatConfigDir(),
    private readonly fetchImpl: typeof fetch = fetch,
    tokenFilename = "drive-token.json",
    maxSizeBytes = 50 * 1024 * 1024 // 50MB default
  ) {
    this.oauth = new DriveOAuth(configDir, fetchImpl, tokenFilename);
    this.maxSizeBytes = maxSizeBytes;
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
      return Buffer.concat(chunks.map((c) => Buffer.from(c)));
    }

    // Node.js Readable stream or async iterator
    // Note: JavaScript specification guarantees that a 'for await...of' loop
    // automatically calls iterator.return() if aborted early (e.g. by throw).
    if (
      body &&
      typeof (body as unknown as AsyncIterable<unknown>)[Symbol.asyncIterator] === "function"
    ) {
      const chunks: Buffer[] = [];
      let totalSize = 0;
      for await (const chunk of body as unknown as AsyncIterable<Uint8Array | string>) {
        const buf = Buffer.from(chunk);
        totalSize += buf.length;
        if (totalSize > maxBytes) {
          throw new Error(`file size limit exceeded: file is larger than ${maxBytes} bytes`);
        }
        chunks.push(buf);
      }
      return Buffer.concat(chunks);
    }

    // Fallback - fail closed on non-streamable bodies
    throw new Error("cannot enforce size limit: response body is not streamable");
  }

  async downloadFile(fileId: string): Promise<Buffer> {
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
    return this.readBodyWithLimit(resp, this.maxSizeBytes);
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
    return this.readBodyWithLimit(resp, this.maxSizeBytes);
  }
}
