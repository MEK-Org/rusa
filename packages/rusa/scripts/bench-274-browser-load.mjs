// Disposable #274 browser-path benchmark. It serves only the generated Flutter
// web build and a synthetic /api/mesh/threads response on loopback, then drives
// Chrome through Playwright with a mobile-sized viewport, 4x CPU throttling,
// and Fast-3G-like network shaping. It never contacts a live rusa instance.
//
// Prerequisites:
//   flutter build web --release --web-renderer canvaskit  # in flutter_dashboard
//   NODE_PATH=/usr/local/lib/node_modules node packages/rusa/scripts/bench-274-browser-load.mjs

import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { extname, join, normalize, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";
import { gzipSync } from "node:zlib";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const actors = Number(process.env.ACTORS ?? 1000);
const sweeps = Number(process.env.SWEEPS ?? 5);
const cpuThrottle = Number(process.env.CPU_THROTTLE ?? 4);
const renderWaitMilliseconds = Number(process.env.RENDER_WAIT_MILLISECONDS ?? 30000);
const pageLoadTimeoutMilliseconds = Number(
  process.env.PAGE_LOAD_TIMEOUT_MILLISECONDS ?? renderWaitMilliseconds
);
const buildDirectory = resolve(
  process.env.FLUTTER_WEB_BUILD_DIR ?? "packages/rusa/flutter_dashboard/build/web"
);
const chromeExecutable = process.env.CHROME_EXECUTABLE ?? "/usr/bin/google-chrome";

if (!Number.isSafeInteger(actors) || actors < 1) {
  throw new Error("ACTORS must be an integer >= 1");
}
if (!Number.isSafeInteger(sweeps) || sweeps < 1) {
  throw new Error("SWEEPS must be an integer >= 1");
}
if (!Number.isFinite(cpuThrottle) || cpuThrottle < 1) {
  throw new Error("CPU_THROTTLE must be a number >= 1");
}
if (!Number.isSafeInteger(renderWaitMilliseconds) || renderWaitMilliseconds < 1) {
  throw new Error("RENDER_WAIT_MILLISECONDS must be an integer >= 1");
}
if (!Number.isSafeInteger(pageLoadTimeoutMilliseconds) || pageLoadTimeoutMilliseconds < 1) {
  throw new Error("PAGE_LOAD_TIMEOUT_MILLISECONDS must be an integer >= 1");
}

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ttf": "font/ttf",
  ".woff2": "font/woff2",
};
const responseStartDelayMilliseconds = 150;
const downstreamBytesPerSecond = (1.6 * 1024 * 1024) / 8;
const responseChunkIntervalMilliseconds = 50;

function preview(actor) {
  let state = actor + 1;
  let text = `Synthetic benchmark actor ${actor}. `;
  for (let index = 0; index < 22; index++) {
    state = (Math.imul(state, 1664525) + 1013904223) & 0x7fffffff;
    text += `${state.toString(36).padStart(6, "0")} `;
  }
  return text;
}

function fixture() {
  return {
    halted: false,
    runtimeCursor: { streamId: "bench-stream", revision: 0 },
    threads: Array.from({ length: actors }, (_, actor) => ({
      id: `actor-${actor}`,
      handle: `synthetic-${actor}`,
      parentId: actor === 0 ? null : "actor-0",
      status: "active",
      provider: "synthetic",
      model: "benchmark",
      charterPreview: preview(actor),
      title: `Synthetic actor ${actor}`,
      createdAt: "2026-01-01T00:00:00.000Z",
      runState: "idle",
      chatDisabled: false,
    })),
  };
}

function median(values) {
  return [...values].sort((left, right) => left - right)[Math.floor(values.length / 2)];
}

