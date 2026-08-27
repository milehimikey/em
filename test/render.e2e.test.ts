// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { compile } from "../src/pipeline.js";
import { renderDot, layoutDot, composeSvg } from "../src/render/render.js";
import { buildSliceDiagram } from "../src/render/sliceDiagram.js";

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

  it("renders a real State View slice as its own small diagram — the event's own column, not the neighboring slice", async () => {
    const { model } = compile(readFileSync(EXAMPLE, "utf8"));
    const i = model.slices.findIndex((s) => s.name === "View Open Orders");
    const dir = mkdtempSync(join(tmpdir(), "em-e2e-slice-"));
    try {
      const { model: sm, grid, dot } = buildSliceDiagram(model, i);
      const raw = await layoutDot(dot);
      const svg = composeSvg(raw, sm, grid, dirname(EXAMPLE), dir);
      expect(svg).toContain(">Order Placed<"); // the resolved source event
      expect(svg).toContain(">Open Orders<"); // this slice's own view
      expect(svg).not.toContain(">Place Order<"); // "Browse Catalog"'s command — not pulled in
      expect(svg).not.toContain(">Product Catalog<"); // "Browse Catalog"'s ui — not pulled in
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("recomposes note hrefs relative to the slice diagram's own output directory, not the full diagram's", async () => {
    // A minimal model whose only slice has a note — written into a real directory
    // tree (not just an in-memory string) so relative-path resolution is real, and
    // the note lives one level up from where a slice diagram under slices/ would
    // be written. This is exactly the shape that broke if a slice diagram reused
    // an already-composed SVG instead of recomposing overlays for its own outDir
    // (see render.ts's layoutDot/composeSvg/writeRendered split).
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

      const { model, grid, dot } = compile(readFileSync(modelFile, "utf8"));

      // full diagram: outDir == baseDir == dir -> note href is "notes/place-order.md"
      const rawFull = await layoutDot(dot);
      const fullSvg = composeSvg(rawFull, model, grid, dir, dir);
      expect(fullSvg).toContain('href="notes/place-order.md"');

      // slice diagram: outDir == dir/slices, one level deeper -> note href gains a "../"
      const sliceDir = join(dir, "slices");
      const { model: sm, grid: sg, dot: sd } = buildSliceDiagram(model, 0);
      const rawSlice = await layoutDot(sd);
      const sliceSvg = composeSvg(rawSlice, sm, sg, dir, sliceDir);
      expect(sliceSvg).toContain('href="../notes/place-order.md"');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("colors a slice header per its slices/<slug>.md doc's Status, and appends a status legend", async () => {
    const dir = mkdtempSync(join(tmpdir(), "em-e2e-status-"));
    try {
      const modelFile = join(dir, "model.em");
      writeFileSync(
        modelFile,
        `slice "Place Order" {
  command Place Order
}
slice "Ship Order" {
  command Ship Order
}
`,
      );
      mkdirSync(join(dir, "slices"), { recursive: true });
      writeFileSync(join(dir, "slices", "place-order.md"), "- **Status:** Reviewed\n");
      // "Ship Order" has no doc at all — should keep the default header color.

      const { model, grid, dot } = compile(readFileSync(modelFile, "utf8"));
      const raw = await layoutDot(dot);
      const svg = composeSvg(raw, model, grid, dir, dir);

      expect(svg).toContain('class="em-status-legend"');
      expect(svg).toContain(">Reviewed<");
      const placeOrderHeader = /<title>__hdr_0<\/title>[\s\S]*?<\/g>/.exec(svg)![0];
      const shipOrderHeader = /<title>__hdr_1<\/title>[\s\S]*?<\/g>/.exec(svg)![0];
      expect(placeOrderHeader).not.toMatch(/fill="#e3e7eb"/i); // recolored
      expect(shipOrderHeader).toMatch(/fill="#e3e7eb"/i); // untouched default
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("MIL-153: embeds a real on-disk slice doc as em-slices metadata HTML, and drops its own doc-binding note marker", async () => {
    const dir = mkdtempSync(join(tmpdir(), "em-e2e-docflyout-"));
    try {
      const modelFile = join(dir, "model.em");
      writeFileSync(
        modelFile,
        `slice "Place Order" {
  command Place Order note "slices/place-order.md"
}
slice "Ship Order" {
  command Ship Order note "notes/ship-order.md"
}
`,
      );
      mkdirSync(join(dir, "slices"), { recursive: true });
      writeFileSync(join(dir, "slices", "place-order.md"), "# Place Order\n\nSome body text.\n");
      mkdirSync(join(dir, "notes"), { recursive: true });
      writeFileSync(join(dir, "notes", "ship-order.md"), "# Ship Order notes\n");

      const { model, grid, dot } = compile(readFileSync(modelFile, "utf8"));
      const raw = await layoutDot(dot);
      const svg = composeSvg(raw, model, grid, dir, dir);

      const json = /<metadata id="em-slices">([\s\S]*?)<\/metadata>/.exec(svg)![1];
      const payload = JSON.parse(json.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"));
      expect(payload.slices[0].docHtml).toContain("Some body text.");
      expect(payload.slices[1].docHtml).toBeNull(); // "Ship Order" has no slices/ship-order.md of its own

      // The doc-binding self-reference on "Place Order" produced no marker/legend
      // row; the genuine note on "Ship Order" still did.
      expect(svg).toContain('class="em-notes"');
      expect(svg).toContain('href="notes/ship-order.md"');
      expect(svg).not.toContain("slices/place-order.md");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("renders identically whether or not a slices/ dir exists, when no slice has a doc (non-breaking default)", async () => {
    const { dot, model, grid } = compile(readFileSync(EXAMPLE, "utf8"));
    const raw = await layoutDot(dot);
    const withoutSlicesDir = composeSvg(raw, model, grid, dirname(EXAMPLE), dirname(EXAMPLE));
    expect(withoutSlicesDir).not.toContain('class="em-status-legend"');
    expect(withoutSlicesDir).toMatch(/fill="#e3e7eb"/i); // every header still the default gray
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

  // MIL-26: PDF is now composed in-process (pdfkit + svg-to-pdfkit) — no system
  // rsvg-convert involved, same self-contained posture as the PNG path above.
  it("composes a PDF in-process, no system rsvg-convert required", async () => {
    const { dot, model, grid } = compile(readFileSync(EXAMPLE, "utf8"));
    const dir = mkdtempSync(join(tmpdir(), "em-e2e-"));
    try {
      const out = join(dir, "out.pdf");
      await renderDot(dot, model, grid, out, "pdf", dirname(EXAMPLE));
      const pdf = readFileSync(out);
      expect(pdf.length).toBeGreaterThan(1000);
      // PDF magic header, and a well-formed trailer (pdfkit's content streams are
      // Flate-compressed by default, so there's no readable diagram text to assert
      // on directly — same smoke-test depth as the PNG magic-number check above).
      expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
      expect(pdf.toString("latin1")).toContain("%%EOF");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // MIL-141: writeRendered goes through tmp-then-rename so the live viewer never
  // fetches a half-written file — a clean render must leave only the real outputs.
  it("writes atomically: a successful render leaves no *.tmp sibling", async () => {
    const { dot, model, grid } = compile(readFileSync(EXAMPLE, "utf8"));
    const dir = mkdtempSync(join(tmpdir(), "em-e2e-atomic-"));
    try {
      await renderDot(dot, model, grid, join(dir, "out.svg"), "svg", dirname(EXAMPLE));
      await renderDot(dot, model, grid, join(dir, "out.png"), "png", dirname(EXAMPLE));
      await renderDot(dot, model, grid, join(dir, "out.pdf"), "pdf", dirname(EXAMPLE));
      expect(readdirSync(dir).sort()).toEqual(["out.pdf", "out.png", "out.svg"]);
      // renamed file is the complete render, not a placeholder
      expect(readFileSync(join(dir, "out.svg"), "utf8").trim().endsWith("</svg>")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
