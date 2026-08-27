import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GchatClient } from "./gchat-client.js";

const dirs: string[] = [];

function credentialsDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "rusa-gchat-client-"));
  dirs.push(dir);
  writeFileSync(
    join(dir, "client.json"),
    JSON.stringify({ installed: { client_id: "client", client_secret: "secret" } })
  );
  writeFileSync(join(dir, "token.json"), JSON.stringify({ refresh_token: "refresh" }));
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("GchatClient reads", () => {
  it("gets an exact message through the Chat REST API", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: "token", expires_in: 3600 }), {
          status: 200,
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ name: "spaces/A/messages/M1", text: "original body" }), {
          status: 200,
        })
      );

    const message = await new GchatClient(credentialsDir()).getMessage("spaces/A/messages/M1");

    expect(message).toMatchObject({ name: "spaces/A/messages/M1", text: "original body" });
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      "https://chat.googleapis.com/v1/spaces/A/messages/M1"
    );
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ method: "GET" });
  });

  it("maps pagination and thread options onto messages.list", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: "token", expires_in: 3600 }), {
          status: 200,
        })
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            messages: [{ name: "spaces/A/messages/M1", text: "body" }],
            nextPageToken: "next",
          }),
          { status: 200 }
        )
      );

    const page = await new GchatClient(credentialsDir()).listMessages("spaces/A", {
      pageSize: 50,
      pageToken: "previous",
      threadName: "spaces/A/threads/T1",
      orderBy: "DESC",
      createdAfter: "2026-07-28T10:00:00Z",
      createdBefore: "2026-07-28T12:00:00Z",
      showDeleted: true,
    });

    expect(page).toEqual({
      messages: [{ name: "spaces/A/messages/M1", text: "body" }],
      nextPageToken: "next",
    });
    const url = new URL(String(fetchMock.mock.calls[1]?.[0]));
    expect(`${url.origin}${url.pathname}`).toBe("https://chat.googleapis.com/v1/spaces/A/messages");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      pageSize: "50",
      pageToken: "previous",
      filter:
        'thread.name = spaces/A/threads/T1 AND createTime > "2026-07-28T10:00:00Z" AND createTime < "2026-07-28T12:00:00Z"',
      orderBy: "createTime desc",
      showDeleted: "true",
    });
  });

  it("maps ASC orderBy onto messages.list", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: "token", expires_in: 3600 }), {
          status: 200,
        })
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            messages: [],
          }),
          { status: 200 }
        )
      );

    await new GchatClient(credentialsDir()).listMessages("spaces/A", {
      orderBy: "ASC",
    });

    const url = new URL(String(fetchMock.mock.calls[1]?.[0]));
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      orderBy: "createTime asc",
    });
  });

  it("normalizes an empty list response to an empty messages array", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: "token", expires_in: 3600 }), {
          status: 200,
        })
      )
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));

    await expect(new GchatClient(credentialsDir()).listMessages("spaces/A")).resolves.toEqual({
      messages: [],
    });
  });

  it("lists the current joined members of a space", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: "token", expires_in: 3600 }), {
          status: 200,
        })
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            memberships: [
              { state: "JOINED", member: { name: "users/self", type: "BOT" } },
              { state: "JOINED", member: { name: "users/human", type: "HUMAN" } },
              { state: "INVITED", member: { name: "users/invited", type: "HUMAN" } },
            ],
            nextPageToken: "next",
          }),
          { status: 200 }
        )
      );

    const page = await new GchatClient(credentialsDir()).listSpaceMembers("spaces/A", {
      pageSize: 1000,
      pageToken: "previous",
    });

    expect(page).toEqual({
      members: [
        { name: "users/self", type: "BOT" },
        { name: "users/human", type: "HUMAN" },
      ],
      nextPageToken: "next",
    });
    const url = new URL(String(fetchMock.mock.calls[1]?.[0]));
    expect(`${url.origin}${url.pathname}`).toBe("https://chat.googleapis.com/v1/spaces/A/members");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      pageSize: "1000",
      pageToken: "previous",
    });
  });

  it("gets attachment metadata by resource name", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: "token", expires_in: 3600 }), {
          status: 200,
        })
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            name: "spaces/A/messages/M1/attachments/ATT1",
            contentName: "photo.png",
            contentType: "image/png",
            attachmentDataRef: { resourceName: "spaces/A/attachments/UPL1" },
            source: "UPLOADED_CONTENT",
          }),
          { status: 200 }
        )
      );

    const attachment = await new GchatClient(credentialsDir()).getAttachment(
      "spaces/A/messages/M1/attachments/ATT1"
    );

    expect(attachment).toMatchObject({
      name: "spaces/A/messages/M1/attachments/ATT1",
      contentName: "photo.png",
      contentType: "image/png",
    });
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      "https://chat.googleapis.com/v1/spaces/A/messages/M1/attachments/ATT1"
    );
  });

  it("downloads binary attachment contents via the media endpoint", async () => {
    const fileBytes = Buffer.from("fake binary content");
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: "token", expires_in: 3600 }), {
          status: 200,
        })
      )
      .mockResolvedValueOnce(new Response(fileBytes, { status: 200 }));

    const downloaded = await new GchatClient(credentialsDir()).downloadAttachment(
      "spaces/A/attachments/ATT1"
    );

    expect(downloaded).toEqual(fileBytes);
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      "https://chat.googleapis.com/v1/media/spaces%2FA%2Fattachments%2FATT1?alt=media"
    );
  });

  it("resolves human-readable message attachment name via getAttachment before downloading", async () => {
    const fileBytes = Buffer.from("resolved binary content");
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: "token", expires_in: 3600 }), {
          status: 200,
        })
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            name: "spaces/A/messages/M1/attachments/ATT1",
            attachmentDataRef: { resourceName: "spaces/A/attachments/DATAREF_99" },
            source: "UPLOADED_CONTENT",
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(new Response(fileBytes, { status: 200 }));

    const downloaded = await new GchatClient(credentialsDir()).downloadAttachment(
      "spaces/A/messages/M1/attachments/ATT1"
    );

    expect(downloaded).toEqual(fileBytes);
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      "https://chat.googleapis.com/v1/spaces/A/messages/M1/attachments/ATT1"
    );
    expect(fetchMock.mock.calls[2]?.[0]).toBe(
      "https://chat.googleapis.com/v1/media/spaces%2FA%2Fattachments%2FDATAREF_99?alt=media"
    );
  });

  it("rejects downloadAttachment if attachment is a Drive file", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: "token", expires_in: 3600 }), {
          status: 200,
        })
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            name: "spaces/A/messages/M1/attachments/ATT1",
            source: "DRIVE_FILE",
          }),
          { status: 200 }
        )
      );

    await expect(
      new GchatClient(credentialsDir()).downloadAttachment("spaces/A/messages/M1/attachments/ATT1")
    ).rejects.toThrow("is a Drive file");
  });

  it("rejects downloadAttachment if message attachment lacks attachmentDataRef", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: "token", expires_in: 3600 }), {
          status: 200,
        })
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            name: "spaces/A/messages/M1/attachments/ATT1",
            source: "UPLOADED_CONTENT",
          }),
          { status: 200 }
        )
      );

    await expect(
      new GchatClient(credentialsDir()).downloadAttachment("spaces/A/messages/M1/attachments/ATT1")
    ).rejects.toThrow("does not contain an attachmentDataRef");
  });

  it("uploads an attachment via multipart request and returns attachmentDataRef", async () => {
    const fileBytes = Buffer.from("document text");
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: "token", expires_in: 3600 }), {
          status: 200,
        })
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            attachmentDataRef: { resourceName: "spaces/A/attachments/RES1" },
          }),
          { status: 200 }
        )
      );

    const res = await new GchatClient(credentialsDir()).uploadAttachment(
      "spaces/A",
      "doc.txt",
      fileBytes,
      "text/plain"
    );

    expect(res).toEqual({
      attachmentDataRef: { resourceName: "spaces/A/attachments/RES1" },
    });
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      "https://chat.googleapis.com/upload/v1/spaces/A/attachments:upload?upload_type=multipart"
    );
    const headers = fetchMock.mock.calls[1]?.[1]?.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer token");
    expect(headers["content-type"]).toContain("multipart/related; boundary=");
  });

  it("rejects downloadAttachment if Content-Length exceeds maxSizeBytes", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: "token", expires_in: 3600 }), {
          status: 200,
        })
      )
      .mockResolvedValueOnce(
        new Response("hello", {
          status: 200,
          headers: { "content-length": "1000" },
        })
      );

    await expect(
      new GchatClient(credentialsDir(), 500).downloadAttachment("spaces/A/attachments/ATT1")
    ).rejects.toThrow("attachment size limit exceeded");
  });

  it("rejects downloadAttachment if streaming body exceeds maxSizeBytes", async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(50));
        controller.enqueue(new Uint8Array(60));
        controller.close();
      },
    });

    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: "token", expires_in: 3600 }), {
          status: 200,
        })
      )
      .mockResolvedValueOnce(new Response(stream, { status: 200 }));

    await expect(
      new GchatClient(credentialsDir(), 80).downloadAttachment("spaces/A/attachments/ATT1")
    ).rejects.toThrow("attachment size limit exceeded");
  });

  it("rejects uploadAttachment if payload size exceeds maxSizeBytes", async () => {
    const largeBytes = Buffer.alloc(100);

    await expect(
      new GchatClient(credentialsDir(), 50).uploadAttachment(
        "spaces/A",
        "doc.txt",
        largeBytes,
        "text/plain"
      )
    ).rejects.toThrow("attachment size limit exceeded");
  });

  it("sends a message with attachments referencing uploaded data", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: "token", expires_in: 3600 }), {
          status: 200,
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ name: "spaces/A/messages/M1" }), { status: 200 })
      );

    const res = await new GchatClient(credentialsDir()).send("spaces/A", "message with att", {
      threadName: "spaces/A/threads/T1",
      attachments: [{ attachmentDataRef: { resourceName: "spaces/A/attachments/RES1" } }],
    });

    expect(res).toEqual({ name: "spaces/A/messages/M1" });
    const postBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as {
      text: string;
      thread?: { name: string };
      attachment?: Array<{ attachmentDataRef?: { resourceName: string } }>;
    };
    expect(postBody).toEqual({
      text: "message with att",
      thread: { name: "spaces/A/threads/T1" },
      attachment: [{ attachmentDataRef: { resourceName: "spaces/A/attachments/RES1" } }],
    });
  });
});
