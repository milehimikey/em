// SPDX-License-Identifier: MIT
// Optional localhost dev server for `em watch --serve`.
//
// Serves the model directory over HTTP and pushes an instant reload to the
// browser via Server-Sent Events (SSE) after each successful re-render. This
// replaces the poll-and-cache-bust loop of the static live.html viewer: no
// polling, instant updates, and zero idle work between edits.
//
// Uses only Node's built-in `http` — no extra dependencies. Binds to
// 127.0.0.1 (loopback) so the model is never exposed off the machine.

import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { AddressInfo } from "node:net";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { extname, join, relative, resolve, sep } from "node:path";

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
};

export interface LiveServer {
  /** Base URL the viewer is served at, e.g. http://localhost:5173 */
  url: string;
  /** The port actually bound (differs from the request if it was taken). */
  port: number;
  /** Push a reload to every connected browser (call after a successful render). */
  notify: () => void;
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
  const pathname = decodeURIComponent(url.pathname);

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

// Served viewer page. Same double-buffered, no-flicker swap as the static
// live.html fallback, but driven by SSE push instead of a poll loop — the
// browser reloads only when the server says the SVG actually changed.
const VIEWER_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Event Model — Live</title>
  <style>
    :root { color-scheme: light dark; }
    body { margin: 0; font-family: system-ui, sans-serif; background: #fafafa; }
    header {
      display: flex; align-items: center; gap: .75rem;
      padding: .5rem .9rem; background: #1f2933; color: #fff; font-size: 14px;
    }
    header .dot { width: 9px; height: 9px; border-radius: 50%; background: #34c759; transition: background .3s; }
    header .dot.stale { background: #f0a020; }
    header .stamp { margin-left: auto; opacity: .7; font-variant-numeric: tabular-nums; }
    #stage { padding: 1rem; }
    object { width: 100%; height: calc(100vh - 60px); border: 0; }
  </style>
</head>
<body>
  <header>
    <span class="dot" id="dot"></span>
    <span>Event Model — live (push)</span>
    <span class="stamp" id="stamp">connecting…</span>
  </header>
  <div id="stage">
    <object id="svg" type="image/svg+xml"></object>
  </div>
  <script>
    // The SVG filename comes from ?svg=<name>.svg (defaults to model.svg), so one
    // server serves any model without editing this page.
    const SVG_FILE = new URLSearchParams(location.search).get("svg") || "model.svg";
    const stage = document.getElementById("stage");
    const stamp = document.getElementById("stamp");
    const dot = document.getElementById("dot");
    let current = document.getElementById("svg");

    // Double-buffer: load into a hidden <object>, swap on load, so the shared
    // screen never flashes white during a reload. Keep <object> (not <img>) so
    // note "..." links inside the SVG stay clickable.
    function reload() {
      dot.classList.add("stale");
      const next = document.createElement("object");
      next.type = "image/svg+xml";
      next.style.cssText = current.style.cssText;
      next.addEventListener("load", () => {
        stage.replaceChild(next, current);
        current = next;
        stamp.textContent = new Date().toLocaleTimeString();
        dot.classList.remove("stale");
      }, { once: true });
      next.setAttribute("data", SVG_FILE + "?t=" + Date.now());
    }

    reload();

    const es = new EventSource("/__events");
    es.onopen = () => { stamp.textContent = new Date().toLocaleTimeString(); };
    es.onmessage = reload;
    es.onerror = () => { dot.classList.add("stale"); };
  </script>
</body>
</html>
`;
