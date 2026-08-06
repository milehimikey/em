// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { parseNodeRects, cropCanvas } from "../src/render/svgGeometry.js";

const SVG = `<svg><g id="graph0" class="graph">
<g id="node1" class="node"><title>place_order</title>
<polygon points="200,-100 100,-100 100,-60 200,-60 200,-100"/>
<text x="150" y="-76">Place Order</text></g>
<g id="node2" class="node"><title>order_placed</title>
<path d="M200,-200C200,-200 100,-200 100,-160 100,-160 200,-160 200,-200"/></g>
<g id="edge1" class="edge"><title>x</title><path d="M1,2 L3,4"/></g>
</g></svg>`;

describe("parseNodeRects", () => {
  it("extracts box rects by id from polygon and path nodes", () => {
    const rects = parseNodeRects(SVG, new Set(["place_order", "order_placed"]));
    const po = rects.get("place_order")!;
    expect(po).toMatchObject({ left: 100, right: 200, top: -100, bottom: -60, cx: 150, cy: -80 });
    const op = rects.get("order_placed")!;
    expect(op).toMatchObject({ left: 100, right: 200, top: -200, bottom: -160, cx: 150, cy: -180 });
  });

  it("ignores ids it was not asked for and non-node groups", () => {
    const rects = parseNodeRects(SVG, new Set(["place_order"]));
    expect(rects.has("place_order")).toBe(true);
    expect(rects.has("order_placed")).toBe(false);
    // the edge group is never treated as a node
    expect(rects.has("x")).toBe(false);
  });
});

const CROP_SVG = `<svg viewBox="0 0 300 200" width="300pt" height="200pt"><g class="graph"></g></svg>`;

describe("cropCanvas", () => {
  it("shrinks the viewBox's x-range and rescales width proportionally, leaving y/height untouched", () => {
    const out = cropCanvas(CROP_SVG, { x0: 100, x1: 150 });
    // padded by CROP_PAD=24 on each side: [100-24, 150+24] = [76, 174], width 98
    expect(out).toContain('viewBox="76 0 98 200"');
    expect(out).toContain('width="98pt"'); // 300 * (98/300) = 98
    expect(out).toContain('height="200pt"'); // untouched
  });

  it("clamps to the existing viewBox instead of growing past it", () => {
    const out = cropCanvas(CROP_SVG, { x0: -500, x1: 500 });
    expect(out).toContain('viewBox="0 0 300 200"');
    expect(out).toBe(CROP_SVG); // no-op: nothing actually shrank
  });

  it("never collapses to a zero/negative width, even for a range entirely past the viewBox", () => {
    // clamped left (max(0, 1000-24)=976) would land past clamped right
    // (min(300, 1000+24)=300) without the Math.max(1, ...) guard.
    const out = cropCanvas(CROP_SVG, { x0: 1000, x1: 1000 });
    const vb = /viewBox="[\d.-]+ [\d.-]+ ([\d.-]+) [\d.-]+"/.exec(out)!;
    expect(+vb[1]).toBeGreaterThanOrEqual(1);
  });

  it("returns the input unchanged when viewBox/width/height can't be parsed", () => {
    const svg = `<svg><g class="graph"></g></svg>`;
    expect(cropCanvas(svg, { x0: 0, x1: 100 })).toBe(svg);
  });
});