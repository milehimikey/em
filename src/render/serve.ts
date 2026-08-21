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
//
// Also carries stakeholder review mode: a Prev/Next storyboard that highlights
// and pans/zooms to one slice at a time, reading the `data-slice`
// attributes/`<metadata id="em-slices">` that src/render/sliceOverlay.ts
// embeds in every rendered SVG. Review-mode state (`reviewMode`/`activeSlice`)
// deliberately lives outside reload()'s closure and is re-applied after every
// SSE-triggered swap — a facilitator hand-editing an `issue "..."` clause live
// during a session should see it appear without losing their place.
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
    .btn {
      background: #3b4754; color: #fff; border: 0; border-radius: 4px;
      padding: .3rem .7rem; font-size: 13px; cursor: pointer; font-family: inherit;
    }
    .btn:hover { background: #4b5763; }
    .btn:disabled { opacity: .4; cursor: default; }
    .btn.active { background: #2f6fed; }
    #storyboard {
      display: flex; align-items: center; gap: .5rem; padding: .4rem .9rem;
      background: #e8eaed; border-bottom: 1px solid #d0d3d7;
    }
    #storyboard[hidden] { display: none; }
    #storyboard .nav { background: none; border: 0; font-size: 18px; line-height: 1; cursor: pointer; color: #3b4754; padding: 0 .3rem; }
    #storyboard .nav:disabled { opacity: .3; cursor: default; }
    #filmstrip { display: flex; gap: .35rem; overflow-x: auto; }
    #filmstrip .slice {
      padding: .25rem .6rem; border-radius: 12px; background: #fff; border: 1px solid #d0d3d7;
      font-size: 12px; white-space: nowrap; cursor: pointer; color: #3b4754; font-family: inherit;
    }
    #filmstrip .slice.active { background: #2f6fed; border-color: #2f6fed; color: #fff; font-weight: 600; }
    #stage { padding: 1rem; }
    object { width: 100%; height: calc(100vh - 60px); border: 0; }
  </style>
