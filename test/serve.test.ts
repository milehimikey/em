// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startLiveServer, LiveServer } from "../src/render/serve.js";

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

  it("serves a model file with no-store caching and the right type", async () => {
    const res = await fetch(`${base}/model.svg`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/image\/svg\+xml/);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.text()).toContain("<svg>");
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
});