function contentType(path) {
  return mimeTypes[extname(path)] ?? "application/octet-stream";
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function serveStatic(response, pathname) {
  const relative = pathname === "/" ? "index.html" : pathname.slice(1);
  const file = normalize(join(buildDirectory, relative));
  if (!file.startsWith(`${buildDirectory}${sep}`) && file !== join(buildDirectory, "index.html")) {
    response.writeHead(403).end();
    return;
  }
  try {
    if (!(await stat(file)).isFile()) throw new Error("not-file");
    response.writeHead(200, {
      "content-type": contentType(file),
      "cache-control": "no-store",
    });
    response.end(await readFile(file));
  } catch {
    response.writeHead(404).end();
  }
}

function createBenchServer(body) {
  const gzip = gzipSync(body);
  const warmBody = Buffer.from(
    JSON.stringify({
      halted: false,
      runtimeCursor: { streamId: "bench-stream", revision: 0 },
      threads: [],
    })
  );
  const pendingThreadRequests = [];
  const waitingForThreadRequest = [];
  const streamClients = new Set();
  let threadRequestCount = 0;
  const nextThreadRequest = () =>
    new Promise((resolveThreadRequest) => {
      const release = pendingThreadRequests.shift();
      if (release) {
        resolveThreadRequest(release);
      } else {
        waitingForThreadRequest.push(resolveThreadRequest);
      }
    });
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/api/mesh/threads") {
      const isWarmup = threadRequestCount++ % 2 === 0;
      if (isWarmup) {
        // A real initial empty snapshot warms the Flutter engine and proves
        // the second request traverses the same fetch → parse → state-update
        // path without folding renderer bootstrap into the result.
        response.writeHead(200, {
          "content-type": "application/json; charset=utf-8",
          "content-length": warmBody.length,
          "cache-control": "no-store",
        });
        response.end(warmBody);
        setTimeout(() => {
          for (const client of streamClients) {
            client.write(
              'event: actor_runtime_state\\ndata: {"streamId":"bench-stream","revision":1,"actorId":"synthetic-missing","runState":"idle"}\\n\\n'
            );
          }
        }, 250);
        return;
      }
      // Hold the response until the browser has loaded its static assets and
      // the harness has enabled mobile-network shaping. That makes the
      // reported response span about this API payload rather than 37 MiB of
      // Flutter/CanvasKit bootstrap assets.
      await new Promise((release) => {
        const waiter = waitingForThreadRequest.shift();
        if (waiter) {
          waiter(release);
        } else {
          pendingThreadRequests.push(release);
        }
      });
      // CDP does not consistently throttle loopback traffic. Pace this
      // disposable response explicitly so the browser really receives this
      // compressed payload at the stated mobile-like rate.
      await delay(responseStartDelayMilliseconds);
      response.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "content-encoding": "gzip",
        "content-length": gzip.length,
        "cache-control": "no-store",
      });
      const chunkBytes = Math.floor(
        (downstreamBytesPerSecond * responseChunkIntervalMilliseconds) / 1000
      );
      for (let offset = 0; offset < gzip.length; offset += chunkBytes) {
        response.write(gzip.subarray(offset, offset + chunkBytes));
        if (offset + chunkBytes < gzip.length) {
          await delay(responseChunkIntervalMilliseconds);
        }
      }
      response.end();
      return;
    }
    if (url.pathname === "/api/mesh/stream") {
      response.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      response.write('event: hello\\ndata: {"streamId":"bench-stream"}\\n\\n');
      streamClients.add(response);
      request.once("close", () => {
        streamClients.delete(response);
        response.end();
      });
      return;
    }
    if (url.pathname === "/api/quota") {
      response.writeHead(503, { "content-type": "application/json" }).end("{}");
      return;
    }
    if (url.pathname === "/api/dashboard/config") {
      response.writeHead(404, { "content-type": "application/json" }).end("{}");
      return;
    }
    await serveStatic(response, url.pathname);
  });
  return { server, nextThreadRequest, gzipBytes: gzip.length };
}

async function listen(server) {
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("missing loopback address");
  }
  return `http://127.0.0.1:${address.port}`;
}

