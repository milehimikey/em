// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { compile } from "../src/pipeline.js";
import { renderDot } from "../src/render/render.js";

// Renders a real example through the full pipeline (WASM Graphviz + overlays +
// resvg) — no system graphviz/librsvg required.
const EXAMPLE = "examples/order-fulfillment.em";

describe("end-to-end render", () => {
  it("produces a self-contained SVG with edges, notes, legend and fields", async () => {
    const { dot, model } = compile(readFileSync(EXAMPLE, "utf8"));
    const dir = mkdtempSync(join(tmpdir(), "em-e2e-"));
    try {
      const out = join(dir, "out.svg");
      await renderDot(dot, model, out, "svg", dirname(EXAMPLE));
      const svg = readFileSync(out, "utf8");

      expect(svg).toMatch(/<svg\b/);
      expect(svg).toContain('class="em-edges"'); // self-drawn arrows
      expect(svg).toMatch(/<path fill="none" stroke="#/);
      expect(svg).toContain('class="em-notes"'); // note markers
      expect(svg).toContain('class="em-note-legend"'); // legend
      expect(svg).toContain("notes/order-placed.md"); // working link
      expect(svg).toContain("authorizationId"); // field text rendered in a box
      expect(svg.trim().endsWith("</svg>")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rasterizes to PNG in-process", async () => {
    const { dot, model } = compile(readFileSync(EXAMPLE, "utf8"));
    const dir = mkdtempSync(join(tmpdir(), "em-e2e-"));
    try {
      const out = join(dir, "out.png");
      await renderDot(dot, model, out, "png", dirname(EXAMPLE));
      const png = readFileSync(out);
      expect(png.length).toBeGreaterThan(1000);
      // PNG magic number
      expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
