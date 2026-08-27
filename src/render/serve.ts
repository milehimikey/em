// SPDX-License-Identifier: MIT
// Optional localhost dev server for `em watch --serve`.
//
// Serves the model directory over HTTP, the viewer page at `/`, and pushes an
// instant reload to the browser via Server-Sent Events (SSE) after each
// successful re-render: no polling, instant updates, and zero idle work
// between edits.
//
// Uses only Node's built-in `http` — no extra dependencies. Binds to
// 127.0.0.1 (loopback) so the model is never exposed off the machine.

import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { AddressInfo } from "node:net";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { extname, join, relative, resolve, sep } from "node:path";
// The viewer page ships as a generated constant (source of truth:
// src/render/viewer.html — see scripts/generate-viewer-html.ts).
import { VIEWER_HTML } from "./viewerHtml.js";

const HOST = "127.0.0.1";
const DEFAULT_PORT = 5173;
// Number of sequential ports to try if the preferred one is taken.
const PORT_TRIES = 10;
// Keepalive comment cadence so proxies/browsers don't drop the idle SSE stream.
const SSE_KEEPALIVE_MS = 15000;

const CONTENT_TYPES: Record<string, string> = {
  ".svg": "image/svg+xml; charset=utf-8",
  ".png": "image/png",
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".pdf": "application/pdf",
  // MIL-153: without this, a note marker's link to a `.md` file falls through to
  // the default application/octet-stream below and the browser downloads it
  // instead of opening it — text/markdown displays it inline like any other text.
  ".md": "text/markdown; charset=utf-8",
};

export interface LiveServer {
  /** Base URL the viewer is served at, e.g. http://localhost:5173 */
  url: string;
  /** The port actually bound (differs from the request if it was taken). */
  port: number;
  /** Push a reload to every connected browser (call after a successful render). */
  notify: () => void;
  /** Tell every connected browser a save failed to render (parse/render error):
   *  the viewer keeps the last good diagram and shows the message in its banner,
   *  so a shared screen never silently goes stale. */
  notifyError: (message: string) => void;
  /** Stop the server and drop all SSE connections. */
  close: () => Promise<void>;
}

export interface StartOptions {
  /** Directory to serve (the model dir); static files are resolved within it. */
  dir: string;
  /** Preferred port; falls forward to the next free one if taken. */
  port?: number;
}

/**
 * Start the live server for `dir`. Resolves once it is listening.
 */
export async function startLiveServer(opts: StartOptions): Promise<LiveServer> {
  const root = resolve(opts.dir);
  const clients = new Set<ServerResponse>();

  const server = createServer((req, res) => handle(req, res, root, clients));

  const port = await listen(server, opts.port ?? DEFAULT_PORT);

  const keepalive = setInterval(() => {
    for (const res of clients) res.write(": keepalive\n\n");
  }, SSE_KEEPALIVE_MS);
  // Don't let the keepalive timer hold the process open on its own.
  keepalive.unref?.();

  return {
    url: `http://localhost:${port}`,
    port,
    notify() {
      for (const res of clients) res.write("data: reload\n\n");
    },
    notifyError(message) {
      // SSE data must be one line; keep it short — it lands in the viewer banner.
      const line = message.replace(/\s*\r?\n\s*/g, " · ").slice(0, 300);
      for (const res of clients) res.write("event: renderError\ndata: " + line + "\n\n");
    },
    async close() {
      clearInterval(keepalive);
      for (const res of clients) res.end();
      clients.clear();
      await new Promise<void>((res) => server.close(() => res()));
    },
  };
}

/** Try to listen on `port`, falling forward a few times if it's in use. */
function listen(
  server: ReturnType<typeof createServer>,
  port: number,
): Promise<number> {
  return new Promise((resolvePort, reject) => {
    let attempt = 0;
    const tryPort = (p: number) => {
      const onError = (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE" && attempt < PORT_TRIES - 1) {
          attempt += 1;
          tryPort(p + 1);
        } else {
          reject(err);
        }
      };
      server.once("error", onError);
      server.listen(p, HOST, () => {
        server.removeListener("error", onError);
        // With p === 0 the OS assigns a free port; read the real one back.
        resolvePort((server.address() as AddressInfo).port);
      });
    };
    tryPort(port);
  });
}

function handle(
  req: IncomingMessage,
  res: ServerResponse,
  root: string,
  clients: Set<ServerResponse>,
): void {
  const url = new URL(req.url ?? "/", "http://localhost");
  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    // A malformed percent-escape must 400, not throw — an uncaught URIError
    // here would take down the watcher and the live view with it.
    res.writeHead(400).end("bad request");
    return;
  }

  if (pathname === "/__events") {
    openEventStream(res, clients);
    return;
  }

  if (pathname === "/") {
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end(VIEWER_HTML);
    return;
  }

  serveStatic(pathname, root, res);
}

function openEventStream(res: ServerResponse, clients: Set<ServerResponse>): void {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-store",
    connection: "keep-alive",
  });
  res.write(": connected\n\n");
  clients.add(res);
  res.on("close", () => clients.delete(res));
}

async function serveStatic(
  pathname: string,
  root: string,
  res: ServerResponse,
): Promise<void> {
  // Resolve within root and reject anything that escapes it (path traversal).
  const target = resolve(join(root, "." + pathname));
  const rel = relative(root, target);
  if (rel === ".." || rel.startsWith(".." + sep) || (rel === "" && pathname !== "/")) {
    res.writeHead(403).end("forbidden");
    return;
  }

  try {
    const info = await stat(target);
    if (!info.isFile()) {
      res.writeHead(404).end("not found");
      return;
    }
    res.writeHead(200, {
      "content-type": CONTENT_TYPES[extname(target).toLowerCase()] ?? "application/octet-stream",
      "cache-control": "no-store",
    });
    createReadStream(target).pipe(res);
  } catch {
    res.writeHead(404).end("not found");
  }
}