async function browserSample(browser, origin, nextThreadRequest) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();
  const session = await context.newCDPSession(page);
  await session.send("Network.enable");
  await session.send("Network.setCacheDisabled", { cacheDisabled: true });
  const webglRenderer = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl") || canvas.getContext("experimental-webgl");
    const extension = gl?.getExtension("WEBGL_debug_renderer_info");
    return extension ? gl.getParameter(extension.UNMASKED_RENDERER_WEBGL) : null;
  });

  const started = performance.now();
  try {
    await page.goto(origin, {
      waitUntil: "domcontentloaded",
      timeout: pageLoadTimeoutMilliseconds,
    });
  } catch {
    await context.close();
    return {
      wallMilliseconds: performance.now() - started,
      responseObserved: false,
      renderCompleted: false,
      timeoutStage: "document-bootstrap",
      webglRenderer,
    };
  }
  const releaseThreads = await Promise.race([
    nextThreadRequest(),
    delay(renderWaitMilliseconds).then(() => null),
  ]);
  if (releaseThreads === null) {
    await context.close();
    return {
      wallMilliseconds: performance.now() - started,
      responseObserved: false,
      renderCompleted: false,
      timeoutStage: "initial-empty-snapshot",
      webglRenderer,
    };
  }
  // The application has finished enough bootstrap to issue its real threads
  // request. Let queued static loads settle before releasing that response;
  // some renderers do not attach a canvas until this first snapshot arrives.
  await page.waitForTimeout(250);
  await session.send("Emulation.setCPUThrottlingRate", { rate: cpuThrottle });
  await session.send("Network.emulateNetworkConditions", {
    offline: false,
    latency: 150,
    downloadThroughput: (1.6 * 1024 * 1024) / 8,
    uploadThroughput: (750 * 1024) / 8,
    connectionType: "cellular3g",
  });
  releaseThreads();
  const responseObserved = await Promise.race([
    page
      .waitForFunction(
        () =>
          performance
            .getEntriesByType("resource")
            .filter((entry) => entry.name.endsWith("/api/mesh/threads") && entry.responseEnd > 0)
            .length >= 2,
        null,
        { timeout: renderWaitMilliseconds }
      )
      .then(() => true),
    delay(renderWaitMilliseconds).then(() => false),
  ]);
  if (!responseObserved) {
    await context.close();
    return {
      wallMilliseconds: performance.now() - started,
      responseObserved: false,
      renderCompleted: false,
      timeoutStage: "response-observation",
      webglRenderer,
    };
  }
  const responseAndFrames = await Promise.race([
    page.evaluate(async () => {
      const entries = performance
        .getEntriesByType("resource")
        .filter((candidate) => candidate.name.endsWith("/api/mesh/threads"));
      const entry = entries.at(-1);
      if (!entry) throw new Error("missing threads resource entry");
      await new Promise((resolveFrame) => requestAnimationFrame(resolveFrame));
      const secondFrame = await new Promise((resolveFrame) => requestAnimationFrame(resolveFrame));
      return {
        responseStart: entry.responseStart,
        responseEnd: entry.responseEnd,
        duration: entry.duration,
        transferSize: entry.transferSize,
        encodedBodySize: entry.encodedBodySize,
        decodedBodySize: entry.decodedBodySize,
        secondFrame,
      };
    }),
    delay(renderWaitMilliseconds).then(() => null),
  ]);
  if (responseAndFrames === null) {
    await context.close();
    return {
      wallMilliseconds: performance.now() - started,
      responseObserved: true,
      renderCompleted: false,
      timeoutStage: "two-animation-frames",
      webglRenderer,
    };
  }
  const metrics = await session.send("Performance.getMetrics");
  await context.close();
  return {
    wallMilliseconds: performance.now() - started,
    responseObserved: true,
    renderCompleted: true,
    requestMilliseconds: responseAndFrames.duration,
    payloadMilliseconds: responseAndFrames.responseEnd - responseAndFrames.responseStart,
    twoFramesAfterResponseMilliseconds:
      responseAndFrames.secondFrame - responseAndFrames.responseEnd,
    transferSize: responseAndFrames.transferSize,
    encodedBodySize: responseAndFrames.encodedBodySize,
    decodedBodySize: responseAndFrames.decodedBodySize,
    taskDurationSeconds:
      metrics.metrics.find((metric) => metric.name === "TaskDuration")?.value ?? null,
    webglRenderer,
  };
}

const body = Buffer.from(JSON.stringify(fixture()));
const benchServer = createBenchServer(body);
const origin = await listen(benchServer.server);
const browser = await chromium.launch({ executablePath: chromeExecutable, headless: true });
try {
  const samples = [];
  for (let sweep = 0; sweep < sweeps; sweep++) {
    samples.push(await browserSample(browser, origin, benchServer.nextThreadRequest));
  }
  console.log(
    JSON.stringify(
      {
        environment: {
          endpoint: "loopback synthetic only",
          browser: "Chrome headless via Playwright",
          viewport: "390x844 CSS px, deviceScaleFactor 2, touch enabled",
          cpuThrottle: `${cpuThrottle}x DevTools emulation`,
          network:
            "150ms synthetic response-start delay plus 1.6 Mbps gzip body pacing; CDP network shaping is also enabled",
        },
        renderWaitMilliseconds,
        pageLoadTimeoutMilliseconds,
        dataset: {
          actorCount: actors,
          topology: "one root with remaining actors as direct children",
          uncompressedJsonBytes: body.length,
          gzipBytes: benchServer.gzipBytes,
          sweeps,
        },
        samples,
        medians: Object.fromEntries(
          [
            "wallMilliseconds",
            "requestMilliseconds",
            "payloadMilliseconds",
            "twoFramesAfterResponseMilliseconds",
          ].map((key) => {
            const values = samples
              .map((sample) => sample[key])
              .filter((value) => Number.isFinite(value));
            return [key, values.length === 0 ? null : median(values)];
          })
        ),
        caveat:
          "Two animation frames after response end is a browser-observable paint opportunity, not an internal Flutter parse/state/render span. The companion Dart harness measures source parser/store/tree preparation separately.",
      },
      null,
      2
    )
  );
} finally {
  await browser.close();
  await new Promise((resolveClose, rejectClose) =>
    benchServer.server.close((error) => (error ? rejectClose(error) : resolveClose()))
  );
}
