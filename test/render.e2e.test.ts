// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { readFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { compile } from "../src/pipeline.js";
import { renderDot, layoutDot, composeSvg } from "../src/render/render.js";
import { cropToSlice } from "../src/render/sliceOverlay.js";

// Renders a real example through the full pipeline (WASM Graphviz + overlays +
// resvg) — no system graphviz/librsvg required.
const EXAMPLE = "examples/order-fulfillment.em";

describe("end-to-end render", () => {
  it("produces a self-contained SVG with edges, notes, legend and fields", async () => {
    const { dot, model, grid } = compile(readFileSync(EXAMPLE, "utf8"));
    const dir = mkdtempSync(join(tmpdir(), "em-e2e-"));
    try {
      const out = join(dir, "out.svg");
      await renderDot(dot, model, grid, out, "svg", dirname(EXAMPLE));
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

  it("crops to a single slice, narrowing the viewBox and keeping only that slice's own elements", async () => {
    const { dot, model, grid } = compile(readFileSync(EXAMPLE, "utf8"));
    const dir = mkdtempSync(join(tmpdir(), "em-e2e-slice-"));
    try {
      const fullOut = join(dir, "full.svg");
      await renderDot(dot, model, grid, fullOut, "svg", dirname(EXAMPLE));
      const fullSvg = readFileSync(fullOut, "utf8");
      const fullVb = /viewBox="[\d.-]+ [\d.-]+ ([\d.-]+) [\d.-]+"/.exec(fullSvg)![1];

      const raw = await layoutDot(dot);
      const svg = composeSvg(raw, model, grid, dirname(EXAMPLE), dirname(fullOut));
      const cropped = cropToSlice(svg, grid, 0); // "Browse Catalog"

      const croppedVb = /viewBox="[\d.-]+ [\d.-]+ ([\d.-]+) [\d.-]+"/.exec(cropped)![1];
      expect(+croppedVb).toBeLessThan(+fullVb); // actually narrowed
      expect(cropped).toContain(">Place Order<"); // this slice's own command
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("recomposes note hrefs relative to the crop's own output directory, not the full diagram's", async () => {
    // A minimal model whose only slice has a note — written into a real directory tree
    // (not just an in-memory string) so relative-path resolution is real, and the note
    // lives one level up from where a slice snippet under slices/ would be written.
    // This is exactly the shape that broke if cropping just re-used the full diagram's
    // already-composed SVG instead of recomposing overlays for the crop's own outDir.
    const dir = mkdtempSync(join(tmpdir(), "em-e2e-notehref-"));
    try {
      const modelFile = join(dir, "model.em");
      writeFileSync(
        modelFile,
        `slice "Place Order" {
  ui Checkout @Customer
  command Place Order note "notes/place-order.md"
  event Order Placed @Order
}
`,
      );
      mkdirSync(join(dir, "notes"), { recursive: true });
      writeFileSync(join(dir, "notes", "place-order.md"), "# Place Order\n");

      const { dot, model, grid } = compile(readFileSync(modelFile, "utf8"));

      // full diagram: outDir == baseDir == dir -> note href is "notes/place-order.md"
      const rawFull = await layoutDot(dot);
      const fullSvg = composeSvg(rawFull, model, grid, dir, dir);
      expect(fullSvg).toContain('href="notes/place-order.md"');

      // slice snippet: outDir == dir/slices, one level deeper -> note href gains a "../"
      const sliceDir = join(dir, "slices");
      const rawSlice = await layoutDot(dot);
      const sliceSvg = composeSvg(rawSlice, model, grid, dir, sliceDir);
      const cropped = cropToSlice(sliceSvg, grid, 0);
      expect(cropped).toContain('href="../notes/place-order.md"');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rasterizes to PNG in-process", async () => {
    const { dot, model, grid } = compile(readFileSync(EXAMPLE, "utf8"));
    const dir = mkdtempSync(join(tmpdir(), "em-e2e-"));
    try {
      const out = join(dir, "out.png");
      await renderDot(dot, model, grid, out, "png", dirname(EXAMPLE));
      const png = readFileSync(out);
      expect(png.length).toBeGreaterThan(1000);
      // PNG magic number
      expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
