// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startLiveServer, LiveServer } from "../src/render/serve.js";
import { splitViewerHtml } from "./helpers/viewerScript.js";

// Exercises the `em watch --serve` dev server: static serving, the SSE stream,
// and path-traversal safety. Port 0 lets the OS pick a free port per test.
describe("live server", () => {
  let dir: string;
  let server: LiveServer;
  // Hit the loopback IPv4 directly — the server binds 127.0.0.1, whereas
  // "localhost" can resolve to IPv6 (::1) first and miss it.
  let base: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "em-serve-"));
    writeFileSync(join(dir, "model.svg"), "<svg><!-- hi --></svg>");
    server = await startLiveServer({ dir, port: 0 });
    base = `http://127.0.0.1:${server.port}`;
  });

  afterEach(async () => {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("serves the viewer HTML at /", async () => {
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    const body = await res.text();
    expect(body).toContain("EventSource");
    expect(body).toContain("__events");
  });

  it("serves the storyboard/review-mode controls and slice-metadata handling", async () => {
    const res = await fetch(`${base}/`);
    const body = await res.text();
    // control bar + interaction
    expect(body).toContain('id="reviewToggle"');
    expect(body).toContain('id="storyboard"');
    expect(body).toContain('id="filmstrip"');
    expect(body).toContain('id="prevSlice"');
    expect(body).toContain('id="nextSlice"');
    expect(body).toContain("ArrowLeft");
    expect(body).toContain("ArrowRight");
    expect(body).toContain("Escape");
    expect(body).toContain("Home");
    expect(body).toContain("End");
    // reads what sliceOverlay.ts embeds in the SVG
    expect(body).toContain('getElementById("em-slices")');
    expect(body).toContain("data-slice");
    expect(body).toContain("em-slice-dim");
  });

  it("sanitizes ?svg= and inlines the SVG via validate-before-swap (no <object>)", async () => {
    // Successor to the MIL-136 <object> regression test: the viewer now inlines
    // the SVG (fetch → DOMParser → validate → swap), so a truncated or malformed
    // file is rejected before it can touch the DOM and blank the screen.
    const res = await fetch(`${base}/`);
    const body = await res.text();
    // MIL-140: the ?svg= param must survive only as a bare *.svg filename —
    // no path separator, no drive/scheme colon. Spaces/unicode stay legal:
    // `em watch` prints whatever the output file is called.
    expect(body).toContain("[^/\\\\:]+\\.svg$");
    expect(body).not.toContain("<object");
    expect(body).toContain("DOMParser");
    expect(body).toContain("parsererror");
    expect(body).toContain("importNode");
  });

  it("serves the error banner and retry-with-backoff path", async () => {
    const res = await fetch(`${base}/`);
    const body = await res.text();
    expect(body).toContain('id="errorBanner"');
    expect(body).toContain("retrying");
    // failed-render pushes land in the same banner (see notifyError below)
    expect(body).toContain('addEventListener("renderError"');
  });

  it("serves syntactically valid viewer JS", async () => {
    // The served constant is GENERATED from src/render/viewer.html
    // (scripts/generate-viewer-html.ts); a stale or mangled generation ships a
    // page that throws on load. Extract the script and parse it for real.
    const res = await fetch(`${base}/`);
    const body = await res.text();
    const { script } = splitViewerHtml(body);
    expect(() => new Function(script)).not.toThrow();
  });

  it("serves the pan/zoom camera surface", async () => {
    const res = await fetch(`${base}/`);
    const body = await res.text();
    // the camera is the svg's viewBox, driven directly
    expect(body).toContain('setAttribute("viewBox"');
    expect(body).toContain('addEventListener("wheel"');
    expect(body).toContain('addEventListener("pointerdown"');
    expect(body).toContain("setPointerCapture");
    expect(body).toContain('id="fitBtn"');
    // flyTo animation for slice navigation / fit / double-click
    expect(body).toContain("requestAnimationFrame");
  });

  it("serves a model file with no-store caching and the right type", async () => {
    const res = await fetch(`${base}/model.svg`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/image\/svg\+xml/);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.text()).toContain("<svg>");
  });

  it("serves a slice-tagged SVG (data-slice + <metadata id=\"em-slices\">) byte-for-byte, unmangled", async () => {
    const tagged =
      '<svg viewBox="0 0 100 100"><metadata id="em-slices">{"slices":[{"index":0,"name":"S","x0":0,"x1":100}],"rowLabels":null}</metadata>' +
      '<g data-slice="0" class="node"><title>place_order</title></g></svg>';
    writeFileSync(join(dir, "tagged.svg"), tagged);
    const res = await fetch(`${base}/tagged.svg`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(tagged);
  });

  it("404s a file that isn't there", async () => {
    const res = await fetch(`${base}/nope.svg`);
    expect(res.status).toBe(404);
  });

  it("rejects path traversal outside the served directory", async () => {
    // Encoded slashes survive URL normalization, so this reaches the server as a
    // path that decodes to ../../etc/passwd — the traversal guard must reject it.
    const res = await fetch(`${base}/..%2f..%2f..%2fetc%2fpasswd`);
    expect(res.status).toBe(403);
  });

  it("400s a malformed percent-escape instead of crashing the process", async () => {
    // decodeURIComponent throws a URIError on %zz; uncaught, it would take down
    // the watcher and the live view mid-session.
    const res = await fetch(`${base}/%zz`);
    expect(res.status).toBe(400);
    // The server must still be alive afterwards.
    expect((await fetch(`${base}/model.svg`)).status).toBe(200);
  });

  it("pushes a reload over SSE when notify() is called", async () => {
    const res = await fetch(`${base}/__events`, {
      headers: { accept: "text/event-stream" },
    });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();

    // Drain the initial ": connected" comment, then trigger a push.
    await reader.read();
    server.notify();

    let buf = "";
    // Read chunks until we see the reload event (a couple of reads at most).
    for (let i = 0; i < 5 && !buf.includes("data: reload"); i++) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
    }
    await reader.cancel();
    expect(buf).toContain("data: reload");
  });

  it("pushes a one-line renderError over SSE when notifyError() is called", async () => {
    const res = await fetch(`${base}/__events`, {
      headers: { accept: "text/event-stream" },
    });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();

    await reader.read(); // drain ": connected"
    // Multi-line diagnostics must be flattened — a newline would break SSE framing.
    server.notifyError("error :3 event \"X\" is unreadable\nsecond line");

    let buf = "";
    for (let i = 0; i < 5 && !buf.includes("renderError"); i++) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
    }
    await reader.cancel();
    expect(buf).toContain("event: renderError");
    expect(buf).toContain('data: error :3 event "X" is unreadable · second line');
  });
});
