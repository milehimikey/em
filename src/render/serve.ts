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

// The viewer page, served at `/`. Self-contained — no external assets, all
// state in this one script — and driven by SSE push: the browser reloads only
// when the server says the SVG actually changed.
//
// The SVG is inlined (fetch → DOMParser → validate → swap) rather than
// embedded via <object>: a truncated or malformed file is detected *before*
// touching the DOM, so a bad render can never blank the shared screen — the
// last good frame stays up behind an error banner while the viewer retries
// with backoff. Inline SVG also keeps note links clickable and hands the
// camera a real viewBox to drive. The ?svg= query param is allowlisted to a
// bare *.svg filename (MIL-140) so it can only name a file in the served dir.
//
// The camera *is* the svg's viewBox (`cam = {x,y,w,h}`): drag and wheel pan,
// ctrl+wheel (what a trackpad pinch emits) and two-pointer pinch zoom about
// the cursor, and flyTo() animates slice navigation and fit. Driving viewBox
// directly (not CSS transforms) keeps text crisp and makes the client→model
// coordinate math a single exact mapping.
//
// Also carries stakeholder review mode: a Prev/Next storyboard that highlights
// and flies to one slice at a time, reading the `data-slice`
// attributes/`<metadata id="em-slices">` that src/render/sliceOverlay.ts
// embeds in every rendered SVG. Review-mode state (`reviewMode`/`activeSlice`)
// deliberately lives outside the load pipeline and is re-applied after every
// SSE-triggered swap — a facilitator hand-editing an `issue "..."` clause live
// during a session should see it appear without losing their place.
const VIEWER_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Event Model — Live</title>
  <style>
    :root { color-scheme: light dark; }
    html, body { height: 100%; }
    body {
      margin: 0; font-family: system-ui, sans-serif; background: #fafafa;
      display: flex; flex-direction: column; overflow: hidden;
    }
    header {
      display: flex; align-items: center; gap: .75rem; flex: none;
      padding: .5rem .9rem; background: #1f2933; color: #fff; font-size: 14px;
    }
    header .dot { width: 9px; height: 9px; border-radius: 50%; background: #34c759; transition: background .3s; flex: none; }
    header .dot.stale { background: #f0a020; }
    header .stamp { margin-left: auto; opacity: .7; font-variant-numeric: tabular-nums; }
    header .zoom { display: flex; align-items: center; gap: .3rem; }
    #zoomPct { font-size: 12px; opacity: .7; min-width: 3.2em; text-align: center; font-variant-numeric: tabular-nums; }
    .btn {
      background: #3b4754; color: #fff; border: 0; border-radius: 4px;
      padding: .3rem .7rem; font-size: 13px; cursor: pointer; font-family: inherit;
    }
    .btn:hover { background: #4b5763; }
    .btn:disabled { opacity: .4; cursor: default; }
    .btn.active { background: #2f6fed; }
    #errorBanner {
      display: flex; align-items: center; gap: .6rem; flex: none;
      padding: .45rem .9rem; background: #8c2f28; color: #fff; font-size: 13px;
    }
    #errorBanner[hidden] { display: none; }
    #errorBanner button {
      margin-left: auto; background: none; border: 0; color: #fff;
      font-size: 16px; line-height: 1; cursor: pointer; opacity: .8;
    }
    #storyboard {
      display: flex; align-items: center; gap: .5rem; padding: .4rem .9rem; flex: none;
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
    #stage {
      flex: 1 1 auto; min-height: 0; position: relative; overflow: hidden;
      touch-action: none; cursor: grab; user-select: none; -webkit-user-select: none;
    }
    #stage.dragging { cursor: grabbing; }
    #stage svg { width: 100%; height: 100%; display: block; }
  </style>
</head>
<body>
  <header>
    <span class="dot" id="dot"></span>
    <span>Event Model — live</span>
    <button class="btn" id="reviewToggle" title="Step through one slice at a time">Review mode</button>
    <span class="zoom">
      <button class="btn" id="zoomOut" aria-label="Zoom out" title="Zoom out (-)">−</button>
      <span id="zoomPct">100%</span>
      <button class="btn" id="zoomIn" aria-label="Zoom in" title="Zoom in (+)">+</button>
      <button class="btn" id="fitBtn" title="Fit the whole diagram (0)">Fit</button>
    </span>
    <span class="stamp" id="stamp">connecting…</span>
  </header>
  <div id="errorBanner" hidden>
    <span id="errorText"></span>
    <button id="errorDismiss" aria-label="Dismiss">×</button>
  </div>
  <nav id="storyboard" hidden>
    <button class="nav" id="prevSlice" aria-label="Previous slice">‹</button>
    <div id="filmstrip"></div>
    <button class="nav" id="nextSlice" aria-label="Next slice">›</button>
  </nav>
  <div id="stage"></div>
  <script>
    // ?svg=<name>.svg picks the model file (default model.svg), so one server
    // serves any model without editing this page. The allowlist keeps the
    // value a bare *.svg filename inside the served directory — no path
    // separator, no drive/scheme colon — so it is safe to fetch (always
    // URI-encoded) and to display (via textContent only, never markup).
    // Spaces and unicode are fine: em watch prints whatever the output file
    // is called, and that URL has to work.
    const svgParam = new URLSearchParams(location.search).get("svg");
    const SVG_FILE = svgParam && /^[^/\\\\:]+\\.svg$/.test(svgParam) ? svgParam : "model.svg";

    const stage = document.getElementById("stage");
    const stamp = document.getElementById("stamp");
    const dot = document.getElementById("dot");
    const banner = document.getElementById("errorBanner");
    const bannerText = document.getElementById("errorText");
    const reviewToggle = document.getElementById("reviewToggle");
    const storyboard = document.getElementById("storyboard");
    const filmstrip = document.getElementById("filmstrip");
    const prevBtn = document.getElementById("prevSlice");
    const nextBtn = document.getElementById("nextSlice");
    const zoomPct = document.getElementById("zoomPct");

    // --- review-mode state: outside the load pipeline on purpose, see the
    // file-level comment above — a reload re-applies it, never resets it. ---
    let reviewMode = false;
    let activeSlice = null; // slice index, or null for "show all"
    let slices = []; // [{index, name, x0, x1}], from this load's <metadata>
    let rowLabels = null; // {x0, x1} | null, the swimlane label column's range

    // --- camera state ---
    let svgEl = null; // the inline <svg>, null until the first good load
    let natural = null; // the loaded SVG's own viewBox: its full-fit frame
    let cam = null; // the current viewBox {x, y, w, h}
    // True while the user has never panned/zoomed (or pressed Fit last): a
    // reload then re-fits to the new natural box instead of pinning the old
    // absolute view onto a diagram that may have grown or shrunk.
    let atFit = true;

    function stageRect() { return stage.getBoundingClientRect(); }

    // Uniform px→model scale of the current view. The svg keeps the default
    // preserveAspectRatio (xMidYMid meet): one scale factor, centered.
    function scale() {
      const r = stageRect();
      return Math.max(cam.w / Math.max(1, r.width), cam.h / Math.max(1, r.height));
    }

    // Exact client-px → model-coords inverse of the "meet" mapping, so
    // zoom-about-cursor keeps the model point under the cursor exactly.
    function toSvg(cx, cy) {
      const r = stageRect();
      const s = scale();
      const ox = cam.x - (r.width * s - cam.w) / 2;
      const oy = cam.y - (r.height * s - cam.h) / 2;
      return { x: ox + (cx - r.left) * s, y: oy + (cy - r.top) * s };
    }

    // Fit a model-space rect into the stage aspect, centered.
    function frameRect(x, y, w, h) {
      const r = stageRect();
      const aspect = Math.max(1, r.width) / Math.max(1, r.height);
      let fw = w, fh = h;
      if (fw / fh < aspect) fw = fh * aspect; else fh = fw / aspect;
      return { x: x + (w - fw) / 2, y: y + (h - fh) / 2, w: fw, h: fh };
    }

    function fitCam() { return frameRect(natural.x, natural.y, natural.w, natural.h); }

    // New cam zoomed by the given factor about model point p, clamped to
    // 0.5×–30× of fit so the diagram is neither lost nor over-magnified.
    function zoomedCam(p, factor) {
      const fitW = fitCam().w;
      const w = Math.min(fitW * 2, Math.max(fitW / 30, cam.w / factor));
      const f = cam.w / w;
      return clampPanOf({
        x: p.x - (p.x - cam.x) / f,
        y: p.y - (p.y - cam.y) / f,
        w: cam.w / f,
        h: cam.h / f,
      });
    }

    // Keep at least half of min(view, diagram) in frame on each axis, so the
    // diagram can never be panned fully out of view.
    function clampPanOf(c) {
      if (!natural) return c;
      const kx = Math.min(c.w, natural.w) / 2;
      const ky = Math.min(c.h, natural.h) / 2;
      c.x = Math.max(natural.x - c.w + kx, Math.min(natural.x + natural.w - kx, c.x));
      c.y = Math.max(natural.y - c.h + ky, Math.min(natural.y + natural.h - ky, c.y));
      return c;
    }
    function clampPan() { cam = clampPanOf(cam); }

    function applyCam() {
      if (!svgEl || !cam) return;
      svgEl.setAttribute("viewBox", cam.x + " " + cam.y + " " + cam.w + " " + cam.h);
      if (natural) zoomPct.textContent = Math.round((fitCam().w / cam.w) * 100) + "%";
    }

    function markMoved() { atFit = false; }

    // Animated camera move; any direct manipulation (drag/wheel/pinch) cancels
    // it and takes over from wherever the animation got to.
    let flyHandle = null;
    function flyTo(target) {
      cancelFly();
      if (!cam) { cam = target; applyCam(); return; }
      const from = { x: cam.x, y: cam.y, w: cam.w, h: cam.h };
      const t0 = performance.now();
      const DUR = 280;
      function ease(t) { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; }
      function frame(now) {
        const t = Math.min(1, (now - t0) / DUR);
        const k = ease(t);
        cam = {
          x: from.x + (target.x - from.x) * k,
          y: from.y + (target.y - from.y) * k,
          w: from.w + (target.w - from.w) * k,
          h: from.h + (target.h - from.h) * k,
        };
        applyCam();
        flyHandle = t < 1 ? requestAnimationFrame(frame) : null;
      }
      flyHandle = requestAnimationFrame(frame);
    }
    function cancelFly() {
      if (flyHandle !== null) { cancelAnimationFrame(flyHandle); flyHandle = null; }
    }

    function goFit() {
      if (!natural) return;
      atFit = true;
      flyTo(fitCam());
    }

    function zoomStep(factor) {
      if (!cam) return;
      const r = stageRect();
      markMoved();
      flyTo(zoomedCam(toSvg(r.left + r.width / 2, r.top + r.height / 2), factor));
    }

    // --- load pipeline: fetch → parse → validate → swap. A failure at any
    // step keeps the last good frame on screen and retries with backoff. ---
    let loadId = 0; // only the latest load's result may touch the DOM
    let retryTimer = null;
    let retryAttempt = 0;
    const RETRY_MS = [500, 1000, 2000, 4000]; // then every 4s

    function reload() {
      const id = ++loadId; // supersedes any in-flight load and pending retry
      if (retryTimer !== null) { clearTimeout(retryTimer); retryTimer = null; }
      dot.classList.add("stale");
      fetch(encodeURIComponent(SVG_FILE) + "?t=" + Date.now(), { cache: "no-store" })
        .then(function (res) {
          if (!res.ok) throw new Error("HTTP " + res.status);
          return res.text();
        })
        .then(function (text) {
          if (id !== loadId) return;
          const doc = new DOMParser().parseFromString(text, "image/svg+xml");
          const root = doc.documentElement;
          // Validate before touching the DOM — a truncated write mid-render or
          // a non-SVG response must not blank the shared screen.
          if (!root || root.localName !== "svg" || doc.querySelector("parsererror")) {
            fail("SVG parse error");
            return;
          }
          applyLoad(root);
        })
        .catch(function (err) {
          if (id !== loadId) return;
          fail(err && err.message ? err.message : String(err));
        });
    }

    function applyLoad(root) {
      const next = document.importNode(root, true);
      const vb = (next.getAttribute("viewBox") || "").trim().split(/[\\s,]+/).map(Number);
      // CSS sizes the element; the viewBox is the camera.
      next.removeAttribute("width");
      next.removeAttribute("height");
      if (svgEl) svgEl.replaceWith(next); else stage.appendChild(next);
      svgEl = next;
      natural = vb.length === 4 && vb.every(isFinite) && vb[2] > 0 && vb[3] > 0
        ? { x: vb[0], y: vb[1], w: vb[2], h: vb[3] }
        : null;
      if (!natural) {
        // No usable viewBox (not something our renderer emits): frame the ink.
        const bb = next.getBBox();
        natural = { x: bb.x, y: bb.y, w: Math.max(1, bb.width), h: Math.max(1, bb.height) };
      }

      const metaEl = document.getElementById("em-slices");
      let meta = null;
      if (metaEl) { try { meta = JSON.parse(metaEl.textContent); } catch (err) { meta = null; } }
      slices = (meta && meta.slices) || [];
      rowLabels = (meta && meta.rowLabels) || null;
      // The model may have changed shape (slice removed) between loads. But a
      // reload with NO metadata at all (a transient bad render) must not eject
      // the facilitator from review mode or lose their place — review state
      // survives every reload; the position is only remapped when there are
      // real slices to remap onto.
      if (slices.length) {
        if (activeSlice !== null && !slices.some(function (s) { return s.index === activeSlice; })) {
          activeSlice = slices[0].index;
        }
        if (reviewMode && activeSlice === null) activeSlice = slices[0].index;
      }
      renderChrome();
      applyDim();

      // Camera across reloads: review mode re-flies to the (possibly moved)
      // active slice; an untouched/fitted camera re-fits to the new natural
      // box; otherwise the absolute view is preserved (including while the
      // active slice is temporarily missing from the metadata).
      cancelFly();
      if (reviewMode && activeSlice !== null &&
          slices.some(function (s) { return s.index === activeSlice; })) {
        flyTo(sliceFrame(activeSlice));
      } else if (atFit || !cam) {
        cam = fitCam();
        applyCam();
      } else {
        clampPan();
        applyCam();
      }

      banner.hidden = true;
      retryAttempt = 0;
      stamp.textContent = new Date().toLocaleTimeString();
      dot.classList.remove("stale");
    }

    function fail(msg) {
      bannerText.textContent = "Couldn't load " + SVG_FILE + " — " + msg + " · retrying…";
      banner.hidden = false;
      const delay = RETRY_MS[Math.min(retryAttempt, RETRY_MS.length - 1)];
      retryAttempt += 1;
      retryTimer = setTimeout(reload, delay);
    }

    // --- review mode / storyboard ---
    function sliceFrame(index) {
      let slice = null;
      for (const s of slices) if (s.index === index) slice = s;
      if (!slice || !natural) return fitCam();
      const PAD = 24; // breathing room around the framed slice
      let x0 = rowLabels ? Math.min(rowLabels.x0, slice.x0) : slice.x0;
      let x1 = slice.x1;
      x0 = Math.max(natural.x, x0 - PAD);
      x1 = Math.min(natural.x + natural.w, x1 + PAD);
      return frameRect(x0, natural.y, Math.max(1, x1 - x0), natural.h);
    }

    function renderChrome() {
      storyboard.hidden = slices.length === 0;
      reviewToggle.classList.toggle("active", reviewMode);
      reviewToggle.disabled = slices.length === 0;
      filmstrip.innerHTML = "";
      for (const s of slices) {
        const b = document.createElement("button");
        b.className = "slice" + (s.index === activeSlice ? " active" : "");
        b.textContent = s.name;
        b.addEventListener("click", function () { goTo(s.index); });
        filmstrip.appendChild(b);
      }
      const first = slices[0], last = slices[slices.length - 1];
      prevBtn.disabled = activeSlice === null || !first || activeSlice <= first.index;
      nextBtn.disabled = activeSlice === null || !last || activeSlice >= last.index;
    }

    function applyDim() {
      if (!svgEl) return;
      svgEl.querySelectorAll("[data-slice]").forEach(function (node) {
        const dim = reviewMode && activeSlice !== null &&
          Number(node.getAttribute("data-slice")) !== activeSlice;
        node.classList.toggle("em-slice-dim", dim);
      });
    }

    function goTo(index) {
      activeSlice = index;
      renderChrome();
      applyDim();
      if (reviewMode) flyTo(sliceFrame(index));
    }

    function step(delta) {
      if (!slices.length) return;
      if (activeSlice === null) { goTo(slices[0].index); return; }
      const i = slices.findIndex(function (s) { return s.index === activeSlice; });
      const next = slices[Math.min(slices.length - 1, Math.max(0, i + delta))];
      if (next) goTo(next.index);
    }

    function exitReview() {
      reviewMode = false;
      renderChrome();
      applyDim();
      goFit();
    }

    reviewToggle.addEventListener("click", function () {
      if (reviewMode) { exitReview(); return; }
      reviewMode = true;
      if (activeSlice === null && slices.length) activeSlice = slices[0].index;
      renderChrome();
      applyDim();
      if (activeSlice !== null) flyTo(sliceFrame(activeSlice));
    });
    prevBtn.addEventListener("click", function () { step(-1); });
    nextBtn.addEventListener("click", function () { step(1); });
    document.getElementById("zoomIn").addEventListener("click", function () { zoomStep(1.5); });
    document.getElementById("zoomOut").addEventListener("click", function () { zoomStep(1 / 1.5); });
    document.getElementById("fitBtn").addEventListener("click", goFit);
    document.getElementById("errorDismiss").addEventListener("click", function () {
      banner.hidden = true; // retries keep going quietly
    });

    // --- direct manipulation: drag pan, wheel pan, ctrl+wheel / pinch zoom ---
    const pointers = new Map(); // pointerId -> last client {x, y}
    let drag = null; // { id, startX, startY, active } — single-pointer pan
    let suppressClick = false; // swallow the click that ends a drag/pinch

    stage.addEventListener("pointerdown", function (e) {
      if (e.button !== 0) return;
      cancelFly(); // direct manipulation takes over from any animation
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 1) {
        suppressClick = false;
        drag = { id: e.pointerId, startX: e.clientX, startY: e.clientY, active: false };
      } else {
        // Second pointer: pinch. Capture both so the gesture survives leaving
        // the stage; a pinch must never end in a note-link click.
        drag = null;
        suppressClick = true;
        stage.classList.add("dragging");
        for (const id of pointers.keys()) {
          try { stage.setPointerCapture(id); } catch (err) { /* pointer already gone */ }
        }
      }
    });

    stage.addEventListener("pointermove", function (e) {
      const pt = pointers.get(e.pointerId);
      if (!pt) return;
      if (pointers.size >= 2) { pinchMove(e, pt); return; }
      if (!drag || drag.id !== e.pointerId || !cam) { pt.x = e.clientX; pt.y = e.clientY; return; }
      if (!drag.active) {
        // Movement threshold before treating it as a drag — capturing the
        // pointer immediately would retarget the eventual click away from the
        // SVG's note links. Until then pt stays at the pointerdown position,
        // so the first panning move applies the full accumulated delta.
        if (Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) < 4) return;
        drag.active = true;
        suppressClick = true;
        stage.setPointerCapture(e.pointerId);
        stage.classList.add("dragging");
      }
      const s = scale();
      cam.x -= (e.clientX - pt.x) * s;
      cam.y -= (e.clientY - pt.y) * s;
      pt.x = e.clientX; pt.y = e.clientY;
      clampPan();
      applyCam();
      markMoved();
    });

    // Incremental pinch: pan by the midpoint's movement, then zoom about the
    // new midpoint by the ratio of pointer distances.
    function pinchMove(e, pt) {
      let other = null;
      for (const entry of pointers) if (entry[0] !== e.pointerId) other = entry[1];
      if (!other || !cam) { pt.x = e.clientX; pt.y = e.clientY; return; }
      const oldMid = { x: (pt.x + other.x) / 2, y: (pt.y + other.y) / 2 };
      const oldDist = Math.hypot(pt.x - other.x, pt.y - other.y);
      pt.x = e.clientX; pt.y = e.clientY;
      const newMid = { x: (pt.x + other.x) / 2, y: (pt.y + other.y) / 2 };
      const newDist = Math.hypot(pt.x - other.x, pt.y - other.y);
      const s = scale();
      cam.x -= (newMid.x - oldMid.x) * s;
      cam.y -= (newMid.y - oldMid.y) * s;
      if (oldDist > 0 && newDist > 0) cam = zoomedCam(toSvg(newMid.x, newMid.y), newDist / oldDist);
      clampPan();
      applyCam();
      markMoved();
    }

    function endPointer(e) {
      if (!pointers.has(e.pointerId)) return; // not a pointer we were tracking
      pointers.delete(e.pointerId);
      if (stage.hasPointerCapture && stage.hasPointerCapture(e.pointerId)) {
        stage.releasePointerCapture(e.pointerId);
      }
      if (drag && drag.id === e.pointerId) drag = null;
      if (pointers.size === 1) {
        // Pinch collapsed to one finger: continue as an already-active pan.
        const rest = pointers.entries().next().value;
        drag = { id: rest[0], startX: rest[1].x, startY: rest[1].y, active: true };
      }
      if (pointers.size === 0) stage.classList.remove("dragging");
    }
    // On window, not the stage: a pointer that goes down on the stage but is
    // released elsewhere (before the drag threshold captures it) must still be
    // cleared, or its stale Map entry would misclassify every later gesture as
    // a pinch. endPointer ignores pointers it never tracked.
    window.addEventListener("pointerup", endPointer);
    window.addEventListener("pointercancel", endPointer);

    stage.addEventListener("click", function (e) {
      if (suppressClick) { suppressClick = false; e.preventDefault(); e.stopPropagation(); }
    }, true);

    stage.addEventListener("wheel", function (e) {
      e.preventDefault(); // the page itself must never scroll or browser-zoom
      if (!cam) return;
      cancelFly();
      const k = e.deltaMode === 1 ? 16 : 1; // line-mode deltas (Firefox) → ~px
      if (e.ctrlKey) {
        // ctrl+wheel is also what a trackpad pinch emits.
        cam = zoomedCam(toSvg(e.clientX, e.clientY), Math.exp(-e.deltaY * k * 0.01));
      } else {
        const s = scale();
        cam.x += e.deltaX * k * s;
        cam.y += e.deltaY * k * s;
        clampPan();
      }
      applyCam();
      markMoved();
    }, { passive: false });

    stage.addEventListener("dblclick", function (e) {
      if (!cam) return;
      e.preventDefault();
      markMoved();
      flyTo(zoomedCam(toSvg(e.clientX, e.clientY), 2));
    });

    document.addEventListener("keydown", function (e) {
      // Modified keys stay with the browser; shift is allowed ("+" needs it
      // on many layouts). Guard against future text inputs, too.
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (e.key === "+" || e.key === "=") { e.preventDefault(); zoomStep(1.5); }
      else if (e.key === "-") { e.preventDefault(); zoomStep(1 / 1.5); }
      else if (e.key === "0" || e.key === "f") { e.preventDefault(); goFit(); }
      else if (e.key === "Escape" && reviewMode) { exitReview(); }
      else if (reviewMode) {
        if (e.key === "ArrowLeft") { e.preventDefault(); step(-1); }
        else if (e.key === "ArrowRight") { e.preventDefault(); step(1); }
        else if (e.key === "Home") { e.preventDefault(); if (slices.length) goTo(slices[0].index); }
        else if (e.key === "End") { e.preventDefault(); if (slices.length) goTo(slices[slices.length - 1].index); }
      }
    });

    window.addEventListener("resize", function () {
      if (!natural || !cam) return;
      // Keep what the presenter framed: an active slice re-frames to the new
      // aspect; a fitted view re-fits; a hand-placed camera stays put.
      if (reviewMode && activeSlice !== null) { cam = sliceFrame(activeSlice); applyCam(); }
      else if (atFit) { cam = fitCam(); applyCam(); }
    });

    reload();

    const es = new EventSource("/__events");
    // onopen reloads only on REconnect (laptop sleep, server restart): pushes
    // sent in the meantime were missed. The initial connect skips it — the
    // eager reload() above is already in flight, and doubling it would fetch
    // and parse every page open twice.
    let firstOpen = true;
    es.onopen = function () {
      retryAttempt = 0;
      if (firstOpen) { firstOpen = false; return; }
      reload();
    };
    es.onmessage = function () { retryAttempt = 0; reload(); };
    es.onerror = function () { dot.classList.add("stale"); };
    // A save that failed to render (parse/render error): the server pushes the
    // message, the last good diagram stays up, and the banner says why the
    // screen is stale — it must never silently show an outdated model. No
    // retry here: refetching can only return the old file; the next successful
    // render pushes a reload that clears the banner.
    es.addEventListener("renderError", function (e) {
      if (retryTimer !== null) { clearTimeout(retryTimer); retryTimer = null; }
      bannerText.textContent = "Model didn't render — " + e.data + " — showing last good diagram";
      banner.hidden = false;
      dot.classList.add("stale");
    });
  </script>
</body>
</html>
`;
