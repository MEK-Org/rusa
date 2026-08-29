import { EventEmitter, once } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DashboardMeshRefs } from "./server.js";
import { createDashboardRequestHandler } from "./server.js";

/**
 * The static-serving branch brands the shell and the PWA manifest with this
 * instance's configured root actor (an issue). The asset module is mocked
 * because CI does not run `build:dashboard-ui`, so there is no real bundle on
 * disk to serve — the transforms themselves are covered in `dashboard/branding`.
 */

const INDEX_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta name="apple-mobile-web-app-title" content="Rusa">
  <link rel="apple-touch-icon" href="icons/Icon-192.png">
  <link rel="icon" type="image/svg+xml" href="favicon.svg"/>
  <title>Rusa</title>
  <link rel="manifest" href="manifest.json">
</head>
<body></body>
</html>
`;

const MANIFEST_JSON = JSON.stringify({ name: "Rusa", short_name: "Rusa" }, null, 2);

vi.mock("../dashboard/assets.js", () => ({
  hasDashboardAsset: (name: string) => name === "index.html",
  getDashboardAssetDir: () => "/fake/dashboard-ui-app",
  getDashboardHtml: () => INDEX_HTML,
  getDashboardAsset: (pathname: string) => {
    if (pathname === "/manifest.json") {
      return {
        body: Buffer.from(MANIFEST_JSON),
        contentType: "application/json; charset=utf-8",
      };
    }
    if (pathname === "/index.html") {
      return { body: Buffer.from(INDEX_HTML), contentType: "text/html; charset=utf-8" };
    }
    if (pathname === "/favicon.png") {
      return { body: Buffer.from("png"), contentType: "image/png" };
    }
    return null;
  },
}));

class MockIncomingMessage extends EventEmitter {
  constructor(
    public method: string,
    public url: string
  ) {
    super();
  }
  headers: Record<string, string | undefined> = {};
}

class MockServerResponse extends EventEmitter {
  statusCode = 200;
  headers: Record<string, string> = {};
  body = "";

  writeHead(statusCode: number, headers?: Record<string, string>): this {
    this.statusCode = statusCode;
    this.headers = headers ?? {};
    return this;
  }

  end(body?: string | Buffer): this {
    if (body) this.body += body.toString();
    this.emit("finish");
    return this;
  }
}

/** A mesh ref carrying only the root identity the branding path reads. */
function meshWithRoot(rootIdentity: DashboardMeshRefs["rootIdentity"]): DashboardMeshRefs {
  return { rootIdentity } as DashboardMeshRefs;
}

async function get(
  url: string,
  mesh?: DashboardMeshRefs
): Promise<{ statusCode: number; headers: Record<string, string>; body: string }> {
  const handler = createDashboardRequestHandler({ port: 8788, mesh });
  const req = new MockIncomingMessage("GET", url);
  const res = new MockServerResponse();
  const done = once(res, "finish");
  void handler(req as unknown as IncomingMessage, res as unknown as ServerResponse);
  req.emit("end");
  await done;
  return { statusCode: res.statusCode, headers: res.headers, body: res.body };
}

describe("dashboard branding from the configured root actor", () => {
  beforeEach(() => {
    // No uploaded root image in this suite: point the avatar cache at a directory
    // that does not exist, so only the name half of branding applies.
    vi.stubEnv("RUSA_HOME", "/nonexistent/rusa-home-branding-test");
  });

  it("serves the built shell unchanged when no root actor is configured", async () => {
    const res = await get("/");
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("<title>Rusa</title>");
  });

  it("keeps the built name for the default root-actor handle", async () => {
    const res = await get("/", meshWithRoot({ handle: "root-actor" }));
    expect(res.body).toContain("<title>Rusa</title>");
  });

  it("titles the shell with the configured root actor name", async () => {
    const res = await get("/", meshWithRoot({ handle: "ember-familiar" }));
    expect(res.body).toContain("<title>Ember Familiar</title>");
    expect(res.body).toContain('<meta name="apple-mobile-web-app-title" content="Ember Familiar">');
    // The title now varies with config, so it must not be cached past a change.
    expect(res.headers["Cache-Control"]).toBe("no-store");
  });

  it("brands an explicit /index.html request too, not just deep links", async () => {
    const res = await get("/index.html", meshWithRoot({ handle: "ember-familiar" }));
    expect(res.body).toContain("<title>Ember Familiar</title>");
  });

  it("renames the installed PWA in the manifest", async () => {
    const res = await get("/manifest.json", meshWithRoot({ handle: "ember-familiar" }));
    expect(res.statusCode).toBe(200);
    expect(res.headers["Content-Type"]).toBe("application/json; charset=utf-8");
    expect(res.headers["Cache-Control"]).toBe("no-store");
    expect(JSON.parse(res.body)).toMatchObject({
      name: "Ember Familiar",
      short_name: "Ember Familiar",
    });
  });

  it("serves the manifest verbatim when nothing is branded", async () => {
    const res = await get("/manifest.json");
    expect(res.body).toBe(MANIFEST_JSON);
  });

  it("leaves other static assets alone", async () => {
    const res = await get("/favicon.png", meshWithRoot({ handle: "ember-familiar" }));
    expect(res.statusCode).toBe(200);
    expect(res.headers["Content-Type"]).toBe("image/png");
    expect(res.body).toBe("png");
  });
});
