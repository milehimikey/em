// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { parseNodeRects } from "../src/render/svgGeometry.js";

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