</head>
<body>
  <header>
    <span class="dot" id="dot"></span>
    <span>Event Model — live (push)</span>
    <button class="btn" id="reviewToggle" title="Step through one slice at a time">Review mode</button>
    <span class="stamp" id="stamp">connecting…</span>
  </header>
  <nav id="storyboard" hidden>
    <button class="nav" id="prevSlice" aria-label="Previous slice">‹</button>
    <div id="filmstrip"></div>
    <button class="nav" id="nextSlice" aria-label="Next slice">›</button>
  </nav>
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
    const reviewToggle = document.getElementById("reviewToggle");
    const storyboard = document.getElementById("storyboard");
    const filmstrip = document.getElementById("filmstrip");
    const prevBtn = document.getElementById("prevSlice");
    const nextBtn = document.getElementById("nextSlice");
    let current = document.getElementById("svg");

    // --- storyboard state: outside reload()'s closure on purpose, see the
    // file-level comment above — an SSE reload must not reset these. ---
    let reviewMode = false;
    let activeSlice = null; // slice index, or null for "show all"
    let slices = []; // [{index, name, x0, x1}], from this load's <metadata>
    let rowLabels = null; // {x0, x1} | null, the swimlane label column's range
    let naturalViewBox = null; // this load's pre-zoom viewBox, cached once per load

    // Double-buffer: load into a hidden <object>, swap on load, so the shared
    // screen never flashes white during a reload. Keep <object> (not <img>) so
    // note "..." links inside the SVG stay clickable. The buffer must be
    // attached to the document BEFORE data is set — a detached <object> never
    // starts fetching its resource, so its load event would never fire.
    let pending = null; // the in-flight buffer <object>, if a reload is loading
    function reload() {
      dot.classList.add("stale");
      if (pending) pending.remove(); // superseded by this newer reload
      const next = document.createElement("object");
      next.type = "image/svg+xml";
      next.style.cssText = current.style.cssText;
      next.style.position = "absolute"; // out of flow + invisible while loading
      next.style.visibility = "hidden";
      next.addEventListener("load", () => {
        if (pending !== next) return; // a newer reload already replaced this one
        pending = null;
        next.style.position = "";
        next.style.visibility = "";
        stage.removeChild(current);
        current = next;
        stamp.textContent = new Date().toLocaleTimeString();
        dot.classList.remove("stale");
        onSvgLoaded();
      }, { once: true });
      stage.appendChild(next);
      pending = next;
      next.setAttribute("data", SVG_FILE + "?t=" + Date.now());
    }

    function readSliceMeta(doc) {
      const el = doc.getElementById("em-slices");
      if (!el) return null;
      try { return JSON.parse(el.textContent); } catch { return null; }
    }

    // The currently-loaded SVG's own document + root element, or null before
    // the first load / if the served file isn't a well-formed SVG.
    function currentSvgDoc() {
      const doc = current.contentDocument;
      const svgRoot = doc && doc.querySelector("svg");
      return doc && svgRoot ? { doc, svgRoot } : null;
    }

    // Re-read this load's slice metadata + natural viewBox, then reapply
    // whatever storyboard state was already in effect (a fresh SSE push mid-
    // review shouldn't reset the facilitator's position).
    function onSvgLoaded() {
      const loaded = currentSvgDoc();
      if (!loaded) return;

      naturalViewBox = loaded.svgRoot.getAttribute("viewBox");
      const meta = readSliceMeta(loaded.doc);
      slices = (meta && meta.slices) || [];
      rowLabels = (meta && meta.rowLabels) || null;
      // The model may have changed shape (slice added/removed) between loads.
      if (activeSlice !== null && !slices.some((s) => s.index === activeSlice)) {
        activeSlice = slices.length ? slices[0].index : null;
      }
      render();
    }

    // Apply reviewMode/activeSlice to the currently-loaded SVG + the control bar.
    // Safe to call directly from UI handlers (Prev/Next/toggle/arrow keys) — it
    // never re-reads metadata, just re-applies the cached state.
    function render() {
      storyboard.hidden = slices.length === 0;
      reviewToggle.classList.toggle("active", reviewMode);
      reviewToggle.disabled = slices.length === 0;
      renderFilmstrip();

      const loaded = currentSvgDoc();
      if (!loaded) return;
      const { doc, svgRoot } = loaded;

      doc.querySelectorAll("[data-slice]").forEach((node) => {
        const dim = reviewMode && activeSlice !== null &&
          Number(node.getAttribute("data-slice")) !== activeSlice;
        node.classList.toggle("em-slice-dim", dim);
      });

      if (!naturalViewBox) return;
      if (!reviewMode || activeSlice === null) {
        svgRoot.setAttribute("viewBox", naturalViewBox);
        return;
      }
      const slice = slices.find((s) => s.index === activeSlice);
      if (!slice) return;
      const [nx, ny, nw, nh] = naturalViewBox.split(/\\s+/).map(Number);
      const PAD = 24; // breathing room around the framed slice
      let x0 = rowLabels ? Math.min(rowLabels.x0, slice.x0) : slice.x0;
      let x1 = slice.x1;
      x0 = Math.max(nx, x0 - PAD);
      x1 = Math.min(nx + nw, x1 + PAD);
      svgRoot.setAttribute("viewBox", x0 + " " + ny + " " + Math.max(1, x1 - x0) + " " + nh);
    }

    function renderFilmstrip() {
      filmstrip.innerHTML = "";
      for (const s of slices) {
        const b = document.createElement("button");
        b.className = "slice" + (s.index === activeSlice ? " active" : "");
        b.textContent = s.name;
        b.addEventListener("click", () => goTo(s.index));
        filmstrip.appendChild(b);
      }
      const first = slices[0], last = slices[slices.length - 1];
      prevBtn.disabled = activeSlice === null || !first || activeSlice <= first.index;
      nextBtn.disabled = activeSlice === null || !last || activeSlice >= last.index;
    }

    function goTo(index) {
      activeSlice = index;
      render();
    }

    function step(delta) {
      if (!slices.length) return;
      if (activeSlice === null) { goTo(slices[0].index); return; }
      const i = slices.findIndex((s) => s.index === activeSlice);
      const next = slices[Math.min(slices.length - 1, Math.max(0, i + delta))];
      if (next) goTo(next.index);
    }

    reviewToggle.addEventListener("click", () => {
      reviewMode = !reviewMode;
      if (reviewMode && activeSlice === null && slices.length) activeSlice = slices[0].index;
      render();
    });
    prevBtn.addEventListener("click", () => step(-1));
    nextBtn.addEventListener("click", () => step(1));
    document.addEventListener("keydown", (e) => {
      if (!reviewMode) return;
      if (e.key === "ArrowLeft") step(-1);
      else if (e.key === "ArrowRight") step(1);
    });

    reload();

    const es = new EventSource("/__events");
    es.onopen = () => { stamp.textContent = new Date().toLocaleTimeString(); };
    es.onmessage = reload;
    es.onerror = () => { dot.classList.add("stale"); };
  </script>
</body>
</html>
`;
